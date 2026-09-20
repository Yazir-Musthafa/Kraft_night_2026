// Exercises the REAL @openai/agents runtime (Agent, run, tool loop, structured output parsing) against a fake
// model, so tool JSON-schema generation and the coordinator wiring are verified without network access.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Usage } from '@openai/agents';
import { fresh } from './helpers.js';
import * as chain from '../src/responseChain.js';
import * as em from '../src/emergency.js';
import { setModelForTests, analyzeEmergency } from '../src/ai.js';

const final = {
  priority: 'CRITICAL',
  summary: 'Multiple emergency signals detected: possible fall and inactivity.',
  triggerAssessment: 'Impact-like motion followed by prolonged inactivity and no response.',
  recommendedRoles: [{ role: 'FIRST_RESPONDER', reason: 'Reach the person' }, { role: 'EMERGENCY_SERVICES_CALLER', reason: 'Decide on emergency services' }],
  nextAction: 'Travel to the reported location and check on the person',
  responsibleRole: 'FIRST_RESPONDER',
  needsBackup: true,
  followUpSeconds: 60,
  callMessage: 'This is CHER emergency coordination. A person may need assistance and their location is available.',
  smsMessage: 'CHER: a person may need assistance. Please check on them.',
};

function fakeModel(script, seen = []) {
  let turn = 0;
  const respond = async (request) => {
    seen.push(request);
    const step = script[Math.min(turn++, script.length - 1)];
    return { usage: new Usage(), output: step, responseId: `resp_${turn}` };
  };
  return { getResponse: respond, async *getStreamedResponse() { throw new Error('not used'); } };
}
const toolCall = (name, args, id = 'call_1') => ({ type: 'function_call', callId: id, name, arguments: JSON.stringify(args), status: 'completed' });
const message = (text) => ({ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] });

test('real Agents SDK run: reads state via a tool, then returns validated structured output', async () => {
  const ctx = await fresh();
  const seen = [];
  setModelForTests(fakeModel([[toolCall('getEmergencyState', {})], [message(JSON.stringify(final))]], seen));
  const o = await chain.triggerEmergency({ triggerType: 'AUTO_FALL_NO_RESPONSE', signals: ['IMPACT', 'INACTIVITY', 'NO_USER_RESPONSE'], userResponse: 'NO_RESPONSE' });
  await o.started;
  const e = await em.getEmergency(o.emergency.id);
  assert.equal(e.aiUsed, true, 'AI output was applied');
  assert.equal(e.priority, 'CRITICAL');
  assert.equal(e.followUp.intervalSeconds, 60);
  assert.equal(e.aiNextAction, final.nextAction);
  // The agent really exposed the controlled tool set, with strict JSON schemas, and the tool result was fed back.
  const tools = seen[0].tools.map((t) => t.name).sort();
  assert.deepEqual(tools, ['assignResponder', 'getEmergencyState', 'getLatestHealthSummary', 'getLatestLocation', 'getResponderAvailability', 'markResponseProgress', 'requestBackup', 'resolveEmergency', 'scheduleFollowUp', 'sendEmergencySMS', 'startTwilioCall', 'updateEmergencyStatus']);
  assert.ok(seen[0].tools.every((t) => t.type === 'function' && t.parameters?.type === 'object'));
  assert.equal(seen.length, 2, 'one tool round-trip then the final answer');
  assert.match(JSON.stringify(seen[1].input), /RESPONDER_SEARCHING|ACTIVE/, 'tool output returned to the model');
  assert.ok(seen[0].outputType, 'structured output type is set');
  // facts sent to the model contain only rounded location, no phone numbers
  const prompt = JSON.stringify(seen[0].input);
  assert.doesNotMatch(prompt, /\+1555\d+/);
  ctx.done();
  setModelForTests(null);
});

test('real Agents SDK run: model returns junk -> deterministic fallback, chain unaffected', async () => {
  const ctx = await fresh();
  setModelForTests(fakeModel([[message('not json at all')]]));
  const o = await chain.triggerEmergency({ triggerType: 'AUTO_MULTI_SIGNAL', signals: ['IMPACT', 'HEART_RATE_ABNORMAL'] });
  await o.started;
  const e = await em.getEmergency(o.emergency.id);
  assert.equal(e.aiUsed, false);
  assert.equal(ctx.twilio.calls.length, 1, 'responder still contacted');
  ctx.done();
  setModelForTests(null);
});

test('real Agents SDK run: model tries a contact tool during INITIAL analysis -> refused by the tool guard', async () => {
  const ctx = await fresh();
  const o = await chain.triggerEmergency({ triggerType: 'MANUAL_SOS' });
  await o.started;
  await o.analysis;
  const callsBefore = ctx.twilio.calls.length;
  setModelForTests(fakeModel([[toolCall('startTwilioCall', { responderId: 'R2' })], [message(JSON.stringify(final))]]));
  const r = await analyzeEmergency(o.emergency.id, chain.makeActions(o.emergency.id, 'INITIAL'), { mode: 'INITIAL' });
  assert.equal(r.source, 'AI');
  assert.equal(ctx.twilio.calls.length, callsBefore, 'no extra call was placed by the AI');
  ctx.done();
  setModelForTests(null);
});

test('real Agents SDK run: model call throws -> fallback', async () => {
  const ctx = await fresh();
  setModelForTests({ getResponse: async () => { throw new Error('429 rate limited'); }, async *getStreamedResponse() {} });
  const o = await chain.triggerEmergency({ triggerType: 'MANUAL_SOS' });
  await o.started;
  const r = await analyzeEmergency(o.emergency.id, chain.makeActions(o.emergency.id, 'INITIAL'));
  assert.equal(r.source, 'FALLBACK');
  ctx.done();
  setModelForTests(null);
});
