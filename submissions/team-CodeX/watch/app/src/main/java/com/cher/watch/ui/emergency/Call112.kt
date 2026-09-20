package com.cher.watch.ui.emergency

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.util.Log
import androidx.core.content.ContextCompat
import com.cher.watch.ui.ai.VoiceGuide
import com.cher.watch.ui.models.EmergencyView
import com.cher.watch.utils.CherConfig as C
import com.cher.watch.utils.Haptics
import com.cher.watch.utils.Prefs

/**
 * When to fall back to the emergency number. Pure, so it is unit-tested.
 *
 * Safety rules:
 *  - ONLY after the wearer explicitly asked for help (SOS hold or "Need help"). A heart-rate reading, a detected fall or a missed
 *    check-in never starts this, because a false call to emergency services is harmful.
 *  - only when nobody (nearby watch or phone contact) has accepted after a while, or the server reports UNCONFIRMED
 *  - always with a countdown the wearer can cancel
 */
object Call112Policy {
    private val EXPLICIT = setOf("MANUAL_SOS", "USER_NEEDS_HELP")

    fun shouldArm(enabled: Boolean, triggerType: String, state: String, hasResponder: Boolean, ageMs: Long, demo: Boolean): Boolean {
        if (!enabled || triggerType !in EXPLICIT || hasResponder) return false
        if (state == "UNCONFIRMED") return true
        if (state == "ACTIVE" && ageMs < 3_000) return false
        return ageMs >= if (demo) C.DEMO_NO_ANSWER_112_MS else C.NO_ANSWER_112_MS
    }
}

/**
 * The 112 fallback: countdown (cancellable) -> place the call in the background with the watch's own phone, or in DEMO mode only
 * *pretend* (a clear "DEMO: no real call" screen; demo mode never touches telephony). Once per emergency, unless the wearer taps 112.
 */
class Call112(
    context: Context,
    private val prefs: Prefs,
    private val voice: VoiceGuide,
    private val haptics: Haptics,
    private val host: Host,
) {
    interface Host {
        fun demoMode(): Boolean
        fun changed()
    }

    enum class Phase { IDLE, COUNTDOWN, CALLING }

    private val ctx = context.applicationContext
    var phase: Phase = Phase.IDLE
        private set
    var deadline: Long = 0L
        private set
    var totalMs: Long = 1L
        private set
    var reasonManual: Boolean = false
        private set
    /** Demo dry run: nothing is dialled. */
    var dryRun: Boolean = false
        private set
    var note: String = ""
        private set

    private var emergencyId: String? = null
    private var firstSeen = 0L
    private var handled = false
    private var callingSince = 0L

    /** ~1 Hz. */
    fun onTick(now: Long, e: EmergencyView?) {
        if (e == null || e.isTerminal) {
            if (phase != Phase.IDLE || emergencyId != null) reset()
            return
        }
        if (emergencyId != e.id) { reset(); emergencyId = e.id; firstSeen = now }
        when (phase) {
            Phase.IDLE -> {
                if (handled || !e.synced) return
                if (Call112Policy.shouldArm(prefs.call112, e.triggerType, e.state, e.hasResponder, now - firstSeen, host.demoMode())) {
                    start(now, manual = false)
                }
            }
            Phase.COUNTDOWN -> {
                if (e.hasResponder && !reasonManual) { cancelQuietly("A responder accepted") ; return }
                if (now >= deadline) dial(now)
            }
            Phase.CALLING -> if (now - callingSince > 15_000) { phase = Phase.IDLE; handled = true; host.changed() }
        }
    }

    /** The wearer tapped 112 themselves: short countdown, still cancellable (pockets happen). */
    fun startManual(now: Long = System.currentTimeMillis()) {
        if (phase != Phase.IDLE || emergencyId == null) return
        start(now, manual = true)
    }

    fun cancel() {
        if (phase == Phase.IDLE) return
        phase = Phase.IDLE
        handled = true // the wearer said no: do not start again by itself
        note = ""
        voice.stop()
        haptics.cancel()
        host.changed()
    }

    fun callNow(now: Long = System.currentTimeMillis()) {
        if (phase == Phase.COUNTDOWN) dial(now)
    }

    private fun start(now: Long, manual: Boolean) {
        reasonManual = manual
        dryRun = host.demoMode()
        totalMs = when {
            manual -> C.MANUAL_112_COUNTDOWN_MS
            dryRun -> C.DEMO_CALL_112_COUNTDOWN_MS
            else -> C.CALL_112_COUNTDOWN_MS
        }
        deadline = now + totalMs
        phase = Phase.COUNTDOWN
        note = if (manual) "You asked to call 112" else "No one has answered yet"
        haptics.emergency()
        if (prefs.aiVoice) voice.speak("Calling ${C.EMERGENCY_NUMBER} in ${(totalMs / 1000)} seconds. Tap cancel to stop.")
        host.changed()
    }

    private fun cancelQuietly(why: String) {
        phase = Phase.IDLE
        note = why
        voice.stop()
        host.changed()
    }

    private fun dial(now: Long) {
        handled = true
        callingSince = now
        phase = Phase.CALLING
        if (dryRun) {
            note = "DEMO: no real call is placed"
            Log.i(TAG, "demo dry run: would dial ${C.EMERGENCY_NUMBER}")
        } else {
            note = place()
        }
        host.changed()
    }

    /** The real thing: the watch's own phone, from the background. Falls back to the dialer if the permission is missing. */
    private fun place(): String {
        val uri = Uri.parse("tel:${C.EMERGENCY_NUMBER}")
        val allowed = ContextCompat.checkSelfPermission(ctx, Manifest.permission.CALL_PHONE) == PackageManager.PERMISSION_GRANTED
        val intent = Intent(if (allowed) Intent.ACTION_CALL else Intent.ACTION_DIAL, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return try {
            ctx.startActivity(intent)
            if (allowed) "Calling ${C.EMERGENCY_NUMBER}" else "Dialer opened: press call"
        } catch (e: ActivityNotFoundException) {
            Log.w(TAG, "no phone app", e)
            "No phone on this watch. Call ${C.EMERGENCY_NUMBER} from your phone"
        } catch (e: SecurityException) {
            Log.w(TAG, "call not permitted", e)
            "Not allowed to call. Dial ${C.EMERGENCY_NUMBER} yourself"
        }
    }

    private fun reset() {
        phase = Phase.IDLE
        emergencyId = null
        handled = false
        note = ""
        voice.stop()
        host.changed()
    }

    private companion object { const val TAG = "CHER/112" }
}
