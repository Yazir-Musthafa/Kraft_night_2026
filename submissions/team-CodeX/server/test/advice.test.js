import test from 'node:test';
import assert from 'node:assert/strict';
import { io as connect } from 'socket.io-client';
import { fresh, SOS } from './helpers.js';
import { createCher } from '../src/server.js';
import { advise, fallbackAdvice, setAdviceRunnerForTests, situationOf } from '../src/advice.js';

const heart = { kind: 'HEART', heart: { bpm: 96, baseline: 72, level: 'ELEVATED', resting: true } };
const modelSays = (text) => async () => ({ finalOutput: { text } });

test.afterEach(() => setAdviceRunnerForTests(null));

test('no AI key: fixed, reviewed sentences, marked RULES', async () => {
  setAdviceRunnerForTests(null);
  const r = await advise('w1', heart);
  assert.equal(r.source, 'RULES');
  assert.match(r.text, /higher than usual/);
  assert.ok(r.text.length <= 150);
});

test('AI text is used when it is short and safe', async () => {
  setAdviceRunnerForTests(modelSays('Your heart rate is higher than usual. Sit down and take slow breaths.'));
  const r = await advise('w2', heart);
  assert.equal(r.source, 'AI');
  assert.match(r.text, /Sit down/);
});

test('diagnosis, medicine talk, or an over-long answer is replaced by the fixed sentence', async () => {
  for (const bad of ['You may be having a heart attack. Call now.', 'Take an aspirin and rest.', 'x'.repeat(400), '', 'Tachycardia dose 5 mg']) {
    setAdviceRunnerForTests(modelSays(bad));
    const r = await advise(`w-${bad.length}`, heart);
    assert.equal(r.source, 'RULES', `rejected: ${bad.slice(0, 30)}`);
    assert.doesNotMatch(r.text, /aspirin|heart attack|mg/i);
  }
});

test('model timeout / error falls back without throwing', async () => {
  setAdviceRunnerForTests(async () => { throw new Error('boom'); });
  const r = await advise('w3', heart);
  assert.equal(r.source, 'RULES');
});

test('rate limit: a second request right away is answered by rules, identical situations are cached', async () => {
  let calls = 0;
  setAdviceRunnerForTests(async () => { calls++; return { finalOutput: { text: 'Sit down and rest for a moment.' } }; });
  const a = await advise('w4', heart);
  const b = await advise('w4', heart);
  assert.equal(a.source, 'AI');
  assert.equal(b.limited, true);
  assert.equal(calls, 1);
});

test('after an AI failure the model is not asked again for a while (fast fallback, no repeated waiting)', async () => {
  let calls = 0;
  setAdviceRunnerForTests(async () => { calls++; throw new Error('429 no credits'); });
  const a = await advise('w6', heart);
  assert.equal(a.source, 'RULES');
  await new Promise((r) => setTimeout(r, 3100)); // past the per-watch minimum gap, still inside the pause
  const b = await advise('w6', { kind: 'HEART', heart: { bpm: 120, level: 'HIGH' } });
  assert.equal(b.source, 'RULES');
  assert.equal(b.reason, 'AI_PAUSED');
  assert.equal(calls, 1);
});

test('the model only receives numbers and states, never anything identifying', async () => {
  let seen = '';
  setAdviceRunnerForTests(async (_agent, input) => { seen = input; return { finalOutput: { text: 'Stay where you are if it is safe.' } }; });
  await advise('w5', { kind: 'EMERGENCY', emergency: { state: 'RESPONDER_MOVING', responder: 'NEARBY_HELPER', etaMinutes: 4 } });
  assert.doesNotMatch(seen, /\+\d{6,}|latitude|longitude|watch-/i);
  assert.match(seen, /NEARBY_HELPER/);
});

test('fallback sentences per situation', () => {
  assert.match(fallbackAdvice({ kind: 'HEART', heart: { level: 'HIGH' } }), /CHER will check on you/);
  assert.match(fallbackAdvice({ kind: 'EMERGENCY', emergency: { state: 'X', responder: 'NEARBY_HELPER', etaMinutes: 4 } }), /about 4 min/);
  assert.match(fallbackAdvice({ kind: 'EMERGENCY', emergency: { state: 'UNCONFIRMED', fallbackCall: true } }), /112/);
  assert.match(fallbackAdvice({ kind: 'HELPER', helper: { arrived: true } }), /112/);
  assert.match(fallbackAdvice({ kind: 'HELPER', helper: { arrived: false } }), /Move safely/);
});

test('situation text for helpers is plain and not medical', () => {
  assert.equal(situationOf({ triggerType: 'MANUAL_SOS', signals: [] }), 'The person pressed SOS');
  assert.match(situationOf({ triggerType: 'AUTO_MULTI_SIGNAL', signals: ['FALL_LIKE_MOTION'] }), /possible fall/);
  assert.doesNotMatch(situationOf({ triggerType: 'AUTO_HEART_RATE_ANOMALY', signals: ['HEART_RATE_ABNORMAL'] }), /attack|arrest|stroke/i);
});

test('socket ai:advise: validated, answered, and needs a hello first', async () => {
  await fresh();
  const cher = createCher();
  const url = `http://127.0.0.1:${await cher.listen(0)}`;
  const c = connect(url, { transports: ['websocket'], reconnection: false });
  const emit = (ev, p) => new Promise((res, rej) => c.timeout(4000).emit(ev, p, (e, r) => (e ? rej(e) : res(r))));
  await new Promise((r) => c.once('connect', r));
  assert.equal((await emit('ai:advise', heart)).error, 'NO_HELLO');
  await emit('watch:hello', { watchId: 'watch-ai' });
  const ok = await emit('ai:advise', heart);
  assert.equal(ok.ok, true);
  assert.ok(ok.text.length > 0);
  assert.equal((await emit('ai:advise', { kind: 'HEART', heart: { bpm: 5000, level: 'HIGH' } })).error, 'INVALID_PAYLOAD');
  assert.equal((await emit('ai:advise', { kind: 'NOPE' })).error, 'INVALID_PAYLOAD');
  c.close();
  await cher.close();
});
