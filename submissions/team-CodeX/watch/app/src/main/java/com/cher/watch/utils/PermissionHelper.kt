package com.cher.watch.utils

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat

/** Runtime permissions CHER needs, each with the reason shown to the wearer before the system dialog. */
object PermissionHelper {
    const val HEALTH_READ_HEART_RATE = "android.permission.health.READ_HEART_RATE" // Wear OS 6+ (API 36+)

    data class Spec(val id: String, val title: String, val why: String, val permissions: List<String>)

    /** Heart rate uses the granular health permission on API 36+, and BODY_SENSORS before that. */
    private fun heartPermissions(): List<String> =
        if (Build.VERSION.SDK_INT >= 36) listOf(HEALTH_READ_HEART_RATE) else listOf(Manifest.permission.BODY_SENSORS)

    fun specs(): List<Spec> = buildList {
        add(Spec("location", "Location", "So CHER can tell your responder where you are during an emergency.",
            listOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)))
        add(Spec("heart", "Heart rate", "So CHER can notice an unusual heart-rate pattern. It never diagnoses anything.", heartPermissions()))
        add(Spec("call", "Emergency call", "So CHER can call 112 for you if nobody answers your SOS. It asks you first and never calls on its own from a reading.", listOf(Manifest.permission.CALL_PHONE)))
        if (Build.VERSION.SDK_INT >= 33) {
            add(Spec("notifications", "Notifications", "To show \"Are you OK?\" checks and emergency updates.", listOf(Manifest.permission.POST_NOTIFICATIONS)))
        }
    }

    fun isGranted(ctx: Context, permission: String) =
        ContextCompat.checkSelfPermission(ctx, permission) == PackageManager.PERMISSION_GRANTED

    fun isSpecGranted(ctx: Context, spec: Spec): Boolean =
        if (spec.id == "location") spec.permissions.any { isGranted(ctx, it) } else spec.permissions.all { isGranted(ctx, it) }

    fun missing(ctx: Context): List<Spec> = specs().filterNot { isSpecGranted(ctx, it) }

    fun hasLocation(ctx: Context) = isGranted(ctx, Manifest.permission.ACCESS_FINE_LOCATION) || isGranted(ctx, Manifest.permission.ACCESS_COARSE_LOCATION)
    fun hasFineLocation(ctx: Context) = isGranted(ctx, Manifest.permission.ACCESS_FINE_LOCATION)
    fun hasHeartRate(ctx: Context) = heartPermissions().all { isGranted(ctx, it) }
    fun hasNotifications(ctx: Context) = Build.VERSION.SDK_INT < 33 || isGranted(ctx, Manifest.permission.POST_NOTIFICATIONS)
}
