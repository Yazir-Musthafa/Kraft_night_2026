package com.cher.watch.ui.sensors

import com.cher.watch.ui.models.MotionEvent
import com.cher.watch.ui.models.MotionEventType
import com.cher.watch.utils.CherConfig as C
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.sqrt

/**
 * Pure motion analysis over accelerometer/gyroscope samples (no Android dependencies, so it is unit-testable).
 *
 * - free-fall followed by an impact  => FALL_LIKE (+ IMPACT), reported immediately
 * - impact-like spike alone          => reported only if it is very hard, or if the wearer goes still afterwards
 *                                       (claps, door bumps and normal wrist knocks are filtered out)
 * - stillness after a reported impact => POST_IMPACT_INACTIVITY
 * - violent rotation                 => UNUSUAL_MOTION
 * - very long stillness while worn   => LONG_INACTIVITY (needs an off-body sensor to know the watch is worn)
 *
 * It only reports observations. It never concludes that anyone is injured or ill.
 */
class MotionAnalyzer(private val onEvent: (MotionEvent) -> Unit) {
    private var freeFallSinceMs = -1L
    private var lastFreeFallMs = -1L

    private var candidateAt = -1L
    private var candidatePeak = 0.0
    private var candidateEnergySum = 0.0
    private var candidateSamples = 0

    private var lastMotionMs = 0L

    private var lastReportedImpactMs = -1L
    private var lastReportedPeak = 0.0
    private var postImpactInactivityReported = false

    private var gyroHighSinceMs = -1L
    private var lastUnusualMs = -1L

    private var onBody: Boolean? = null // null = unknown (no off-body sensor)
    private var lastLongInactivityMs = -1L

    /** Highest g-force seen in the last few seconds (for telemetry). */
    @Volatile var recentPeakG: Double = 1.0
        private set
    private var recentPeakAt = 0L

    fun onAccelerometer(tMs: Long, x: Float, y: Float, z: Float) {
        val g = sqrt((x * x + y * y + z * z).toDouble()) / C.GRAVITY
        val dev = abs(g - 1.0)

        if (tMs - recentPeakAt > 5_000) recentPeakG = 1.0
        if (g > recentPeakG) {
            recentPeakG = g
            recentPeakAt = tMs
        }

        if (dev > C.MOVING_G || lastMotionMs == 0L) lastMotionMs = tMs

        // Free-fall detection
        if (g < C.FREE_FALL_G) {
            if (freeFallSinceMs < 0) freeFallSinceMs = tMs
            if (tMs - freeFallSinceMs >= C.FREE_FALL_MIN_MS) lastFreeFallMs = tMs
        } else {
            freeFallSinceMs = -1L
        }

        // Impact detection
        if (g >= C.IMPACT_G && candidateAt < 0 && (lastReportedImpactMs < 0 || tMs - lastReportedImpactMs > 3_000)) {
            val afterFall = lastFreeFallMs >= 0 && tMs - lastFreeFallMs <= C.FREE_FALL_TO_IMPACT_MS
            if (afterFall) {
                report(MotionEventType.IMPACT, g, tMs)
                report(MotionEventType.FALL_LIKE, g, tMs)
                lastReportedImpactMs = tMs
                lastReportedPeak = g
                postImpactInactivityReported = false
                lastFreeFallMs = -1L
            } else {
                candidateAt = tMs
                candidatePeak = g
                candidateEnergySum = 0.0
                candidateSamples = 0
            }
        } else if (candidateAt >= 0) {
            candidatePeak = max(candidatePeak, g)
            if (tMs - candidateAt >= C.IMPACT_SKIP_MS) {
                candidateEnergySum += dev
                candidateSamples++
            }
        }
    }

    fun onGyroscope(tMs: Long, x: Float, y: Float, z: Float) {
        val w = sqrt((x * x + y * y + z * z).toDouble())
        if (w >= C.GYRO_UNUSUAL_RAD_S) {
            if (gyroHighSinceMs < 0) gyroHighSinceMs = tMs
            if (tMs - gyroHighSinceMs >= C.GYRO_UNUSUAL_MIN_MS && (lastUnusualMs < 0 || tMs - lastUnusualMs > C.UNUSUAL_MOTION_COOLDOWN_MS)) {
                lastUnusualMs = tMs
                report(MotionEventType.UNUSUAL_MOTION, recentPeakG, tMs)
            }
        } else {
            gyroHighSinceMs = -1L
        }
    }

    fun onOffBody(tMs: Long, offBody: Boolean) {
        onBody = !offBody
        if (offBody) lastMotionMs = tMs // watch removed: restart the stillness clock
    }

    /** Call about once per second. Drives the timer-based decisions. */
    fun tick(nowMs: Long) {
        // Resolve an impact-only candidate once the observation window has passed.
        if (candidateAt >= 0 && nowMs - candidateAt >= C.IMPACT_OBSERVE_MS) {
            val energy = if (candidateSamples > 0) candidateEnergySum / candidateSamples else 0.0
            val still = energy < C.STILL_ENERGY_G
            if (still || candidatePeak >= C.HARD_IMPACT_G) {
                report(MotionEventType.IMPACT, candidatePeak, nowMs)
                lastReportedImpactMs = candidateAt
                lastReportedPeak = candidatePeak
                postImpactInactivityReported = false
            }
            candidateAt = -1L
        }

        // Stillness after a reported impact.
        if (lastReportedImpactMs >= 0 && !postImpactInactivityReported && nowMs - lastReportedImpactMs <= C.POST_IMPACT_WINDOW_MS) {
            if (inactivitySeconds(nowMs) >= C.POST_IMPACT_STILL_SECONDS) {
                postImpactInactivityReported = true
                report(MotionEventType.POST_IMPACT_INACTIVITY, lastReportedPeak, nowMs)
            }
        }

        // Very long stillness, only while the watch is known to be on the wrist.
        if (onBody == true && nowMs - lastMotionMs >= C.LONG_INACTIVITY_MS &&
            (lastLongInactivityMs < 0 || nowMs - lastLongInactivityMs >= C.LONG_INACTIVITY_MS)
        ) {
            lastLongInactivityMs = nowMs
            report(MotionEventType.LONG_INACTIVITY, recentPeakG, nowMs)
        }
    }

    /** Seconds since the last movement above the "moving" threshold. */
    /** No notable movement for [quietSeconds]. Before any movement was ever seen the watch has simply been still. */
    fun isResting(nowMs: Long, quietSeconds: Int): Boolean = lastMotionMs == 0L || inactivitySeconds(nowMs) >= quietSeconds

    fun inactivitySeconds(nowMs: Long): Int = if (lastMotionMs == 0L) 0 else ((nowMs - lastMotionMs) / 1000).toInt().coerceAtLeast(0)

    fun reset() {
        candidateAt = -1L
        lastReportedImpactMs = -1L
        postImpactInactivityReported = false
        lastFreeFallMs = -1L
        freeFallSinceMs = -1L
    }

    private fun report(type: MotionEventType, peak: Double, t: Long) {
        onEvent(MotionEvent(type, peak, inactivitySeconds(t), t))
    }
}
