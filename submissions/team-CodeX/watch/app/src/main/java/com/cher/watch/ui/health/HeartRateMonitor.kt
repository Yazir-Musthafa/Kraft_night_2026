package com.cher.watch.ui.health

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.core.content.ContextCompat
import androidx.health.services.client.HealthServices
import androidx.health.services.client.MeasureCallback
import androidx.health.services.client.data.Availability
import androidx.health.services.client.data.DataPointContainer
import androidx.health.services.client.data.DataType
import androidx.health.services.client.data.DataTypeAvailability
import androidx.health.services.client.data.DeltaDataType
import androidx.health.services.client.data.HeartRateAccuracy
import com.cher.watch.ui.models.HeartAccuracy
import com.cher.watch.ui.models.HeartAnalysis
import com.cher.watch.ui.models.HeartSample
import com.cher.watch.ui.models.HeartSource
import com.cher.watch.utils.CherConfig as C
import com.cher.watch.utils.PermissionHelper

/**
 * Continuous heart-rate source. Picks, in order:
 *  1. Wear OS Health Services MeasureClient (capability-checked)
 *  2. the platform TYPE_HEART_RATE sensor
 *  3. nothing: the UI then reports "unavailable"; it never invents readings.
 * Demo mode can inject samples via [injectDemo].
 *
 * Power: [setDutyCycle] lets SAFE mode measure in bursts instead of continuously.
 */
class HeartRateMonitor(context: Context, private val listener: Listener) {
    interface Listener {
        fun onHeartSample(sample: HeartSample, analysis: HeartAnalysis)
        fun onHeartStatus(source: HeartSource, note: String)
    }

    private val appContext = context.applicationContext
    private val main = Handler(Looper.getMainLooper())
    private val history = ArrayDeque<HeartSample>()

    var source: HeartSource = HeartSource.NONE
        private set
    var statusNote: String = "Not started"
        private set
    var analysis: HeartAnalysis = HeartAnalysis.UNAVAILABLE
        private set
    var lastSample: HeartSample? = null
        private set

    private var running = false
    private var demoActive = false
    private var dutyOnMs = 0L
    private var dutyOffMs = 0L
    private var measuring = false

    private var sensorManager: SensorManager? = null
    private var hrSensor: Sensor? = null
    private var healthCallbackRegistered = false
    private var healthSupported: Boolean? = null

    private val healthCallback = object : MeasureCallback {
        override fun onAvailabilityChanged(dataType: DeltaDataType<*, *>, availability: Availability) {
            val note = when (availability) {
                DataTypeAvailability.AVAILABLE -> "Measuring"
                DataTypeAvailability.ACQUIRING -> "Acquiring signal"
                DataTypeAvailability.UNAVAILABLE_DEVICE_OFF_BODY -> "Watch not worn"
                else -> "Sensor unavailable"
            }
            main.post { setStatus(HeartSource.HEALTH_SERVICES, note) }
        }

        override fun onDataReceived(data: DataPointContainer) {
            val now = System.currentTimeMillis()
            for (dp in data.getData(DataType.HEART_RATE_BPM)) {
                val acc = when ((dp.accuracy as? HeartRateAccuracy)?.sensorStatus) {
                    HeartRateAccuracy.SensorStatus.ACCURACY_HIGH -> HeartAccuracy.HIGH
                    HeartRateAccuracy.SensorStatus.ACCURACY_MEDIUM -> HeartAccuracy.MEDIUM
                    HeartRateAccuracy.SensorStatus.ACCURACY_LOW -> HeartAccuracy.LOW
                    HeartRateAccuracy.SensorStatus.NO_CONTACT -> HeartAccuracy.NO_CONTACT
                    HeartRateAccuracy.SensorStatus.UNRELIABLE -> HeartAccuracy.UNRELIABLE
                    else -> HeartAccuracy.UNKNOWN
                }
                main.post { accept(HeartSample(dp.value, acc, now, HeartSource.HEALTH_SERVICES)) }
            }
        }
    }

    private val sensorListener = object : SensorEventListener {
        override fun onSensorChanged(event: SensorEvent) {
            val bpm = event.values.firstOrNull()?.toDouble() ?: return
            if (bpm <= 0.0) return // 0 = no reading
            val acc = when (event.accuracy) {
                SensorManager.SENSOR_STATUS_ACCURACY_HIGH -> HeartAccuracy.HIGH
                SensorManager.SENSOR_STATUS_ACCURACY_MEDIUM -> HeartAccuracy.MEDIUM
                SensorManager.SENSOR_STATUS_ACCURACY_LOW -> HeartAccuracy.LOW
                SensorManager.SENSOR_STATUS_UNRELIABLE -> HeartAccuracy.UNRELIABLE
                SensorManager.SENSOR_STATUS_NO_CONTACT -> HeartAccuracy.NO_CONTACT
                else -> HeartAccuracy.UNKNOWN
            }
            accept(HeartSample(bpm, acc, System.currentTimeMillis(), HeartSource.SENSOR_MANAGER))
        }

        override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}
    }

    private val dutyOn: Runnable = Runnable { startMeasuring(); if (dutyOffMs > 0) main.postDelayed(dutyOff, dutyOnMs) }
    private val dutyOff: Runnable = Runnable { stopMeasuring(); main.postDelayed(dutyOn, dutyOffMs) }

    // ---------------------------------------------------------------- lifecycle
    fun start() {
        if (running) return
        running = true
        if (!PermissionHelper.hasHeartRate(appContext) && !demoActive) {
            setStatus(HeartSource.NONE, "Permission denied")
            return
        }
        applyDuty()
    }

    fun stop() {
        running = false
        main.removeCallbacks(dutyOn)
        main.removeCallbacks(dutyOff)
        stopMeasuring()
    }

    /** on/off in ms. (0, 0) = continuous measuring. */
    fun setDutyCycle(onMs: Long, offMs: Long) {
        dutyOnMs = onMs
        dutyOffMs = offMs
        if (running) applyDuty()
    }

    private fun applyDuty() {
        main.removeCallbacks(dutyOn)
        main.removeCallbacks(dutyOff)
        stopMeasuring()
        if (dutyOffMs > 0) main.post(dutyOn) else startMeasuring()
    }

    fun permissionChanged() {
        if (running) applyDuty()
    }

    private fun startMeasuring() {
        if (measuring || demoActive) return
        if (!PermissionHelper.hasHeartRate(appContext)) {
            setStatus(HeartSource.NONE, "Permission denied")
            return
        }
        measuring = true
        checkHealthServices { supported ->
            if (!measuring) return@checkHealthServices
            if (supported) registerHealthServices() else registerSensorFallback()
        }
    }

    private fun stopMeasuring() {
        measuring = false
        if (healthCallbackRegistered) {
            try {
                HealthServices.getClient(appContext).measureClient.unregisterMeasureCallbackAsync(DataType.HEART_RATE_BPM, healthCallback)
            } catch (e: Exception) {
                Log.w(TAG, "unregister failed", e)
            }
            healthCallbackRegistered = false
        }
        sensorManager?.unregisterListener(sensorListener)
    }

    // ---------------------------------------------------------------- Health Services
    private fun checkHealthServices(done: (Boolean) -> Unit) {
        healthSupported?.let { done(it); return }
        try {
            val future = HealthServices.getClient(appContext).measureClient.getCapabilitiesAsync()
            future.addListener({
                val ok = try {
                    DataType.HEART_RATE_BPM in future.get().supportedDataTypesMeasure
                } catch (e: Exception) {
                    Log.w(TAG, "capabilities failed", e); false
                }
                healthSupported = ok
                done(ok)
            }, ContextCompat.getMainExecutor(appContext))
        } catch (e: Exception) {
            Log.w(TAG, "Health Services unavailable", e)
            healthSupported = false
            done(false)
        }
    }

    private fun registerHealthServices() {
        try {
            HealthServices.getClient(appContext).measureClient.registerMeasureCallback(DataType.HEART_RATE_BPM, healthCallback)
            healthCallbackRegistered = true
            setStatus(HeartSource.HEALTH_SERVICES, "Starting")
        } catch (e: Exception) {
            Log.w(TAG, "register failed, trying sensor", e)
            registerSensorFallback()
        }
    }

    // ---------------------------------------------------------------- Sensor fallback
    private fun registerSensorFallback() {
        val sm = appContext.getSystemService(Context.SENSOR_SERVICE) as SensorManager
        sensorManager = sm
        hrSensor = sm.getDefaultSensor(Sensor.TYPE_HEART_RATE)
        val s = hrSensor
        if (s == null) {
            setStatus(HeartSource.NONE, "No heart-rate sensor")
            return
        }
        try {
            sm.registerListener(sensorListener, s, SensorManager.SENSOR_DELAY_NORMAL)
            setStatus(HeartSource.SENSOR_MANAGER, "Measuring")
        } catch (e: SecurityException) {
            setStatus(HeartSource.NONE, "Permission denied")
        }
    }

    // ---------------------------------------------------------------- data
    private fun accept(sample: HeartSample) {
        if (demoActive && sample.source != HeartSource.DEMO) return
        lastSample = sample
        history.addLast(sample)
        while (history.size > C.HR_HISTORY_MAX) history.removeFirst()
        analysis = HeartRateAnalyzer.analyze(history.toList(), sample.timestamp)
        if (source != sample.source) setStatus(sample.source, statusNote)
        listener.onHeartSample(sample, analysis)
    }

    /** Re-evaluate staleness with no new sample (e.g. watch taken off). */
    fun refreshAnalysis(nowMs: Long): HeartAnalysis {
        analysis = HeartRateAnalyzer.analyze(history.toList(), nowMs)
        return analysis
    }

    private fun setStatus(s: HeartSource, note: String) {
        source = s
        statusNote = note
        listener.onHeartStatus(s, note)
    }

    // ---------------------------------------------------------------- demo
    fun setDemo(active: Boolean) {
        if (demoActive == active) return
        demoActive = active
        history.clear()
        analysis = HeartAnalysis.UNAVAILABLE
        lastSample = null
        if (active) {
            stopMeasuring()
            setStatus(HeartSource.DEMO, "Simulated")
        } else if (running) {
            applyDuty()
        }
    }

    fun injectDemo(bpm: Double, timestamp: Long = System.currentTimeMillis()) {
        if (!demoActive) return
        accept(HeartSample(bpm, HeartAccuracy.HIGH, timestamp, HeartSource.DEMO))
    }

    private companion object {
        const val TAG = "CHER/HeartRate"
    }
}
