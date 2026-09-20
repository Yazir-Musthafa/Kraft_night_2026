import test from 'node:test';
import assert from 'node:assert/strict';
import { fresh, advance, SOS } from './helpers.js';
import * as chain from '../src/responseChain.js';
import { getEmergencyResponders, getTimeline, viewOf } from '../src/emergency.js';
import { setStatusFetcherForTests } from '../src/callWatcher.js';

process.env.CHER_DEMO_AUTO_ANSWER = 'true';
process.env.CHER_DEMO_POLL_MS = '50';
process.env.CHER_DEMO_AUTO_MOVING_SECONDS = '1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 6000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(50);
  }
  return false;
};
const contact = async (id) => (await getEmergencyResponders(id)).find((r) => r.responderId === 'R1');
const reset = () => setStatusFetcherForTests(async () => { throw new Error('unused'); });

/** Fake Twilio that hands out valid-looking call SIDs and lets the test decide each call's status. */
function phone(ctx) {
  const sids = [];
  const status = {};
  ctx.twilio.client.calls.create = async (o) => {
    ctx.twilio.calls.push(o);
    const sid = `CA${String(sids.length + 1).padStart(32, '0')}`;
    sids.push(sid);
    return { sid };
  };
  setStatusFetcherForTests(async (sid) => status[sid] ?? { status: 'queued', duration: 0 });
  return { sids, status };
}

test('demo: three call stages, each answered call moves the response forward with no keypress', async () => {
  const ctx = await fresh();
  const p = phone(ctx);
  const out = await chain.triggerEmergency({ ...SOS, watchId: 'watch-1', eventId: 'cw-1' });
  await out.started;
  const id = out.emergency.id;

  // stage 1: first call. placed -> ringing -> answered
  assert.ok(await until(() => p.sids.length === 1));
  assert.ok(await until(async () => /placed/i.test((await viewOf(id)).contactStatus)), 'call placed is visible');
  assert.equal((await contact(id)).status, 'CONTACTING');
  p.status[p.sids[0]] = { status: 'ringing', duration: 0 };
  assert.ok(await until(async () => /ringing/i.test((await viewOf(id)).contactStatus)), 'ringing is visible');
  const ringing = await viewOf(id);
  assert.ok(ringing.coverage.percent >= 20, 'delivered alert counts');
  assert.notEqual((await contact(id)).status, 'ACCEPTED', 'ringing is not an accept');

  p.status[p.sids[0]] = { status: 'in-progress', duration: 0 };
  assert.ok(await until(async () => ['ACCEPTED', 'MOVING'].includes((await contact(id))?.status)), 'answered = accepted');
  assert.ok(await until(async () => (await viewOf(id)).state === 'RESPONDER_MOVING'), 'then on the way (scripted step)');
  const moving = await viewOf(id);
  assert.ok(moving.coverage.percent > ringing.coverage.percent);

  // stage 2: status follow-up call answered => reached
  await advance(1);
  assert.ok(await until(() => p.sids.length === 2), 'follow-up call placed');
  p.status[p.sids[1]] = { status: 'in-progress', duration: 0 };
  assert.ok(await until(async () => (await viewOf(id)).state === 'PERSON_REACHED'), 'answered follow-up = reached');

  // stage 3: confirm follow-up call answered => help confirmed, but NOT resolved
  await advance(1);
  assert.ok(await until(() => p.sids.length === 3), 'confirm call placed');
  p.status[p.sids[2]] = { status: 'in-progress', duration: 0 };
  assert.ok(await until(async () => (await viewOf(id)).state === 'HELP_CONFIRMED'), 'answered confirm call = help confirmed');
  const done = await viewOf(id);
  assert.ok(done.coverage.percent > moving.coverage.percent);
  assert.notEqual(done.state, 'RESOLVED', "closing stays with the person (I'M SAFE)");

  const tl = await getTimeline(id);
  assert.ok(tl.filter((x) => x.type === 'CALL_ANSWERED').every((x) => /no keypress/i.test(x.message) && /simulated demo step/.test(x.message)));
  assert.ok(tl.filter((x) => x.type === 'DEMO_STEP').every((x) => /simulated demo step/.test(x.message)));
  reset();
});

test('demo: a call that is never answered accepts nobody and says so', async () => {
  const ctx = await fresh();
  const p = phone(ctx);
  const out = await chain.triggerEmergency({ ...SOS, watchId: 'watch-1', eventId: 'cw-2' });
  await out.started;
  assert.ok(await until(() => p.sids.length === 1));
  p.status[p.sids[0]] = { status: 'no-answer', duration: 0 };
  assert.ok(await until(async () => /not answered/i.test((await viewOf(out.emergency.id)).contactStatus)));
  assert.notEqual((await contact(out.emergency.id)).status, 'ACCEPTED');
  reset();
});
