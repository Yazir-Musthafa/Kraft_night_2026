package com.cher.watch.ui.emergency

import com.cher.watch.ui.models.HeartAnalysis
import com.cher.watch.ui.models.MotionEvent
import com.cher.watch.ui.models.MotionEventType
import com.cher.watch.ui.models.MonitoringState
import com.cher.watch.ui.models.SignalType
import com.cher.watch.ui.models.TriggerType
import com.cher.watch.utils.CherConfig as C

/**
 * Combines independent signals (heart rate, impact, motion, inactivity, user response) into a decision.
 * No single sensor reading can create an automatic SOS: a check-in ("Are you OK?") is always the first step,
 * and escalation needs corroboration plus a failed/absent user response. Mirrors server sensors.js assessSignals().
 */
class SignalFusion {
    data class Assessment(val state: MonitoringState, val confidence: Double, val signals: Set<SignalType>, val corroborated: Boolean)

    private val lastSeen = mutableMapOf<SignalType, Long>()
    private var hrAbnormalSince = -1L
    private var restingHighSince = -1L
    var peakG: Double = 0.0
        private set
    var inactivitySeconds: Int = 0
        private set
    var lastMotionEvent: String? = null
        private set

    /** @param resting the wearer has been still for a while: only then does a fast heart rate (110+) take the shorter check-in path */
    fun onHeart(a: HeartAnalysis, nowMs: Long, resting: Boolean = false) {
        if (a.level == com.cher.watch.ui.models.HeartLevel.HIGH && resting) { if (restingHighSince < 0) restingHighSince = nowMs } else restingHighSince = -1L
        if (a.abnormal) {
            lastSeen[SignalType.HEART_RATE_ABNORMAL] = nowMs
            if (hrAbnormalSince < 0) hrAbnormalSince = nowMs
        } else {
            hrAbnormalSince = -1L
            lastSeen.remove(SignalType.HEART_RATE_ABNORMAL)
        }
    }

    fun onMotion(e: MotionEvent) {
        peakG = maxOf(peakG, e.peakG)
        inactivitySeconds = maxOf(inactivitySeconds, e.inactivitySeconds)
        lastMotionEvent = e.type.name
        when (e.type) {
            MotionEventType.IMPACT -> lastSeen[SignalType.IMPACT] = e.timestamp
            MotionEventType.FALL_LIKE -> lastSeen[SignalType.FALL_LIKE_MOTION] = e.timestamp
            MotionEventType.POST_IMPACT_INACTIVITY -> {
                lastSeen[SignalType.INACTIVITY] = e.timestamp
                inactivitySeconds = maxOf(inactivitySeconds, C.POST_IMPACT_STILL_SECONDS)
            }
            MotionEventType.LONG_INACTIVITY -> {
                lastSeen[SignalType.INACTIVITY] = e.timestamp
                inactivitySeconds = maxOf(inactivitySeconds, C.SERVER_INACTIVITY_SECONDS)
            }
            MotionEventType.UNUSUAL_MOTION -> lastSeen[SignalType.UNUSUAL_MOTION] = e.timestamp
        }
    }

    fun active(nowMs: Long): Set<SignalType> {
        lastSeen.entries.removeAll { nowMs - it.value > C.SIGNAL_TTL_MS }
        return lastSeen.keys.toSet()
    }

    fun clear() {
        lastSeen.clear()
        hrAbnormalSince = -1L
        restingHighSince = -1L
        peakG = 0.0
        inactivitySeconds = 0
        lastMotionEvent = null
    }

    fun hrAbnormalForMs(nowMs: Long): Long = if (hrAbnormalSince < 0) 0 else nowMs - hrAbnormalSince

    /** Weighted confidence from a signal set (weights identical to the server). */
    fun assess(signals: Set<SignalType>): Assessment {
        val weights = mapOf(
            SignalType.HEART_RATE_ABNORMAL to 0.35, SignalType.IMPACT to 0.4, SignalType.FALL_LIKE_MOTION to 0.1,
            SignalType.UNUSUAL_MOTION to 0.15, SignalType.INACTIVITY to 0.25, SignalType.NO_USER_RESPONSE to 0.5,
        )
        val confidence = if (SignalType.USER_REQUESTED_HELP in signals) 1.0 else minOf(1.0, signals.sumOf { weights[it] ?: 0.0 })
        var state = MonitoringState.NORMAL
        if (signals.isNotEmpty()) state = MonitoringState.POSSIBLE_ANOMALY
        if (SignalType.IMPACT in signals || confidence >= 0.5) state = MonitoringState.VERIFYING
        if (SignalType.NO_USER_RESPONSE in signals && signals.size >= 2 && confidence >= C.AUTO_ESCALATE_CONFIDENCE) state = MonitoringState.ESCALATING
        if (SignalType.USER_REQUESTED_HELP in signals) state = MonitoringState.ACTIVE_EMERGENCY
        return Assessment(state, confidence, signals, signals.size >= 2)
    }

    /**
     * Should the watch ask "Are you OK?" now? This never sends an SOS by itself.
     * A fall-like motion, an impact followed by stillness or another signal, corroborating signals, or a
     * heart-rate pattern that persists for a long time all justify a check-in.
     */
    fun shouldCheckIn(nowMs: Long, demo: Boolean = false): Boolean {
        val s = active(nowMs)
        if (s.isEmpty()) return false
        if (SignalType.FALL_LIKE_MOTION in s) return true
        if (SignalType.IMPACT in s && (s.size >= 2 || peakG >= C.HARD_IMPACT_G)) return true
        if (s.size >= 2) return true
        // Fast while resting is asked about after 30 s; a very high rate (150+) or a big drop keeps the long 2 min persistence.
        val persist = when {
            restingHighSince >= 0 -> if (demo) C.DEMO_HR_CHECKIN_PERSIST_MS else C.HR_HIGH_REST_CHECKIN_MS
            demo -> C.DEMO_HR_CHECKIN_PERSIST_MS
            else -> C.HR_CHECKIN_PERSIST_MS
        }
        if (SignalType.HEART_RATE_ABNORMAL in s && hrAbnormalForMs(nowMs) >= persist) return true
        return false
    }

    /** After a check-in got no answer: is there enough corroboration to escalate to an SOS? */
    fun assessAfterNoResponse(nowMs: Long): Assessment = assess(active(nowMs) + SignalType.NO_USER_RESPONSE)

    fun triggerFor(signals: Set<SignalType>): TriggerType = when {
        SignalType.USER_REQUESTED_HELP in signals -> TriggerType.USER_NEEDS_HELP
        signals.count { it != SignalType.NO_USER_RESPONSE } >= 3 -> TriggerType.AUTO_MULTI_SIGNAL
        SignalType.IMPACT in signals || SignalType.FALL_LIKE_MOTION in signals -> TriggerType.AUTO_FALL_NO_RESPONSE
        SignalType.HEART_RATE_ABNORMAL in signals && signals.size >= 3 -> TriggerType.AUTO_MULTI_SIGNAL
        SignalType.HEART_RATE_ABNORMAL in signals -> TriggerType.AUTO_HEART_RATE_ANOMALY
        SignalType.INACTIVITY in signals -> TriggerType.AUTO_INACTIVITY
        else -> TriggerType.AUTO_MULTI_SIGNAL
    }
}
