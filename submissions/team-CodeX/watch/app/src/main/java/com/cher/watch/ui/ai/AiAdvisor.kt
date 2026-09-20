package com.cher.watch.ui.ai

import com.cher.watch.ui.models.EmergencyView
import com.cher.watch.ui.models.HeartAnalysis
import com.cher.watch.ui.models.HeartLevel
import com.cher.watch.ui.models.HelpAssignment
import com.cher.watch.ui.socket.SocketClient
import com.cher.watch.utils.CherConfig as C
import com.cher.watch.utils.Prefs
import org.json.JSONObject

/**
 * Asks the CHER server for a short piece of guidance (the server talks to the AI; no key ever lives on the watch) and keeps the
 * latest suggestion for each place it is shown. Three situations, matching CHER's theme of people helping people:
 *
 *   HEART      resting heart rate above the wearer's own usual for a while  -> one simple, calm thing to do
 *   EMERGENCY  the wearer's own SOS is running                              -> what is happening, what to do while help comes
 *   HELPER     this watch is on its way to somebody                         -> how to approach, what to check on arrival
 *
 * Everything is optional and off with AI Mode. Suggestions are observations and advice, never a diagnosis (also enforced on the
 * server). If the server or the AI is unreachable nothing is shown and nothing breaks.
 */
class AiAdvisor(
    private val socket: SocketClient,
    private val prefs: Prefs,
    private val voice: VoiceGuide,
    private val host: Host,
) {
    interface Host {
        fun demoMode(): Boolean
        fun changed()
    }

    data class Advice(val text: String, val source: String, val kind: String, val at: Long)

    var health: Advice? = null
        private set
    var emergency: Advice? = null
        private set
    var helper: Advice? = null
        private set

    private var levelSince = -1L
    private var normalSince = -1L
    private var lastHealthLevel = HeartLevel.NORMAL
    private var lastHealthAt = 0L
    private var lastEmergencySig = ""
    private var lastEmergencyAt = 0L
    private var lastHelperSig = ""
    private var lastHelperAt = 0L
    private var busy = false
    private var lastEmergencyId: String? = null

    val active: Boolean get() = prefs.aiMode

    /** ~1 Hz. Decides whether a new suggestion is worth asking for. */
    fun onTick(
        now: Long,
        analysis: HeartAnalysis,
        resting: Boolean,
        own: EmergencyView?,
        call112Pending: Boolean,
        assignment: HelpAssignment?,
        distanceM: Double?,
    ) {
        if (!prefs.aiMode) { clearAll(); return }
        healthTick(now, analysis, resting, own)
        emergencyTick(now, own, call112Pending)
        helperTick(now, assignment, distanceM)
        expire(now)
    }

    /** Speak the current suggestion again (tap on the text). */
    fun repeat(text: String) {
        if (prefs.aiVoice) voice.speak(text)
    }

    // ------------------------------------------------------------------ heart rate
    private fun healthTick(now: Long, a: HeartAnalysis, resting: Boolean, own: EmergencyView?) {
        val level = if (prefs.aiHealth && a.available && resting && own == null) a.level else HeartLevel.NORMAL
        if (level == HeartLevel.NORMAL) {
            levelSince = -1L
            lastHealthLevel = HeartLevel.NORMAL
            if (normalSince < 0) normalSince = now
            if (health != null && now - normalSince >= 10_000) { health = null; host.changed() } // situation over: let the text go
            return
        }
        normalSince = -1L
        if (levelSince < 0) levelSince = now
        val sustain = if (host.demoMode()) C.DEMO_AI_ELEVATED_SUSTAIN_MS else C.AI_ELEVATED_SUSTAIN_MS
        val cooldown = if (host.demoMode()) C.DEMO_AI_HEALTH_COOLDOWN_MS else C.AI_HEALTH_COOLDOWN_MS
        val changedLevel = level != lastHealthLevel
        if (now - levelSince < sustain || busy) return
        if (!changedLevel && now - lastHealthAt < cooldown) return
        lastHealthLevel = level
        lastHealthAt = now
        val heart = JSONObject().put("bpm", a.current ?: return).put("level", level.name).put("resting", resting)
        a.baseline?.let { heart.put("baseline", it) }
        ask(JSONObject().put("kind", "HEART").put("heart", heart)) { health = it }
    }

    // ------------------------------------------------------------------ own emergency
    private fun emergencyTick(now: Long, e: EmergencyView?, call112Pending: Boolean) {
        if (e == null || e.isTerminal || !prefs.aiEmergency || !e.synced) {
            if (e == null && emergency != null) { emergency = null; lastEmergencySig = ""; host.changed() }
            return
        }
        if (lastEmergencyId != e.id) { lastEmergencyId = e.id; lastEmergencySig = ""; emergency = null }
        val active = e.responders.firstOrNull { it.status in setOf("ACCEPTED", "MOVING", "REACHED") }
        val kind = when { active == null -> null; active.id.startsWith("H:") -> "NEARBY_HELPER"; else -> "CONTACT" }
        val sig = "${e.state}|$kind|$call112Pending"
        if (sig == lastEmergencySig || busy || now - lastEmergencyAt < C.AI_EMERGENCY_MIN_GAP_MS && emergency != null) return
        lastEmergencySig = sig
        lastEmergencyAt = now
        val em = JSONObject().put("state", e.state).put("fallbackCall", call112Pending)
        kind?.let { em.put("responder", it) }
        ask(JSONObject().put("kind", "EMERGENCY").put("emergency", em)) { emergency = it }
    }

    // ------------------------------------------------------------------ helping somebody
    private fun helperTick(now: Long, a: HelpAssignment?, distanceM: Double?) {
        if (a == null || !prefs.aiEmergency) {
            if (a == null && helper != null) { helper = null; lastHelperSig = ""; host.changed() }
            return
        }
        val arrived = a.arrived || (distanceM != null && distanceM <= 30.0)
        val sig = "${a.emergencyId}|$arrived"
        if (sig == lastHelperSig || busy || now - lastHelperAt < 5_000) return
        lastHelperSig = sig
        lastHelperAt = now
        val h = JSONObject().put("arrived", arrived).put("situation", a.situation)
        distanceM?.let { h.put("distanceM", it.toInt().coerceIn(0, 100_000)) }
        ask(JSONObject().put("kind", "HELPER").put("helper", h)) { helper = it }
    }

    // ------------------------------------------------------------------ plumbing
    private fun ask(payload: JSONObject, store: (Advice) -> Unit) {
        busy = true
        val kind = payload.getString("kind")
        socket.request("ai:advise", payload, timeoutMs = 9_000) { res ->
            busy = false
            val text = res?.takeIf { it.optBoolean("ok") }?.optString("text").orEmpty()
            if (text.isNotBlank() && prefs.aiMode) {
                store(Advice(text, res!!.optString("source", "RULES"), kind, System.currentTimeMillis()))
                if (prefs.aiVoice) voice.speak(text)
                host.changed()
            }
        }
    }

    private fun expire(now: Long) {
        if (health != null && normalSince < 0 && now - health!!.at > C.AI_ADVICE_TTL_MS * 3) { health = null; host.changed() }
    }

    private fun clearAll() {
        if (health != null || emergency != null || helper != null) {
            health = null; emergency = null; helper = null
            lastEmergencySig = ""; lastHelperSig = ""; levelSince = -1L
            voice.stop()
            host.changed()
        }
    }
}
