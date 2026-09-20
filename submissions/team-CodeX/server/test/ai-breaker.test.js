import test from 'node:test';
import assert from 'node:assert/strict';
import { fresh } from './helpers.js';
import * as chain from '../src/responseChain.js';
import { analyzeEmergency, resetAiBreaker, setRunnerForTests } from '../src/ai.js';

const SOS = { triggerType: 'MANUAL_SOS' };
const setup = async (runner) => {
  const ctx = await fresh({ ai: runner });
  const o = await chain.triggerEmergency(SOS);
  await o.started;
  await o.analysis;
  return { ctx, id: o.emergency.id, actions: chain.makeActions(o.emergency.id, 'INITIAL') };
};

test('after an AI outage the breaker skips the AI instantly instead of waiting out the timeout again', async () => {
  let calls = 0;
  const { ctx, id, actions } = await setup(async () => { calls += 1; throw new Error('503 upstream unavailable'); });
  resetAiBreaker();
  calls = 0;
  const first = await analyzeEmergency(id, actions);
  assert.equal(first.source, 'FALLBACK');
  assert.equal(calls, 1);
  const t0 = Date.now();
  const second = await analyzeEmergency(id, actions);
  assert.equal(calls, 1, 'the AI is NOT called again while paused');
  assert.match(second.error, /AI_PAUSED_AFTER_FAILURE.*AI paused/);
  assert.ok(Date.now() - t0 < 100, 'fails fast');
  assert.ok(second.output.callMessage, 'the deterministic analysis is still complete');
  ctx.done();
});

test('no credits (HTTP 429 insufficient_quota) is recognised, and pauses much longer than a blip', async () => {
  const { ctx, id, actions } = await setup(async () => { throw Object.assign(new Error('429 You have no credits remaining'), { status: 429 }); });
  resetAiBreaker();
  await analyzeEmergency(id, actions);
  const second = await analyzeEmergency(id, actions);
  assert.match(second.error, /NO_CREDITS_OR_BAD_KEY/);
  const secs = Number(second.error.match(/retrying in (\d+)s/)[1]);
  assert.ok(secs > 600, `paused ${secs}s, expected the long quota window`);
  ctx.done();
});

test('the true cause is learned even when it arrives AFTER the timeout (the SDK retries 429s until we give up)', async () => {
  let calls = 0;
  const slowQuota = () => new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('429 insufficient_quota'), { status: 429 })), 120));
  const { ctx, id, actions } = await setup(async () => { calls += 1; return slowQuota(); });
  resetAiBreaker();
  calls = 0;
  const first = await analyzeEmergency(id, actions, { timeoutMs: 40 });
  assert.match(first.error, /AI_TIMEOUT/);
  await new Promise((r) => setTimeout(r, 200)); // the late rejection lands
  const second = await analyzeEmergency(id, actions, { timeoutMs: 40 });
  assert.equal(calls, 1);
  assert.match(second.error, /NO_CREDITS_OR_BAD_KEY/, 'timeout was upgraded to the real cause');
  ctx.done();
});

test('model misbehaviour (invalid output) is not an outage: the AI is tried again next time', async () => {
  let calls = 0;
  const { ctx, id, actions } = await setup(async () => { calls += 1; return { finalOutput: { nonsense: true } }; });
  resetAiBreaker();
  calls = 0;
  await analyzeEmergency(id, actions);
  const second = await analyzeEmergency(id, actions);
  assert.equal(calls, 2, 'not paused');
  assert.match(second.error, /AI_INVALID_OUTPUT/);
  ctx.done();
});

test('the breaker closes again after a successful analysis', async () => {
  const good = { priority: 'HIGH', summary: 'A person may need assistance.', triggerAssessment: 'Manual SOS.', recommendedRoles: [{ role: 'FIRST_RESPONDER', reason: 'r' }], nextAction: 'Reach the reported location', responsibleRole: 'FIRST_RESPONDER', needsBackup: false, followUpSeconds: 30, callMessage: 'CHER: a person may need help.', smsMessage: 'CHER: please check on them.' };
  let fail = true;
  const { ctx, id, actions } = await setup(async () => { if (fail) throw new Error('503'); return { finalOutput: good }; });
  resetAiBreaker();
  await analyzeEmergency(id, actions); // trips
  resetAiBreaker(); // window elapsed (simulated)
  fail = false;
  assert.equal((await analyzeEmergency(id, actions)).source, 'AI');
  assert.equal((await analyzeEmergency(id, actions)).source, 'AI', 'stays healthy');
  ctx.done();
  setRunnerForTests(null);
});
