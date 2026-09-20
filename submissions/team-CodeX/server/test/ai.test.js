import test from 'node:test';
import assert from 'node:assert/strict';
import { fresh } from './helpers.js';
import * as chain from '../src/responseChain.js';
import * as em from '../src/emergency.js';
import { analyzeEmergency, deterministicAnalysis, buildTools, finalizeOutput } from '../src/ai.js';
import { aiOutputSchema, containsDiagnosis } from '../src/validation.js';

const SOS = { triggerType: 'MANUAL_SOS' };
const good = {
  priority: 'HIGH',
  summary: 'The person pressed SOS and may need assistance.',
  triggerAssessment: 'Manual SOS with no additional sensor signals.',
  recommendedRoles: [{ role: 'FIRST_RESPONDER', reason: 'Reach the person' }, { role: 'FIRST_RESPONDER', reason: 'dup' }],
  nextAction: 'Travel to the reported location and check on the person',
  responsibleRole: 'FIRST_RESPONDER',
  needsBackup: false,
  followUpSeconds: 45,
  callMessage: 'This is CHER. A person may need help and their location is available.',
  smsMessage: 'CHER: a person may need assistance. Please check on them.',
};
const runner = (out) => async () => ({ finalOutput: out });

test('AI success: structured output validated and applied; DTMF prompt guaranteed on the call', async () => {
  const ctx = await fresh({ ai: runner(good) });
  const out = await chain.triggerEmergency({ triggerType: 'AUTO_MULTI_SIGNAL', signals: ['IMPACT', 'HEART_RATE_ABNORMAL'] });
  await out.started;
  const e = await em.getEmergency(out.emergency.id);
  assert.equal(e.aiUsed, true);
  assert.equal(e.summary, good.summary);
  assert.equal(e.aiNextAction, good.nextAction);
  assert.equal(e.recommendedRoles.length, 1, 'duplicate role removed');
  assert.match(e.messages.callMessage, /Press 1 if you can help\. Press 2 if you cannot help\./);
  assert.equal(e.followUp.intervalSeconds, 45);
  assert.equal(ctx.twilio.calls.length, 1);
  ctx.done();
});

test('AI failure (throws): deterministic fallback keeps the chain running', async () => {
  const ctx = await fresh({ ai: async () => { throw new Error('OpenAI 500'); } });
  const out = await chain.triggerEmergency(SOS);
  await out.started;
  await out.analysis;
  const e = await em.getEmergency(out.emergency.id);
  assert.equal(e.aiUsed, false);
  assert.equal(e.priority, 'HIGH');
  assert.equal(ctx.twilio.calls.length, 1);
  const tl = await em.getTimeline(out.emergency.id);
  assert.ok(tl.some((t) => t.type === 'AI_ANALYZED' && /Deterministic/.test(t.message)));
  ctx.done();
});

test('AI timeout: analysis gives up after the configured timeout and falls back', async () => {
  const ctx = await fresh({ ai: () => new Promise(() => {}) });
  const o = await chain.triggerEmergency(SOS);
  await o.started;
  const t0 = Date.now();
  const r = await analyzeEmergency(o.emergency.id, chain.makeActions(o.emergency.id, 'INITIAL'), { timeoutMs: 60 });
  assert.equal(r.source, 'FALLBACK');
  assert.match(r.error, /AI_TIMEOUT/);
  assert.ok(Date.now() - t0 < 1500);
  ctx.done();
});

test('AI invalid structured output is rejected -> fallback (and fallback output satisfies the schema)', async () => {
  const ctx = await fresh({ ai: runner({ ...good, priority: 'EXTREME' }) });
  const o = await chain.triggerEmergency(SOS);
  await o.started;
  const id = o.emergency.id;
  const r = await analyzeEmergency(id, chain.makeActions(id, 'INITIAL'));
  assert.equal(r.source, 'FALLBACK');
  assert.match(r.error, /AI_INVALID_OUTPUT/);
  assert.equal(aiOutputSchema.safeParse(r.output).success, true);
  ctx.done();
});

test('AI text that states a diagnosis is rejected -> fallback', async () => {
  const ctx = await fresh({ ai: runner({ ...good, summary: 'The watch detected a heart attack.' }) });
  const o = await chain.triggerEmergency(SOS);
  await o.started;
  const r = await analyzeEmergency(o.emergency.id, chain.makeActions(o.emergency.id, 'INITIAL'));
  assert.equal(r.source, 'FALLBACK');
  assert.match(r.error, /DIAGNOSIS/);
  for (const t of ['heart attack', 'cardiac arrest', 'had a stroke', 'seizure', 'diagnosed with x']) assert.equal(containsDiagnosis(t), true, t);
  assert.equal(containsDiagnosis('unusual heart-rate pattern and possible fall'), false);
  ctx.done();
});

test('AI cannot lower priority below the rule-based floor', async () => {
  const ctx = await fresh({ ai: runner({ ...good, priority: 'LOW' }) });
  const o = await chain.triggerEmergency(SOS);
  await o.started;
  await o.analysis;
  assert.equal((await em.getEmergency(o.emergency.id)).priority, 'HIGH');
  ctx.done();
});

test('AI callMessage containing a diagnosis is replaced by the safe deterministic message', () => {
  const e = { triggerType: 'MANUAL_SOS', signals: [], location: {}, userResponse: 'NONE' };
  const out = finalizeOutput({ ...good, callMessage: 'The person has had a cardiac arrest.' }, e);
  assert.doesNotMatch(out.callMessage, /cardiac/i);
  assert.match(out.callMessage, /Press 1/);
});

test('deterministic analysis is schema-valid and diagnosis-free for every trigger type', () => {
  for (const triggerType of ['MANUAL_SOS', 'USER_NEEDS_HELP', 'AUTO_FALL_NO_RESPONSE', 'AUTO_MULTI_SIGNAL', 'AUTO_HEART_RATE_ANOMALY', 'AUTO_INACTIVITY']) {
    const a = deterministicAnalysis({ triggerType, signals: ['IMPACT', 'INACTIVITY'], location: null, userResponse: 'NONE' });
    assert.equal(aiOutputSchema.safeParse(a).success, true, triggerType);
    assert.equal(containsDiagnosis(a.callMessage + a.summary + a.smsMessage), false);
  }
});

test('agent tool surface is exactly the controlled set; contact tools denied in INITIAL mode', async () => {
  const ctx = await fresh();
  const o = await chain.triggerEmergency(SOS);
  await o.started;
  const id = o.emergency.id;
  const tools = buildTools(id, chain.makeActions(id, 'INITIAL'), 'INITIAL');
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    ['assignResponder', 'getEmergencyState', 'getLatestHealthSummary', 'getLatestLocation', 'getResponderAvailability', 'markResponseProgress', 'requestBackup', 'resolveEmergency', 'scheduleFollowUp', 'sendEmergencySMS', 'startTwilioCall', 'updateEmergencyStatus'],
  );
  const call = async (name, args) => JSON.parse(await tools.find((t) => t.name === name).invoke({}, JSON.stringify(args)));
  const denied = await call('startTwilioCall', { responderId: 'R2' });
  assert.equal(denied.ok, false);
  assert.match(denied.error, /not permitted/);
  assert.equal((await call('getEmergencyState', {})).id, id);
  ctx.done();
});

test('agent tools (REPLAN) validate: unknown responder, duplicate assign, resolve without human confirmation, diagnosis scrub', async () => {
  const ctx = await fresh();
  const o = await chain.triggerEmergency(SOS);
  await o.started;
  const id = o.emergency.id;
  const tools = buildTools(id, chain.makeActions(id, 'REPLAN'), 'REPLAN');
  const call = async (name, args) => JSON.parse(await tools.find((t) => t.name === name).invoke({}, JSON.stringify(args)));
  assert.equal((await call('assignResponder', { responderId: 'R99', role: 'FIRST_RESPONDER', reason: 'x' })).ok, false);
  assert.equal((await call('assignResponder', { responderId: 'R1', role: 'FIRST_RESPONDER', reason: 'x' })).ok, false, 'R1 already involved');
  assert.equal((await call('assignResponder', { responderId: 'R2', role: 'AED_RUNNER', reason: 'nearby' })).ok, true);
  assert.equal((await call('resolveEmergency', { confirmedBy: 'AI', note: 'looks fine' })).ok, false, 'AI cannot resolve on its own');
  assert.notEqual((await em.getEmergency(id)).state, 'RESOLVED');
  await call('updateEmergencyStatus', { priority: null, summary: 'The person had a stroke', nextAction: null });
  assert.doesNotMatch((await em.getEmergency(id)).summary, /stroke/i);
  ctx.done();
});
