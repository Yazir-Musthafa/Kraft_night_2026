import test from 'node:test';
import assert from 'node:assert/strict';
import { fresh, advance, names, SOS } from './helpers.js';
import * as chain from '../src/responseChain.js';
import * as em from '../src/emergency.js';
import * as scheduler from '../src/scheduler.js';

const cidOf = (call) => new URL(call.url).searchParams.get('cid');
const start = async (ctx) => {
  const out = await chain.triggerEmergency(SOS);
  await out.started;
  return out.emergency.id;
};

test('responder presses 1: accepted, responsible person set, location SMS, follow-up scheduled', async () => {
  const ctx = await fresh();
  const id = await start(ctx);
  const cid = cidOf(ctx.twilio.calls[0]);
  const res = await chain.onGather(cid, '1');
  assert.equal(res.kind, 'ACCEPTED');
  const e = await em.getEmergency(id);
  assert.equal(e.state, 'RESPONDER_ACCEPTED');
  assert.equal(e.responsiblePerson, 'Abhishek');
  assert.equal(e.responsibleRole, 'Emergency Contact');
  assert.ok(e.nextAction);
  assert.ok(ctx.twilio.messages.some((m) => /location update/i.test(m.body)), 'location SMS sent');
  const items = await scheduler.listItems(id);
  assert.ok(items.some((i) => i.type === 'FOLLOWUP_STATUS' && i.status === 'PENDING'));
  assert.ok(names(ctx.events).includes('response:accepted'));
  assert.ok(names(ctx.events).includes('followup:scheduled'));
  ctx.done();
});

test('duplicate Twilio gather webhook is applied once', async () => {
  const ctx = await fresh();
  await start(ctx);
  const cid = cidOf(ctx.twilio.calls[0]);
  assert.equal((await chain.onGather(cid, '1')).kind, 'ACCEPTED');
  const smsCount = ctx.twilio.messages.length;
  assert.equal((await chain.onGather(cid, '1')).kind, 'DUPLICATE');
  assert.equal(ctx.twilio.messages.length, smsCount);
  ctx.done();
});

test('invalid DTMF digit is not accepted as a response', async () => {
  const ctx = await fresh();
  const id = await start(ctx);
  assert.equal((await chain.onGather(cidOf(ctx.twilio.calls[0]), '7')).kind, 'INVALID');
  assert.equal((await em.getEmergency(id)).state, 'RESPONDER_SEARCHING');
  ctx.done();
});

test('responder presses 2: marked unavailable, next responder contacted', async () => {
  const ctx = await fresh();
  const id = await start(ctx);
  await chain.onGather(cidOf(ctx.twilio.calls[0]), '2');
  const recs = await em.getEmergencyResponders(id);
  assert.equal(recs.find((r) => r.responderId === 'R1').status, 'DECLINED');
  assert.equal(recs.find((r) => r.responderId === 'R2').status, 'CONTACTING');
  assert.equal(ctx.twilio.calls.length, 2);
  assert.equal((await em.getEmergency(id)).state, 'RESPONDER_SEARCHING');
  ctx.done();
});

test('all responders decline -> UNCONFIRMED with a human next action (never abandoned)', async () => {
  const ctx = await fresh();
  const id = await start(ctx);
  for (let i = 0; i < 3; i++) await chain.onGather(cidOf(ctx.twilio.calls.at(-1)), '2');
  const e = await em.getEmergency(id);
  assert.equal(e.state, 'UNCONFIRMED');
  assert.match(e.nextAction, /emergency services/i);
  assert.ok(e.responsiblePerson);
  assert.ok(names(ctx.events).includes('response:unconfirmed'));
  ctx.done();
});

test('no answer: Twilio retries per policy, then hands off to the next responder', async () => {
  const ctx = await fresh();
  const id = await start(ctx);
  assert.equal(ctx.twilio.calls.length, 1);
  // status callback: call ended with no answer
  await chain.onCallStatus({ cid: cidOf(ctx.twilio.calls[0]), callSid: 'CA0001', status: 'no-answer' });
  let e = await em.getEmergency(id);
  assert.match(e.contactStatus, /Retrying/);
  await advance(1);
  assert.equal(ctx.twilio.calls.length, 2, 'retry #2 to same responder');
  assert.equal(cidOf(ctx.twilio.calls[1]) !== cidOf(ctx.twilio.calls[0]), true);
  await chain.onCallStatus({ cid: cidOf(ctx.twilio.calls[1]), callSid: 'CA0002', status: 'busy' });
  await advance(1);
  assert.equal(ctx.twilio.calls.length, 3, 'retry #3');
  await chain.onCallStatus({ cid: cidOf(ctx.twilio.calls[2]), callSid: 'CA0003', status: 'no-answer' });
  // exhausted -> R2 contacted
  const recs = await em.getEmergencyResponders(id);
  assert.equal(recs.find((r) => r.responderId === 'R1').status, 'NO_RESPONSE');
  assert.equal(recs.find((r) => r.responderId === 'R1').attempts, 3, 'not called more than TWILIO_MAX_RETRIES');
  assert.equal(recs.find((r) => r.responderId === 'R2').status, 'CONTACTING');
  assert.equal(ctx.twilio.calls.length, 4);
  ctx.done();
});

test('responder timeout without any status callback is caught by the scheduler', async () => {
  const ctx = await fresh();
  const id = await start(ctx);
  // Nobody answers, no callback ever arrives. Scheduler timeout ticks drive retries and handoff.
  for (let i = 0; i < 24; i++) await advance(1);
  const recs = await em.getEmergencyResponders(id);
  assert.equal(recs.find((r) => r.responderId === 'R1').status, 'NO_RESPONSE');
  assert.ok(recs.every((r) => r.attempts <= 3));
  // ends in a bounded state, never infinite calls
  const total = ctx.twilio.calls.length;
  await advance(3);
  assert.equal(ctx.twilio.calls.length, total);
  assert.equal((await em.getEmergency(id)).state, 'UNCONFIRMED');
  assert.equal(total, 9, '3 responders x 3 attempts');
  ctx.done();
});

test('a call that ended without a key press counts as no response; duplicate status callbacks ignored', async () => {
  const ctx = await fresh();
  const id = await start(ctx);
  const cid = cidOf(ctx.twilio.calls[0]);
  await chain.onCallStatus({ cid, callSid: 'CAx', status: 'completed' });
  assert.equal((await chain.onCallStatus({ cid, callSid: 'CAx', status: 'completed' })).duplicate, true);
  await advance(1);
  assert.equal(ctx.twilio.calls.length, 2);
  ctx.done();
  assert.ok(id);
});

test('answered call (pressed 1) followed by completed status does not trigger a retry', async () => {
  const ctx = await fresh();
  await start(ctx);
  const cid = cidOf(ctx.twilio.calls[0]);
  await chain.onGather(cid, '1');
  await chain.onCallStatus({ cid, callSid: 'CAy', status: 'completed' });
  await advance(2);
  assert.equal(ctx.twilio.calls.filter((c) => c.url.includes('/twilio/voice')).length, 1);
  ctx.done();
});

test('backup request finds another responder; original responder stays in the loop', async () => {
  const ctx = await fresh();
  const id = await start(ctx);
  await chain.onGather(cidOf(ctx.twilio.calls[0]), '1');
  await chain.responderMoving(id, 'R1');
  await chain.responderNeedsBackup(id, 'R1', { reason: 'need another person' });
  let e = await em.getEmergency(id);
  assert.equal(e.state, 'RESPONDER_SEARCHING');
  const recs = await em.getEmergencyResponders(id);
  assert.equal(recs.find((r) => r.responderId === 'R2').role, 'BACKUP_RESPONDER');
  assert.equal(recs.find((r) => r.responderId === 'R2').status, 'CONTACTING');
  assert.ok(names(ctx.events).includes('response:backup'));
  // backup accepts -> continues with a named responsible person
  await chain.onGather(cidOf(ctx.twilio.calls.at(-1)), '1');
  e = await em.getEmergency(id);
  assert.ok(e.responsiblePerson);
  assert.ok(e.nextAction);
  ctx.done();
});

test('backup with nobody left -> UNCONFIRMED (not silently dropped)', async () => {
  const ctx = await fresh();
  const id = await start(ctx);
  await chain.responderDeclines(id, 'R2');
  await chain.responderDeclines(id, 'R3');
  await chain.responderAccepts(id, 'R1');
  await chain.responderNeedsBackup(id, 'R1', { reason: 'help' });
  const e = await em.getEmergency(id);
  assert.equal(e.state, 'UNCONFIRMED');
  assert.ok(e.nextAction && e.responsiblePerson);
  ctx.done();
});

test('follow-up: due call is placed once, DTMF 1 -> PERSON_REACHED, 3 -> MOVING, 2 -> backup', async () => {
  const ctx = await fresh();
  const id = await start(ctx);
  await chain.onGather(cidOf(ctx.twilio.calls[0]), '1');
  const callsBefore = ctx.twilio.calls.length;
  await advance(1);
  assert.equal(ctx.twilio.calls.length, callsBefore + 1, 'follow-up call placed');
  await advance(1); // must not double-call
  const fu = ctx.twilio.calls.filter((c) => c.url.includes('/twilio/followup'));
  assert.equal(fu.length, 1, 'no duplicate follow-up calls');
  // 3: still travelling
  assert.equal((await chain.onFollowupAnswer(cidOf(fu[0]), '3')).kind, 'OK');
  assert.equal((await em.getEmergency(id)).state, 'RESPONDER_MOVING');
  await advance(1);
  const fu2 = ctx.twilio.calls.filter((c) => c.url.includes('/twilio/followup'));
  assert.equal(fu2.length, 2);
  assert.equal((await chain.onFollowupAnswer(cidOf(fu2[1]), '1')).kind, 'OK');
  assert.equal((await em.getEmergency(id)).state, 'PERSON_REACHED');
  // confirmation follow-up
  await advance(1);
  const fu3 = ctx.twilio.calls.filter((c) => c.url.includes('/twilio/followup'));
  assert.equal(fu3.length, 3);
  assert.equal((await chain.onFollowupAnswer(cidOf(fu3[2]), '1')).kind, 'OK');
  assert.equal((await em.getEmergency(id)).state, 'HELP_CONFIRMED');
  assert.notEqual((await em.getEmergency(id)).state, 'RESOLVED', 'confirmation is not resolution');
  ctx.done();
});

test('follow-up confirm call: digit 3 explicitly closes the emergency', async () => {
  const ctx = await fresh();
  const id = await start(ctx);
  await chain.responderReached(id, 'R1');
  await advance(1);
  const fu = ctx.twilio.calls.filter((c) => c.url.includes('/twilio/followup'));
  await chain.onFollowupAnswer(cidOf(fu.at(-1)), '3');
  assert.equal((await em.getEmergency(id)).state, 'RESOLVED');
  ctx.done();
});

test('follow-up backup digit (2) requests backup', async () => {
  const ctx = await fresh();
  const id = await start(ctx);
  await chain.onGather(cidOf(ctx.twilio.calls[0]), '1');
  await advance(1);
  const fu = ctx.twilio.calls.filter((c) => c.url.includes('/twilio/followup'));
  await chain.onFollowupAnswer(cidOf(fu[0]), '2');
  const recs = await em.getEmergencyResponders(id);
  assert.equal(recs.find((r) => r.responderId === 'R2').status, 'CONTACTING');
  ctx.done();
});

test('unanswered follow-ups: counted, retried, then handed off to backup, finally UNCONFIRMED', async () => {
  const ctx = await fresh();
  const id = await start(ctx);
  await chain.responderDeclines(id, 'R3');
  await chain.onGather(cidOf(ctx.twilio.calls[0]), '1');
  for (let i = 0; i < 3; i++) {
    await advance(1);
    const fu = ctx.twilio.calls.filter((c) => c.url.includes('/twilio/followup')).at(-1);
    if (fu) await chain.onCallStatus({ cid: cidOf(fu), callSid: `CAf${i}`, status: 'no-answer' });
  }
  let recs = await em.getEmergencyResponders(id);
  assert.equal(recs.find((r) => r.responderId === 'R1').status, 'UNRESPONSIVE');
  assert.equal(recs.find((r) => r.responderId === 'R2').status, 'CONTACTING', 'handed off to next responder');
  assert.ok((await em.getEmergency(id)).retryCount >= 2);
  // backup responder never answers either -> UNCONFIRMED
  for (let i = 0; i < 14; i++) await advance(1);
  assert.equal((await em.getEmergency(id)).state, 'UNCONFIRMED');
  ctx.done();
});

test('persisted scheduler survives restart: RUNNING item is recovered and executed', async () => {
  const ctx = await fresh();
  const id = await start(ctx);
  await chain.onGather(cidOf(ctx.twilio.calls[0]), '1');
  const [item] = (await scheduler.listItems(id)).filter((i) => i.type === 'FOLLOWUP_STATUS');
  // Simulate a crash mid-run: claimed (ZREM'd) and marked RUNNING but never finished.
  const { K, r } = await import('../src/redis.js');
  await r().zRem(K.dueZset(), `${id}|${item.id}`);
  await scheduler.markItem(id, item.id, { status: 'RUNNING' });
  assert.equal(await advance(1), 0, 'nothing due: it is lost from the due-set');
  await chain.resumeAfterRestart();
  const before = ctx.twilio.calls.length;
  await advance(1);
  assert.equal(ctx.twilio.calls.length, before + 1, 'follow-up executed after recovery');
  ctx.done();
});

test('scheduler claims are exclusive: two concurrent ticks never double-run an item', async () => {
  const ctx = await fresh();
  const id = await start(ctx);
  await chain.onGather(cidOf(ctx.twilio.calls[0]), '1');
  const before = ctx.twilio.calls.length;
  await Promise.all([advance(1), advance(1), advance(1)]);
  assert.equal(ctx.twilio.calls.length, before + 1);
  ctx.done();
  assert.ok(id);
});

test('inbound SMS fallback: YES accepts, MOVING/REACHED advance, unknown numbers rejected', async () => {
  const ctx = await fresh();
  const id = await start(ctx);
  assert.match((await chain.onInboundSms('+19990000000', 'YES')).reply, /not registered/);
  await chain.onInboundSms('+15550000001', 'YES');
  assert.equal((await em.getEmergency(id)).state, 'RESPONDER_ACCEPTED');
  await chain.onInboundSms('+15550000001', 'MOVING');
  assert.equal((await em.getEmergency(id)).state, 'RESPONDER_MOVING');
  await chain.onInboundSms('+15550000001', 'REACHED');
  assert.equal((await em.getEmergency(id)).state, 'PERSON_REACHED');
  ctx.done();
});

test('responder unavailable globally is skipped', async () => {
  const ctx = await fresh();
  await chain.setResponderStatus('R1', 'UNAVAILABLE');
  const id = await start(ctx);
  const recs = await em.getEmergencyResponders(id);
  assert.equal(recs[0].responderId, 'R2');
  ctx.done();
});
