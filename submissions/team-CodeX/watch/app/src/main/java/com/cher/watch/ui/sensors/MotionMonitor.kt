package com.cher.watch.ui.sensors

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Handler
import android.os.Looper
import com.cher.watch.ui.models.MotionEvent
import com.cher.watch.ui.models.PowerMode

/**
 * Registers accelerometer / gyroscope / off-body sensors that actually exist and feeds [MotionAnalyzer].
 * Capability flags let the UI say honestly what is (not) being monitored.
 */
class MotionMonitor(context: Context, private val onEvent: (MotionEvent) -> Unit) : SensorEventListener {
    private val sm = context.applicationContext.getSystemService(Context.SENSOR_SERVICE) as SensorManager
    private val main = Handler(Looper.getMainLooper())
    val analyzer = MotionAnalyzer(onEvent)

    private val accel: Sensor? = sm.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
    private val gyro: Sensor? = sm.getDefaultSensor(Sensor.TYPE_GYROSCOPE)
    private val offBody: Sensor? = sm.getDefaultSensor(Sensor.TYPE_LOW_LATENCY_OFFBODY_DETECT)

    val hasAccelerometer get() = accel != null
    val hasGyroscope get() = gyro != null
    val hasOffBody get() = offBody != null

    private var running = false
    private var mode = PowerMode.NORMAL

    private val ticker = object : Runnable {
        override fun run() {
            analyzer.tick(System.currentTimeMillis())
            if (running) main.postDelayed(this, 1000)
        }
    }

    fun start(mode: PowerMode) {
        this.mode = mode
        if (running) sm.unregisterListener(this)
        running = true
        register()
        main.removeCallbacks(ticker)
        main.postDelayed(ticker, 1000)
    }

    fun stop() {
        running = false
        sm.unregisterListener(this)
        main.removeCallbacks(ticker)
    }

    /** NORMAL: 50 Hz accel + gyro. SAFE: 10 Hz accel, no gyro (impact detection is coarser). EMERGENCY: 5 Hz accel only. */
    private fun register() {
        val (accelUs, useGyro) = when (mode) {
            PowerMode.NORMAL -> 20_000 to true
            PowerMode.SAFE -> 100_000 to false
            PowerMode.EMERGENCY -> 200_000 to false
        }
        accel?.let { sm.registerListener(this, it, accelUs, 500_000) }
        if (useGyro) gyro?.let { sm.registerListener(this, it, 40_000, 500_000) }
        offBody?.let { sm.registerListener(this, it, SensorManager.SENSOR_DELAY_NORMAL) }
    }

    override fun onSensorChanged(e: SensorEvent) {
        val t = System.currentTimeMillis()
        when (e.sensor.type) {
            Sensor.TYPE_ACCELEROMETER -> analyzer.onAccelerometer(t, e.values[0], e.values[1], e.values[2])
            Sensor.TYPE_GYROSCOPE -> analyzer.onGyroscope(t, e.values[0], e.values[1], e.values[2])
            Sensor.TYPE_LOW_LATENCY_OFFBODY_DETECT -> analyzer.onOffBody(t, e.values[0] == 0f)
        }
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}

    /** Human-readable capability line for the settings screen. */
    fun capabilitySummary(): String = buildString {
        append("Accel ").append(if (hasAccelerometer) "yes" else "NO")
        append(" | Gyro ").append(if (hasGyroscope) "yes" else "NO")
        append(" | Worn ").append(if (hasOffBody) "yes" else "NO")
    }
}
