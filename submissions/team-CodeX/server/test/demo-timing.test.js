import test from 'node:test';
import assert from 'node:assert/strict';
import { fresh, advance, SOS } from './helpers.js';
import { buildConfig } from '../src/config.js';
import { config } from '../src/config.js';
import * as chain from '../src/responseChain.js';
import * as em from '../src/emergency.js';
import * as scheduler from '../src/scheduler.js';

const cidOf = (call) => new URL(call.url).searchParams.get('cid');
// Nearby helpers (a parallel feature) are exercised elsewhere; here nobody is registered, so contacts are called directly.

test('timing is chosen in ONE place: demo mode uses the short gap, production keeps its normal intervals', () => {
  const demo = buildConfig({ CHER_DEMO_MODE: 'true', CHER_DEMO_CALL_INTERVAL_SECONDS: '20', TWILIO_RETRY_INTERVAL_SECONDS: '120', CHER_FOLLOWUP_INTERVAL_SECONDS: '120' });
  assert.equal(demo.timing.followUpSeconds(), 20);
  assert.equal(demo.timing.nearbyWaitSeconds(), 20);
  assert.equal(demo.timing.retrySeconds(), 45, 'a phone rings ~30 s, so "no answer" is not declared at 20 s');
  const prod = buildConfig({ CHER_DEMO_MODE: 'false', CHER_DEMO_CALL_INTERVAL_SECONDS: '20', TWILIO_RETRY_INTERVAL_SECONDS: '120', CHER_FOLLOWUP_INTERVAL_SECONDS: '120' });
  assert.equal(prod.timing.followUpSeconds(), 120);
  assert.equal(prod.timing.retrySeconds(), 120);
  assert.equal(prod.timing.nearbyWaitSeconds(), prod.nearby.waitSeconds);
  assert.equal(buildConfig({ CHER_DEMO_MODE: 'true' }).demo.callIntervalSeconds, 20, 'default demo gap is 20 s');
});

test('demo: the follow-up after an accepted call is scheduled ~20 s out (persisted in Redis, via the existing scheduler)', async () => {
  const ctx = await fresh();
  assert.equal(config.demoMode, true);
  const out = await chain.triggerEmergency(SOS);
  await out.started;
  await chain.onGather(cidOf(ctx.twilio.calls[0]), '1');
  const [item] = (await scheduler.listItems(out.emergency.id)).filter((i) => i.type === 'FOLLOWUP_STATUS' && i.status === 'PENDING');
  const inS = (item.dueAt - Date.now()) / 1000;
  assert.ok(inS > 15 && inS <= 21, `follow-up due in ${inS.toFixed(1)}s, expected ~20`);
  ctx.done();
});

test('coverage moves on RESPONSES, not on initiating calls: 10% while ringing, 55% only after the responder presses 1', async () => {
  const ctx = await fresh();
  const out = await chain.triggerEmergency(SOS);
  await out.started;
  const id = out.emergency.id;
  assert.equal(ctx.twilio.calls.length, 1, 'the call was placed');
  assert.equal((await em.getEmergency(id)).coverage.percent, 10, 'placing a call/SMS adds nothing');
  await chain.onGather(cidOf(ctx.twilio.calls[0]), '1');
  assert.equal((await em.getEmergency(id)).coverage.percent, 55, 'answered + accepted + location delivered');
  await advance(1); // follow-up call placed: still nothing gained until they answer it
  assert.equal((await em.getEmergency(id)).coverage.percent, 55);
  const fu = ctx.twilio.calls.filter((c) => c.url.includes('/twilio/followup')).at(-1);
  await chain.onFollowupAnswer(cidOf(fu), '3'); // "still travelling"
  assert.equal((await em.getEmergency(id)).coverage.percent, 65);
  await advance(1);
  const fu2 = ctx.twilio.calls.filter((c) => c.url.includes('/twilio/followup')).at(-1);
  await chain.onFollowupAnswer(cidOf(fu2), '1'); // reached
  assert.equal((await em.getEmergency(id)).coverage.percent, 90);
  assert.notEqual((await em.getEmergency(id)).state, 'RESOLVED');
  await advance(1);
  const fu3 = ctx.twilio.calls.filter((c) => c.url.includes('/twilio/followup')).at(-1);
  await chain.onFollowupAnswer(cidOf(fu3), '1'); // help confirmed
  const e = await em.getEmergency(id);
  assert.equal(e.coverage.percent, 100);
  assert.equal(e.state, 'HELP_CONFIRMED', '100% but NOT auto-resolved');
  ctx.done();
});

test('an unanswered call never raises coverage', async () => {
  const ctx = await fresh();
  const out = await chain.triggerEmergency(SOS);
  await out.started;
  for (let i = 0; i < 6; i++) await advance(1);
  assert.equal((await em.getEmergency(out.emergency.id)).coverage.percent, 10);
  ctx.done();
});

test('view exposes a visible countdown, a progress checklist and the nearby setting', async () => {
  const ctx = await fresh();
  const out = await chain.triggerEmergency(SOS);
  await out.started;
  const id = out.emergency.id;
  let v = await em.viewOf(id);
  assert.equal(v.countdown.kind, 'RETRY');
  assert.ok(v.countdown.seconds > 0 && v.countdown.seconds <= 45);
  assert.equal(v.nearbyEnabled, true);
  assert.deepEqual(v.progress.map((p) => p.label).slice(0, 2), ['Emergency detected', 'Location captured']);
  assert.equal(v.progress[0].state, 'done');
  await chain.onGather(cidOf(ctx.twilio.calls[0]), '1');
  v = await em.viewOf(id);
  assert.equal(v.countdown.kind, 'FOLLOWUP');
  assert.match(v.countdown.label, /follow-up/i);
  assert.ok(v.countdown.seconds <= 21);
  assert.equal(v.followUp.nextInSeconds, v.countdown.seconds);
  assert.equal(v.progress.find((p) => p.label === 'Responder accepted').state, 'done');
  assert.equal(v.progress.filter((p) => p.state === 'current').length, 1, 'exactly one current step');
  ctx.done();
});

test('timeline shows the verified step and the Last Responsible Person at every stage', async () => {
  const ctx = await fresh();
  const out = await chain.triggerEmergency({ triggerType: 'AUTO_FALL_NO_RESPONSE', signals: ['IMPACT', 'NO_USER_RESPONSE'], userResponse: 'NO_RESPONSE' });
  await out.started;
  const id = out.emergency.id;
  const types = (await em.getTimeline(id)).map((t) => t.type);
  assert.ok(types.indexOf('EMERGENCY_CREATED') < types.indexOf('EMERGENCY_VERIFIED'));
  assert.match((await em.getTimeline(id)).find((t) => t.type === 'EMERGENCY_VERIFIED').message, /possible fall/);
  const check = async () => {
    const e = await em.getEmergency(id);
    assert.ok(e.responsiblePerson && e.responsibleRole && e.nextAction, `${e.state} must have a responsible person/role/next action`);
    return e;
  };
  await check();
  await chain.onGather(cidOf(ctx.twilio.calls[0]), '1');
  const acc = await check();
  assert.equal(acc.responsibleRole, 'Emergency Contact');
  await chain.responderMoving(id, 'R1');
  await check();
  await chain.responderNeedsBackup(id, 'R1', { reason: 'help' });
  const back = await check();
  assert.notEqual(back.state, 'RESOLVED');
  ctx.done();
});

test('the wearer can opt out of nearby alerts: the setting is stored with the emergency', async () => {
  const ctx = await fresh();
  const a = await chain.triggerEmergency({ ...SOS, emergencyId: 'E-off', eventId: 'ev-off', nearbyAlerts: false });
  await a.started;
  assert.equal((await em.getEmergency('E-off')).nearbyEnabled, false);
  assert.equal((await em.viewOf('E-off')).nearbyEnabled, false);
  ctx.done();
});
