package com.cher.watch

import com.cher.watch.ui.emergency.Call112Policy
import com.cher.watch.utils.CherConfig as C
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The 112 fallback must be impossible to trigger without the wearer's explicit SOS, and only when nobody has answered. */
class Call112PolicyTest {
    private val late = C.NO_ANSWER_112_MS + 1

    private fun arm(trigger: String = "MANUAL_SOS", state: String = "RESPONDER_SEARCHING", responder: Boolean = false, age: Long = late, demo: Boolean = false, enabled: Boolean = true) =
        Call112Policy.shouldArm(enabled, trigger, state, responder, age, demo)

    @Test fun explicitSosWithNobodyAnsweringArmsAfterTheWait() {
        assertTrue(arm())
        assertTrue(arm(trigger = "USER_NEEDS_HELP"))
    }

    @Test fun automaticTriggersNeverArm() {
        for (t in listOf("AUTO_HEART_RATE_ANOMALY", "AUTO_FALL_NO_RESPONSE", "AUTO_MULTI_SIGNAL", "AUTO_INACTIVITY")) {
            assertFalse("$t must never start a 112 call by itself", arm(trigger = t))
            assertFalse(arm(trigger = t, state = "UNCONFIRMED"))
        }
    }

    @Test fun neverBeforeTheWaitHasPassed() {
        assertFalse(arm(age = 5_000))
        assertFalse(arm(age = C.NO_ANSWER_112_MS - 1))
    }

    @Test fun anAcceptedResponderStopsIt() {
        assertFalse(arm(responder = true))
        assertFalse(arm(responder = true, state = "UNCONFIRMED"))
    }

    @Test fun unconfirmedArmsRightAway() {
        assertTrue(arm(state = "UNCONFIRMED", age = 10_000))
    }

    @Test fun offSwitchWins() {
        assertFalse(arm(enabled = false))
        assertFalse(arm(enabled = false, state = "UNCONFIRMED"))
    }

    @Test fun demoModeUsesTheShortWait() {
        assertTrue(arm(demo = true, age = C.DEMO_NO_ANSWER_112_MS + 1))
        assertFalse(arm(demo = false, age = C.DEMO_NO_ANSWER_112_MS + 1))
    }
}
