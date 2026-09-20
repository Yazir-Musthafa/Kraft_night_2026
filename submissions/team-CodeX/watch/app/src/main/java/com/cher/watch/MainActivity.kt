package com.cher.watch

import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.ColorStateList
import android.graphics.drawable.Drawable
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.ImageView
import android.widget.ScrollView
import android.widget.Switch
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.core.content.ContextCompat
import com.cher.watch.ui.emergency.DemoController
import com.cher.watch.ui.emergency.HoldButton
import com.cher.watch.ui.models.ConnectionState
import com.cher.watch.ui.models.EmergencyView
import com.cher.watch.ui.models.HelpAssignment
import com.cher.watch.ui.models.LocationStatus
import com.cher.watch.ui.models.MonitoringState
import com.cher.watch.ui.models.PowerMode
import com.cher.watch.ui.models.prettyRole
import com.cher.watch.ui.services.CherRuntime
import com.cher.watch.ui.services.MonitoringService
import com.cher.watch.ui.widgets.DirectionView
import com.cher.watch.ui.widgets.MiniMapView
import com.cher.watch.ui.widgets.PulseView
import com.cher.watch.ui.widgets.RingView
import com.cher.watch.ui.widgets.SwipePager
import com.cher.watch.utils.CherConfig
import com.cher.watch.utils.Geo
import com.cher.watch.utils.PermissionHelper
import com.cher.watch.utils.TimeUtils

/**
 * Single-activity, XML/View based UI for a round Wear OS screen. It only *renders* the runtime's state:
 * which screen is shown follows from the emergency state machine and the nearby-help state, not from navigation history.
 * Every screen wears the same edge [RingView] so state reads at a glance: green = fine, amber = attention, red = emergency,
 * blue = you are helping somebody.
 */
class MainActivity : ComponentActivity() {
    private lateinit var runtime: CherRuntime
    private val handler = Handler(Looper.getMainLooper())
    private val renderListener: () -> Unit = { render() }

    private lateinit var screens: Map<Screen, View>
    private var showSettings = false
    private var showPermissions = false
    private var cancelArmed = false
    private var pendingSpecIndex = 0
    private var permissionQueue: List<PermissionHelper.Spec> = emptyList()
    private var lastNavEmergency: String? = null
    private var lastScreen: Screen? = null
    private var safeSentAt = 0L

    private enum class Screen { MAIN, CHECKIN, ESCALATING, EMERGENCY, RESPONSE, CLOSED, PERMISSION, SETTINGS, HELP_REQUEST, HELP_CHECKIN, HELP_NAV, CALL112 }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        runtime = CherRuntime.ensure(this)
        screens = mapOf(
            Screen.MAIN to findViewById(R.id.screenMain),
            Screen.CHECKIN to findViewById(R.id.screenCheckIn),
            Screen.ESCALATING to findViewById(R.id.screenEscalating),
            Screen.EMERGENCY to findViewById(R.id.screenEmergency),
            Screen.RESPONSE to findViewById(R.id.screenResponse),
            Screen.CLOSED to findViewById(R.id.screenClosed),
            Screen.PERMISSION to findViewById(R.id.screenPermission),
            Screen.SETTINGS to findViewById(R.id.screenSettings),
            Screen.HELP_REQUEST to findViewById(R.id.screenHelpRequest),
            Screen.HELP_CHECKIN to findViewById(R.id.screenHelpCheckIn),
            Screen.HELP_NAV to findViewById(R.id.screenHelpNav),
            Screen.CALL112 to findViewById(R.id.screenCall112),
        )
        // Page 1 of the home screen is exactly one screen tall; the details are one swipe below.
        findViewById<View>(R.id.mainPage1).layoutParams.height = resources.displayMetrics.heightPixels
        findViewById<PulseView>(R.id.pulseEm).apply { color = res(R.color.cher_red); showDisc = false; rings = 3; periodMs = 3200 }
        findViewById<PulseView>(R.id.pulseHelp).apply { color = res(R.color.cher_red); icon = ContextCompat.getDrawable(context, R.drawable.ic_shield); periodMs = 2200 }
        bindActions()
        handleIntent(intent)
        if (!runtime.prefs.permissionsPromptShown && PermissionHelper.missing(this).isNotEmpty()) startPermissionFlow()
        MonitoringService.start(this)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
    }

    override fun onStart() {
        super.onStart()
        runtime.addListener(renderListener)
        runtime.notifier.uiShown()
        render()
    }

    override fun onStop() {
        runtime.removeListener(renderListener)
        runtime.notifier.uiHidden()
        runtime.controller.refreshNotification()
        super.onStop()
    }

    private fun res(id: Int) = ContextCompat.getColor(this, id)

    // ---------------------------------------------------------------- adb / launcher extras
    /**
     * Dev/demo hooks:  adb shell am start -n com.cher.watch/.MainActivity --es cher_server_url http://HOST:3000
     *                  adb shell am start -n com.cher.watch/.MainActivity --ez cher_demo true --es cher_action fall
     *                  adb shell am start -n com.cher.watch/.MainActivity --es cher_watch_id watch-2 --es cher_helper_name Riya
     */
    private fun handleIntent(i: Intent?) {
        i ?: return
        i.getStringExtra("cher_server_url")?.takeIf { it.isNotBlank() }?.let { runtime.setServerUrl(it) }
        i.getStringExtra("cher_watch_id")?.takeIf { it.isNotBlank() }?.let { runtime.setWatchId(it) }
        i.getStringExtra("cher_helper_name")?.takeIf { it.isNotBlank() }?.let { runtime.setHelperName(it) }
        if (i.hasExtra("cher_broadcast")) runtime.setBroadcastNearby(i.getBooleanExtra("cher_broadcast", true))
        if (i.hasExtra("cher_call112")) runtime.setCall112(i.getBooleanExtra("cher_call112", true))
        if (i.hasExtra("cher_ai")) runtime.setAiMode(i.getBooleanExtra("cher_ai", true))
        if (i.hasExtra("cher_voice")) runtime.setAiVoice(i.getBooleanExtra("cher_voice", true))
        if (i.hasExtra("cher_nearby")) runtime.setNearbyAlerts(i.getBooleanExtra("cher_nearby", true))
        if (i.hasExtra("cher_demo")) runtime.setDemoMode(i.getBooleanExtra("cher_demo", false))
        i.getStringExtra("cher_action")?.let { action ->
            when (action) {
                "sos" -> runtime.controller.manualSos()
                "fall" -> { runtime.setDemoMode(true); runtime.demo.simulateFall() }
                "impact" -> { runtime.setDemoMode(true); runtime.demo.simulateImpact() }
                "inactivity" -> { runtime.setDemoMode(true); runtime.demo.simulateInactivity() }
                "hr_high" -> { runtime.setDemoMode(true); runtime.demo.setScenario(DemoController.Scenario.HIGH) }
                "hr_low" -> { runtime.setDemoMode(true); runtime.demo.setScenario(DemoController.Scenario.LOW) }
                "hr_trend" -> { runtime.setDemoMode(true); runtime.demo.setScenario(DemoController.Scenario.TREND) }
                "hr_normal" -> { runtime.setDemoMode(true); runtime.demo.setScenario(DemoController.Scenario.NORMAL) }
                "ok" -> runtime.controller.userOk()
                "help" -> runtime.controller.userNeedsHelp()
                "help_accept" -> runtime.helper.accept()
                "help_decline" -> runtime.helper.decline()
                "help_arrived" -> runtime.helper.status("REACHED")
                "elevate" -> { runtime.setDemoMode(true); runtime.demo.setScenario(DemoController.Scenario.ELEVATED) }
                "very_high" -> { runtime.setDemoMode(true); runtime.demo.setScenario(DemoController.Scenario.VERY_HIGH) }
                "call112" -> runtime.call112.startManual()
            }
        }
    }

    // ---------------------------------------------------------------- wiring
    private fun bindActions() {
        val sos = findViewById<HoldButton>(R.id.btnSos)
        sos.onHoldComplete = { runtime.controller.manualSos() }
        sos.onHoldTooShort = {
            sos.text = "Keep holding…"
            handler.removeCallbacks(resetSosLabel)
            handler.postDelayed(resetSosLabel, 1_800)
        }
        findViewById<View>(R.id.btnSettings).setOnClickListener { showSettings = true; render() }
        findViewById<View>(R.id.btnSettingsBack).setOnClickListener { showSettings = false; render() }
        findViewById<View>(R.id.btnMore).setOnClickListener { findViewById<ScrollView>(R.id.mainScroll).smoothScrollTo(0, resources.displayMetrics.heightPixels) }
        findViewById<Switch>(R.id.swNearby).setOnCheckedChangeListener { b, on -> if (b.isPressed) runtime.setNearbyAlerts(on) }

        findViewById<View>(R.id.btnOk).setOnClickListener { runtime.controller.userOk() }
        findViewById<View>(R.id.btnNeedHelp).setOnClickListener { runtime.controller.userNeedsHelp() }
        findViewById<View>(R.id.btnEscalateCancel).setOnClickListener { runtime.controller.cancelEscalation() }

        val cancel = View.OnClickListener { armedCancel() }
        findViewById<View>(R.id.btnEmCancel).setOnClickListener(cancel)
        findViewById<View>(R.id.btnRsCancel).setOnClickListener(cancel)
        findViewById<View>(R.id.btnRsSafe).setOnClickListener {
            if (System.currentTimeMillis() - safeSentAt < SAFE_FEEDBACK_MS) return@setOnClickListener // already sent: do not queue duplicates
            safeSentAt = System.currentTimeMillis()
            runtime.haptics.confirm() // the wearer feels that the tap registered
            runtime.controller.confirmSafe()
            render()
        }
        findViewById<View>(R.id.btnClosedOk).setOnClickListener {
            if (runtime.snapshot().closed != null) runtime.controller.dismissClosed() else runtime.helper.dismissNotice()
        }

        findViewById<View>(R.id.btnPermGrant).setOnClickListener { requestCurrentPermission() }
        findViewById<View>(R.id.btnPermSkip).setOnClickListener { advancePermissionFlow() }
        findViewById<View>(R.id.btnPerms).setOnClickListener { startPermissionFlow() }

        // nearby help: someone needs help close to me
        findViewById<View>(R.id.btnHelpAccept).setOnClickListener { runtime.helper.accept() }
        findViewById<View>(R.id.btnHelpDecline).setOnClickListener { runtime.helper.decline() }
        findViewById<View>(R.id.btnHcOn).setOnClickListener { runtime.helper.status(if (runtime.helper.checkIn?.type == "CONFIRM") "CONFIRMED" else "MOVING") }
        findViewById<View>(R.id.btnHcArrived).setOnClickListener { runtime.helper.status(if (runtime.helper.checkIn?.type == "CONFIRM") "SAFE" else "REACHED") }
        findViewById<View>(R.id.btnHcBackup).setOnClickListener { runtime.helper.status("BACKUP") }
        findViewById<View>(R.id.btnNavPrimary).setOnClickListener { runtime.helper.status(if (runtime.helper.assignment?.arrived == true) "CONFIRMED" else "REACHED") }
        findViewById<View>(R.id.btnNavSecondary).setOnClickListener { runtime.helper.status("SAFE") }
        findViewById<View>(R.id.btnNavBackup).setOnClickListener { runtime.helper.status("BACKUP") }

        val demo = findViewById<Switch>(R.id.swDemo)
        demo.setOnCheckedChangeListener { b, on -> if (b.isPressed) runtime.setDemoMode(on) }
        findViewById<Switch>(R.id.swBroadcast).setOnCheckedChangeListener { b, on -> if (b.isPressed) runtime.setBroadcastNearby(on) }
        val safe = findViewById<Switch>(R.id.swSafe)
        safe.setOnCheckedChangeListener { b, on -> if (b.isPressed) runtime.setForceSafe(on) }
        findViewById<Switch>(R.id.swAi).setOnCheckedChangeListener { b, on -> if (b.isPressed) runtime.setAiMode(on) }
        findViewById<Switch>(R.id.swAiVoice).setOnCheckedChangeListener { b, on -> if (b.isPressed) runtime.setAiVoice(on) }
        findViewById<Switch>(R.id.swAiHealth).setOnCheckedChangeListener { b, on -> if (b.isPressed) runtime.setAiHealth(on) }
        findViewById<Switch>(R.id.swAiEmergency).setOnCheckedChangeListener { b, on -> if (b.isPressed) runtime.setAiEmergency(on) }
        findViewById<Switch>(R.id.sw112).setOnCheckedChangeListener { b, on -> if (b.isPressed) runtime.setCall112(on) }
        // The two heart-rate simulations go straight to the home screen, where the suggestion (or the check-in) appears.
        findViewById<View>(R.id.btnDemoElevate).setOnClickListener { runtime.demo.setScenario(DemoController.Scenario.ELEVATED); showSettings = false; render() }
        findViewById<View>(R.id.btnDemoVeryHigh).setOnClickListener { runtime.demo.setScenario(DemoController.Scenario.VERY_HIGH); showSettings = false; render() }
        findViewById<View>(R.id.btnEm112).setOnClickListener { runtime.call112.startManual() }
        findViewById<View>(R.id.btnCallNow).setOnClickListener { runtime.call112.callNow() }
        findViewById<View>(R.id.btnCallCancel).setOnClickListener { runtime.call112.cancel() }
        findViewById<View>(R.id.tvMonitoringDetail).setOnClickListener { runtime.snapshot().healthAdvice?.let { runtime.ai.repeat(it.text) } }
        findViewById<View>(R.id.btnDemoNormal).setOnClickListener { runtime.demo.setScenario(DemoController.Scenario.NORMAL) }
        findViewById<View>(R.id.btnDemoHigh).setOnClickListener { runtime.demo.setScenario(DemoController.Scenario.HIGH) }
        findViewById<View>(R.id.btnDemoLow).setOnClickListener { runtime.demo.setScenario(DemoController.Scenario.LOW) }
        findViewById<View>(R.id.btnDemoTrend).setOnClickListener { runtime.demo.setScenario(DemoController.Scenario.TREND) }
        findViewById<View>(R.id.btnDemoImpact).setOnClickListener { runtime.demo.simulateImpact(); showSettings = false; render() }
        findViewById<View>(R.id.btnDemoFall).setOnClickListener { runtime.demo.simulateFall(); showSettings = false; render() }
        findViewById<View>(R.id.btnDemoInactive).setOnClickListener { runtime.demo.simulateInactivity(); showSettings = false; render() }
    }

    private val resetSosLabel = Runnable { findViewById<Button>(R.id.btnSos).setText(R.string.hold_for_sos) }
    private val disarmCancel = Runnable { cancelArmed = false; render() }

    /** Cancelling a live emergency needs a deliberate second tap. */
    private fun armedCancel() {
        if (!cancelArmed) {
            cancelArmed = true
            handler.removeCallbacks(disarmCancel)
            handler.postDelayed(disarmCancel, 4_000)
            render()
        } else {
            cancelArmed = false
            handler.removeCallbacks(disarmCancel)
            runtime.controller.cancelEmergency()
        }
    }

    // ---------------------------------------------------------------- permissions
    private fun startPermissionFlow() {
        runtime.prefs.permissionsPromptShown = true
        permissionQueue = PermissionHelper.missing(this)
        pendingSpecIndex = 0
        showPermissions = permissionQueue.isNotEmpty()
        render()
    }

    private fun currentSpec(): PermissionHelper.Spec? = permissionQueue.getOrNull(pendingSpecIndex)

    private fun requestCurrentPermission() {
        val spec = currentSpec() ?: return advancePermissionFlow()
        requestPermissions(spec.permissions.toTypedArray(), REQ_PERMISSIONS)
    }

    private fun advancePermissionFlow() {
        pendingSpecIndex++
        if (pendingSpecIndex >= permissionQueue.size) showPermissions = false
        render()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQ_PERMISSIONS) return
        runtime.onPermissionsChanged()
        MonitoringService.start(this) // may now be allowed to run in the foreground
        if (grantResults.any { it != PackageManager.PERMISSION_GRANTED }) {
            // Denied: the app keeps working and reports degraded monitoring.
        }
        advancePermissionFlow()
    }

    // ---------------------------------------------------------------- rendering
    private fun render() {
        val s = runtime.snapshot()
        val em = s.emergency
        // The wearer's own safety always wins; then anything about helping others; then the calm screens.
        val target = when {
            s.closed != null -> Screen.CLOSED
            s.call112Phase != com.cher.watch.ui.emergency.Call112.Phase.IDLE -> Screen.CALL112
            em != null && em.hasResponder -> Screen.RESPONSE
            em != null -> Screen.EMERGENCY
            s.monitoringState == MonitoringState.VERIFYING -> Screen.CHECKIN
            s.monitoringState == MonitoringState.ESCALATING -> Screen.ESCALATING
            s.helpRequest != null -> Screen.HELP_REQUEST
            s.helpCheckIn != null && s.helpAssignment != null -> Screen.HELP_CHECKIN
            s.helpAssignment != null -> Screen.HELP_NAV
            s.helpNotice != null && s.helpRequest == null && s.helpNoticeFinal -> Screen.CLOSED
            showPermissions && currentSpec() != null -> Screen.PERMISSION
            showSettings -> Screen.SETTINGS
            else -> Screen.MAIN
        }
        for ((k, v) in screens) v.visibility = if (k == target) View.VISIBLE else View.GONE
        if (target != lastScreen) {
            // Window attributes are an IPC to the window manager: touch them only when the screen actually changes, not on every refresh.
            val keepOn = setOf(Screen.CHECKIN, Screen.ESCALATING, Screen.EMERGENCY, Screen.RESPONSE, Screen.HELP_REQUEST, Screen.HELP_CHECKIN, Screen.HELP_NAV, Screen.CALL112)
            if (target in keepOn) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            if (target == Screen.MAIN) findViewById<ScrollView>(R.id.mainScroll).scrollTo(0, 0)
        }
        lastScreen = target

        when (target) {
            Screen.MAIN -> renderMain(s)
            Screen.CHECKIN -> renderCheckIn(s)
            Screen.ESCALATING -> renderEscalating(s)
            Screen.EMERGENCY -> renderEmergency(em!!, s)
            Screen.RESPONSE -> renderResponse(em!!)
            Screen.CLOSED -> renderClosed(s)
            Screen.PERMISSION -> renderPermission()
            Screen.SETTINGS -> renderSettings(s)
            Screen.HELP_REQUEST -> renderHelpRequest(s)
            Screen.HELP_CHECKIN -> renderHelpCheckIn(s)
            Screen.HELP_NAV -> renderHelpNav(s)
            Screen.CALL112 -> renderCall112(s)
        }
    }

    /** Only touches the view when the value really changed (this runs several times a second while navigating). */
    private fun text(id: Int, value: String, color: Int? = null) {
        val tv = findViewById<TextView>(id)
        if (tv.text.toString() != value) tv.text = value
        if (color != null && tv.currentTextColor != ContextCompat.getColor(this, color)) tv.setTextColor(ContextCompat.getColor(this, color))
    }

    private fun tint(id: Int, colorRes: Int) {
        findViewById<View>(id).backgroundTintList = ColorStateList.valueOf(res(colorRes))
    }

    private fun ring(id: Int, colorRes: Int, progress: Float? = null, breathe: Boolean = false, comet: Boolean = false) {
        findViewById<RingView>(id).apply {
            ringColor = res(colorRes)
            this.progress = progress
            this.breathe = breathe
            this.comet = comet
        }
    }

    private fun frac(deadline: Long, total: Long): Float =
        if (total <= 0) 0f else ((deadline - System.currentTimeMillis()).toFloat() / total).coerceIn(0f, 1f)

    private fun renderMain(s: CherRuntime.UiState) {
        val ok = s.monitoringLabel == "ACTIVE"
        val online = s.connection == ConnectionState.CONNECTED
        ring(R.id.ringMain, if (ok && online) R.color.cher_green else if (ok) R.color.cher_amber else R.color.cher_amber, breathe = true)
        findViewById<View>(R.id.tvDemoBadge).visibility = if (s.demoMode) View.VISIBLE else View.GONE
        text(R.id.tvMonitoring, if (ok) "Monitoring" else "Limited")
        tint(R.id.dotMonitoring, if (ok) R.color.cher_green else R.color.cher_amber)
        text(R.id.tvHeart, if (s.bpm != null) "${s.bpm}" else "--")
        findViewById<com.cher.watch.ui.widgets.HeartbeatView>(R.id.heartView).setBpm(s.bpm)
        val trend = if (s.hrTrend != "UNAVAILABLE" && s.hrTrend != "STABLE") " · ${s.hrTrend.lowercase().replace('_', ' ')}" else ""
        val tip = s.healthAdvice?.takeIf { s.aiMode }
        findViewById<View>(R.id.chipRow).visibility = if (tip != null) View.GONE else View.VISIBLE // the tip needs the room
        val detail = findViewById<TextView>(R.id.tvMonitoringDetail)
        if (tip != null && s.aiMode) {
            // a small suggestion instead of the technical line; tap it to hear it again
            text(R.id.tvMonitoringDetail, "${tipLabel(tip)} ${tip.text}")
            detail.maxLines = 3
            if (detail.currentTextColor != res(R.color.cher_blue)) detail.setTextColor(res(R.color.cher_blue))
        } else {
            text(R.id.tvMonitoringDetail, s.degradedReasons.joinToString(" · ").ifEmpty { "${s.hrSource.label}: ${s.hrNote}$trend" })
            detail.maxLines = 2
            if (detail.currentTextColor != res(R.color.cher_text_dim)) detail.setTextColor(res(R.color.cher_text_dim))
        }

        val (link, linkColor) = when (s.connection) {
            ConnectionState.CONNECTED -> (if (s.pendingSync > 0) "${s.pendingSync} QUEUED" else "LINK") to R.color.cher_green
            ConnectionState.CONNECTING -> "LINK…" to R.color.cher_amber
            ConnectionState.DISCONNECTED -> "OFFLINE" to R.color.cher_red
        }
        text(R.id.tvLink, link); tint(R.id.dotLink, linkColor)
        val (gps, gpsColor) = when (s.location) {
            LocationStatus.AVAILABLE -> "GPS" to R.color.cher_green
            LocationStatus.STALE -> "GPS OLD" to R.color.cher_amber
            LocationStatus.UNAVAILABLE -> "NO GPS" to R.color.cher_amber
            LocationStatus.NO_PERMISSION -> "GPS OFF" to R.color.cher_red
        }
        text(R.id.tvGps, gps); tint(R.id.dotGps, gpsColor)
        text(R.id.tvBat, "${s.battery}%${if (s.charging) "⚡" else ""}")
        tint(R.id.dotBat, if (s.battery <= 20 && !s.charging) R.color.cher_red else if (s.battery <= 35 && !s.charging) R.color.cher_amber else R.color.cher_green)

        // page 2
        val (conn, connColor) = when (s.connection) {
            ConnectionState.CONNECTED -> "CONNECTED" + (if (s.pendingSync > 0) " · ${s.pendingSync} queued" else "") to R.color.cher_green
            ConnectionState.CONNECTING -> "CONNECTING" to R.color.cher_amber
            ConnectionState.DISCONNECTED -> "OFFLINE" to R.color.cher_red
        }
        text(R.id.tvConnection, conn, connColor)
        val (loc, locColor) = when (s.location) {
            LocationStatus.AVAILABLE -> "AVAILABLE" to R.color.cher_green
            LocationStatus.STALE -> "STALE" to R.color.cher_amber
            LocationStatus.UNAVAILABLE -> "UNAVAILABLE" to R.color.cher_amber
            LocationStatus.NO_PERMISSION -> "NO PERMISSION" to R.color.cher_red
        }
        text(R.id.tvLocation, loc, locColor)
        text(R.id.tvBattery, "${s.battery}%${if (s.charging) " ⚡" else ""} · ${s.powerMode.name}")
        text(R.id.tvHeartNote, "${s.hrSource.label}: ${s.hrNote}")
        val nearby = findViewById<Switch>(R.id.swNearby)
        if (nearby.isChecked != s.nearbyAlerts) nearby.isChecked = s.nearbyAlerts
        text(R.id.tvNearbyNote, if (s.nearbyAlerts) "Alert me when someone close needs help" else "You won't get nearby alerts")
        val note = findViewById<TextView>(R.id.tvNote)
        val noteText = s.note ?: s.helpNotice
        note.text = noteText ?: ""
        note.visibility = if (noteText != null) View.VISIBLE else View.GONE
    }

    private fun renderCheckIn(s: CherRuntime.UiState) {
        val total = if (s.demoMode) CherConfig.DEMO_CHECKIN_TIMEOUT_MS else CherConfig.CHECKIN_TIMEOUT_MS
        ring(R.id.ringCheckIn, R.color.cher_amber, progress = frac(s.checkInDeadline, total))
        text(R.id.tvCheckInCountdown, TimeUtils.secondsLeft(s.checkInDeadline).toString())
        text(R.id.tvCheckInReason, if (s.demoMode) "Possible fall (demo)" else "Unusual signals detected")
    }

    private fun renderEscalating(s: CherRuntime.UiState) {
        val total = if (s.demoMode) CherConfig.DEMO_ESCALATION_GRACE_MS else CherConfig.ESCALATION_GRACE_MS
        ring(R.id.ringEscalate, R.color.cher_red, progress = frac(s.escalationDeadline, total))
        text(R.id.tvEscalateCountdown, TimeUtils.secondsLeft(s.escalationDeadline).toString())
    }

    /** The server's live call progress: "Call placed to Abhishek", "Phone is ringing", "Call answered by ..." (also nearby alerts). */
    private fun isCallStage(s: String) = listOf("Alerting", "Call ", "Phone ", "Follow-up call").any { s.startsWith(it) }

    private fun friendlyResponse(e: EmergencyView): String = when (e.state) {
        "ACTIVE" -> "Starting response..."
        "RESPONDER_SEARCHING" -> if (isCallStage(e.contactStatus)) e.contactStatus else "Searching for responder..."
        "RESPONDER_ACCEPTED" -> "Responder accepted"
        "RESPONDER_MOVING" -> "Responder on the way"
        "RESPONDER_NEEDS_BACKUP" -> "Finding backup..."
        "PERSON_REACHED" -> "Responder reached you"
        "HELP_CONFIRMED" -> "Help confirmed"
        "UNCONFIRMED" -> "No responder confirmed"
        else -> e.state
    }

    private fun renderEmergency(e: EmergencyView, s: CherRuntime.UiState) {
        // Not yet acknowledged by the backend: nobody has been contacted. Say so plainly.
        val unsent = !e.synced
        val offline = unsent && s.connection != ConnectionState.CONNECTED
        val cov = if (unsent) 0 else e.coveragePercent
        ring(R.id.ringEm, if (offline) R.color.cher_amber else R.color.cher_red, progress = (cov.coerceAtLeast(3) / 100f), breathe = true)
        text(R.id.tvEmPriority, "SOS · ${e.priority}", if (e.priority == "CRITICAL" || e.priority == "HIGH") R.color.cher_red else R.color.cher_amber)
        text(R.id.tvEmResponse, if (offline) "Not sent yet" else if (unsent) "Sending to CHER..." else friendlyResponse(e), if (offline) R.color.cher_amber else R.color.cher_text)
        val headline = friendlyResponse(e)
        val sub = if (offline) "No connection to CHER. Retrying automatically" else if (e.contactStatus == headline || isCallStage(e.contactStatus)) "" else e.contactStatus.ifEmpty { "..." }
        val ai = s.emergencyAdvice?.takeIf { s.aiMode && sub.isEmpty() }
        val line = if (ai != null) "${tipLabel(ai)} ${ai.text}" else sub
        text(R.id.tvEmContact, line)
        findViewById<View>(R.id.tvEmContact).visibility = if (line.isEmpty()) View.GONE else View.VISIBLE
        findViewById<TextView>(R.id.tvEmContact).setTextColor(res(if (ai != null) R.color.cher_blue else R.color.cher_text_dim))
        findViewById<View>(R.id.btnEm112).visibility = if (s.call112Enabled) View.VISIBLE else View.GONE
        text(R.id.tvEmLocation, if (e.locationShared) "LOCATION SHARED" else if (e.synced) "SHARING LOCATION" else "LOCATION PENDING", if (e.locationShared) R.color.cher_green else R.color.cher_amber)
        // a live "why is nothing happening yet" timer beats a static sentence
        text(R.id.tvEmNext, if (e.countdownLabel != null) "${e.countdownLeft()}s · ${e.countdownLabel}" else "${e.responsiblePerson}: ${e.nextAction}")
        renderSteps(e)
        findViewById<ImageView>(R.id.ivEmLocation).imageTintList = ColorStateList.valueOf(res(if (e.locationShared) R.color.cher_green else R.color.cher_amber))
        findViewById<Button>(R.id.btnEmCancel).apply { val l = getString(if (cancelArmed) R.string.cancel_confirm else R.string.cancel); if (text.toString() != l) text = l }
    }

    /** Small checklist dots: done = green, current = white ring, skipped = dim, pending = grey. */
    private fun renderSteps(e: EmergencyView) {
        val row = findViewById<android.widget.LinearLayout>(R.id.stepDots)
        val sig = e.steps.joinToString("|") { it.state }
        if (row.tag == sig) return
        row.tag = sig
        row.removeAllViews()
        val d = resources.displayMetrics.density
        for (step in e.steps.take(8)) {
            val dot = View(this)
            val size = ((if (step.state == "current") 9 else 7) * d).toInt()
            val lp = android.widget.LinearLayout.LayoutParams(size, size).apply { marginStart = (3 * d).toInt(); marginEnd = (3 * d).toInt() }
            dot.layoutParams = lp
            dot.setBackgroundResource(R.drawable.dot)
            dot.backgroundTintList = ColorStateList.valueOf(when (step.state) {
                "done" -> res(R.color.cher_green)
                "current" -> res(R.color.cher_text)
                "skipped" -> res(R.color.cher_text_faint)
                else -> res(R.color.cher_stroke)
            })
            row.addView(dot)
        }
    }

    private fun renderResponse(e: EmergencyView) {
        val bad = e.state == "RESPONDER_NEEDS_BACKUP"
        ring(R.id.ringRs, if (bad) R.color.cher_amber else R.color.cher_green, progress = e.coveragePercent.coerceAtLeast(3) / 100f, breathe = true)
        text(R.id.tvRsName, e.responderName ?: e.responsiblePerson)
        text(R.id.tvRsRole, prettyRole(e.responderRole))
        val status = findViewById<TextView>(R.id.tvRsStatus)
        val chipBg = if (bad) R.drawable.bg_chip_amber else R.drawable.bg_chip_green
        if (status.tag != chipBg) { status.setBackgroundResource(chipBg); status.tag = chipBg }
        text(R.id.tvRsStatus, when (e.state) {
            "RESPONDER_ACCEPTED" -> "ACCEPTED"
            "RESPONDER_MOVING" -> "ON THE WAY"
            "RESPONDER_NEEDS_BACKUP" -> "FINDING BACKUP"
            "PERSON_REACHED" -> "REACHED YOU"
            "HELP_CONFIRMED" -> "HELP CONFIRMED"
            else -> friendlyResponse(e).uppercase()
        }, if (bad) R.color.cher_amber else R.color.cher_green)
        text(R.id.tvRsCoverage, "${e.coveragePercent}%")
        val aiTip = runtime.snapshot().let { snap -> snap.emergencyAdvice?.takeIf { snap.aiMode }?.text }
        text(R.id.tvRsNext, when {
            isCallStage(e.contactStatus) -> e.contactStatus
            aiTip != null -> "${tipLabel(runtime.snapshot().emergencyAdvice)} $aiTip"
            else -> "${e.responsiblePerson}: ${e.nextAction}"
        })
        text(R.id.tvRsTracking, if (e.locationShared) "Your location is shared" else "Location not yet shared")
        val safeVisible = e.state == "PERSON_REACHED" || e.state == "HELP_CONFIRMED"
        findViewById<View>(R.id.btnRsSafe).visibility = if (safeVisible) View.VISIBLE else View.GONE
        val closing = System.currentTimeMillis() - safeSentAt < SAFE_FEEDBACK_MS
        findViewById<Button>(R.id.btnRsSafe).apply {
            val label = if (closing) "Closing…" else getString(R.string.im_safe)
            if (text.toString() != label) text = label
            alpha = if (closing) 0.6f else 1f
        }
        findViewById<View>(R.id.tvRsCoverage).visibility = if (safeVisible) View.GONE else View.VISIBLE
        findViewById<Button>(R.id.btnRsCancel).apply { val l = getString(if (cancelArmed) R.string.cancel_confirm else R.string.cancel); if (text.toString() != l) text = l }
    }

    private fun renderClosed(s: CherRuntime.UiState) {
        val icon = findViewById<ImageView>(R.id.ivClosed)
        val own = s.closed
        if (own != null) {
            val resolved = own.state == "RESOLVED"
            val c = if (resolved) R.color.cher_green else R.color.cher_amber
            ring(R.id.ringClosed, c)
            text(R.id.tvClosedTitle, if (resolved) "Resolved" else "Cancelled", c)
            text(R.id.tvClosedBody, if (resolved) "Your situation was confirmed and the emergency is closed." else "The emergency was cancelled. Responders were told.")
            icon.setImageResource(if (resolved) R.drawable.ic_check else R.drawable.ic_close)
            icon.imageTintList = ColorStateList.valueOf(res(c))
        } else {
            // a helping session ended
            ring(R.id.ringClosed, R.color.cher_blue)
            text(R.id.tvClosedTitle, "Thank you", R.color.cher_blue)
            text(R.id.tvClosedBody, s.helpNotice ?: "")
            icon.setImageResource(R.drawable.ic_heart)
            icon.imageTintList = ColorStateList.valueOf(res(R.color.cher_blue))
        }
    }

    private fun renderPermission() {
        val spec = currentSpec() ?: return
        ring(R.id.ringPerm, R.color.cher_blue, progress = (pendingSpecIndex + 1f) / permissionQueue.size)
        text(R.id.tvPermTitle, "${spec.title} (${pendingSpecIndex + 1}/${permissionQueue.size})")
        text(R.id.tvPermWhy, spec.why)
    }

    private fun renderSettings(s: CherRuntime.UiState) {
        findViewById<Switch>(R.id.swDemo).isChecked = s.demoMode
        findViewById<Switch>(R.id.swSafe).isChecked = s.forceSafe
        findViewById<Switch>(R.id.swBroadcast).isChecked = s.broadcastNearby
        findViewById<Switch>(R.id.swAi).isChecked = s.aiMode
        findViewById<Switch>(R.id.swAiVoice).apply { isChecked = s.aiVoice; isEnabled = s.aiMode; alpha = if (s.aiMode) 1f else 0.4f }
        findViewById<Switch>(R.id.swAiHealth).apply { isChecked = s.aiHealth; isEnabled = s.aiMode; alpha = if (s.aiMode) 1f else 0.4f }
        findViewById<Switch>(R.id.swAiEmergency).apply { isChecked = s.aiEmergency; isEnabled = s.aiMode; alpha = if (s.aiMode) 1f else 0.4f }
        findViewById<Switch>(R.id.sw112).isChecked = s.call112Enabled
        findViewById<View>(R.id.demoControls).visibility = if (s.demoMode) View.VISIBLE else View.GONE
        text(R.id.tvServer, "${s.serverUrl}\nwatch id: ${runtime.prefs.watchId} · ${s.helperName}")
        val perms = PermissionHelper.specs().joinToString("\n") { "${it.title}: ${if (PermissionHelper.isSpecGranted(this, it)) "granted" else "DENIED"}" }
        text(R.id.tvPerms, perms)
        text(R.id.tvCaps, s.motionCaps + "\nHR: ${s.hrSource.label} (${s.hrNote})\nCompass: ${if (s.compassAvailable) "yes" else "no sensor (north-up map)"}")
        text(R.id.tvBg, if (s.background) "Background service: running" else "Background service: NOT running (monitoring only while app is open)")
        if (s.powerMode == PowerMode.EMERGENCY) text(R.id.tvBg, "Emergency power mode")
    }

    // ---------------------------------------------------------------- helping somebody else
    private fun renderHelpRequest(s: CherRuntime.UiState) {
        val r = s.helpRequest ?: return
        ring(R.id.ringHelp, R.color.cher_red, progress = frac(r.deadlineMs, r.totalMs), breathe = true)
        val who = if (r.personName.equals("the CHER user", true)) "Someone nearby" else r.personName
        text(R.id.tvHelpTitle, "$who needs help")
        text(R.id.tvHelpDistance, Geo.formatDistance(r.distanceM.toDouble()))
        val dir = Geo.compassWord(r.direction)
        text(R.id.tvHelpDirection, "$dir · ${Geo.walkTime(r.distanceM.toDouble())} walk".uppercase())
        text(R.id.tvHelpError, s.helpError ?: "")
        findViewById<Button>(R.id.btnHelpAccept).text = if (s.helpBusy) "…" else "Can help"
        findViewById<View>(R.id.btnHelpAccept).isEnabled = !s.helpBusy
    }

    /** Honest label: "AI:" only when the AI really wrote it; a rule-based sentence (AI unreachable) says "Tip:". */
    private fun tipLabel(a: com.cher.watch.ui.ai.AiAdvisor.Advice?) = if (a?.source == "AI") "AI:" else "Tip:"

    private fun renderCall112(s: CherRuntime.UiState) {
        val calling = s.call112Phase == com.cher.watch.ui.emergency.Call112.Phase.CALLING
        ring(R.id.ringCall, R.color.cher_red, progress = if (calling) 1f else frac(s.call112Deadline, s.call112Total), breathe = calling)
        text(R.id.tvCallTitle, if (calling) (if (s.call112Dry) "Demo · 112" else "Calling 112") else "Calling 112 in")
        text(R.id.tvCallCount, if (calling) "☎" else TimeUtils.secondsLeft(s.call112Deadline).toString())
        text(R.id.tvCallNote, if (!calling && s.call112Dry) "${s.call112Note}\nDEMO: no real call" else s.call112Note)
        findViewById<View>(R.id.btnCallNow).visibility = if (calling) View.GONE else View.VISIBLE
        findViewById<Button>(R.id.btnCallCancel).text = if (calling) "OK" else "Cancel"
    }

    private fun renderHelpCheckIn(s: CherRuntime.UiState) {
        val c = s.helpCheckIn ?: return
        ring(R.id.ringHelpCheckIn, R.color.cher_amber, progress = frac(c.deadlineMs, c.totalMs))
        val confirm = c.type == "CONFIRM"
        text(R.id.tvHcTitle, if (confirm) "Is the person OK?" else "Still on your way?")
        text(R.id.tvHcCountdown, "${TimeUtils.secondsLeft(c.deadlineMs)} s")
        findViewById<Button>(R.id.btnHcOn).text = if (confirm) "Help received" else "Still coming"
        findViewById<Button>(R.id.btnHcArrived).text = if (confirm) "Person is safe" else "I've arrived"
        text(R.id.tvHcError, s.helpError ?: "")
    }

    private fun renderHelpNav(s: CherRuntime.UiState) {
        val a = s.helpAssignment ?: return
        val pager = findViewById<SwipePager>(R.id.navPager)
        if (lastNavEmergency != a.emergencyId) { lastNavEmergency = a.emergencyId; pager.setPage(0, animate = false) }

        val own = s.ownPosition
        val tgt = a.location
        val dist = if (own != null && tgt != null) Geo.distanceM(own.latitude, own.longitude, tgt.latitude, tgt.longitude) else null
        val bearing = if (own != null && tgt != null) Geo.bearingDeg(own.latitude, own.longitude, tgt.latitude, tgt.longitude) else null
        val close = a.arrived || (dist != null && Geo.isClose(dist))
        val backup = a.state == "RESPONDER_NEEDS_BACKUP" || a.responderStatus == "NEEDS_BACKUP"
        ring(R.id.ringNav, if (close) R.color.cher_green else if (backup) R.color.cher_amber else R.color.cher_blue, breathe = true)

        // page 1: direction
        findViewById<DirectionView>(R.id.dirView).apply {
            this.bearing = bearing
            heading = s.headingDeg
            this.close = close
        }
        text(R.id.tvNavDistance, when { dist != null -> Geo.formatDistance(dist); tgt == null -> "--" else -> "GPS…" })
        text(R.id.tvNavSub, when {
            a.arrived -> "YOU'VE ARRIVED"
            close -> "YOU'RE CLOSE"
            dist != null && bearing != null -> "${Geo.compassWord(Geo.compass8(bearing))} · ${Geo.walkTime(dist)}"
            tgt == null -> "WAITING FOR LOCATION"
            else -> "WAITING FOR YOUR GPS"
        })

        // page 2: map
        findViewById<MiniMapView>(R.id.mapView).apply {
            this.own = own
            target = tgt
            trail = s.trail
            heading = s.headingDeg
        }
        text(R.id.tvMapDistance, if (dist != null) "${Geo.formatDistance(dist)} · ${Geo.walkTime(dist)}".uppercase() else "LOCATING")
        text(R.id.tvMapNote, if (s.headingDeg != null) "Heading up" else "North up · straight line")

        // page 3: details + actions
        text(R.id.tvNavPerson, if (a.personName.equals("the CHER user", true)) "Person in need" else a.personName)
        val (statusText, statusColor, statusBg) = when {
            a.state == "HELP_CONFIRMED" -> Triple("Help confirmed", R.color.cher_green, R.drawable.bg_chip_green)
            a.arrived -> Triple("Arrived", R.color.cher_green, R.drawable.bg_chip_green)
            backup -> Triple("Backup requested", R.color.cher_amber, R.drawable.bg_chip_amber)
            else -> Triple("On the way", R.color.cher_blue, R.drawable.bg_chip_blue)
        }
        findViewById<TextView>(R.id.tvNavStatus).apply { if (tag != statusBg) { setBackgroundResource(statusBg); tag = statusBg } }
        text(R.id.tvNavStatus, statusText, statusColor)
        val helperTip = s.helperAdvice?.takeIf { s.aiMode }
        text(R.id.tvNavCoords, if (helperTip != null) "${tipLabel(helperTip)} ${helperTip.text}" else if (tgt != null) "%.5f, %.5f".format(java.util.Locale.US, tgt.latitude, tgt.longitude) + (tgt.accuracy?.let { " ±${it.toInt()}m" } ?: "") else "Waiting for location")
        val primary = findViewById<Button>(R.id.btnNavPrimary)
        val secondary = findViewById<Button>(R.id.btnNavSecondary)
        when {
            a.state == "HELP_CONFIRMED" -> { primary.visibility = View.GONE; secondary.visibility = View.VISIBLE; secondary.text = "Person is safe" }
            a.arrived -> { primary.visibility = View.VISIBLE; primary.text = "Help received"; secondary.visibility = View.VISIBLE; secondary.text = "Person is safe" }
            else -> { primary.visibility = View.VISIBLE; primary.text = "I've arrived"; secondary.visibility = View.GONE }
        }
        primary.isEnabled = !s.helpBusy
        text(R.id.tvNavError, s.helpError ?: "")
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        super.onDestroy()
    }

    private companion object {
        const val REQ_PERMISSIONS = 42
        const val SAFE_FEEDBACK_MS = 3_000L
    }
}
