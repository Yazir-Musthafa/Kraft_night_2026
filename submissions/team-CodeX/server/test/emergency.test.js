import test from 'node:test';
import assert from 'node:assert/strict';
import { fresh, advance, names, SOS } from './helpers.js';
import * as chain from '../src/responseChain.js';
import * as em from '../src/emergency.js';
import { setRunnerForTests } from '../src/ai.js';

test('manual SOS: creates emergency, calls + texts contact immediately, never waits for AI', async () => {
  const ctx = await fresh({ ai: () => new Promise(() => {}) }); // AI that never answers
  const out = await chain.triggerEmergency(SOS);
  await out.started; // resolves without waiting for the (hung) AI
  const e = await em.getEmergency(out.emergency.id);
  assert.equal(out.created, true);
  assert.equal(e.triggerType, 'MANUAL_SOS');
  assert.equal(e.priority, 'HIGH');
  assert.equal(e.state, 'RESPONDER_SEARCHING');
  assert.equal(ctx.twilio.calls.length, 1);
  assert.equal(ctx.twilio.messages.length, 1);
  assert.match(ctx.twilio.messages[0].body, /CHER emergency #/);
  assert.match(ctx.twilio.messages[0].body, /37\.42200, -122\.08400/);
  assert.ok(e.responsiblePerson && e.responsibleRole && e.nextAction, 'always has a responsible person/action');
  assert.ok(names(ctx.events).includes('emergency:created'));
  ctx.done();
});

test('automatic SOS (fall + no response): CRITICAL, AI/fallback analysis applied before outreach', async () => {
  const ctx = await fresh();
  const out = await chain.triggerEmergency({ triggerType: 'AUTO_FALL_NO_RESPONSE', signals: ['IMPACT', 'INACTIVITY', 'NO_USER_RESPONSE'], userResponse: 'NO_RESPONSE' });
  await out.started;
  const e = await em.getEmergency(out.emergency.id);
  assert.equal(e.priority, 'CRITICAL');
  assert.equal(e.aiUsed, false);
  assert.match(e.summary, /possible fall/i);
  assert.equal(ctx.twilio.calls.length, 1);
  ctx.done();
});

test('duplicate SOS (same emergencyId / eventId) creates exactly one emergency', async () => {
  const ctx = await fresh();
  const a = await chain.triggerEmergency({ ...SOS, emergencyId: 'E-dup-1', eventId: 'ev-1' });
  const b = await chain.triggerEmergency({ ...SOS, emergencyId: 'E-dup-1', eventId: 'ev-1' });
  const c = await chain.triggerEmergency({ ...SOS, eventId: 'ev-1' });
  await Promise.all([a.started, b.started, c.started]);
  assert.equal(a.created, true);
  assert.equal(b.duplicate, true);
  assert.equal(c.duplicate, true);
  assert.equal((await em.listEmergencies()).length, 1);
  assert.equal(ctx.twilio.calls.length, 1, 'contact called once');
  ctx.done();
});

test('concurrent identical SOS requests race safely', async () => {
  const ctx = await fresh();
  const rs = await Promise.all(Array.from({ length: 5 }, () => chain.triggerEmergency({ ...SOS, emergencyId: 'E-race', eventId: 'ev-race' })));
  await Promise.all(rs.map((r) => r.started));
  assert.equal(rs.filter((r) => r.created).length, 1);
  assert.equal((await em.listEmergencies()).length, 1);
  ctx.done();
});

test('a different trigger while an emergency is active merges instead of duplicating', async () => {
  const ctx = await fresh();
  const a = await chain.triggerEmergency({ triggerType: 'AUTO_HEART_RATE_ANOMALY', signals: ['HEART_RATE_ABNORMAL'], eventId: 'ev-a' });
  await a.started;
  const b = await chain.triggerEmergency({ ...SOS, eventId: 'ev-b' });
  assert.equal(b.merged, true);
  assert.equal(b.emergency.id, a.emergency.id);
  assert.equal(b.emergency.priority, 'HIGH', 'manual SOS raises priority');
  assert.equal((await em.listEmergencies()).length, 1);
  ctx.done();
});

test('explicit resolution only: nothing short of confirmation resolves', async () => {
  const ctx = await fresh();
  const out = await chain.triggerEmergency(SOS);
  await out.started;
  const id = out.emergency.id;
  await assert.rejects(chain.resolveEmergency(id, { confirmedBy: 'x' }), /Cannot resolve from RESPONDER_SEARCHING/);
  await chain.responderAccepts(id, 'R1');
  await assert.rejects(chain.resolveEmergency(id, { confirmedBy: 'x' }), /Cannot resolve from RESPONDER_ACCEPTED/);
  await chain.responderMoving(id, 'R1');
  await assert.rejects(chain.resolveEmergency(id, { confirmedBy: 'x' }), /Cannot resolve from RESPONDER_MOVING/);
  assert.notEqual((await em.getEmergency(id)).state, 'RESOLVED');
  await chain.responderReached(id, 'R1');
  let e = await em.getEmergency(id);
  assert.equal(e.state, 'PERSON_REACHED');
  assert.equal(e.coverage.percent < 100, true);
  await chain.helpConfirmed(id, 'Abhishek');
  assert.equal((await em.getEmergency(id)).state, 'HELP_CONFIRMED');
  await chain.resolveEmergency(id, { confirmedBy: 'Abhishek' });
  e = await em.getEmergency(id);
  assert.equal(e.state, 'RESOLVED');
  assert.equal(e.coverage.percent, 100);
  assert.ok(names(ctx.events).includes('emergency:resolved'));
  // Timeline is complete and ordered.
  const tl = (await em.getTimeline(id)).map((t) => t.type);
  for (const t of ['EMERGENCY_CREATED', 'RESPONDER_ACCEPTED', 'RESPONDER_MOVING', 'PERSON_REACHED', 'HELP_CONFIRMED', 'RESOLVED']) assert.ok(tl.includes(t), t);
  ctx.done();
});

test('resolve from PERSON_REACHED passes through HELP_CONFIRMED with explicit confirmer', async () => {
  const ctx = await fresh();
  const out = await chain.triggerEmergency(SOS);
  await out.started;
  await chain.responderReached(out.emergency.id, 'R1');
  await chain.resolveEmergency(out.emergency.id, { confirmedBy: 'PERSON' });
  const tl = (await em.getTimeline(out.emergency.id)).map((t) => t.type);
  assert.ok(tl.indexOf('HELP_CONFIRMED') < tl.indexOf('RESOLVED'));
  ctx.done();
});

test('cancellation: stops outreach, notifies responder, cannot be resolved afterwards', async () => {
  const ctx = await fresh();
  const out = await chain.triggerEmergency(SOS);
  await out.started;
  const id = out.emergency.id;
  await chain.responderAccepts(id, 'R1');
  const before = ctx.twilio.messages.length;
  await chain.cancelEmergency(id, { reason: 'false alarm', cancelledBy: 'PERSON' });
  const e = await em.getEmergency(id);
  assert.equal(e.state, 'CANCELLED');
  assert.ok(ctx.twilio.messages.length > before, 'accepted responder is told');
  assert.match(ctx.twilio.messages.at(-1).body, /cancelled/i);
  assert.equal(await advance(3), 0, 'no follow-ups run for a cancelled emergency');
  await assert.rejects(chain.resolveEmergency(id, { confirmedBy: 'x' }));
  assert.equal((await chain.cancelEmergency(id)).duplicate, true, 'cancel is idempotent');
  assert.equal(await (await import('../src/redis.js')).r().sMembers('cher-test:emergencies:active').then((m) => m.length), 0);
  ctx.done();
});

test('coverage is weighted and exposed; backup lowers it', async () => {
  const ctx = await fresh();
  const out = await chain.triggerEmergency(SOS);
  await out.started;
  const id = out.emergency.id;
  const c0 = (await em.getEmergency(id)).coverage.percent;
  await chain.responderAccepts(id, 'R1');
  const c1 = (await em.getEmergency(id)).coverage.percent;
  await chain.responderMoving(id, 'R1');
  const c2 = (await em.getEmergency(id)).coverage.percent;
  assert.ok(c0 < c1 && c1 < c2, `${c0} < ${c1} < ${c2}`);
  await chain.responderNeedsBackup(id, 'R1', { reason: 'need help' });
  const c3 = (await em.getEmergency(id)).coverage.percent;
  assert.ok(c3 < c2, 'coverage drops when accepted-responder cover is lost');
  ctx.done();
});

test('state machine rejects illegal transitions', () => {
  assert.equal(em.canTransition('ACTIVE', 'RESOLVED'), false);
  assert.equal(em.canTransition('RESPONDER_ACCEPTED', 'RESOLVED'), false);
  assert.equal(em.canTransition('PERSON_REACHED', 'RESOLVED'), false);
  assert.equal(em.canTransition('HELP_CONFIRMED', 'RESOLVED'), true);
  assert.equal(em.canTransition('RESOLVED', 'ACTIVE'), false);
  assert.equal(em.canTransition('CANCELLED', 'RESPONDER_SEARCHING'), false);
  setRunnerForTests(null);
});
