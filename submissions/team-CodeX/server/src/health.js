// Health sample intake: stores recent history in Redis, analyses trend, exposes a summary.
import { config } from './config.js';
import { K, safe, claimOnce } from './redis.js';
import { analyzeHeartRate, assessSignals } from './sensors.js';
import { publish } from './events.js';
import { logger } from './logging.js';

/** Recent samples, ascending. */
export async function recentSamples(watchId, n = config.limits.healthHistory) {
  const raw = await safe((c) => c.lRange(K.health(watchId), -n, -1));
  const out = [];
  for (const s of raw) {
    try {
      out.push(JSON.parse(s));
    } catch {
      /* skip corrupt entry */
    }
  }
  return out;
}

/** Compact, privacy-conscious summary of the current heart-rate picture. */
export function summarize(analysis, extra = {}) {
  return {
    bpm: analysis.current,
    baselineBpm: analysis.baseline,
    deviationPct: analysis.deviationPct,
    trend: analysis.trend,
    abnormal: analysis.abnormal,
    sensorAvailable: analysis.available,
    signalQuality: analysis.signalQuality,
    ...extra,
  };
}

export async function getHealthSummary(watchId) {
  const samples = await recentSamples(watchId);
  return summarize(analyzeHeartRate(samples));
}

/**
 * Process one health update. Idempotent (eventId) and ignores stale out-of-order samples.
 * @returns {Promise<{accepted:boolean, reason?:string, summary?:object, assessment?:object}>}
 */
export async function processHealth(payload) {
  const watchId = payload.watchId ?? config.defaultWatchId;
  const ts = payload.timestamp ?? Date.now();

  if (Date.now() - ts > config.limits.staleEventMs) return { accepted: false, reason: 'STALE' };
  if (payload.eventId && !(await claimOnce(K.idem('health', payload.eventId), config.limits.idempotencyTtlSeconds))) {
    return { accepted: false, reason: 'DUPLICATE' };
  }

  const samples = await recentSamples(watchId, 1);
  const latest = samples[samples.length - 1];
  if (latest && ts < latest.timestamp) return { accepted: false, reason: 'STALE' };

  const sample = { bpm: payload.bpm, accuracy: payload.accuracy ?? 'UNKNOWN', timestamp: ts, source: payload.source ?? 'watch' };
  await safe(async (c) => {
    await c.rPush(K.health(watchId), JSON.stringify(sample));
    await c.lTrim(K.health(watchId), -config.limits.healthHistory, -1);
    await c.expire(K.health(watchId), config.limits.healthTtlSeconds);
  });

  const history = await recentSamples(watchId);
  const analysis = analyzeHeartRate(history);
  const assessment = assessSignals({ hr: analysis, motion: payload.motion });
  const summary = summarize(analysis, { battery: payload.battery, monitoringState: payload.monitoringState });
  publish('health:update', { watchId, summary, assessment: { state: assessment.state, confidence: assessment.confidence, reasons: assessment.reasons }, timestamp: ts }, { watchId });
  logger.debug('health.processed', { watchId, trend: summary.trend, state: assessment.state });
  return { accepted: true, summary, assessment };
}
