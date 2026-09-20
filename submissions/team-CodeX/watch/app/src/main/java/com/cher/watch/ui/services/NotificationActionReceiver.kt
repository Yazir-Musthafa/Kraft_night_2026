package com.cher.watch.ui.services

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Handles the buttons on the "Are you OK?" / "Sending SOS" notifications. */
class NotificationActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val runtime = CherRuntime.ensure(context)
        when (intent.action) {
            Notifier.ACTION_OK -> runtime.controller.userOk()
            Notifier.ACTION_NEED_HELP -> runtime.controller.userNeedsHelp()
            Notifier.ACTION_CANCEL_ESCALATION -> runtime.controller.cancelEscalation()
        }
    }
}
