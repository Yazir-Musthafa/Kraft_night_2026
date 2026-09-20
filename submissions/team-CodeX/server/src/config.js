// Environment configuration + tunable thresholds. Secrets are read ONLY from process.env.
import 'dotenv/config';
import { z } from 'zod';

const bool = (v, d = false) => (v === undefined || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()));
const int = (v, d) => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : d;
};
const str = (v, d = '') => (v === undefined || v === '' ? d : String(v).trim());

const e164 = /^\+[1-9]\d{6,14}$/;

const envSchema = z.object({
  port: z.number().int().min(1).max(65535),
  redisUrl: z.string().min(1),
});

/**
 * Build a config object from an env map. Exported so tests can build isolated configs.
 * @param {Record<string,string|undefined>} env
 */
export function buildConfig(env = process.env) {
  const contacts = [];
  for (let i = 1; i <= 3; i++) {
    const phone = str(env[`EMERGENCY_CONTACT_${i}`]);
    if (!phone) continue;
    contacts.push({
      id: `R${i}`,
      name: str(env[`EMERGENCY_CONTACT_${i}_NAME`], `Emergency Contact ${i}`),
      phone,
      phoneValid: e164.test(phone),
      priorityOrder: i,
    });
  }

  const cfg = {
    port: int(env.PORT, 3000),
    redisUrl: str(env.REDIS_URL, 'redis://localhost:6379'),
    redisPrefix: str(env.CHER_REDIS_PREFIX, 'cher'),
    logLevel: str(env.LOG_LEVEL, 'info'),
    demoMode: bool(env.CHER_DEMO_MODE, false),
    apiKey: str(env.CHER_API_KEY),
    publicUrl: str(env.CHER_PUBLIC_URL).replace(/\/+$/, ''),
    userName: str(env.CHER_USER_NAME, 'the CHER user'),
    defaultWatchId: str(env.CHER_WATCH_ID, 'watch-1'),
    locationUrlTemplate: str(env.CHER_LOCATION_URL_TEMPLATE),

    openai: {
      apiKey: str(env.OPENAI_API_KEY),
      model: str(env.OPENAI_MODEL, 'gpt-4.1-mini'),
      timeoutMs: int(env.CHER_AI_TIMEOUT_MS, 6000),
      maxTurns: 6,
      // Fail-fast breaker: after an AI transport/quota failure, skip the AI (use the deterministic rules) for this long.
      breakerSeconds: Math.max(5, int(env.CHER_AI_BREAKER_SECONDS, 60)),
      quotaBreakerSeconds: Math.max(30, int(env.CHER_AI_QUOTA_BREAKER_SECONDS, 900)), // no credits / bad key: retrying is pointless
    },

    twilio: {
      accountSid: str(env.TWILIO_ACCOUNT_SID),
      authToken: str(env.TWILIO_AUTH_TOKEN),
      phoneNumber: str(env.TWILIO_PHONE_NUMBER),
      // CHER_TWILIO_SIMULATE=true keeps credentials in .env but never calls Twilio (offline demos).
      forceSimulated: bool(env.CHER_TWILIO_SIMULATE, false),
      // Trial accounts may only reference Twilio-hosted TwiML (TwiML Bins), not a custom webhook URL or inline TwiML.
      // When set, calls use these bin URLs and the keypress is posted back to CHER by the bin's <Gather action>.
      bins: {
        initial: str(env.TWILIO_TWIML_BIN_INITIAL),
        followupStatus: str(env.TWILIO_TWIML_BIN_FOLLOWUP_STATUS),
        followupConfirm: str(env.TWILIO_TWIML_BIN_FOLLOWUP_CONFIRM),
      },
      maxRetries: Math.max(1, int(env.TWILIO_MAX_RETRIES, 3)),
      retryIntervalSeconds: Math.max(5, int(env.TWILIO_RETRY_INTERVAL_SECONDS, 120)),
    },

    contacts,
    // With exactly one configured contact, a backup request / exhausted follow-up may re-call that same person
    // (once) as the backup. Off with 2+ contacts. Never used after "cannot help" or an unanswered call.
    reuseSingleContact: bool(env.CHER_REUSE_SINGLE_CONTACT, contacts.length === 1),

    followUp: {
      intervalSeconds: Math.max(10, int(env.CHER_FOLLOWUP_INTERVAL_SECONDS, 120)),
      maxRetries: Math.max(1, int(env.CHER_FOLLOWUP_MAX_RETRIES, 3)),
      minSeconds: 15,
      maxSeconds: 900,
    },

    // DEMO timing. Only applied while CHER_DEMO_MODE=true; production paths use the normal intervals below.
    demo: {
      callIntervalSeconds: Math.max(5, int(env.CHER_DEMO_CALL_INTERVAL_SECONDS, 20)), // gap between calls / follow-ups / nearby wait
      // A phone rings ~30 s. Declaring "no answer" earlier than that would place a second call on top of the first.
      outreachTimeoutSeconds: Math.max(30, int(env.CHER_DEMO_OUTREACH_TIMEOUT_SECONDS, 45)),
    },

    scheduler: { pollIntervalMs: int(env.CHER_SCHEDULER_POLL_MS, 2000) },

    // Nearby helpers: other CHER watches close to the person are alerted FIRST (pop-up on their watch). Phone contacts are
    // only called when nobody nearby accepts within waitSeconds, everyone declines, or nobody is in range.
    nearby: {
      enabled: bool(env.CHER_NEARBY_ENABLED, true),
      radiusMeters: Math.max(50, int(env.CHER_NEARBY_RADIUS_M, 1500)),
      waitSeconds: Math.max(10, int(env.CHER_NEARBY_WAIT_SECONDS, 45)),
      maxAlerted: Math.max(1, int(env.CHER_NEARBY_MAX_ALERTED, 5)),
      maxResponders: Math.max(1, int(env.CHER_NEARBY_MAX_RESPONDERS, 2)),
      locationMaxAgeSeconds: Math.max(30, int(env.CHER_NEARBY_LOCATION_MAX_AGE_SECONDS, 600)),
      checkinSeconds: Math.max(15, int(env.CHER_NEARBY_CHECKIN_SECONDS, 60)),
    },

    // Server-side (second opinion) anomaly thresholds. The watch has a matching set in CherConfig.kt.
    thresholds: {
      hrBaselineMinSamples: 12,
      hrBaselineWindow: 60,
      hrRecentWindow: 6,
      hrHighAbsolute: 150,
      hrLowAbsolute: 40,
      hrDeviationPct: 0.35,
      hrSuddenDeltaBpm: 30,
      hrSuddenWindowSamples: 4,
      hrPersistenceSamples: 5,
      hrMinValidBpm: 25,
      hrMaxValidBpm: 240,
      hrStaleSeconds: 60,
      impactGForce: 2.5,
      inactivitySeconds: 60,
      autoEscalateConfidence: 0.7,
    },

    limits: {
      healthHistory: 200,
      locationMinIntervalMs: 1000,
      locationTtlSeconds: 24 * 3600,
      healthTtlSeconds: 24 * 3600,
      idempotencyTtlSeconds: 24 * 3600,
      historyTtlSeconds: 30 * 24 * 3600,
      staleEventMs: 10 * 60 * 1000,
    },
  };

  // The single place where demo vs production intervals are chosen.
  cfg.timing = {
    followUpSeconds: () => (cfg.demoMode ? cfg.demo.callIntervalSeconds : cfg.followUp.intervalSeconds),
    retrySeconds: () => (cfg.demoMode ? cfg.demo.outreachTimeoutSeconds : cfg.twilio.retryIntervalSeconds),
    nearbyWaitSeconds: () => (cfg.demoMode ? cfg.demo.callIntervalSeconds : cfg.nearby.waitSeconds),
  };

  envSchema.parse({ port: cfg.port, redisUrl: cfg.redisUrl });
  return cfg;
}

/** Non-fatal configuration problems, for the startup banner. Never includes secret values. */
export function configWarnings(cfg) {
  const w = [];
  if (!cfg.openai.apiKey) w.push('OPENAI_API_KEY not set: AI coordinator disabled, deterministic fallback in use.');
  if (!cfg.twilio.accountSid || !cfg.twilio.authToken || !cfg.twilio.phoneNumber) {
    w.push('Twilio credentials incomplete: calls/SMS run in SIMULATED mode.');
  }
  if (cfg.contacts.length === 0) w.push('EMERGENCY_CONTACT_1 not set: no responder can be contacted.');
  for (const c of cfg.contacts) if (!c.phoneValid) w.push(`EMERGENCY_CONTACT_${c.priorityOrder} is not valid E.164 (+15551234567).`);
  if (!cfg.publicUrl && cfg.twilio.accountSid) w.push('CHER_PUBLIC_URL not set: Twilio cannot fetch TwiML/webhooks.');
  if (!cfg.apiKey) w.push('CHER_API_KEY not set: API and Socket.IO are unauthenticated (prototype/demo only).');
  return w;
}

export const config = buildConfig();
