package com.cher.watch.ui.help

import android.util.Log
import com.cher.watch.ui.models.GeoPoint
import com.cher.watch.ui.models.HelpAssignment
import com.cher.watch.ui.models.HelpCheckIn
import com.cher.watch.ui.models.HelpRequest
import com.cher.watch.ui.models.LocationFix
import com.cher.watch.ui.services.Notifier
import com.cher.watch.ui.socket.SocketClient
import com.cher.watch.utils.Geo
import com.cher.watch.utils.Haptics
import org.json.JSONObject

/**
 * This watch helping somebody else. Everything the server decides arrives as `help:*` events:
 *
 *   help:request  a nearby person needs help: pop-up (distance + rough direction only), countdown to expiry
 *   [tap CAN HELP -> help:respond ACCEPT]  the server answers with the person's live location -> guidance starts
 *   help:update   the person's location / the response state changed: map and arrow follow
 *   help:checkin  "still on your way?": answered on the watch (no phone call to a helper)
 *   help:closed   resolved / cancelled / expired / already covered
 *
 * Runs on the main thread. If the connection drops the server re-sends the open pop-up or assignment on `watch:hello`.
 */
class HelperController(
    private val socket: SocketClient,
    private val notifier: Notifier,
    private val haptics: Haptics,
    private val host: Host,
) {
    interface Host {
        fun lastLocation(): LocationFix?
        fun ownEmergencyActive(): Boolean
        fun onHelpingChanged(helping: Boolean)
        fun changed()
    }

    var request: HelpRequest? = null
        private set
    var assignment: HelpAssignment? = null
        private set
    var checkIn: HelpCheckIn? = null
        private set
    /** Final message after helping ended ("Resolved. Thank you!"), shown until dismissed. */
    var notice: String? = null
        private set
    /** true = show the full "thank you" screen; false = just a one-line note on the home screen. */
    var noticeFinal: Boolean = false
        private set
    /** Transient problem ("No connection: try again"). */
    var error: String? = null
        private set
    var busy: Boolean = false
        private set

    /** The helper's own recent positions (oldest first), drawn as a trail on the map. */
    val trail = ArrayDeque<GeoPoint>()

    val helping: Boolean get() = assignment != null

    // ---------------------------------------------------------------- server input
    fun onServerEvent(event: String, p: JSONObject) {
        val serverNow = p.optLong("serverTs", System.currentTimeMillis())
        when (event) {
            "help:request" -> onRequest(HelpRequest.fromJson(p, serverNow))
            "help:update" -> onUpdate(p)
            "help:checkin" -> onCheckIn(p, serverNow)
            "help:closed" -> onClosed(p)
        }
    }

    /** `watch:hello` response: restore an open pop-up or an ongoing assignment after a reconnect. */
    fun onHello(res: JSONObject) {
        val help = res.optJSONObject("help") ?: return
        val serverNow = res.optLong("serverTime", System.currentTimeMillis())
        help.optJSONObject("request")?.let { if (request == null && assignment == null) onRequest(HelpRequest.fromJson(it, serverNow)) }
        val a = help.optJSONObject("assignment")
        if (a != null) setAssignment(HelpAssignment.fromJson(a)) else if (assignment != null && help.has("assignment")) endAssignment(null)
    }

    private fun onRequest(r: HelpRequest) {
        if (host.ownEmergencyActive() || assignment != null) return // never pull a person in trouble (or a busy helper) away
        if (request?.emergencyId == r.emergencyId) return
        request = r
        notice = null
        noticeFinal = false
        error = null
        haptics.helpRequest()
        notifier.showHelpRequest(r.personName, Geo.formatDistance(r.distanceM.toDouble()), Geo.compassWord(r.direction).lowercase().replace('-', ' '))
        host.changed()
    }

    private fun onUpdate(p: JSONObject) {
        val a = assignment ?: return
        if (p.optString("emergencyId") != a.emergencyId) return
        assignment = a.withLocation(GeoPoint.fromJson(p.optJSONObject("location")), p.optString("state", a.state), p.optLong("updatedAt", System.currentTimeMillis()))
        host.changed()
    }

    private fun onCheckIn(p: JSONObject, serverNow: Long) {
        val a = assignment ?: return
        if (p.optString("emergencyId") != a.emergencyId) return
        val total = (p.optLong("expiresAt", serverNow) - serverNow).coerceIn(5_000L, 300_000L)
        checkIn = HelpCheckIn(p.optString("type", "STATUS"), System.currentTimeMillis() + total, total)
        haptics.checkIn()
        host.changed()
    }

    private fun onClosed(p: JSONObject) {
        val id = p.optString("emergencyId")
        val message = p.optString("message").ifEmpty { "This request is closed." }
        if (request?.emergencyId == id) clearRequest()
        if (assignment?.emergencyId == id) endAssignment(message) else if (request == null) {
            // A pop-up that closed on its own (expired / covered / declined): a one-line note is enough.
            if (p.optString("reason") in setOf("EXPIRED", "COVERED")) { notice = message; noticeFinal = false }
            host.changed()
        }
    }

    // ---------------------------------------------------------------- wearer actions
    fun accept() {
        val r = request ?: return
        if (busy) return
        busy = true
        error = null
        host.changed()
        socket.request("help:respond", JSONObject().put("emergencyId", r.emergencyId).put("response", "ACCEPT")) { res ->
            busy = false
            when {
                res == null -> error = "No connection. Try again"
                res.optBoolean("ok") -> {
                    clearRequest()
                    res.optJSONObject("assignment")?.let { setAssignment(HelpAssignment.fromJson(it)) }
                    haptics.confirm()
                }
                res.optString("error") == "REQUEST_CLOSED" || res.optString("error") == "NOT_FOUND" -> {
                    clearRequest()
                    notice = "Someone else is already helping. Thank you!"
                    noticeFinal = true
                }
                else -> error = "Could not accept (${res.optString("error")})"
            }
            host.changed()
        }
    }

    fun decline() {
        val r = request ?: return
        clearRequest()
        socket.request("help:respond", JSONObject().put("emergencyId", r.emergencyId).put("response", "DECLINE")) { }
        host.changed()
    }

    /** MOVING / REACHED / BACKUP / CONFIRMED / SAFE. Any report also answers an open check-in. */
    fun status(status: String) {
        val a = assignment ?: return
        if (busy) return
        busy = true
        error = null
        host.changed()
        socket.request("help:status", JSONObject().put("emergencyId", a.emergencyId).put("status", status)) { res ->
            busy = false
            when {
                res == null -> error = "No connection. Try again"
                res.optBoolean("ok") -> {
                    checkIn = null
                    res.optJSONObject("assignment")?.let { setAssignment(HelpAssignment.fromJson(it), keepTrail = true) }
                    haptics.confirm()
                }
                res.optString("error") == "NOT_FOUND" || res.optString("error") == "INVALID_TRANSITION" -> endAssignment("This emergency is already closed.")
                else -> error = "Could not send (${res.optString("error")})"
            }
            host.changed()
        }
    }

    fun dismissNotice() {
        notice = null
        noticeFinal = false
        host.changed()
    }

    // ---------------------------------------------------------------- own position
    fun onOwnFix(fix: LocationFix) {
        if (assignment == null) return
        val last = trail.lastOrNull()
        if (last != null && Geo.distanceM(last.latitude, last.longitude, fix.latitude, fix.longitude) < 3.0) return
        trail.addLast(GeoPoint(fix.latitude, fix.longitude, fix.accuracy, fix.timestamp))
        while (trail.size > TRAIL_MAX) trail.removeFirst()
    }

    /** ~1 Hz: expire pop-up / check-in on this watch's clock. */
    fun tick(nowMs: Long) {
        val r = request
        if (r != null && nowMs > r.deadlineMs + 1_500) {
            clearRequest()
            host.changed()
        }
        val c = checkIn
        if (c != null && nowMs > c.deadlineMs) {
            checkIn = null // the server counts it as missed and escalates; nothing more to ask here
            host.changed()
        }
    }

    // ---------------------------------------------------------------- internals
    private fun setAssignment(a: HelpAssignment, keepTrail: Boolean = false) {
        val wasHelping = helping
        assignment = a
        if (!keepTrail && !wasHelping) trail.clear()
        host.lastLocation()?.let { onOwnFix(it) }
        notifier.showHelping("${a.personName}: ${a.state.lowercase().replace('_', ' ')}")
        if (!wasHelping) host.onHelpingChanged(true)
    }

    private fun endAssignment(message: String?) {
        assignment = null
        checkIn = null
        notice = message ?: notice
        noticeFinal = true
        trail.clear()
        haptics.cancel()
        notifier.cancelHelp()
        Log.i(TAG, "helping ended: $message")
        host.onHelpingChanged(false)
        host.changed()
    }

    private fun clearRequest() {
        request = null
        haptics.cancel()
        notifier.cancelHelp()
    }

    private companion object {
        const val TAG = "CHER/Helper"
        const val TRAIL_MAX = 40
    }
}
