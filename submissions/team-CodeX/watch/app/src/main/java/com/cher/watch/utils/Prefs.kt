package com.cher.watch.utils

import android.content.Context
import android.content.SharedPreferences
import com.cher.watch.BuildConfig

/** Small settings store. The server URL/API token defaults come from BuildConfig and can be overridden at runtime. */
class Prefs(context: Context) {
    private val sp: SharedPreferences = context.getSharedPreferences("cher_prefs", Context.MODE_PRIVATE)

    var serverUrl: String
        get() = sp.getString(K_URL, null)?.takeIf { it.isNotBlank() } ?: BuildConfig.CHER_SERVER_URL
        set(v) = sp.edit().putString(K_URL, v.trim().trimEnd('/')).apply()

    val apiKey: String get() = BuildConfig.CHER_API_KEY

    var watchId: String
        get() = sp.getString(K_WATCH, null)?.takeIf { it.isNotBlank() } ?: BuildConfig.CHER_WATCH_ID
        set(v) = sp.edit().putString(K_WATCH, v.trim()).apply()

    var demoMode: Boolean
        get() = sp.getBoolean(K_DEMO, false)
        set(v) = sp.edit().putBoolean(K_DEMO, v).apply()

    /** true = force SAFE mode; false = automatic (battery based). */
    var forceSafeMode: Boolean
        get() = sp.getBoolean(K_SAFE, false)
        set(v) = sp.edit().putBoolean(K_SAFE, v).apply()

    /** Receive a pop-up when someone nearby needs help (this watch becomes a possible helper). */
    var nearbyAlerts: Boolean
        get() = sp.getBoolean(K_NEARBY, true)
        set(v) = sp.edit().putBoolean(K_NEARBY, v).apply()

    // ---- AI assistance -------------------------------------------------------------------------
    /** Master switch: short AI suggestions on the watch (heart rate, own emergency, helping someone). Off = nothing is sent to the AI. */
    var aiMode: Boolean
        get() = sp.getBoolean(K_AI, true)
        set(v) = sp.edit().putBoolean(K_AI, v).apply()
    var aiVoice: Boolean
        get() = sp.getBoolean(K_AI_VOICE, true)
        set(v) = sp.edit().putBoolean(K_AI_VOICE, v).apply()
    var aiHealth: Boolean
        get() = sp.getBoolean(K_AI_HEALTH, true)
        set(v) = sp.edit().putBoolean(K_AI_HEALTH, v).apply()
    var aiEmergency: Boolean
        get() = sp.getBoolean(K_AI_EMERGENCY, true)
        set(v) = sp.edit().putBoolean(K_AI_EMERGENCY, v).apply()
    /** After an explicit SOS, if nobody answers the watch calls 112 (never from a heart-rate reading alone; never in demo mode). */
    var call112: Boolean
        get() = sp.getBoolean(K_112, true)
        set(v) = sp.edit().putBoolean(K_112, v).apply()

    /** "Nearby Responder Alerts": may CHER ask nearby watches to help when *I* have an emergency (off = contacts are called at once). */
    var broadcastNearby: Boolean
        get() = sp.getBoolean(K_BROADCAST, true)
        set(v) = sp.edit().putBoolean(K_BROADCAST, v).apply()

    /** Shown to the person being helped. */
    var helperName: String
        get() = sp.getString(K_HELPER_NAME, null)?.takeIf { it.isNotBlank() } ?: "Nearby helper"
        set(v) = sp.edit().putString(K_HELPER_NAME, v.trim().take(40)).apply()

    var permissionsPromptShown: Boolean
        get() = sp.getBoolean(K_PERM_SHOWN, false)
        set(v) = sp.edit().putBoolean(K_PERM_SHOWN, v).apply()

    private companion object {
        const val K_URL = "server_url"
        const val K_WATCH = "watch_id"
        const val K_DEMO = "demo_mode"
        const val K_SAFE = "force_safe"
        const val K_PERM_SHOWN = "perm_shown"
        const val K_NEARBY = "nearby_alerts"
        const val K_AI = "ai_mode"
        const val K_AI_VOICE = "ai_voice"
        const val K_AI_HEALTH = "ai_health"
        const val K_AI_EMERGENCY = "ai_emergency"
        const val K_112 = "call_112"
        const val K_BROADCAST = "nearby_broadcast"
        const val K_HELPER_NAME = "helper_name"
    }
}
