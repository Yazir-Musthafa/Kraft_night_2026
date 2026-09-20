package com.cher.watch

import com.cher.watch.ui.emergency.SignalFusion
import com.cher.watch.ui.health.HeartRateAnalyzer
import com.cher.watch.ui.models.HeartAccuracy
import com.cher.watch.ui.models.HeartSample
import com.cher.watch.ui.models.HeartSource
import com.cher.watch.ui.models.MonitoringState
import com.cher.watch.ui.models.MotionEvent
import com.cher.watch.ui.models.MotionEventType
import com.cher.watch.ui.models.SignalType
import com.cher.watch.ui.models.TriggerType
import com.cher.watch.ui.sensors.MotionAnalyzer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DetectionTest {
    private val now = 1_000_000_000L

    private fun series(vals: List<Double>, acc: HeartAccuracy = HeartAccuracy.HIGH, spacing: Long = 5_000L) =
        vals.mapIndexed { i, v -> HeartSample(v, acc, now - (vals.size - 1 - i) * spacing, HeartSource.DEMO) }

    private val normal = List(50) { 70.0 + (it % 4) }

    @Test fun normalHeartRateIsNotAbnormal() {
        val a = HeartRateAnalyzer.analyze(series(normal), now)
        assertFalse(a.abnormal)
        assertEquals("STABLE", a.trend)
        assertTrue(a.baseline in 68..76)
    }

    @Test fun singleSpikeIsNotAbnormal() {
        val a = HeartRateAnalyzer.analyze(series(normal + 175.0), now)
        assertFalse(a.abnormal)
    }

    @Test fun sustainedHighAndLowAreFlagged() {
        val hi = HeartRateAnalyzer.analyze(series(normal + listOf(158.0, 160.0, 162.0, 159.0, 161.0, 163.0)), now)
        assertTrue(hi.abnormal); assertEquals("SUSTAINED_HIGH", hi.trend)
        val lo = HeartRateAnalyzer.analyze(series(normal + listOf(36.0, 37.0, 35.0, 36.0, 38.0, 37.0)), now)
        assertTrue(lo.abnormal); assertEquals("SUSTAINED_LOW", lo.trend)
    }

    @Test fun suddenRiseIsInformationalOnly() {
        val a = HeartRateAnalyzer.analyze(series(normal + listOf(80.0, 95.0, 112.0)), now)
        assertTrue(a.flags.suddenRise); assertFalse(a.abnormal)
    }

    @Test fun unreliableSamplesAreIgnoredAndStaleIsNotCurrent() {
        assertFalse(HeartRateAnalyzer.analyze(series(normal, HeartAccuracy.NO_CONTACT), now).available)
        assertEquals("STALE", HeartRateAnalyzer.analyze(series(normal), now + 10 * 60_000L).trend)
        assertFalse(HeartRateAnalyzer.analyze(emptyList(), now).available)
    }

    // --- motion --------------------------------------------------------------------------------
    private fun feed(m: MotionAnalyzer, fromMs: Long, toMs: Long, g: Float, stepMs: Long = 20L) {
        var t = fromMs
        while (t < toMs) { m.onAccelerometer(t, 0f, 0f, g * 9.80665f); t += stepMs }
    }

    @Test fun fallLikeMotionFreeFallThenImpact() {
        val events = mutableListOf<MotionEvent>()
        val m = MotionAnalyzer { events += it }
        feed(m, 0, 2000, 1.0f)
        feed(m, 2000, 2300, 0.1f)      // free-fall
        feed(m, 2300, 2340, 4.5f)      // impact
        assertTrue(events.any { it.type == MotionEventType.FALL_LIKE })
        assertTrue(events.any { it.type == MotionEventType.IMPACT })
    }

    @Test fun impactWithoutFreeFallIsFilteredWhenMovementContinues() {
        val events = mutableListOf<MotionEvent>()
        val m = MotionAnalyzer { events += it }
        feed(m, 0, 2000, 1.0f)
        feed(m, 2000, 2040, 3.0f)      // clap-like spike
        // wearer keeps moving vigorously
        var t = 2040L
        while (t < 8000) { m.onAccelerometer(t, 0f, 0f, (if ((t / 20) % 2 == 0L) 1.6f else 0.5f) * 9.80665f); t += 20; if (t % 1000 == 0L) m.tick(t) }
        m.tick(8000)
        assertTrue("no impact report for benign spike", events.none { it.type == MotionEventType.IMPACT })
    }

    @Test fun impactFollowedByStillnessIsReportedThenInactivity() {
        val events = mutableListOf<MotionEvent>()
        val m = MotionAnalyzer { events += it }
        feed(m, 0, 2000, 1.0f)
        feed(m, 2000, 2040, 3.0f)
        var t = 2040L
        while (t < 30_000) { m.onAccelerometer(t, 0f, 0f, 9.80665f); t += 20; if (t % 1000 == 0L) m.tick(t) }
        assertTrue(events.any { it.type == MotionEventType.IMPACT })
        assertTrue(events.any { it.type == MotionEventType.POST_IMPACT_INACTIVITY })
    }

    @Test fun hardImpactIsReportedEvenIfMovementContinues() {
        val events = mutableListOf<MotionEvent>()
        val m = MotionAnalyzer { events += it }
        feed(m, 0, 2000, 1.0f)
        feed(m, 2000, 2040, 5.0f)
        var t = 2040L
        while (t < 8000) { m.onAccelerometer(t, 0f, 0f, (if ((t / 20) % 2 == 0L) 1.6f else 0.5f) * 9.80665f); t += 20; if (t % 1000 == 0L) m.tick(t) }
        assertTrue(events.any { it.type == MotionEventType.IMPACT })
    }

    @Test fun unusualRotationIsReportedOnceThenCoolsDown() {
        val events = mutableListOf<MotionEvent>()
        val m = MotionAnalyzer { events += it }
        var t = 0L
        while (t < 3000) { m.onGyroscope(t, 12f, 0f, 0f); t += 20 }
        assertEquals(1, events.count { it.type == MotionEventType.UNUSUAL_MOTION })
    }

    // --- fusion --------------------------------------------------------------------------------
    @Test fun impactAloneDoesNotEscalateOrAutoSos() {
        val f = SignalFusion()
        f.onMotion(MotionEvent(MotionEventType.IMPACT, 3.0, 0, now))
        assertFalse("soft lone impact does not even ask", f.shouldCheckIn(now))
        f.onMotion(MotionEvent(MotionEventType.IMPACT, 5.0, 0, now))
        assertTrue("hard impact asks the user first", f.shouldCheckIn(now))
        // and without corroboration a no-response is not enough to escalate
        val soft = SignalFusion().also { it.onMotion(MotionEvent(MotionEventType.FALL_LIKE, 3.0, 0, now)) }
        assertTrue(soft.shouldCheckIn(now))
        assertFalse(soft.assessAfterNoResponse(now).state == MonitoringState.ESCALATING)
    }

    @Test fun fallImpactInactivityNoResponseEscalates() {
        val f = SignalFusion()
        f.onMotion(MotionEvent(MotionEventType.IMPACT, 4.2, 0, now))
        f.onMotion(MotionEvent(MotionEventType.FALL_LIKE, 4.2, 0, now))
        f.onMotion(MotionEvent(MotionEventType.POST_IMPACT_INACTIVITY, 4.2, 15, now))
        val a = f.assessAfterNoResponse(now)
        assertEquals(MonitoringState.ESCALATING, a.state)
        assertEquals(TriggerType.AUTO_MULTI_SIGNAL, f.triggerFor(a.signals))
    }

    @Test fun heartRateAloneNeedsLongPersistenceForACheckIn() {
        val f = SignalFusion()
        val abnormal = HeartRateAnalyzer.analyze(series(normal + listOf(158.0, 160.0, 162.0, 159.0, 161.0, 163.0)), now)
        f.onHeart(abnormal, now)
        assertFalse(f.shouldCheckIn(now))
        f.onHeart(abnormal, now + 130_000L)
        assertTrue(f.shouldCheckIn(now + 130_000L))
        assertEquals(TriggerType.AUTO_HEART_RATE_ANOMALY, f.triggerFor(setOf(SignalType.HEART_RATE_ABNORMAL, SignalType.NO_USER_RESPONSE)))
    }

    @Test fun signalsExpire() {
        val f = SignalFusion()
        f.onMotion(MotionEvent(MotionEventType.FALL_LIKE, 4.0, 0, now))
        assertTrue(f.active(now).isNotEmpty())
        assertTrue(f.active(now + 10 * 60_000L).isEmpty())
    }
}

/** The 90 / 110 heart-rate levels: a gentle suggestion band and an emergency path that needs the wearer to be at rest. */
class HeartLevelTest {
    private val now = 1_000_000_000L
    private fun series(vals: List<Double>) = vals.mapIndexed { i, v -> HeartSample(v, HeartAccuracy.HIGH, now - (vals.size - 1 - i) * 2_000L, HeartSource.DEMO) }
    private val baseline = List(40) { 70.0 + (it % 4) }

    @Test fun ninetySixAtRestIsElevatedButNotAbnormal() {
        val a = HeartRateAnalyzer.analyze(series(baseline + List(8) { 96.0 }), now)
        assertEquals(com.cher.watch.ui.models.HeartLevel.ELEVATED, a.level)
        assertFalse("96 bpm must stay in the gentle-suggestion band", a.abnormal)
    }

    @Test fun hundredAndEighteenIsHighAndSustainedAbnormal() {
        val a = HeartRateAnalyzer.analyze(series(baseline + List(8) { 118.0 }), now)
        assertEquals(com.cher.watch.ui.models.HeartLevel.HIGH, a.level)
        assertTrue(a.abnormal)
    }

    @Test fun ninetyIsNotElevatedForSomeoneWhoseUsualIsHigh() {
        val athleteBaseline = List(40) { 88.0 + (it % 3) }
        val a = HeartRateAnalyzer.analyze(series(athleteBaseline + List(8) { 92.0 }), now)
        assertEquals("92 is not 15% above a baseline of ~89", com.cher.watch.ui.models.HeartLevel.NORMAL, a.level)
    }

    @Test fun normalRateIsNormal() {
        assertEquals(com.cher.watch.ui.models.HeartLevel.NORMAL, HeartRateAnalyzer.analyze(series(baseline + List(8) { 74.0 }), now).level)
    }

    @Test fun highWhileRestingAsksAreYouOkAfterThirtySecondsButNotWhileMoving() {
        val f = SignalFusion()
        val a = HeartRateAnalyzer.analyze(series(baseline + List(8) { 118.0 }), now)
        f.onHeart(a, now, resting = true)
        assertFalse(f.shouldCheckIn(now))
        f.onHeart(a, now + 31_000L, resting = true)
        assertTrue("resting + 110+ for 30 s => check-in", f.shouldCheckIn(now + 31_000L))

        val g = SignalFusion()
        g.onHeart(a, now, resting = false)
        g.onHeart(a, now + 31_000L, resting = false)
        assertFalse("running/moving: a fast rate is normal and keeps the long persistence", g.shouldCheckIn(now + 31_000L))
    }

    @Test fun demoModeUsesShortPersistence() {
        val f = SignalFusion()
        val a = HeartRateAnalyzer.analyze(series(baseline + List(8) { 118.0 }), now)
        f.onHeart(a, now, resting = true)
        f.onHeart(a, now + 9_000L, resting = true)
        assertTrue(f.shouldCheckIn(now + 9_000L, demo = true))
        assertFalse(f.shouldCheckIn(now + 9_000L, demo = false))
    }

    @Test fun elevatedNeverCreatesACheckInByItself() {
        val f = SignalFusion()
        val a = HeartRateAnalyzer.analyze(series(baseline + List(8) { 96.0 }), now)
        f.onHeart(a, now, resting = true)
        f.onHeart(a, now + 600_000L, resting = true)
        assertFalse(f.shouldCheckIn(now + 600_000L, demo = true))
    }
}
