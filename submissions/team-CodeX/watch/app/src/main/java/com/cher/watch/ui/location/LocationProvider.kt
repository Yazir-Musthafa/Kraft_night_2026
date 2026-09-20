package com.cher.watch.ui.location

import android.annotation.SuppressLint
import android.content.Context
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.core.content.ContextCompat
import com.cher.watch.ui.models.LocationFix
import com.cher.watch.ui.models.LocationStatus
import com.cher.watch.ui.models.PowerMode
import com.cher.watch.utils.CherConfig as C
import com.cher.watch.utils.PermissionHelper

/**
 * Native android.location only (no Play Services, no map SDKs, no routing).
 * Update frequency follows the power mode: sparse when idle, frequent and high-accuracy in an emergency.
 */
class LocationProvider(context: Context, private val onFix: (LocationFix) -> Unit) {
    private val ctx = context.applicationContext
    private val lm = ctx.getSystemService(Context.LOCATION_SERVICE) as LocationManager
    private val main = Handler(Looper.getMainLooper())

    var lastFix: LocationFix? = null
        private set
    private var mode: PowerMode = PowerMode.NORMAL
    private var running = false

    private val listener = object : LocationListener {
        override fun onLocationChanged(location: Location) = handle(location)
        override fun onProviderEnabled(provider: String) {}
        override fun onProviderDisabled(provider: String) {}
    }

    fun status(nowMs: Long = System.currentTimeMillis()): LocationStatus {
        if (!PermissionHelper.hasLocation(ctx)) return LocationStatus.NO_PERMISSION
        val fix = lastFix ?: return LocationStatus.UNAVAILABLE
        return if (nowMs - fix.timestamp <= C.LOCATION_STALE_MS) LocationStatus.AVAILABLE else LocationStatus.STALE
    }

    fun start(mode: PowerMode) {
        this.mode = mode
        running = true
        register()
        seedFromLastKnown()
    }

    fun stop() {
        running = false
        try {
            lm.removeUpdates(listener)
        } catch (e: SecurityException) {
            Log.w(TAG, "removeUpdates", e)
        }
    }

    fun setMode(mode: PowerMode) {
        if (this.mode == mode && running) return
        this.mode = mode
        if (running) register()
    }

    fun permissionChanged() {
        if (running) {
            register()
            seedFromLastKnown()
        }
    }

    /** Emergency: ask for one fresh high-accuracy fix right now (in addition to regular updates). */
    @SuppressLint("MissingPermission")
    fun requestFreshFix() {
        if (!PermissionHelper.hasLocation(ctx)) return
        val provider = bestProvider() ?: return
        try {
            if (Build.VERSION.SDK_INT >= 30) {
                lm.getCurrentLocation(provider, null, ContextCompat.getMainExecutor(ctx)) { loc -> if (loc != null) handle(loc) }
            }
        } catch (e: Exception) {
            Log.w(TAG, "getCurrentLocation failed", e)
        }
    }

    @SuppressLint("MissingPermission")
    private fun register() {
        try {
            lm.removeUpdates(listener)
        } catch (e: SecurityException) {
            return
        }
        if (!PermissionHelper.hasLocation(ctx)) return
        val (intervalMs, minDistM) = when (mode) {
            PowerMode.NORMAL -> 120_000L to 25f
            PowerMode.SAFE -> 600_000L to 100f
            PowerMode.EMERGENCY -> 5_000L to 0f
        }
        val providers = buildList {
            val fine = PermissionHelper.hasFineLocation(ctx)
            if (mode == PowerMode.EMERGENCY && fine && lm.isProviderEnabled(LocationManager.GPS_PROVIDER)) add(LocationManager.GPS_PROVIDER)
            if (Build.VERSION.SDK_INT >= 31 && lm.isProviderEnabled(LocationManager.FUSED_PROVIDER)) add(LocationManager.FUSED_PROVIDER)
            if (lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) add(LocationManager.NETWORK_PROVIDER)
            if (isEmpty() && fine && lm.isProviderEnabled(LocationManager.GPS_PROVIDER)) add(LocationManager.GPS_PROVIDER)
        }
        for (p in providers) {
            try {
                lm.requestLocationUpdates(p, intervalMs, minDistM, listener, Looper.getMainLooper())
            } catch (e: Exception) {
                Log.w(TAG, "requestLocationUpdates($p) failed", e)
            }
        }
    }

    @SuppressLint("MissingPermission")
    private fun bestProvider(): String? {
        if (PermissionHelper.hasFineLocation(ctx) && lm.isProviderEnabled(LocationManager.GPS_PROVIDER)) return LocationManager.GPS_PROVIDER
        if (Build.VERSION.SDK_INT >= 31 && lm.isProviderEnabled(LocationManager.FUSED_PROVIDER)) return LocationManager.FUSED_PROVIDER
        if (lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) return LocationManager.NETWORK_PROVIDER
        return null
    }

    @SuppressLint("MissingPermission")
    private fun seedFromLastKnown() {
        if (!PermissionHelper.hasLocation(ctx)) return
        try {
            val best = lm.getProviders(true).mapNotNull { lm.getLastKnownLocation(it) }.maxByOrNull { it.time }
            if (best != null && (lastFix == null || best.time > lastFix!!.timestamp)) handle(best)
        } catch (e: Exception) {
            Log.w(TAG, "last known failed", e)
        }
    }

    private fun handle(loc: Location) {
        val fix = LocationFix(loc.latitude, loc.longitude, if (loc.hasAccuracy()) loc.accuracy else null, if (loc.time > 0) loc.time else System.currentTimeMillis(), loc.provider)
        val prev = lastFix
        if (prev != null && fix.timestamp <= prev.timestamp) return
        lastFix = fix
        onFix(fix)
    }

    private companion object {
        const val TAG = "CHER/Location"
    }
}
