package com.cher.watch.utils

import kotlin.math.abs
import kotlin.math.asin
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sqrt

/** Plain geodesy for on-watch directions. No map or routing API: straight-line guidance from two coordinates. */
object Geo {
    private const val EARTH_M = 6_371_000.0
    const val WALK_SPEED_MS = 1.4 // ~5 km/h

    private fun rad(d: Double) = Math.toRadians(d)

    fun distanceM(lat1: Double, lon1: Double, lat2: Double, lon2: Double): Double {
        val dLat = rad(lat2 - lat1)
        val dLon = rad(lon2 - lon1)
        val h = sin(dLat / 2).let { it * it } + cos(rad(lat1)) * cos(rad(lat2)) * sin(dLon / 2).let { it * it }
        return 2 * EARTH_M * asin(sqrt(h.coerceIn(0.0, 1.0)))
    }

    /** Initial bearing from point 1 to point 2, degrees clockwise from true north in [0, 360). */
    fun bearingDeg(lat1: Double, lon1: Double, lat2: Double, lon2: Double): Double {
        val y = sin(rad(lon2 - lon1)) * cos(rad(lat2))
        val x = cos(rad(lat1)) * sin(rad(lat2)) - sin(rad(lat1)) * cos(rad(lat2)) * cos(rad(lon2 - lon1))
        return (Math.toDegrees(atan2(y, x)) + 360.0) % 360.0
    }

    /** Offset of point 2 from point 1 in metres on the local tangent plane: (east, north). Accurate for map-sized areas. */
    fun eastNorthM(lat1: Double, lon1: Double, lat2: Double, lon2: Double): Pair<Double, Double> {
        val north = rad(lat2 - lat1) * EARTH_M
        val east = rad(lon2 - lon1) * EARTH_M * cos(rad((lat1 + lat2) / 2))
        return east to north
    }

    private val POINTS = arrayOf("N", "NE", "E", "SE", "S", "SW", "W", "NW")
    fun compass8(bearing: Double): String = POINTS[((((bearing % 360) + 360) % 360) / 45.0).roundToInt() % 8]

    private val LONG = mapOf("N" to "NORTH", "NE" to "NORTH-EAST", "E" to "EAST", "SE" to "SOUTH-EAST", "S" to "SOUTH", "SW" to "SOUTH-WEST", "W" to "WEST", "NW" to "NORTH-WEST")
    fun compassWord(point: String): String = LONG[point] ?: point

    /** Smallest signed difference a - b in (-180, 180]. */
    fun angleDiff(a: Double, b: Double): Double {
        var d = (a - b) % 360.0
        if (d > 180) d -= 360
        if (d <= -180) d += 360
        return d
    }

    fun formatDistance(m: Double): String = when {
        m < 0 -> "--"
        m < 10 -> "${m.roundToInt()} m"
        m < 1000 -> "${(m / 5).roundToInt() * 5} m"
        m < 10_000 -> "%.1f km".format(java.util.Locale.US, m / 1000)
        else -> "${(m / 1000).roundToInt()} km"
    }

    /** "1 min", "4 min", "1 h 5 min"; never claims precision it does not have. */
    fun walkTime(m: Double): String {
        val min = (m / WALK_SPEED_MS / 60.0).roundToInt().coerceAtLeast(1)
        return if (min < 60) "$min min" else "${min / 60} h ${min % 60} min"
    }

    fun isClose(m: Double) = m in 0.0..CLOSE_M
    const val CLOSE_M = 30.0

    /** Low-pass filter for compass headings that handles the 359° -> 0° wrap. */
    fun smoothHeading(prev: Double?, next: Double, alpha: Double = 0.18): Double {
        if (prev == null) return next
        val d = angleDiff(next, prev)
        return ((prev + alpha * d) % 360.0 + 360.0) % 360.0
    }

    fun absDiff(a: Double, b: Double) = abs(angleDiff(a, b))
}
