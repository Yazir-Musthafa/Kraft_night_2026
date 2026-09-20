package com.cher.watch.ui.services

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.cher.watch.utils.PermissionHelper

/**
 * Foreground service that keeps CHER monitoring while the screen is off or the app is not visible.
 * The OS decides what it actually allows: if the service cannot start (permissions, battery restrictions)
 * the runtime keeps running only while the app process lives, and the UI says so ("DEGRADED").
 */
class MonitoringService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val runtime = CherRuntime.ensure(this)
        val type = foregroundTypes(this)
        try {
            ServiceCompat.startForeground(this, Notifier.ID_MONITOR, runtime.notifier.monitoring(runtime.statusLine()), type)
            runtime.setBackgroundGuaranteed(true)
        } catch (e: Exception) {
            // ForegroundServiceStartNotAllowed / SecurityException (missing runtime permission for the type).
            Log.w(TAG, "Foreground start refused: ${e.javaClass.simpleName}: ${e.message}")
            runtime.setBackgroundGuaranteed(false)
            stopSelf()
            return START_NOT_STICKY
        }
        return START_STICKY
    }

    override fun onDestroy() {
        CherRuntime.current?.setBackgroundGuaranteed(false)
        super.onDestroy()
    }

    companion object {
        private const val TAG = "CHER/Service"

        /** Foreground-service type mask for what is actually permitted right now (0 = cannot run in foreground). */
        fun foregroundTypes(ctx: Context): Int {
            var t = 0
            if (Build.VERSION.SDK_INT >= 29 && PermissionHelper.hasLocation(ctx)) t = t or ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
            if (Build.VERSION.SDK_INT >= 34 && PermissionHelper.hasHeartRate(ctx)) t = t or ServiceInfo.FOREGROUND_SERVICE_TYPE_HEALTH
            return t
        }

        fun canRunInForeground(ctx: Context) = foregroundTypes(ctx) != 0

        fun start(ctx: Context) {
            if (!canRunInForeground(ctx)) {
                CherRuntime.ensure(ctx).setBackgroundGuaranteed(false)
                return
            }
            try {
                ContextCompat.startForegroundService(ctx, Intent(ctx, MonitoringService::class.java))
            } catch (e: Exception) {
                Log.w(TAG, "startForegroundService refused: ${e.message}")
                CherRuntime.ensure(ctx).setBackgroundGuaranteed(false)
            }
        }

        fun stop(ctx: Context) {
            ctx.stopService(Intent(ctx, MonitoringService::class.java))
        }
    }
}
