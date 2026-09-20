package com.cher.watch

import com.cher.watch.ui.models.EmergencyView
import com.cher.watch.ui.models.HelpAssignment
import com.cher.watch.ui.models.HelpRequest
import com.cher.watch.utils.Geo
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Directions maths and the nearby-help models. `isReturnDefaultValues` lets org.json stubs run on the JVM only where needed. */
class NearbyHelpTest {
    private val lat = 37.422
    private val lon = -122.084

    @Test fun distanceAndBearingDueNorth() {
        val north = lat + 300 / 111_320.0
        assertEquals(300.0, Geo.distanceM(lat, lon, north, lon), 1.0)
        assertEquals(0.0, Geo.bearingDeg(lat, lon, north, lon), 0.01)
        assertEquals(180.0, Geo.bearingDeg(north, lon, lat, lon), 0.01)
        assertEquals("N", Geo.compass8(359.0))
        assertEquals("SW", Geo.compass8(225.0))
    }

    @Test fun eastNorthOffsetMatchesDistance() {
        val (e, n) = Geo.eastNorthM(lat, lon, lat + 0.001, lon + 0.001)
        assertTrue(e > 80 && e < 95)
        assertTrue(n > 105 && n < 115)
    }

    @Test fun angleDiffWrapsAround() {
        assertEquals(20.0, Geo.angleDiff(10.0, 350.0), 1e-9)
        assertEquals(-20.0, Geo.angleDiff(350.0, 10.0), 1e-9)
        assertEquals(180.0, Geo.angleDiff(180.0, 0.0), 1e-9)
    }

    @Test fun headingSmoothingDoesNotSpinTheLongWay() {
        val next = Geo.smoothHeading(359.0, 1.0, alpha = 0.5)
        assertTrue("stays near north, not near 180: $next", next > 359.0 || next < 2.0)
    }

    @Test fun formatting() {
        assertEquals("45 m", Geo.formatDistance(44.0))
        assertEquals("300 m", Geo.formatDistance(301.0))
        assertEquals("1.2 km", Geo.formatDistance(1234.0))
        assertEquals("4 min", Geo.walkTime(300.0))
        assertEquals("1 min", Geo.walkTime(10.0))
        assertTrue(Geo.isClose(20.0))
        assertFalse(Geo.isClose(80.0))
    }

    @Test fun helpRequestCountdownUsesServerRemainingTimeNotTheClock() {
        // The server clock is 5 minutes ahead of this watch: the countdown must still be 30 s, not 5 min.
        val serverNow = 1_000_000_000L
        val json = JSONObject().put("emergencyId", "E-1").put("distanceM", 300).put("direction", "S").put("waitSeconds", 45).put("expiresAt", serverNow + 30_000)
        val local = 5_000L
        val r = HelpRequest.fromJson(json, serverNow, local)
        assertEquals(local + 30_000, r.deadlineMs)
        assertEquals(45_000, r.totalMs)
        assertEquals("S", r.direction)
    }

    @Test fun helpAssignmentParsesLocationAndArrival() {
        val a = HelpAssignment.fromJson(
            JSONObject().put("emergencyId", "E-1").put("state", "RESPONDER_MOVING").put("responderStatus", "MOVING")
                .put("location", JSONObject().put("latitude", lat).put("longitude", lon).put("accuracy", 6.0).put("timestamp", 5L)),
        )
        assertNotNull(a.location)
        assertEquals(6f, a.location!!.accuracy!!, 0.01f)
        assertFalse(a.arrived)
        assertTrue(a.copy(responderStatus = "REACHED").arrived)
        assertNull(HelpAssignment.fromJson(JSONObject().put("emergencyId", "E-1")).location)
    }

    @Test fun updateWithoutLocationKeepsTheLastKnownPosition() {
        val a = HelpAssignment.fromJson(JSONObject().put("emergencyId", "E-1").put("location", JSONObject().put("latitude", lat).put("longitude", lon)))
        val b = a.withLocation(null, "PERSON_REACHED", 9L)
        assertEquals(lat, b.location!!.latitude, 1e-9)
        assertEquals("PERSON_REACHED", b.state)
    }

    @Test fun emergencyViewReadsCountdownAndChecklist() {
        val o = JSONObject().put("id", "E-1").put("state", "RESPONDER_SEARCHING")
            .put("countdown", JSONObject().put("label", "Waiting for a nearby helper").put("seconds", 40))
            .put("progress", org.json.JSONArray().put(JSONObject().put("label", "Recorded").put("state", "done")).put("Malformed"))
        val v = EmergencyView.fromJson(o)
        assertEquals("Waiting for a nearby helper", v.countdownLabel)
        assertEquals(40, v.countdownLeft(v.receivedAt))
        assertEquals(37, v.countdownLeft(v.receivedAt + 3_000))
        assertEquals(0, v.countdownLeft(v.receivedAt + 90_000))
        assertEquals(1, v.steps.size)
        assertEquals("done", v.steps[0].state)
    }
}
