package com.cher.watch.ui.services

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.cher.watch.ui.ai.AiAdvisor
import com.cher.watch.ui.ai.VoiceGuide
import com.cher.watch.ui.emergency.Call112
import com.cher.watch.ui.emergency.DemoController
import com.cher.watch.ui.emergency.EmergencyController
import com.cher.watch.ui.emergency.SignalFusion
import com.cher.watch.ui.health.HeartRateMonitor
import com.cher.watch.ui.help.HelperController
import com.cher.watch.ui.location.LocationProvider
import com.cher.watch.ui.models.ConnectionState
import com.cher.watch.ui.models.EmergencyView
import com.cher.watch.ui.models.GeoPoint
import com.cher.watch.ui.models.HelpAssignment
import com.cher.watch.ui.models.HelpCheckIn
import com.cher.watch.ui.models.HelpRequest
import com.cher.watch.ui.models.HeartAnalysis
import com.cher.watch.ui.models.HeartSample
import com.cher.watch.ui.models.HeartSource
import com.cher.watch.ui.models.LocationFix
import com.cher.watch.ui.models.LocationStatus
import com.cher.watch.ui.models.MonitoringState
import com.cher.watch.ui.models.MotionEvent
import com.cher.watch.ui.models.PowerMode
import com.cher.watch.ui.sensors.HeadingProvider
import com.cher.watch.ui.sensors.MotionMonitor
import com.cher.watch.ui.socket.PendingStore
import com.cher.watch.ui.socket.SocketClient
import com.cher.watch.utils.CherConfig as C
import com.cher.watch.utils.Haptics
import com.cher.watch.utils.Ids
import com.cher.watch.utils.PermissionHelper
import com.cher.watch.utils.Prefs
import org.json.JSONObject
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Owns every long-lived component (sensors, location, socket, state machine). It lives as long as the process;
 * [MonitoringService] is what asks the OS to keep the process alive. The UI only reads [snapshot].
 */
class CherRuntime private constructor(context: Context) :
    HeartRateMonitor.Listener, SocketClient.Listener, EmergencyController.Host {

    val ctx: Context = context.applicationContext
    private val main = Handler(Looper.getMainLooper())
    val prefs = Prefs(ctx)
    val haptics = Haptics(ctx)
    val notifier = Notifier(ctx)
    private val pendingStore = PendingStore(ctx)
    private val fusion = SignalFusion()
    val power = PowerModeManager()
    val battery = BatteryMonitor(ctx) { onBatteryChanged() }
    val socket = SocketClient(pendingStore, this)
    val location = LocationProvider(ctx) { onFix(it) }
    val hr = HeartRateMonitor(ctx, this)
    val motion = MotionMonitor(ctx) { onMotion(it) }
    val controller = EmergencyController(ctx, socket, pendingStore, fusion, notifier, haptics, this)
    val voice = VoiceGuide(ctx)
    val ai = AiAdvisor(socket, prefs, voice, object : AiAdvisor.Host {
        override fun demoMode(): Boolean = prefs.demoMode
        override fun changed() = this@CherRuntime.changed()
    })
    val call112 = Call112(ctx, prefs, voice, haptics, object : Call112.Host {
        override fun demoMode(): Boolean = prefs.demoMode
        override fun changed() = this@CherRuntime.changed()
    })
    val heading = HeadingProvider(ctx) { changed() }
    val helper = HelperController(socket, notifier, haptics, object : HelperController.Host {
        override fun lastLocation(): LocationFix? = location.lastFix
        override fun ownEmergencyActive(): Boolean = controller.emergencyActive
        override fun onHelpingChanged(helping: Boolean) = this@CherRuntime.onHelpingChanged(helping)
        override fun changed() = this@CherRuntime.changed()
    })
    val demo = DemoController(hr, { onMotion(it) }, { onFix(it) }, { location.lastFix?.provider != null && location.lastFix?.provider != "demo" }, { controller.clearCooldown() })

    private val listeners = CopyOnWriteArrayList<() -> Unit>()
    private var started = false
    private var changedPosted = false
    private var lastHealthSentAt = 0L
    private var lastLocationSentAt = 0L
    private var lastFreshFixAt = 0L
    @Volatile private var backgroundGuaranteed = false
    private var lastStatusLine = ""

    private val ticker = object : Runnable {
        override fun run() {
            val now = System.currentTimeMillis()
            val analysis = hr.refreshAnalysis(now)
            controller.onHeart(analysis, now)
            controller.tick(now)
            helper.tick(now)
            keepPositionFresh(now)
            call112.onTick(now, controller.emergency)
            val own = location.lastFix
            val assign = helper.assignment
            val dist = if (own != null && assign?.location != null) com.cher.watch.utils.Geo.distanceM(own.latitude, own.longitude, assign.location.latitude, assign.location.longitude) else null
            ai.onTick(now, hr.analysis, resting(), controller.emergency, call112.phase == Call112.Phase.COUNTDOWN, assign, dist)
            pushStatusNotification()
            changed()
            main.postDelayed(this, 1_000)
        }
    }

    // ---------------------------------------------------------------- lifecycle
    fun start() {
        if (started) return
        started = true
        socket.helloExtras = { JSONObject().put("name", prefs.helperName).put("helper", prefs.nearbyAlerts) }
        battery.start()
        applyPower(force = true)
        connectSocket()
        if (prefs.demoMode) demo.start()
        hr.start()
        motion.start(power.mode)
        location.start(power.mode)
        main.postDelayed(ticker, 1_000)
        Log.i(TAG, "runtime started (power=${power.mode}, demo=${prefs.demoMode})")
    }

    fun stop() {
        if (!started) return
        started = false
        main.removeCallbacks(ticker)
        hr.stop(); motion.stop(); location.stop(); battery.stop(); demo.stop(); heading.stop(); socket.disconnect()
    }

    fun connectSocket() = socket.connect(prefs.serverUrl, prefs.watchId, prefs.apiKey)

    fun onPermissionsChanged() {
        hr.permissionChanged()
        location.permissionChanged()
        changed()
    }

    fun setBackgroundGuaranteed(v: Boolean) {
        backgroundGuaranteed = v
        changed()
    }

    /**
     * Others can only be asked to help if the server knows where this watch is. Regular updates only come when the
     * wearer moves, so a stationary wearer refreshes their position now and then (not in battery-saver mode).
     */
    private fun keepPositionFresh(now: Long, force: Boolean = false) {
        if (!prefs.nearbyAlerts || power.mode == PowerMode.SAFE) return
        if (!force && now - lastFreshFixAt < C.NEARBY_FIX_REFRESH_MS) return
        lastFreshFixAt = now
        location.requestFreshFix()
    }

    // ---------------------------------------------------------------- settings actions
    fun setDemoMode(on: Boolean) {
        prefs.demoMode = on
        if (on) demo.start() else demo.stop()
        hr.start()
        changed()
    }

    fun setForceSafe(on: Boolean) {
        prefs.forceSafeMode = on
        applyPower()
    }

    fun setAiMode(on: Boolean) { prefs.aiMode = on; if (!on) voice.stop(); changed() }
    fun setAiVoice(on: Boolean) { prefs.aiVoice = on; if (!on) voice.stop(); changed() }
    fun setAiHealth(on: Boolean) { prefs.aiHealth = on; changed() }
    fun setAiEmergency(on: Boolean) { prefs.aiEmergency = on; changed() }
    fun setCall112(on: Boolean) { prefs.call112 = on; changed() }

    fun setBroadcastNearby(on: Boolean) {
        prefs.broadcastNearby = on
        changed()
    }

    /** Dev/demo: run this watch as another person (e.g. a second emulator playing the nearby helper). */
    fun setWatchId(id: String) {
        prefs.watchId = id
        connectSocket()
        changed()
    }

    fun setHelperName(name: String) {
        prefs.helperName = name
        connectSocket()
        socket.request("helper:availability", JSONObject().put("available", prefs.nearbyAlerts).put("name", prefs.helperName)) { }
        changed()
    }

    /** Receive (or stop receiving) pop-ups when someone nearby needs help. The server hears about it immediately. */
    fun setNearbyAlerts(on: Boolean) {
        prefs.nearbyAlerts = on
        socket.request("helper:availability", JSONObject().put("available", on).put("name", prefs.helperName)) { }
        changed()
    }

    fun setServerUrl(url: String) {
        prefs.serverUrl = url
        connectSocket()
        changed()
    }

    // ---------------------------------------------------------------- power
    private fun applyPower(force: Boolean = false) {
        val changedMode = power.evaluate(battery.percent, battery.charging, controller.emergencyActive || helper.helping, prefs.forceSafeMode)
        if (!changedMode && !force) return
        val p = power.profile
        if (!prefs.demoMode) hr.setDutyCycle(p.hrOnMs, p.hrOffMs)
        if (started) {
            motion.start(power.mode)
            location.setMode(power.mode)
        }
        Log.i(TAG, "power mode -> ${power.mode}")
        changed()
    }

    private fun onBatteryChanged() {
        applyPower()
        changed()
    }

    // ---------------------------------------------------------------- HeartRateMonitor.Listener
    override fun onHeartSample(sample: HeartSample, analysis: HeartAnalysis) {
        controller.onHeart(analysis, sample.timestamp)
        val now = System.currentTimeMillis()
        if (now - lastHealthSentAt >= power.profile.healthSendIntervalMs) {
            lastHealthSentAt = now
            socket.sendTelemetry("health:update", healthJson(sample))
        }
        changed()
    }

    override fun onHeartStatus(source: HeartSource, note: String) = changed()

    private fun healthJson(s: HeartSample) = JSONObject().apply {
        put("eventId", Ids.newEventId())
        s.bpm?.let { put("bpm", it) } ?: put("bpm", JSONObject.NULL)
        put("accuracy", s.accuracy.name)
        put("timestamp", s.timestamp)
        put("source", s.source.name.lowercase())
        put("battery", battery.percent)
        put("monitoringState", controller.state.name)
        put("motion", JSONObject().put("peakG", motion.analyzer.recentPeakG).put("inactivitySeconds", motion.analyzer.inactivitySeconds(System.currentTimeMillis())))
    }

    // ---------------------------------------------------------------- motion / location
    private fun onMotion(e: MotionEvent) {
        controller.onMotion(e)
        changed()
    }

    private fun onFix(fix: LocationFix) {
        helper.onOwnFix(fix)
        val now = System.currentTimeMillis()
        if (now - lastLocationSentAt >= power.profile.locationSendIntervalMs || controller.emergencyActive && now - lastLocationSentAt >= 2_000) {
            lastLocationSentAt = now
            socket.sendTelemetry("location:update", fix.toJson().put("eventId", Ids.newEventId()))
        }
        changed()
    }

    // ---------------------------------------------------------------- SocketClient.Listener
    override fun onConnection(state: ConnectionState) = changed()

    override fun onHello(response: JSONObject) {
        controller.onHello(response)
        helper.onHello(response)
        keepPositionFresh(System.currentTimeMillis(), force = true)
        lastLocation()?.let { socket.sendTelemetry("location:update", it.toJson().put("eventId", Ids.newEventId())) }
    }

    override fun onServerEvent(event: String, payload: JSONObject) {
        if (event == "demo:command") {
            when (payload.optString("command")) {
                "SIMULATE_FALL" -> { if (!prefs.demoMode) setDemoMode(true); demo.simulateFall() }
                "RESET" -> controller.dismissClosed()
            }
            return
        }
        if (event.startsWith("help:")) helper.onServerEvent(event, payload) else controller.onServerEvent(event, payload)
    }

    /** Guidance needs frequent fixes and the compass; both stop when nobody is being helped any more. */
    private fun onHelpingChanged(helping: Boolean) {
        if (helping) {
            heading.start()
            location.requestFreshFix()
        } else heading.stop()
        applyPower(force = true)
    }

    override fun onAcked(event: String, response: JSONObject) = controller.onAcked(event, response)

    // ---------------------------------------------------------------- EmergencyController.Host
    override fun lastLocation(): LocationFix? = location.lastFix
    override fun heartAnalysis(): HeartAnalysis = hr.analysis
    override fun batteryPercent(): Int = battery.percent
    override fun demoMode(): Boolean = prefs.demoMode
    override fun resting(): Boolean = prefs.demoMode || (motion.hasAccelerometer && motion.analyzer.isResting(System.currentTimeMillis(), C.HR_RESTING_QUIET_S))
    override fun nearbyBroadcast(): Boolean = prefs.broadcastNearby
    override fun requestFreshLocation() = location.requestFreshFix()
    override fun onEmergencyActiveChanged(active: Boolean) = applyPower(force = true)
    override fun changed() {
        if (changedPosted) return
        changedPosted = true
        main.post {
            changedPosted = false
            for (l in listeners) l()
        }
    }

    // ---------------------------------------------------------------- UI
    fun addListener(l: () -> Unit) { listeners.add(l) }
    fun removeListener(l: () -> Unit) { listeners.remove(l) }

    data class UiState(
        val monitoringState: MonitoringState,
        val monitoringLabel: String,
        val degradedReasons: List<String>,
        val bpm: Int?,
        val hrNote: String,
        val hrSource: HeartSource,
        val hrTrend: String,
        val connection: ConnectionState,
        val pendingSync: Int,
        val location: LocationStatus,
        val battery: Int,
        val charging: Boolean,
        val powerMode: PowerMode,
        val demoMode: Boolean,
        val demoScenario: DemoController.Scenario,
        val checkInDeadline: Long,
        val escalationDeadline: Long,
        val emergency: EmergencyView?,
        val closed: EmergencyView?,
        val note: String?,
        val serverUrl: String,
        val motionCaps: String,
        val background: Boolean,
        val forceSafe: Boolean,
        // --- helping somebody else
        val nearbyAlerts: Boolean,
        val broadcastNearby: Boolean,
        val helpRequest: HelpRequest?,
        val helpAssignment: HelpAssignment?,
        val helpCheckIn: HelpCheckIn?,
        val helpNotice: String?,
        val helpNoticeFinal: Boolean,
        val helpError: String?,
        val helpBusy: Boolean,
        val ownPosition: GeoPoint?,
        val trail: List<GeoPoint>,
        val headingDeg: Double?,
        val compassAvailable: Boolean,
        val helperName: String,
        // --- AI guidance and the 112 fallback
        val aiMode: Boolean,
        val aiVoice: Boolean,
        val aiHealth: Boolean,
        val aiEmergency: Boolean,
        val call112Enabled: Boolean,
        val healthAdvice: AiAdvisor.Advice?,
        val emergencyAdvice: AiAdvisor.Advice?,
        val helperAdvice: AiAdvisor.Advice?,
        val heartLevel: com.cher.watch.ui.models.HeartLevel,
        val call112Phase: Call112.Phase,
        val call112Deadline: Long,
        val call112Total: Long,
        val call112Manual: Boolean,
        val call112Dry: Boolean,
        val call112Note: String,
    )

    fun snapshot(): UiState {
        val a = hr.analysis
        val loc = location.status()
        val reasons = degradedReasons(a, loc)
        val label = when {
            controller.state == MonitoringState.ACTIVE_EMERGENCY -> "EMERGENCY"
            reasons.isNotEmpty() -> "DEGRADED"
            else -> "ACTIVE"
        }
        return UiState(
            monitoringState = controller.state, monitoringLabel = label, degradedReasons = reasons,
            bpm = a.current, hrNote = hr.statusNote, hrSource = hr.source, hrTrend = a.trend,
            connection = socket.state, pendingSync = socket.pendingCount(), location = loc,
            battery = battery.percent, charging = battery.charging, powerMode = power.mode,
            demoMode = prefs.demoMode, demoScenario = demo.scenario,
            checkInDeadline = controller.checkInDeadline, escalationDeadline = controller.escalationDeadline,
            emergency = controller.emergency, closed = controller.closed, note = controller.lastNote,
            serverUrl = prefs.serverUrl, motionCaps = motion.capabilitySummary(), background = backgroundGuaranteed, forceSafe = prefs.forceSafeMode,
            nearbyAlerts = prefs.nearbyAlerts, broadcastNearby = prefs.broadcastNearby, helpRequest = helper.request, helpAssignment = helper.assignment, helpCheckIn = helper.checkIn,
            helpNotice = helper.notice, helpNoticeFinal = helper.noticeFinal, helpError = helper.error, helpBusy = helper.busy,
            ownPosition = location.lastFix?.let { GeoPoint(it.latitude, it.longitude, it.accuracy, it.timestamp) },
            trail = helper.trail.toList(), headingDeg = heading.heading, compassAvailable = heading.available, helperName = prefs.helperName,
            aiMode = prefs.aiMode, aiVoice = prefs.aiVoice, aiHealth = prefs.aiHealth, aiEmergency = prefs.aiEmergency, call112Enabled = prefs.call112,
            healthAdvice = ai.health, emergencyAdvice = ai.emergency, helperAdvice = ai.helper, heartLevel = a.level,
            call112Phase = call112.phase, call112Deadline = call112.deadline, call112Total = call112.totalMs, call112Manual = call112.reasonManual,
            call112Dry = call112.dryRun, call112Note = call112.note,
        )
    }

    /** Honest monitoring status: anything that is not really being monitored is listed here. */
    private fun degradedReasons(a: HeartAnalysis, loc: LocationStatus): List<String> = buildList {
        if (!prefs.demoMode) {
            when {
                !PermissionHelper.hasHeartRate(ctx) -> add("Heart rate: permission denied")
                hr.source == HeartSource.NONE -> add("Heart rate: ${hr.statusNote.lowercase()}")
                hr.statusNote == "Watch not worn" -> add("Watch not worn")
                !a.available && power.mode != PowerMode.SAFE && hr.lastSample != null -> add("Heart rate: no recent signal")
            }
        }
        if (!motion.hasAccelerometer) add("No motion sensor")
        if (loc == LocationStatus.NO_PERMISSION) add("Location: permission denied")
        if (!backgroundGuaranteed) add("Runs only while app is open")
        if (power.mode == PowerMode.SAFE) add("Battery saver: reduced monitoring")
    }

    fun statusLine(): String {
        val s = snapshot()
        return when (s.monitoringState) {
            MonitoringState.ACTIVE_EMERGENCY -> "EMERGENCY ACTIVE"
            MonitoringState.VERIFYING -> "Are you OK?"
            MonitoringState.ESCALATING -> "Sending SOS soon"
            else -> "${s.monitoringLabel}" + (s.bpm?.let { " · $it BPM" } ?: "")
        }
    }

    private fun pushStatusNotification() {
        if (!backgroundGuaranteed) return
        val line = statusLine()
        if (line != lastStatusLine) {
            lastStatusLine = line
            notifier.updateMonitoring(line)
        }
    }

    companion object {
        private const val TAG = "CHER/Runtime"
        @Volatile var current: CherRuntime? = null
            private set

        fun ensure(context: Context): CherRuntime {
            current?.let { return it }
            synchronized(this) {
                current?.let { return it }
                val r = CherRuntime(context)
                current = r
                r.start()
                return r
            }
        }
    }
}
