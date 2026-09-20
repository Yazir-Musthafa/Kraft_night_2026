import './single-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fresh, advance, SOS } from './helpers.js';
import * as chain from '../src/responseChain.js';
import * as em from '../src/emergency.js';
import { config } from '../src/config.js';

const cidOf = (call) => new URL(call.url).searchParams.get('cid');

test('one configured contact: backup request re-calls the SAME person once as backup', async () => {
  const ctx = await fresh();
  assert.equal(config.contacts.length, 1);
  assert.equal(config.reuseSingleContact, true);
  const out = await chain.triggerEmergency(SOS);
  await out.started;
  const id = out.emergency.id;
  await chain.onGather(cidOf(ctx.twilio.calls[0]), '1');
  await chain.responderNeedsBackup(id, 'R1', { reason: 'need another pair of hands' });
  assert.equal(ctx.twilio.calls.length, 2, 'a second call goes to the same number');
  assert.equal(ctx.twilio.calls[1].to, ctx.twilio.calls[0].to);
  const recs = await em.getEmergencyResponders(id);
  assert.equal(recs.find((r) => r.responderId === 'R1.b1').role, 'BACKUP_RESPONDER');
  assert.equal((await em.getEmergency(id)).state, 'RESPONDER_SEARCHING');
  // press 1 on the backup call: accepted with a named responsible person
  assert.equal((await chain.onGather(cidOf(ctx.twilio.calls[1]), '1')).kind, 'ACCEPTED');
  const e = await em.getEmergency(id);
  assert.equal(e.state, 'RESPONDER_ACCEPTED');
  assert.ok(e.responsiblePerson && e.nextAction);
  // a SECOND backup request must not loop forever: nobody left -> UNCONFIRMED
  await chain.responderNeedsBackup(id, 'R1.b1', { reason: 'again' });
  assert.equal((await em.getEmergency(id)).state, 'UNCONFIRMED');
  ctx.done();
});

test('one contact who says "cannot help" is NOT re-called: UNCONFIRMED', async () => {
  const ctx = await fresh();
  const out = await chain.triggerEmergency(SOS);
  await out.started;
  await chain.onGather(cidOf(ctx.twilio.calls[0]), '2');
  assert.equal((await em.getEmergency(out.emergency.id)).state, 'UNCONFIRMED');
  assert.equal(ctx.twilio.calls.length, 1);
  ctx.done();
});

test('one contact never answers: bounded retries then UNCONFIRMED (no re-call loop)', async () => {
  const ctx = await fresh();
  const out = await chain.triggerEmergency(SOS);
  await out.started;
  for (let i = 0; i < 14; i++) await advance(1);
  assert.equal((await em.getEmergency(out.emergency.id)).state, 'UNCONFIRMED');
  assert.equal(ctx.twilio.calls.length, 3);
  ctx.done();
});
