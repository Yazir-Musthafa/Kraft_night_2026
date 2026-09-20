package com.cher.watch.ui.services

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import com.cher.watch.MainActivity
import com.cher.watch.R
import com.cher.watch.utils.PermissionHelper

/** All notifications: the ongoing monitoring notice, the "Are you OK?" check and emergency updates. */
class Notifier(context: Context) {
    private val ctx = context.applicationContext
    private val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

    init {
        nm.createNotificationChannel(NotificationChannel(CH_MONITOR, "Monitoring", NotificationManager.IMPORTANCE_LOW).apply {
            description = "Shown while CHER monitors for emergency signals"
        })
        nm.createNotificationChannel(NotificationChannel(CH_HELP, "Nearby help requests", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "Someone nearby needs help"
            enableVibration(true)
        })
        nm.createNotificationChannel(NotificationChannel(CH_ALERT, "Emergency alerts", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "Are you OK checks and emergency status"
            enableVibration(true)
        })
    }

    private fun openApp(): PendingIntent = PendingIntent.getActivity(
        ctx, 0, Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_NEW_TASK),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    private fun action(name: String, code: Int): PendingIntent = PendingIntent.getBroadcast(
        ctx, code, Intent(ctx, NotificationActionReceiver::class.java).setAction(name), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    fun monitoring(text: String): Notification = NotificationCompat.Builder(ctx, CH_MONITOR)
        .setSmallIcon(R.drawable.ic_stat_cher)
        .setContentTitle("CHER")
        .setContentText(text)
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .setContentIntent(openApp())
        .setCategory(NotificationCompat.CATEGORY_SERVICE)
        .build()

    fun updateMonitoring(text: String) = notify(ID_MONITOR, monitoring(text))

    fun showCheckIn(seconds: Int) = notify(
        ID_ALERT,
        NotificationCompat.Builder(ctx, CH_ALERT)
            .setSmallIcon(R.drawable.ic_stat_cher)
            .setContentTitle("Are you OK?")
            .setContentText("Answer within ${seconds}s or CHER will ask for help")
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setOngoing(true)
            .setContentIntent(openApp())
            .addAction(0, "I'M OK", action(ACTION_OK, 1))
            .addAction(0, "NEED HELP", action(ACTION_NEED_HELP, 2))
            .build(),
    )

    fun showEscalating(seconds: Int) = notify(
        ID_ALERT,
        NotificationCompat.Builder(ctx, CH_ALERT)
            .setSmallIcon(R.drawable.ic_stat_cher)
            .setContentTitle("Sending SOS in ${seconds}s")
            .setContentText("Tap CANCEL if you are OK")
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setOngoing(true)
            .setContentIntent(openApp())
            .addAction(0, "CANCEL", action(ACTION_CANCEL_ESCALATION, 3))
            .build(),
    )

    fun showEmergency(title: String, text: String) = notify(
        ID_ALERT,
        NotificationCompat.Builder(ctx, CH_ALERT)
            .setSmallIcon(R.drawable.ic_stat_cher)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setOnlyAlertOnce(true)
            .setOngoing(true)
            .setContentIntent(openApp())
            .build(),
    )

    /** Full-screen intent so the pop-up appears even when the watch screen is off or another app is showing. */
    fun showHelpRequest(person: String, distance: String, direction: String) = notify(
        ID_HELP_REQUEST,
        NotificationCompat.Builder(ctx, CH_HELP)
            .setSmallIcon(R.drawable.ic_stat_cher)
            .setContentTitle("$person needs help")
            .setContentText("$distance $direction of you. Tap to respond")
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(openApp())
            .setFullScreenIntent(openApp(), true)
            .build(),
    )

    fun showHelping(text: String) = notify(
        ID_HELP,
        NotificationCompat.Builder(ctx, CH_ALERT)
            .setSmallIcon(R.drawable.ic_stat_cher)
            .setContentTitle("You are helping")
            .setContentText(text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(openApp())
            .build(),
    )

    fun cancelHelp() {
        nm.cancel(ID_HELP)
        nm.cancel(ID_HELP_REQUEST)
    }

    fun cancelAlerts() = nm.cancel(ID_ALERT)

    /**
     * True while the CHER screen is showing. Alert notifications are then pointless (the screen shows the same thing) and harmful:
     * Wear OS pops them up as a card over the bottom of the screen, exactly where the OK / SAFE / CANCEL buttons are, and the
     * card swallows the wearer's taps. They are posted again as soon as the screen goes away.
     */
    @Volatile var uiVisible: Boolean = false
        private set

    fun uiShown() {
        uiVisible = true
        nm.cancel(ID_ALERT)
        nm.cancel(ID_HELP_REQUEST)
    }

    fun uiHidden() {
        uiVisible = false
    }

    private fun notify(id: Int, n: Notification) {
        if (!PermissionHelper.hasNotifications(ctx)) return // degraded: the on-screen UI still works
        if (uiVisible && (id == ID_ALERT || id == ID_HELP_REQUEST)) return
        nm.notify(id, n)
    }

    companion object {
        const val CH_MONITOR = "cher_monitoring"
        const val CH_ALERT = "cher_alerts"
        const val ID_MONITOR = 1001
        const val ID_ALERT = 1002
        const val ID_HELP = 1003
        const val ID_HELP_REQUEST = 1004
        const val CH_HELP = "cher_help"
        const val ACTION_OK = "com.cher.watch.action.OK"
        const val ACTION_NEED_HELP = "com.cher.watch.action.NEED_HELP"
        const val ACTION_CANCEL_ESCALATION = "com.cher.watch.action.CANCEL_ESCALATION"
    }
}
