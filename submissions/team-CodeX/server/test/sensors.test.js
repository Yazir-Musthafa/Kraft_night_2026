import './env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeHeartRate, assessSignals, deterministicPriority } from '../src/sensors.js';
import { config } from '../src/config.js';

const now = Date.now();
const series = (vals, spacing = 5000) => vals.map((bpm, i) => ({ bpm, accuracy: 'HIGH', timestamp: now - (vals.length - 1 - i) * spacing }));
const normal = Array.from({ length: 50 }, (_, i) => 70 + (i % 4));

test('normal heart rate is not abnormal', () => {
  const a = analyzeHeartRate(series(normal), config.thresholds, now);
  assert.equal(a.abnormal, false);
  assert.equal(a.trend, 'STABLE');
  assert.ok(a.baseline >= 68 && a.baseline <= 76);
});

test('a single spike does NOT count as abnormal (persistence required)', () => {
  const a = analyzeHeartRate(series([...normal, 175]), config.thresholds, now);
  assert.equal(a.abnormal, false);
  assert.equal(a.flags.sustainedAbnormal, false);
});

test('sustained high heart rate is flagged', () => {
  const a = analyzeHeartRate(series([...normal, 158, 160, 162, 159, 161, 163]), config.thresholds, now);
  assert.equal(a.abnormal, true);
  assert.equal(a.trend, 'SUSTAINED_HIGH');
});

test('sustained low heart rate is flagged', () => {
  const a = analyzeHeartRate(series([...normal, 36, 37, 35, 36, 38, 37]), config.thresholds, now);
  assert.equal(a.abnormal, true);
  assert.equal(a.trend, 'SUSTAINED_LOW');
});

test('sudden rise / drop flagged but informational only', () => {
  const rise = analyzeHeartRate(series([...normal, 80, 95, 112]), config.thresholds, now);
  assert.equal(rise.flags.suddenRise, true);
  assert.equal(rise.abnormal, false);
  const drop = analyzeHeartRate(series([...normal, 70, 55, 40]), config.thresholds, now);
  assert.equal(drop.flags.suddenDrop, true);
});

test('unreliable / no-contact samples are ignored; unavailable sensor handled', () => {
  const bad = series(normal).map((s) => ({ ...s, accuracy: 'NO_CONTACT' }));
  const a = analyzeHeartRate(bad, config.thresholds, now);
  assert.equal(a.available, false);
  assert.equal(a.trend, 'UNAVAILABLE');
  assert.equal(analyzeHeartRate([], config.thresholds, now).available, false);
});

test('stale readings are not treated as current', () => {
  const old = series(normal).map((s) => ({ ...s, timestamp: s.timestamp - 10 * 60_000 }));
  assert.equal(analyzeHeartRate(old, config.thresholds, now).trend, 'STALE');
});

test('fall detection: impact alone -> VERIFYING, never straight to escalation', () => {
  const a = assessSignals({ motion: { peakG: 4 } });
  assert.equal(a.state, 'VERIFYING');
  assert.deepEqual(a.signals, ['IMPACT']);
});

test('impact + inactivity + no response -> ESCALATING (corroborated)', () => {
  const a = assessSignals({ motion: { peakG: 4, inactivitySeconds: 90 }, userResponse: 'NO_RESPONSE' });
  assert.equal(a.state, 'ESCALATING');
  assert.equal(a.corroborated, true);
});

test('no response alone does not escalate; user asking for help is immediate', () => {
  assert.notEqual(assessSignals({ userResponse: 'NO_RESPONSE' }).state, 'ESCALATING');
  assert.equal(assessSignals({ userResponse: 'NEEDS_HELP' }).state, 'ACTIVE_EMERGENCY');
});

test('nothing unusual -> NORMAL; heart rate alone -> POSSIBLE_ANOMALY/VERIFYING but not escalation', () => {
  assert.equal(assessSignals({}).state, 'NORMAL');
  const hr = assessSignals({ hr: { abnormal: true } });
  assert.notEqual(hr.state, 'ESCALATING');
  assert.notEqual(hr.state, 'ACTIVE_EMERGENCY');
});

test('deterministic priority rules', () => {
  assert.equal(deterministicPriority('MANUAL_SOS'), 'HIGH');
  assert.equal(deterministicPriority('AUTO_FALL_NO_RESPONSE', ['IMPACT', 'NO_USER_RESPONSE']), 'CRITICAL');
  assert.equal(deterministicPriority('AUTO_HEART_RATE_ANOMALY', ['HEART_RATE_ABNORMAL']), 'MEDIUM');
});
