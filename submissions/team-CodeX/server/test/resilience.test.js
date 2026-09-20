import test from 'node:test';
import assert from 'node:assert/strict';
import { fresh, advance, SOS } from './helpers.js';
import { createCher } from '../src/server.js';
import * as chain from '../src/responseChain.js';
import * as em from '../src/emergency.js';
import * as scheduler from '../src/scheduler.js';
import * as redis from '../src/redis.js';
import { MemoryRedis } from '../src/memoryRedis.js';
import { processHealth } from '../src/health.js';
import { processLocation, resetLocationRateLimit } from '../src/location.js';

const cidOf = (call) => new URL(call.url).searchParams.get('cid');

test('Redis failure: create fails with STORE_UNAVAILABLE and a degraded SMS still alerts the primary contact', async () => {
  const ctx = await fresh();
  ctx.redis.failing = true;
  await assert.rejects(chain.triggerEmergency({ ...SOS, eventId: 'ev-down' }), (e) => e.code === 'STORE_UNAVAILABLE');
  assert.equal(ctx.twilio.messages.length, 1, 'degraded SMS sent');
  assert.match(ctx.twilio.messages[0].body, /degraded mode/);
  // retry while still down does not spam the contact
  await assert.rejects(chain.triggerEmergency({ ...SOS, eventId: 'ev-down' }));
  assert.equal(ctx.twilio.messages.length, 1);
  // Redis returns: the retried SOS now creates the real emergency
  ctx.redis.failing = false;
  const out = await chain.triggerEmergency({ ...SOS, eventId: 'ev-down' });
  await out.started;
  assert.equal(out.created, true);
  ctx.done();
});

test('Redis failure: HTTP API answers 503 (retryable) and /health reports degraded; recovers afterwards', async () => {
  const ctx = await fresh();
  const cher = createCher();
  const port = await cher.listen(0);
  const base = `http://127.0.0.1:${port}`;
  ctx.redis.failing = true;
  const h = await fetch(`${base}/health`);
  assert.equal(h.status, 503);
  assert.equal((await h.json()).status, 'degraded');
  const r = await fetch(`${base}/api/emergencies`, { method: 'GET' });
  assert.equal(r.status, 503);
  assert.equal((await r.json()).retryable, true);
  const post = await fetch(`${base}/api/health`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bpm: 70 }) });
  assert.equal(post.status, 503);
  ctx.redis.failing = false;
  assert.equal((await fetch(`${base}/health`)).status, 200);
  await cher.close();
  ctx.done();
});

test('scheduler tick tolerates a Redis blip (no crash, work resumes)', async () => {
  const ctx = await fresh();
  const out = await chain.triggerEmergency(SOS);
  await out.started;
  await chain.onGather(cidOf(ctx.twilio.calls[0]), '1');
  ctx.redis.failing = true;
  await assert.rejects(scheduler.tick(Date.now() + 1e9));
  ctx.redis.failing = false;
  const before = ctx.twilio.calls.length;
  await advance(1);
  assert.equal(ctx.twilio.calls.length, before + 1);
  ctx.done();
});

test('Redis persistence: emergency, timeline, responders and follow-ups survive a "process restart"', async () => {
  const ctx = await fresh();
  const out = await chain.triggerEmergency(SOS);
  await out.started;
  const id = out.emergency.id;
  await chain.onGather(cidOf(ctx.twilio.calls[0]), '1');
  const snapshot = ctx.redis; // Redis keeps the data...
  // ...while every in-process structure is thrown away: new client wrapper on the same data, fresh locks/rate limits.
  redis.setClient(null);
  resetLocationRateLimit();
  redis.setClient(snapshot);
  const resumed = await chain.resumeAfterRestart();
  assert.equal(resumed.active, 1);
  const e = await em.getEmergency(id);
  assert.equal(e.state, 'RESPONDER_ACCEPTED');
  assert.equal(e.responsiblePerson, 'Abhishek');
  assert.ok((await em.getTimeline(id)).length >= 8);
  assert.equal((await em.getEmergencyResponders(id)).length, 1);
  const pending = (await scheduler.listItems(id)).filter((i) => i.status === 'PENDING' && i.type === 'FOLLOWUP_STATUS');
  assert.equal(pending.length, 1, 'follow-up still scheduled');
  const before = ctx.twilio.calls.length;
  await advance(1);
  assert.equal(ctx.twilio.calls.length, before + 1, 'and it runs after the restart');
  ctx.done();
});

test('key schema follows the documented layout', async () => {
  const ctx = await fresh();
  const out = await chain.triggerEmergency(SOS);
  await out.started;
  const id = out.emergency.id;
  await processHealth({ bpm: 72, accuracy: 'HIGH', timestamp: Date.now(), watchId: 'watch-1' });
  await processLocation({ latitude: 1, longitude: 2, timestamp: Date.now() + 5, watchId: 'watch-1' });
  const keys = [...ctx.redis.data.keys()];
  for (const k of [`cher-test:emergency:${id}`, `cher-test:emergency:${id}:events`, `cher-test:emergency:${id}:responders`, `cher-test:emergency:${id}:followups`, 'cher-test:responder:R1', 'cher-test:watch:watch-1:health', 'cher-test:watch:watch-1:location']) {
    assert.ok(keys.includes(k), `missing key ${k}`);
  }
  ctx.done();
});

test('health/location intake: duplicate, stale and out-of-order events ignored; rate limit applies', async () => {
  const ctx = await fresh();
  const t = Date.now();
  assert.equal((await processHealth({ bpm: 70, eventId: 'h1', timestamp: t, watchId: 'w' })).accepted, true);
  assert.equal((await processHealth({ bpm: 70, eventId: 'h1', timestamp: t, watchId: 'w' })).reason, 'DUPLICATE');
  assert.equal((await processHealth({ bpm: 71, timestamp: t - 1000, watchId: 'w' })).reason, 'STALE');
  assert.equal((await processHealth({ bpm: 71, timestamp: t - 3_600_000, watchId: 'w' })).reason, 'STALE');
  assert.equal((await processLocation({ latitude: 1, longitude: 2, timestamp: t, watchId: 'w' })).accepted, true);
  assert.equal((await processLocation({ latitude: 1, longitude: 2, timestamp: t + 1, watchId: 'w' })).reason, 'RATE_LIMITED');
  assert.equal((await processLocation({ latitude: 1, longitude: 2, timestamp: t - 5, watchId: 'w' })).reason, 'STALE');
  ctx.done();
});

test('real Redis integration (skipped if unavailable): create, persist, read back, clean up', async (tc) => {
  const { createClient } = await import('redis');
  const c = createClient({ url: process.env.REDIS_URL ?? 'redis://localhost:6379', socket: { reconnectStrategy: false, connectTimeout: 800 } });
  c.on('error', () => {});
  try {
    await c.connect();
  } catch {
    return tc.skip('no Redis at REDIS_URL');
  }
  const ctx = await fresh();
  redis.setClient(c);
  try {
    const out = await chain.triggerEmergency({ ...SOS, emergencyId: 'E-real-redis-test' });
    await out.started;
    await chain.responderAccepts('E-real-redis-test', 'R1');
    const e = await em.getEmergency('E-real-redis-test');
    assert.equal(e.state, 'RESPONDER_ACCEPTED');
    assert.ok((await em.getTimeline('E-real-redis-test')).length > 5);
    assert.equal((await scheduler.listItems('E-real-redis-test')).some((i) => i.type === 'FOLLOWUP_STATUS'), true);
    assert.equal(await c.get('cher-test:idem:emergency:E-real-redis-test'), '1');
  } finally {
    await redis.deleteByPrefix('cher-test:');
    redis.setClient(new MemoryRedis());
    await c.quit();
    ctx.done();
  }
});
