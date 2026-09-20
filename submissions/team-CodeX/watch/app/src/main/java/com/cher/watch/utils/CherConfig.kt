package com.cher.watch.utils

/**
 * Every tunable threshold and timing lives here, with the reasoning next to it.
 * The server keeps a matching heart-rate set in server/src/config.js ("thresholds"); keep them in sync.
 */
object CherConfig {
    // ---- Heart rate ---------------------------------------------------------------------------
    const val HR_MIN_VALID_BPM = 25.0            // below this a reading is a sensor artefact
    const val HR_MAX_VALID_BPM = 240.0           // above this a reading is a sensor artefact
    const val HR_HIGH_ABSOLUTE = 150.0           // resting-ish absolute ceiling for "unusually high"
    const val HR_LOW_ABSOLUTE = 40.0             // absolute floor for "unusually low"
    const val HR_DEVIATION_PCT = 0.35            // 35% away from the personal rolling baseline
    const val HR_SUDDEN_DELTA_BPM = 30.0         // change within HR_SUDDEN_WINDOW_SAMPLES => sudden rise/drop
    const val HR_SUDDEN_WINDOW_SAMPLES = 4
    const val HR_PERSISTENCE_SAMPLES = 5         // samples in a row that must be abnormal (no single-spike SOS)
    const val HR_BASELINE_WINDOW = 60            // samples considered for the baseline
    const val HR_RECENT_WINDOW = 6               // most recent samples excluded from the baseline
    const val HR_BASELINE_MIN_SAMPLES = 12       // below this, only absolute limits apply
    const val HR_STALE_MS = 60_000L              // a reading older than this is not "current"
    const val HR_HISTORY_MAX = 240               // samples kept in memory
    const val HR_CHECKIN_PERSIST_MS = 120_000L   // abnormal HR this long => ask "Are you OK?" (never SOS by itself)

    // Heart-rate levels (resting adults are normally 60-100 bpm; above 100 at rest is "fast"). Reported as observations only.
    const val HR_ELEVATED_ABS = 90               // at rest, at least this high AND ...
    const val HR_ELEVATED_REL = 0.15             // ... 15% above the wearer's own baseline => "elevated": a gentle AI suggestion
    const val HR_RESTING_HIGH = 110              // at rest => "high": normal Are-you-OK check-in path (never an SOS by itself)
    const val HR_RESTING_QUIET_S = 20            // no notable movement for this long counts as resting
    const val HR_HIGH_REST_CHECKIN_MS = 30_000L  // high while resting this long => check-in (150+ still needs 2 min)
    const val DEMO_HR_CHECKIN_PERSIST_MS = 8_000L

    // ---- Motion -------------------------------------------------------------------------------
    const val GRAVITY = 9.80665f
    const val FREE_FALL_G = 0.45                 // |a| below this = weightlessness
    const val FREE_FALL_MIN_MS = 60L             // ...for at least this long
    const val FREE_FALL_TO_IMPACT_MS = 1_200L    // impact this soon after free-fall => fall-like
    const val IMPACT_G = 2.5                     // spike considered an impact
    const val HARD_IMPACT_G = 4.0                // impact this hard is reported even without stillness
    const val IMPACT_OBSERVE_MS = 4_000L         // watch what happens after an impact-only spike
    const val IMPACT_SKIP_MS = 400L              // ignore the ringing right after the spike
    const val STILL_ENERGY_G = 0.07              // mean |g-1| below this = "still"
    const val MOVING_G = 0.12                    // |g-1| above this counts as movement
    const val POST_IMPACT_STILL_SECONDS = 15     // stillness after an impact that counts as inactivity
    const val POST_IMPACT_WINDOW_MS = 120_000L
    const val GYRO_UNUSUAL_RAD_S = 10.0          // tumbling-level rotation rate
    const val GYRO_UNUSUAL_MIN_MS = 400L
    const val UNUSUAL_MOTION_COOLDOWN_MS = 30_000L
    const val LONG_INACTIVITY_MS = 45 * 60_000L  // only evaluated while the watch reports being ON the wrist
    const val SERVER_INACTIVITY_SECONDS = 60     // matches server thresholds.inactivitySeconds

    // ---- Fusion / verification ----------------------------------------------------------------
    const val SIGNAL_TTL_MS = 5 * 60_000L        // a signal stays relevant this long
    const val AUTO_ESCALATE_CONFIDENCE = 0.7     // matches server thresholds.autoEscalateConfidence
    const val CHECKIN_TIMEOUT_MS = 30_000L       // time to answer "Are you OK?"
    const val ESCALATION_GRACE_MS = 10_000L      // last chance to cancel before the SOS is sent
    const val POST_OK_COOLDOWN_MS = 60_000L      // after "I'M OK" do not re-ask immediately
    const val DEMO_POST_OK_COOLDOWN_MS = 3_000L  // demo mode: simulated events must be repeatable back to back
    const val DEMO_CHECKIN_TIMEOUT_MS = 12_000L  // shortened timers for live demos
    const val DEMO_ESCALATION_GRACE_MS = 5_000L
    const val MANUAL_SOS_HOLD_MS = 1_500L        // hold duration for the manual SOS button

    // ---- Power profiles -----------------------------------------------------------------------
    const val SAFE_MODE_BATTERY_PCT = 20         // enter SAFE below this (unless charging / in emergency)
    const val SAFE_MODE_EXIT_PCT = 25            // hysteresis
    const val HR_DUTY_ON_MS = 20_000L            // SAFE: measure this long...
    const val HR_DUTY_OFF_MS = 100_000L          // ...then rest this long

    // ---- AI guidance ------------------------------------------------------------------------------
    const val AI_ELEVATED_SUSTAIN_MS = 20_000L   // elevated this long before the AI is asked (a spike is not a trend)
    const val DEMO_AI_ELEVATED_SUSTAIN_MS = 5_000L
    const val AI_HEALTH_COOLDOWN_MS = 120_000L   // same level: do not repeat the suggestion sooner than this
    const val DEMO_AI_HEALTH_COOLDOWN_MS = 25_000L
    const val AI_ADVICE_TTL_MS = 90_000L         // how long a suggestion stays on screen after the situation ends
    const val AI_EMERGENCY_MIN_GAP_MS = 12_000L

    // ---- 112 fallback -----------------------------------------------------------------------------
    const val EMERGENCY_NUMBER = "112"           // India and the EU; change here for another country
    const val NO_ANSWER_112_MS = 120_000L        // SOS pressed and nobody accepted for this long => 112 countdown
    const val DEMO_NO_ANSWER_112_MS = 30_000L
    const val CALL_112_COUNTDOWN_MS = 10_000L    // last chance to cancel
    const val DEMO_CALL_112_COUNTDOWN_MS = 8_000L
    const val MANUAL_112_COUNTDOWN_MS = 4_000L   // the wearer tapped 112 themselves

    // ---- Nearby help ----------------------------------------------------------------------------
    const val NEARBY_FIX_REFRESH_MS = 4 * 60_000L // a stationary helper must not look "gone": server drops locations older than 10 min

    // ---- Networking ---------------------------------------------------------------------------
    const val QUEUE_RETRY_MS = 5_000L
    const val ACK_TIMEOUT_MS = 8_000L
    const val LOCATION_STALE_MS = 10 * 60_000L
}
