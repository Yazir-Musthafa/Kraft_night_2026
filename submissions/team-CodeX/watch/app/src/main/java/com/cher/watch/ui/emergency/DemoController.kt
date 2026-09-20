package com.cher.watch.ui.emergency

import android.os.Handler
import android.os.Looper
import com.cher.watch.ui.health.HeartRateMonitor
import com.cher.watch.ui.models.LocationFix
import com.cher.watch.ui.models.MotionEvent
import com.cher.watch.ui.models.MotionEventType
import kotlin.math.sin

/**
 * Demo mode: an emulator has no heart-rate sensor and no real falls, so this feeds *simulated* signals into the
 * exact same pipeline the real sensors use (analyzer -> fusion -> check-in -> escalation -> backend).
 * Data injected here is labelled "Demo" in the UI and flagged demo:true to the backend.
 */
class DemoController(
    private val hr: HeartRateMonitor,
    private val injectMotion: (MotionEvent) -> Unit,
    private val injectLocation: (LocationFix) -> Unit,
    private val hasRealLocation: () -> Boolean,
    private val beforeSimulate: () -> Unit = {},
) {
    enum class Scenario(val label: String) { NORMAL("Normal HR"), ELEVATED("Elevated HR"), VERY_HIGH("Very high HR"), HIGH("High HR"), LOW("Low HR"), TREND("HR trend up") }

    private val main = Handler(Looper.getMainLooper())
    var scenario = Scenario.NORMAL
        private set
    private var running = false
    private var step = 0
    private var trendBpm = BASE

    private val tick = object : Runnable {
        override fun run() {
            if (!running) return
            step++
            val jitter = sin(step * 1.7) * 2.5
            val bpm = when (scenario) {
                Scenario.NORMAL -> BASE + jitter
                Scenario.ELEVATED -> ELEVATED_BPM + jitter          // a little over 90: the gentle AI suggestion
                Scenario.VERY_HIGH -> VERY_HIGH_BPM + jitter        // over 110 at rest: the normal Are-you-OK path
                Scenario.HIGH -> 158.0 + (step % 3) * 3
                Scenario.LOW -> 36.0 + (step % 3)
                Scenario.TREND -> { trendBpm = minOf(trendBpm + 4.0, 145.0); trendBpm }
            }
            hr.injectDemo(bpm)
            main.postDelayed(this, 2_000)
        }
    }

    fun start() {
        if (running) return
        running = true
        hr.setDemo(true)
        if (!hasRealLocation()) injectLocation(LocationFix(37.4220, -122.0840, 12f, System.currentTimeMillis(), "demo"))
        // Seed a believable baseline instantly so trends are meaningful straight away.
        for (i in 30 downTo 1) hr.injectDemo(BASE + sin(i * 1.7) * 2.5, System.currentTimeMillis() - i * 2_000L)
        main.post(tick)
    }

    fun stop() {
        running = false
        main.removeCallbacks(tick)
        hr.setDemo(false)
        scenario = Scenario.NORMAL
    }

    val isRunning get() = running

    fun setScenario(s: Scenario) {
        scenario = s
        if (s == Scenario.TREND) trendBpm = BASE
        // A rise takes the analyser ~12 s to notice from live samples; backfill the last 12 s as a quick ramp so a demo reacts at once.
        val target = when (s) { Scenario.ELEVATED -> ELEVATED_BPM; Scenario.VERY_HIGH -> VERY_HIGH_BPM; else -> return }
        val now = System.currentTimeMillis()
        for (i in 6 downTo 1) {
            val frac = (7 - i) / 6.0
            hr.injectDemo(BASE + (target - BASE) * minOf(1.0, frac + 0.3), now - i * 2_000L)
        }
    }

    /** Simulated fall: impact after free-fall, then stillness. The normal "Are you OK?" flow takes over. */
    fun simulateFall() {
        beforeSimulate()
        val now = System.currentTimeMillis()
        injectMotion(MotionEvent(MotionEventType.IMPACT, 4.2, 0, now))
        injectMotion(MotionEvent(MotionEventType.FALL_LIKE, 4.2, 0, now))
        main.postDelayed({ injectMotion(MotionEvent(MotionEventType.POST_IMPACT_INACTIVITY, 4.2, 15, System.currentTimeMillis())) }, 2_500)
    }

    fun simulateImpact() {
        beforeSimulate()
        injectMotion(MotionEvent(MotionEventType.IMPACT, 5.0, 0, System.currentTimeMillis()))
    }

    fun simulateInactivity() {
        beforeSimulate()
        injectMotion(MotionEvent(MotionEventType.POST_IMPACT_INACTIVITY, 1.0, 60, System.currentTimeMillis()))
    }

    private companion object {
        const val BASE = 72.0
        const val ELEVATED_BPM = 96.0
        const val VERY_HIGH_BPM = 118.0
    }
}
