// Pure signal analysis (heart-rate trend, motion, multi-signal fusion).
// The watch runs an equivalent detector on-device; this is the server's second opinion.
// NOTE: outputs are neutral observations, never medical diagnoses.
import { config } from './config.js';

export function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Keep only physiologically plausible samples with usable signal quality. */
export function validSamples(samples, th = config.thresholds) {
  return samples.filter(
    (s) =>
      typeof s.bpm === 'number' &&
      s.bpm >= th.hrMinValidBpm &&
      s.bpm <= th.hrMaxValidBpm &&
      s.accuracy !== 'UNRELIABLE' &&
      s.accuracy !== 'NO_CONTACT',
  );
}

/**
 * Analyse heart-rate samples (ascending by timestamp).
 * Requires persistence: a single spike never yields `abnormal`.
 */
export function analyzeHeartRate(samples, th = config.thresholds, now = Date.now()) {
  const valid = validSamples(samples, th);
  const total = samples.length;
  const quality = total === 0 ? 0 : valid.length / total;
  const result = {
    available: false,
    current: null,
    baseline: null,
    deviationPct: null,
    trend: 'UNAVAILABLE',
    flags: { high: false, low: false, suddenRise: false, suddenDrop: false, sustainedAbnormal: false },
    abnormal: false,
    signalQuality: Number(quality.toFixed(2)),
    sampleCount: valid.length,
  };
  if (!valid.length) return result;

  const last = valid[valid.length - 1];
  const ageSec = (now - (last.timestamp ?? now)) / 1000;
  if (ageSec > th.hrStaleSeconds) return { ...result, trend: 'STALE' };

  result.available = true;
  result.current = Math.round(last.bpm);

  const recent = valid.slice(-th.hrRecentWindow);
  const older = valid.slice(-th.hrBaselineWindow, -th.hrRecentWindow);
  const recentMedian = median(recent.map((s) => s.bpm));
  if (older.length >= th.hrBaselineMinSamples) {
    result.baseline = Math.round(median(older.map((s) => s.bpm)));
    result.deviationPct = Number(((recentMedian - result.baseline) / result.baseline).toFixed(3));
  }

  const outside = (bpm) =>
    bpm >= th.hrHighAbsolute ||
    bpm <= th.hrLowAbsolute ||
    (result.baseline != null && Math.abs(bpm - result.baseline) / result.baseline >= th.hrDeviationPct);

  const tail = valid.slice(-th.hrPersistenceSamples);
  result.flags.sustainedAbnormal = tail.length >= th.hrPersistenceSamples && tail.every((s) => outside(s.bpm));
  result.flags.high = recentMedian >= th.hrHighAbsolute || (result.deviationPct != null && result.deviationPct >= th.hrDeviationPct);
  result.flags.low = recentMedian <= th.hrLowAbsolute || (result.deviationPct != null && result.deviationPct <= -th.hrDeviationPct);

  const win = valid.slice(-th.hrSuddenWindowSamples);
  if (win.length >= 2) {
    const delta = win[win.length - 1].bpm - win[0].bpm;
    result.flags.suddenRise = delta >= th.hrSuddenDeltaBpm;
    result.flags.suddenDrop = delta <= -th.hrSuddenDeltaBpm;
  }

  result.abnormal = result.flags.sustainedAbnormal;
  if (result.flags.sustainedAbnormal) result.trend = result.flags.low ? 'SUSTAINED_LOW' : result.flags.high ? 'SUSTAINED_HIGH' : 'SUSTAINED_DEVIATION';
  else if (result.flags.suddenRise) result.trend = 'SUDDEN_RISE';
  else if (result.flags.suddenDrop) result.trend = 'SUDDEN_DROP';
  else if (result.deviationPct != null && result.deviationPct > 0.1) result.trend = 'RISING';
  else if (result.deviationPct != null && result.deviationPct < -0.1) result.trend = 'FALLING';
  else result.trend = 'STABLE';
  return result;
}

const WEIGHTS = { HEART_RATE_ABNORMAL: 0.35, IMPACT: 0.4, FALL_LIKE_MOTION: 0.1, UNUSUAL_MOTION: 0.15, INACTIVITY: 0.25, NO_USER_RESPONSE: 0.5 };

/**
 * Fuse independent signals into a monitoring state.
 * NORMAL -> POSSIBLE_ANOMALY -> VERIFYING -> ESCALATING -> ACTIVE_EMERGENCY.
 * Automatic escalation never rests on one sensor: it needs corroboration or a failed user check.
 */
export function assessSignals({ hr, motion, userResponse } = {}, th = config.thresholds) {
  const signals = [];
  if (hr?.abnormal) signals.push('HEART_RATE_ABNORMAL');
  if ((motion?.peakG ?? 0) >= th.impactGForce) signals.push('IMPACT');
  if ((motion?.inactivitySeconds ?? 0) >= th.inactivitySeconds) signals.push('INACTIVITY');
  if (motion?.unusual) signals.push('UNUSUAL_MOTION');
  if (userResponse === 'NO_RESPONSE') signals.push('NO_USER_RESPONSE');
  if (userResponse === 'NEEDS_HELP') signals.push('USER_REQUESTED_HELP');

  const confidence = signals.includes('USER_REQUESTED_HELP') ? 1 : Math.min(1, signals.reduce((a, s) => a + (WEIGHTS[s] ?? 0), 0));
  const reasons = signals.map((s) => s.toLowerCase().replaceAll('_', ' '));

  let state = 'NORMAL';
  if (signals.length) state = 'POSSIBLE_ANOMALY';
  if (signals.includes('IMPACT') || confidence >= 0.5) state = 'VERIFYING';
  if (signals.includes('NO_USER_RESPONSE') && signals.length >= 2 && confidence >= th.autoEscalateConfidence) state = 'ESCALATING';
  if (signals.includes('USER_REQUESTED_HELP')) state = 'ACTIVE_EMERGENCY';
  return { state, confidence: Number(confidence.toFixed(2)), signals, reasons, corroborated: new Set(signals).size >= 2 };
}

/** Deterministic priority for a trigger + its signals (used by the fallback and as an AI sanity floor). */
export function deterministicPriority(triggerType, signals = [], userResponse) {
  const distinct = new Set(signals);
  if (triggerType === 'MANUAL_SOS' || triggerType === 'USER_NEEDS_HELP' || userResponse === 'NEEDS_HELP') return 'HIGH';
  if (triggerType === 'AUTO_FALL_NO_RESPONSE') return distinct.size >= 2 ? 'CRITICAL' : 'HIGH';
  if (triggerType === 'AUTO_MULTI_SIGNAL') return distinct.size >= 3 ? 'CRITICAL' : 'HIGH';
  if (triggerType === 'AUTO_HEART_RATE_ANOMALY' || triggerType === 'AUTO_INACTIVITY') return distinct.size >= 2 ? 'HIGH' : 'MEDIUM';
  return 'HIGH';
}
