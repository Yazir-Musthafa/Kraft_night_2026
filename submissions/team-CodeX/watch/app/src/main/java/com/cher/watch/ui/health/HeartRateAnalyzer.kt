package com.cher.watch.ui.health

import com.cher.watch.ui.models.HeartAccuracy
import com.cher.watch.ui.models.HeartAnalysis
import com.cher.watch.ui.models.HeartFlags
import com.cher.watch.ui.models.HeartLevel
import com.cher.watch.ui.models.HeartSample
import com.cher.watch.utils.CherConfig as C
import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * Pure heart-rate analysis: personal rolling baseline, deviation, sudden rise/drop, sustained abnormal
 * pattern and signal-quality handling. Reports neutral observations only, never a diagnosis.
 * Mirrors server/src/sensors.js analyzeHeartRate().
 */
object HeartRateAnalyzer {
    fun median(values: List<Double>): Double? {
        if (values.isEmpty()) return null
        val s = values.sorted()
        val m = s.size / 2
        return if (s.size % 2 == 1) s[m] else (s[m - 1] + s[m]) / 2.0
    }

    fun validSamples(samples: List<HeartSample>): List<HeartSample> = samples.filter {
        val bpm = it.bpm
        bpm != null && bpm >= C.HR_MIN_VALID_BPM && bpm <= C.HR_MAX_VALID_BPM &&
            it.accuracy != HeartAccuracy.UNRELIABLE && it.accuracy != HeartAccuracy.NO_CONTACT
    }

    fun analyze(samples: List<HeartSample>, nowMs: Long): HeartAnalysis {
        val valid = validSamples(samples)
        val quality = if (samples.isEmpty()) 0.0 else valid.size.toDouble() / samples.size
        if (valid.isEmpty()) return HeartAnalysis.UNAVAILABLE.copy(signalQuality = quality)

        val last = valid.last()
        if (nowMs - last.timestamp > C.HR_STALE_MS) {
            return HeartAnalysis.UNAVAILABLE.copy(trend = "STALE", signalQuality = quality, sampleCount = valid.size)
        }

        val recent = valid.takeLast(C.HR_RECENT_WINDOW)
        val window = valid.takeLast(C.HR_BASELINE_WINDOW)
        val older = window.dropLast(minOf(C.HR_RECENT_WINDOW, window.size)) // baseline excludes the most recent samples
        val recentMedian = median(recent.map { it.bpm!! })!!
        var baseline: Int? = null
        var deviation: Double? = null
        if (older.size >= C.HR_BASELINE_MIN_SAMPLES) {
            baseline = median(older.map { it.bpm!! })!!.roundToInt()
            deviation = (recentMedian - baseline) / baseline
        }

        // A relative rise only counts once it is also a fast rate (>= HR_RESTING_HIGH): 97 bpm is +35% for someone at 72 but is a
        // normal resting rate, and that band belongs to the gentle "elevated" suggestion, not to the emergency path.
        fun outside(bpm: Double): Boolean =
            bpm >= C.HR_HIGH_ABSOLUTE || bpm <= C.HR_LOW_ABSOLUTE ||
                (baseline != null && abs(bpm - baseline) / baseline >= C.HR_DEVIATION_PCT && (bpm < baseline || bpm >= C.HR_RESTING_HIGH))

        val tail = valid.takeLast(C.HR_PERSISTENCE_SAMPLES)
        val sustained = tail.size >= C.HR_PERSISTENCE_SAMPLES && tail.all { outside(it.bpm!!) }
        val high = recentMedian >= C.HR_HIGH_ABSOLUTE || (deviation != null && deviation >= C.HR_DEVIATION_PCT && recentMedian >= C.HR_RESTING_HIGH)
        val low = recentMedian <= C.HR_LOW_ABSOLUTE || (deviation != null && deviation <= -C.HR_DEVIATION_PCT)

        val win = valid.takeLast(C.HR_SUDDEN_WINDOW_SAMPLES)
        var rise = false
        var drop = false
        if (win.size >= 2) {
            val delta = win.last().bpm!! - win.first().bpm!!
            rise = delta >= C.HR_SUDDEN_DELTA_BPM
            drop = delta <= -C.HR_SUDDEN_DELTA_BPM
        }

        val trend = when {
            sustained && low -> "SUSTAINED_LOW"
            sustained && high -> "SUSTAINED_HIGH"
            sustained -> "SUSTAINED_DEVIATION"
            rise -> "SUDDEN_RISE"
            drop -> "SUDDEN_DROP"
            deviation != null && deviation > 0.10 -> "RISING"
            deviation != null && deviation < -0.10 -> "FALLING"
            else -> "STABLE"
        }
        val level = when {
            recentMedian >= C.HR_RESTING_HIGH -> HeartLevel.HIGH
            recentMedian >= C.HR_ELEVATED_ABS && (baseline == null || recentMedian >= baseline * (1 + C.HR_ELEVATED_REL)) -> HeartLevel.ELEVATED
            else -> HeartLevel.NORMAL
        }
        return HeartAnalysis(
            available = true,
            current = last.bpm!!.roundToInt(),
            baseline = baseline,
            deviationPct = deviation?.let { (it * 1000).roundToInt() / 1000.0 },
            trend = trend,
            flags = HeartFlags(high, low, rise, drop, sustained),
            signalQuality = (quality * 100).roundToInt() / 100.0,
            sampleCount = valid.size,
            level = level,
        )
    }
}
