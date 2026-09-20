package com.cher.watch.ui.sensors

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import com.cher.watch.utils.Geo
import kotlin.math.abs

/**
 * Compass heading (degrees clockwise from north) from the rotation-vector sensor, smoothed. Only runs while a
 * helper is being guided. If the watch has no such sensor [available] stays false and the UI falls back to a
 * north-up view instead of pretending to know which way the wearer faces.
 */
class HeadingProvider(context: Context, private val onChange: () -> Unit) : SensorEventListener {
    private val sm = context.applicationContext.getSystemService(Context.SENSOR_SERVICE) as SensorManager
    private val sensor: Sensor? = sm.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR)
    private val rotation = FloatArray(9)
    private val orientation = FloatArray(3)
    private var running = false
    private var lastDeliveredAt = 0L

    /** Smoothed heading, or null until the first reading arrives (or if there is no sensor). */
    @Volatile var heading: Double? = null
        private set

    val available: Boolean get() = sensor != null

    fun start() {
        if (running || sensor == null) return
        running = true
        sm.registerListener(this, sensor, SensorManager.SENSOR_DELAY_UI)
    }

    fun stop() {
        if (!running) return
        running = false
        sm.unregisterListener(this)
        heading = null
    }

    override fun onSensorChanged(event: SensorEvent) {
        SensorManager.getRotationMatrixFromVector(rotation, event.values)
        SensorManager.getOrientation(rotation, orientation)
        val azimuth = (Math.toDegrees(orientation[0].toDouble()) + 360.0) % 360.0
        val prev = heading
        val next = Geo.smoothHeading(prev, azimuth)
        heading = next
        val now = System.currentTimeMillis()
        // ~10 UI updates per second is plenty for a needle and spares the battery.
        if (prev == null || (now - lastDeliveredAt >= 100 && abs(Geo.angleDiff(next, prev)) > 0.5)) {
            lastDeliveredAt = now
            onChange()
        }
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}
}
