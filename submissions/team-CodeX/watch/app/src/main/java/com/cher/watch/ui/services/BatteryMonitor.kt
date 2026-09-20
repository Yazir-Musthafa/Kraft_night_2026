package com.cher.watch.ui.services

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import androidx.core.content.ContextCompat

/** Tracks battery level and charging state from the sticky ACTION_BATTERY_CHANGED broadcast. */
class BatteryMonitor(context: Context, private val onChange: () -> Unit) {
    private val ctx = context.applicationContext
    var percent: Int = 100
        private set
    var charging: Boolean = false
        private set
    private var registered = false

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            if (read(intent)) onChange()
        }
    }

    private fun read(i: Intent): Boolean {
        val level = i.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
        val scale = i.getIntExtra(BatteryManager.EXTRA_SCALE, 100)
        val status = i.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
        val pct = if (level >= 0 && scale > 0) level * 100 / scale else percent
        val chg = status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL
        val changed = pct != percent || chg != charging
        percent = pct
        charging = chg
        return changed
    }

    fun start() {
        if (registered) return
        registered = true
        val sticky = ContextCompat.registerReceiver(ctx, receiver, IntentFilter(Intent.ACTION_BATTERY_CHANGED), ContextCompat.RECEIVER_NOT_EXPORTED)
        sticky?.let { read(it) }
    }

    fun stop() {
        if (!registered) return
        registered = false
        try { ctx.unregisterReceiver(receiver) } catch (_: IllegalArgumentException) {}
    }
}
