package com.cher.watch.ui.emergency

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.cher.watch.ui.models.EmergencyView
import com.cher.watch.ui.models.HeartAnalysis
import com.cher.watch.ui.models.LocationFix
import com.cher.watch.ui.models.MonitoringState
import com.cher.watch.ui.models.MotionEvent
import com.cher.watch.ui.models.SignalType
import com.cher.watch.ui.models.TriggerType
import com.cher.watch.ui.services.Notifier
import com.cher.watch.ui.socket.PendingStore
import com.cher.watch.ui.socket.SocketClient
import com.cher.watch.utils.CherConfig as C
import com.cher.watch.utils.Haptics
import com.cher.watch.utils.Ids
import org.json.JSONArray
import org.json.JSONObject

/**
 * The watch-side emergency state machine:
 *
 *   NORMAL -> POSSIBLE_ANOMALY -> VERIFYING ("Are you OK?") -> ESCALATING (last-chance cancel) -> ACTIVE_EMERGENCY
 *
 * Manual SOS bypasses all detection and goes straight to ACTIVE_EMERGENCY. Once active, the emergency is
 * created locally first (persisted + queued) and synchronised with the backend whenever connectivity allows.
 * Everything here runs on the main thread.
 */
class EmergencyController(
    context: Context,
    private val socket: SocketClient,
    private val pending: PendingStore,
    private val fusion: SignalFusion,
    private val notifier: Notifier,
    private val haptics: Haptics,
    private val host: Host,
) {
    interface Host {
        fun lastLocation(): LocationFix?
        fun heartAnalysis(): HeartAnalysis
        fun batteryPercent(): Int
        fun demoMode(): Boolean
        /** Known to be at rest (still for a while). Unknown counts as NOT resting: the 110+ check-in path needs certainty. */
        fun resting(): Boolean
        fun nearbyBroadcast(): Boolean
        fun requestFreshLocation()
        fun onEmergencyActiveChanged(active: Boolean)
        fun changed()
    }

    private val ctx = context.applicationContext
    private val main = Handler(Looper.getMainLooper())
    private val activeStore = ctx.getSharedPreferences("cher_active", Context.MODE_PRIVATE)

    var state: MonitoringState = MonitoringState.NORMAL
        private set
    var checkInDeadline: Long = 0
        private set
    var escalationDeadline: Long = 0
        private set
    var emergency: EmergencyView? = null
        private set
    /** Last finished emergency (RESOLVED/CANCELLED), shown until the wearer dismisses it. */
    var closed: EmergencyView? = null
        private set
    var lastNote: String? = null
        private set

    private var cooldownUntil = 0L
    private var escalationSignals: Set<SignalType> = emptySet()

    /** How long to stay quiet after "I'M OK" / a finished emergency (short in demo mode so simulations can be repeated). */
    private fun cooldownMs() = if (host.demoMode()) C.DEMO_POST_OK_COOLDOWN_MS else C.POST_OK_COOLDOWN_MS

    /** A simulated fall/impact is an explicit request to run the flow: it must never be swallowed by the "I'M OK" quiet period. */
    fun clearCooldown() { cooldownUntil = 0L }

    val emergencyActive: Boolean get() = state == MonitoringState.ACTIVE_EMERGENCY

    private val checkInTimeout = Runnable { onCheckInTimeout() }
    private val escalationTimeout = Runnable { onEscalationTimeout() }

    init {
        restoreActive()
    }

    // ---------------------------------------------------------------- inputs from sensors
    fun onHeart(a: HeartAnalysis, nowMs: Long = System.currentTimeMillis()) {
        fusion.onHeart(a, nowMs, host.resting())
        evaluate(nowMs)
    }

    fun onMotion(e: MotionEvent) {
        fusion.onMotion(e)
        evaluate(System.currentTimeMillis())
    }

    /** ~1 Hz housekeeping. */
    fun tick(nowMs: Long = System.currentTimeMillis()) {
        evaluate(nowMs)
        if (state == MonitoringState.VERIFYING) notifier.showCheckIn(secondsLeft(checkInDeadline))
        if (state == MonitoringState.ESCALATING) notifier.showEscalating(secondsLeft(escalationDeadline))
    }

    private fun secondsLeft(deadline: Long) = com.cher.watch.utils.TimeUtils.secondsLeft(deadline)

    private fun evaluate(now: Long) {
        if (state == MonitoringState.VERIFYING || state == MonitoringState.ESCALATING || state == MonitoringState.ACTIVE_EMERGENCY) return
        val active = fusion.active(now)
        val next = if (active.isEmpty()) MonitoringState.NORMAL else MonitoringState.POSSIBLE_ANOMALY
        if (now >= cooldownUntil && fusion.shouldCheckIn(now, host.demoMode())) {
            startCheckIn(now)
            return
        }
        setState(next)
    }

    // ---------------------------------------------------------------- verification
    private fun startCheckIn(now: Long) {
        setState(MonitoringState.VERIFYING)
        val timeout = if (host.demoMode()) C.DEMO_CHECKIN_TIMEOUT_MS else C.CHECKIN_TIMEOUT_MS
        checkInDeadline = now + timeout
        main.removeCallbacks(checkInTimeout)
        main.postDelayed(checkInTimeout, timeout)
        haptics.checkIn()
        notifier.showCheckIn(secondsLeft(checkInDeadline))
        host.changed()
    }

    fun userOk() {
        if (state != MonitoringState.VERIFYING && state != MonitoringState.ESCALATING) return
        cancelTimers()
        fusion.clear()
        cooldownUntil = System.currentTimeMillis() + cooldownMs()
        notifier.cancelAlerts()
        haptics.confirm()
        socket.sendTelemetry("user:response", JSONObject().put("response", "OK").put("eventId", Ids.newEventId()))
        lastNote = "You said you're OK"
        setState(MonitoringState.NORMAL)
    }

    fun userNeedsHelp() {
        if (state == MonitoringState.ACTIVE_EMERGENCY) return
        cancelTimers()
        activate(TriggerType.USER_NEEDS_HELP, fusion.active(System.currentTimeMillis()) + SignalType.USER_REQUESTED_HELP, "NEEDS_HELP")
    }

    private fun onCheckInTimeout() {
        if (state != MonitoringState.VERIFYING) return
        val a = fusion.assessAfterNoResponse(System.currentTimeMillis())
        if (a.state == MonitoringState.ESCALATING) {
            escalationSignals = a.signals
            setState(MonitoringState.ESCALATING)
            val grace = if (host.demoMode()) C.DEMO_ESCALATION_GRACE_MS else C.ESCALATION_GRACE_MS
            escalationDeadline = System.currentTimeMillis() + grace
            main.removeCallbacks(escalationTimeout)
            main.postDelayed(escalationTimeout, grace)
            haptics.emergency()
            notifier.showEscalating(secondsLeft(escalationDeadline))
            host.changed()
        } else {
            // Not enough corroboration to call for help on a silent check-in: keep monitoring, do not spam.
            Log.i(TAG, "No response but signals not corroborated (${a.signals}); continuing to monitor")
            cooldownUntil = System.currentTimeMillis() + cooldownMs()
            notifier.cancelAlerts()
            setState(MonitoringState.POSSIBLE_ANOMALY)
        }
    }

    fun cancelEscalation() {
        if (state != MonitoringState.ESCALATING) return
        userOkFromEscalation()
    }

    private fun userOkFromEscalation() {
        cancelTimers()
        fusion.clear()
        cooldownUntil = System.currentTimeMillis() + cooldownMs()
        notifier.cancelAlerts()
        haptics.confirm()
        lastNote = "SOS cancelled"
        setState(MonitoringState.NORMAL)
    }

    private fun onEscalationTimeout() {
        if (state != MonitoringState.ESCALATING) return
        val signals = escalationSignals + SignalType.NO_USER_RESPONSE
        activate(fusion.triggerFor(signals), signals, "NO_RESPONSE")
    }

    // ---------------------------------------------------------------- activation
    /** Manual SOS: bypasses detection, AI, video, analysis, everything. */
    fun manualSos() {
        cancelTimers()
        activate(TriggerType.MANUAL_SOS, emptySet(), "NONE")
    }

    private fun activate(trigger: TriggerType, signals: Set<SignalType>, userResponse: String) {
        cancelTimers()
        val now = System.currentTimeMillis()
        val existing = emergency
        val id = existing?.takeIf { !it.isTerminal }?.id ?: Ids.newEmergencyId()
        val eventId = Ids.newEventId()
        val payload = buildPayload(id, eventId, trigger, signals, userResponse, now)

        if (existing == null || existing.isTerminal) {
            emergency = EmergencyView.local(id, trigger, now)
            closed = null
            activeStore.edit().putString(KEY_ACTIVE, JSONObject().put("id", id).put("trigger", trigger.wire).put("createdAt", now).toString()).apply()
        }
        setState(MonitoringState.ACTIVE_EMERGENCY)
        host.onEmergencyActiveChanged(true)
        host.requestFreshLocation()
        socket.sendCritical("emergency:create", payload, eventId)
        haptics.emergency()
        notifier.showEmergency("Emergency active", "Contacting your responder...")
        host.changed()
    }

    private fun buildPayload(id: String, eventId: String, trigger: TriggerType, signals: Set<SignalType>, userResponse: String, now: Long): JSONObject {
        val hr = host.heartAnalysis()
        val o = JSONObject()
            .put("emergencyId", id)
            .put("eventId", eventId)
            .put("triggerType", trigger.wire)
            .put("triggeredAt", now)
            .put("signals", JSONArray(signals.map { it.name }))
            .put("userResponse", userResponse)
            .put("battery", host.batteryPercent())
            .put("demo", host.demoMode())
            .put("nearbyAlerts", host.nearbyBroadcast())
        o.put("health", JSONObject().apply {
            hr.current?.let { put("bpm", it) }
            hr.baseline?.let { put("baselineBpm", it) }
            put("trend", hr.trend)
            put("sensorAvailable", hr.available)
        })
        if (fusion.lastMotionEvent != null || fusion.peakG > 0) {
            o.put("motion", JSONObject().apply {
                fusion.lastMotionEvent?.let { put("event", it) }
                put("peakG", fusion.peakG)
                put("inactivitySeconds", fusion.inactivitySeconds)
            })
        }
        host.lastLocation()?.let { o.put("location", it.toJson()) }
        return o
    }

    // ---------------------------------------------------------------- ending
    /**
     * Wearer cancels (false alarm). A create that is still queued locally is withdrawn, and a cancel is always sent:
     * if the server never saw the emergency it answers NOT_FOUND (harmless), and if the create was in flight the
     * cancel arrives after it on the same connection, so nothing is left running.
     */
    fun cancelEmergency() {
        val e = emergency ?: return
        if (e.isTerminal) return
        pending.all().filter { it.event == "emergency:create" && it.payload.optString("emergencyId") == e.id }.forEach { pending.remove(it.id) }
        socket.sendCritical("emergency:cancel", JSONObject().put("emergencyId", e.id).put("reason", "Cancelled on watch").put("cancelledBy", "PERSON"))
        finish(e.copy(state = "CANCELLED", nextAction = "None", contactStatus = "Cancelled"))
    }

    /** Wearer confirms they are safe. The server refuses unless a responder has reached them. */
    fun confirmSafe() {
        val e = emergency ?: return
        socket.sendCritical("emergency:resolve", JSONObject().put("emergencyId", e.id))
    }

    fun dismissClosed() {
        closed = null
        lastNote = null
        host.changed()
    }

    private fun finish(view: EmergencyView) {
        cancelTimers()
        emergency = null
        closed = view
        activeStore.edit().remove(KEY_ACTIVE).apply()
        fusion.clear()
        cooldownUntil = System.currentTimeMillis() + cooldownMs()
        notifier.cancelAlerts()
        haptics.confirm()
        setState(MonitoringState.NORMAL)
        host.onEmergencyActiveChanged(false)
    }

    // ---------------------------------------------------------------- server input
    fun onServerEvent(event: String, payload: JSONObject) {
        val obj = payload.optJSONObject("emergency") ?: return
        val view = try { EmergencyView.fromJson(obj) } catch (e: Exception) { Log.w(TAG, "bad emergency payload", e); return }
        adopt(view)
    }

    fun onAcked(event: String, res: JSONObject) {
        if (!res.optBoolean("ok")) {
            lastNote = "Sync issue: ${res.optString("error")}"
            host.changed()
            return
        }
        res.optJSONObject("emergency")?.let { adopt(EmergencyView.fromJson(it)) }
    }

    /** After (re)connecting: the server's active emergency for this watch is authoritative. */
    fun onHello(res: JSONObject) {
        val active = res.optJSONObject("activeEmergency")
        if (active != null) {
            adopt(EmergencyView.fromJson(active))
        } else {
            val e = emergency
            val createQueued = e != null && pending.all().any { it.event == "emergency:create" && it.payload.optString("emergencyId") == e.id }
            if (e != null && e.synced && !createQueued && !e.isTerminal) {
                // The server no longer has it active: ask what happened to it.
                socket.sendTelemetry("emergency:get", JSONObject().put("emergencyId", e.id))
            }
        }
    }

    private fun adopt(view: EmergencyView) {
        val current = emergency
        if (current != null && current.id != view.id && !current.isTerminal) return // a different emergency
        if (current != null && current.id == view.id && current.synced && view.lastUpdate in 1 until current.lastUpdate) return // stale event
        if (view.isTerminal) {
            if (current?.id == view.id || current == null && state == MonitoringState.ACTIVE_EMERGENCY) finish(view)
            return
        }
        val wasNew = current == null
        emergency = view
        if (wasNew || state != MonitoringState.ACTIVE_EMERGENCY) {
            cancelTimers()
            setState(MonitoringState.ACTIVE_EMERGENCY)
            host.onEmergencyActiveChanged(true)
            activeStore.edit().putString(KEY_ACTIVE, JSONObject().put("id", view.id).put("trigger", view.triggerType).put("createdAt", view.createdAt).toString()).apply()
        }
        notifyEmergency(view)
        host.changed()
    }

    private fun notifyEmergency(view: EmergencyView) = notifier.showEmergency(
        if (view.hasResponder) "${view.responderName}: ${view.responderStatus?.lowercase()}" else "Emergency active",
        "${view.contactStatus}. Next: ${view.nextAction}",
    )

    /** The screen went away: re-post the current emergency notification (it is not shown while the screen is up). */
    fun refreshNotification() {
        val e = emergency ?: return
        if (!e.isTerminal) notifyEmergency(e)
    }

    // ---------------------------------------------------------------- persistence / plumbing
    private fun restoreActive() {
        val raw = activeStore.getString(KEY_ACTIVE, null) ?: return
        try {
            val o = JSONObject(raw)
            val trigger = TriggerType.values().firstOrNull { it.wire == o.optString("trigger") } ?: TriggerType.MANUAL_SOS
            emergency = EmergencyView.local(o.getString("id"), trigger, o.optLong("createdAt"))
            state = MonitoringState.ACTIVE_EMERGENCY
        } catch (e: Exception) {
            activeStore.edit().remove(KEY_ACTIVE).apply()
        }
    }

    private fun cancelTimers() {
        main.removeCallbacks(checkInTimeout)
        main.removeCallbacks(escalationTimeout)
        checkInDeadline = 0
        escalationDeadline = 0
    }

    private fun setState(s: MonitoringState) {
        if (state == s) return
        Log.i(TAG, "monitoring state $state -> $s")
        state = s
        host.changed()
    }

    private companion object {
        const val TAG = "CHER/Controller"
        const val KEY_ACTIVE = "active"
    }
}
