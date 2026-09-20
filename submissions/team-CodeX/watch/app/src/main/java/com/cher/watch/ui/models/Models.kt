package com.cher.watch.ui.models

import org.json.JSONArray
import org.json.JSONObject

/** Detection state machine: NORMAL -> POSSIBLE_ANOMALY -> VERIFYING -> ESCALATING -> ACTIVE_EMERGENCY. */
enum class MonitoringState { NORMAL, POSSIBLE_ANOMALY, VERIFYING, ESCALATING, ACTIVE_EMERGENCY }

enum class PowerMode { NORMAL, SAFE, EMERGENCY }

enum class ConnectionState { CONNECTED, CONNECTING, DISCONNECTED }

/** Independent evidence the detector can combine. Names match the server's SIGNAL_TYPES. */
enum class SignalType { HEART_RATE_ABNORMAL, IMPACT, FALL_LIKE_MOTION, INACTIVITY, UNUSUAL_MOTION, NO_USER_RESPONSE, USER_REQUESTED_HELP }

enum class TriggerType(val wire: String) {
    MANUAL_SOS("MANUAL_SOS"),
    USER_NEEDS_HELP("USER_NEEDS_HELP"),
    AUTO_FALL_NO_RESPONSE("AUTO_FALL_NO_RESPONSE"),
    AUTO_MULTI_SIGNAL("AUTO_MULTI_SIGNAL"),
    AUTO_HEART_RATE_ANOMALY("AUTO_HEART_RATE_ANOMALY"),
    AUTO_INACTIVITY("AUTO_INACTIVITY"),
}

enum class HeartAccuracy { HIGH, MEDIUM, LOW, UNRELIABLE, NO_CONTACT, UNKNOWN }

/** Where heart-rate data comes from; the UI never claims a source that is not really delivering. */
enum class HeartSource(val label: String) {
    HEALTH_SERVICES("Health Services"), SENSOR_MANAGER("Sensor"), DEMO("Demo"), NONE("None")
}

data class HeartSample(val bpm: Double?, val accuracy: HeartAccuracy, val timestamp: Long, val source: HeartSource)

data class HeartFlags(
    val high: Boolean = false,
    val low: Boolean = false,
    val suddenRise: Boolean = false,
    val suddenDrop: Boolean = false,
    val sustainedAbnormal: Boolean = false,
)

/** NORMAL, ELEVATED (above their usual, gentle suggestion) or HIGH (fast; normal check-in path when resting). Not a diagnosis. */
enum class HeartLevel { NORMAL, ELEVATED, HIGH }

data class HeartAnalysis(
    val available: Boolean,
    val current: Int?,
    val baseline: Int?,
    val deviationPct: Double?,
    val trend: String,
    val flags: HeartFlags,
    val signalQuality: Double,
    val sampleCount: Int,
    val level: HeartLevel = HeartLevel.NORMAL,
) {
    /** Only a *sustained* pattern is abnormal: one spike never is. */
    val abnormal: Boolean get() = flags.sustainedAbnormal

    companion object {
        val UNAVAILABLE = HeartAnalysis(false, null, null, null, "UNAVAILABLE", HeartFlags(), 0.0, 0)
    }
}

enum class MotionEventType { IMPACT, FALL_LIKE, POST_IMPACT_INACTIVITY, UNUSUAL_MOTION, LONG_INACTIVITY }

data class MotionEvent(val type: MotionEventType, val peakG: Double, val inactivitySeconds: Int, val timestamp: Long)

data class LocationFix(val latitude: Double, val longitude: Double, val accuracy: Float?, val timestamp: Long, val provider: String?) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("latitude", latitude)
        put("longitude", longitude)
        accuracy?.let { put("accuracy", it.toDouble()) }
        put("timestamp", timestamp)
        provider?.let { put("provider", it) }
    }
}

enum class LocationStatus { AVAILABLE, STALE, UNAVAILABLE, NO_PERMISSION }

/** "FIRST_RESPONDER" -> "First Responder". */
fun prettyRole(role: String?): String = role?.lowercase()?.split('_')?.joinToString(" ") { w -> w.replaceFirstChar { it.uppercase() } } ?: ""

/** One line of the server's response checklist. [state]: done | current | pending | skipped. */
data class ProgressStep(val label: String, val state: String)

data class ResponderView(val id: String, val name: String, val role: String?, val status: String)

/** Public emergency view as produced by the server (never contains phone numbers). */
data class EmergencyView(
    val id: String,
    val state: String,
    val priority: String,
    val summary: String,
    val triggerType: String,
    val responsiblePerson: String,
    val responsibleRole: String,
    val nextAction: String,
    val coveragePercent: Int,
    val contactStatus: String,
    val locationShared: Boolean,
    val responderName: String?,
    val responderRole: String?,
    val responderStatus: String?,
    val responders: List<ResponderView>,
    val retryCount: Int,
    val createdAt: Long,
    val lastUpdate: Long,
    val synced: Boolean,
    /** "Next follow-up in 20s": a visible timer for why the next step happens soon. Server-clock seconds at [receivedAt]. */
    val countdownLabel: String? = null,
    val countdownSeconds: Int = 0,
    val receivedAt: Long = System.currentTimeMillis(),
    val steps: List<ProgressStep> = emptyList(),
) {
    /** Seconds left, ticking down locally between server updates. */
    fun countdownLeft(nowMs: Long = System.currentTimeMillis()): Int =
        (countdownSeconds - ((nowMs - receivedAt) / 1000).toInt()).coerceAtLeast(0)

    val isTerminal: Boolean get() = state == "RESOLVED" || state == "CANCELLED"

    /** True once a human has taken the emergency: switches the UI to the response screen. */
    val hasResponder: Boolean
        get() = state in setOf("RESPONDER_ACCEPTED", "RESPONDER_MOVING", "PERSON_REACHED", "HELP_CONFIRMED", "RESPONDER_NEEDS_BACKUP") && responderName != null

    companion object {
        /** Placeholder shown immediately, before the server has confirmed (offline-first). */
        fun local(id: String, trigger: TriggerType, createdAt: Long) = EmergencyView(
            id = id, state = "ACTIVE", priority = "HIGH", summary = "SOS created on watch", triggerType = trigger.wire,
            responsiblePerson = "CHER (syncing)", responsibleRole = "Coordinator", nextAction = "Reaching the CHER backend",
            coveragePercent = 0, contactStatus = "Sending to CHER...", locationShared = false,
            responderName = null, responderRole = null, responderStatus = null, responders = emptyList(),
            retryCount = 0, createdAt = createdAt, lastUpdate = createdAt, synced = false,
        )

        fun fromJson(o: JSONObject): EmergencyView {
            val assigned = o.optJSONObject("assignedResponder")
            val list = mutableListOf<ResponderView>()
            val arr: JSONArray? = o.optJSONArray("responders")
            if (arr != null) for (i in 0 until arr.length()) {
                val r = arr.optJSONObject(i) ?: continue
                list += ResponderView(r.optString("responderId"), r.optString("name"), r.optString("role").ifEmpty { null }, r.optString("status"))
            }
            val cd = o.optJSONObject("countdown")
            val stepList = mutableListOf<ProgressStep>()
            o.optJSONArray("progress")?.let { a -> for (i in 0 until a.length()) a.optJSONObject(i)?.let { stepList += ProgressStep(it.optString("label"), it.optString("state")) } }
            return EmergencyView(
                id = o.getString("id"),
                state = o.optString("state", "ACTIVE"),
                priority = o.optString("priority", "HIGH"),
                summary = o.optString("summary", ""),
                triggerType = o.optString("triggerType", ""),
                responsiblePerson = o.optString("responsiblePerson", "CHER Coordinator"),
                responsibleRole = o.optString("responsibleRole", ""),
                nextAction = o.optString("nextAction", ""),
                coveragePercent = o.optJSONObject("coverage")?.optInt("percent", 0) ?: 0,
                contactStatus = o.optString("contactStatus", ""),
                locationShared = o.optBoolean("locationShared", false),
                responderName = assigned?.optString("name")?.ifEmpty { null },
                responderRole = assigned?.optString("role")?.ifEmpty { null },
                responderStatus = assigned?.optString("status")?.ifEmpty { null },
                responders = list,
                retryCount = o.optInt("retryCount", 0),
                createdAt = o.optLong("createdAt", 0L),
                lastUpdate = o.optLong("lastUpdate", 0L),
                synced = true,
                countdownLabel = cd?.optString("label")?.ifEmpty { null },
                countdownSeconds = cd?.optInt("seconds", 0) ?: 0,
                steps = stepList,
            )
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Nearby-helper flow (this watch helping somebody else). Server side: server/src/nearby.js.

/** A position on the map, in degrees. */
data class GeoPoint(val latitude: Double, val longitude: Double, val accuracy: Float? = null, val timestamp: Long = 0L) {
    companion object {
        fun fromJson(o: JSONObject?): GeoPoint? {
            o ?: return null
            if (!o.has("latitude") || !o.has("longitude")) return null
            return GeoPoint(o.getDouble("latitude"), o.getDouble("longitude"), if (o.isNull("accuracy")) null else o.optDouble("accuracy").toFloat(), o.optLong("timestamp", 0L))
        }
    }
}

/**
 * The pop-up shown before accepting: how far away and in which rough direction. The exact spot is only sent after
 * the wearer taps CAN HELP. [deadlineMs] is on this watch's clock (computed from the server's remaining time).
 */
data class HelpRequest(
    val emergencyId: String,
    val personName: String,
    val distanceM: Int,
    val direction: String,
    val priority: String,
    val deadlineMs: Long,
    val totalMs: Long,
) {
    companion object {
        /** @param serverNowMs the server clock at the time the message was produced (skew-proof countdown) */
        fun fromJson(o: JSONObject, serverNowMs: Long, localNowMs: Long = System.currentTimeMillis()): HelpRequest {
            val waitMs = o.optLong("waitSeconds", 45L) * 1000
            val remaining = (o.optLong("expiresAt", serverNowMs + waitMs) - serverNowMs).coerceIn(0L, waitMs + 5_000)
            return HelpRequest(
                emergencyId = o.getString("emergencyId"),
                personName = o.optString("personName", "Someone").ifEmpty { "Someone" },
                distanceM = o.optInt("distanceM", 0),
                direction = o.optString("direction", ""),
                priority = o.optString("priority", "HIGH"),
                deadlineMs = localNowMs + remaining,
                totalMs = waitMs,
            )
        }
    }
}

/** Live view of the emergency for a helper who accepted: where the person is and how the response stands. */
data class HelpAssignment(
    val emergencyId: String,
    val personName: String,
    val state: String,
    val priority: String,
    val responderStatus: String,
    val role: String,
    val location: GeoPoint?,
    val updatedAt: Long,
    /** Plain-words reason (never a diagnosis): "The person pressed SOS", "A possible fall was detected and there was no reply". */
    val situation: String? = null,
) {
    /** The wearer has reported arriving (or the emergency moved past that point). */
    val arrived: Boolean get() = responderStatus == "REACHED" || state == "PERSON_REACHED" || state == "HELP_CONFIRMED"

    fun withLocation(loc: GeoPoint?, state: String, updatedAt: Long) = copy(location = loc ?: location, state = state, updatedAt = updatedAt)

    companion object {
        fun fromJson(o: JSONObject) = HelpAssignment(
            emergencyId = o.getString("emergencyId"),
            personName = o.optString("personName", "the person").ifEmpty { "the person" },
            state = o.optString("state", ""),
            priority = o.optString("priority", "HIGH"),
            responderStatus = o.optString("responderStatus", "MOVING"),
            role = o.optString("role", "FIRST_RESPONDER"),
            location = GeoPoint.fromJson(o.optJSONObject("location")),
            updatedAt = o.optLong("updatedAt", System.currentTimeMillis()),
            situation = o.optString("situation").ifEmpty { null },
        )
    }
}

/** "Still on your way?" (STATUS) or "Is the person OK?" (CONFIRM), answered on the watch instead of a phone call. */
data class HelpCheckIn(val type: String, val deadlineMs: Long, val totalMs: Long)
