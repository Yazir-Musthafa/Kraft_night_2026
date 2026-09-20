import test from 'node:test';
import assert from 'node:assert/strict';
import { io as connect } from 'socket.io-client';
import { fresh, SOS } from './helpers.js';
import { createCher } from '../src/server.js';
import * as chain from '../src/responseChain.js';

let cher;
let url;
let ctx;
const clients = [];

test.before(async () => {
  ctx = await fresh();
  cher = createCher();
  url = `http://127.0.0.1:${await cher.listen(0)}`;
});
test.after(async () => {
  for (const c of clients) c.close();
  await cher.close();
});

const client = (opts = {}) => {
  const c = connect(url, { transports: ['websocket'], reconnection: true, reconnectionDelay: 50, reconnectionDelayMax: 100, ...opts });
  clients.push(c);
  return c;
};
const opened = (c) => new Promise((res) => (c.connected ? res() : c.once('connect', res)));
const emit = (c, ev, payload) => new Promise((res, rej) => c.timeout(4000).emit(ev, payload, (err, r) => (err ? rej(err) : res(r))));
const nextEvent = (c, ev) => new Promise((res) => c.once(ev, res));

test('watch:hello joins room, and emergency events reach the watch', async () => {
  ctx = await fresh();
  const w = client();
  await opened(w);
  const hello = await emit(w, 'watch:hello', { watchId: 'watch-1' });
  assert.equal(hello.ok, true);
  assert.equal(hello.activeEmergency, null);
  const created = nextEvent(w, 'emergency:created');
  const r = await emit(w, 'emergency:create', { ...SOS, eventId: 'sock-1' });
  assert.equal(r.ok, true);
  assert.equal(r.created, true);
  const ev = await created;
  assert.equal(ev.emergency.id, r.emergency.id);
  assert.ok(ev.eventId && ev.serverTs);
  // later updates arrive too
  const upd = nextEvent(w, 'response:accepted');
  await chain.responderAccepts(r.emergency.id, 'R1');
  const accepted = await upd;
  assert.equal(accepted.emergency.responsiblePerson, 'Abhishek');
  assert.equal(accepted.emergency.coverage.percent > 30, true);
  w.close();
});

test('duplicate emergency:create over the socket returns the same emergency', async () => {
  ctx = await fresh();
  const w = client();
  await opened(w);
  await emit(w, 'watch:hello', { watchId: 'watch-1' });
  const a = await emit(w, 'emergency:create', { ...SOS, emergencyId: 'E-sock-dup', eventId: 'e1' });
  const b = await emit(w, 'emergency:create', { ...SOS, emergencyId: 'E-sock-dup', eventId: 'e1' });
  assert.equal(a.created, true);
  assert.equal(b.duplicate, true);
  assert.equal(a.emergency.id, b.emergency.id);
  w.close();
});

test('reconnect: watch reconnects, re-hellos and receives its active emergency state', async () => {
  ctx = await fresh();
  const w = client();
  await opened(w);
  await emit(w, 'watch:hello', { watchId: 'watch-1' });
  const r = await emit(w, 'emergency:create', { ...SOS, eventId: 'rc-1' });
  // connection drops mid-emergency; the response chain keeps running while the watch is away
  const dropped = new Promise((res) => w.once('disconnect', res));
  const reconnected = new Promise((res) => w.once('connect', res));
  w.io.engine.close();
  await dropped;
  await chain.responderAccepts(r.emergency.id, 'R1');
  await chain.responderMoving(r.emergency.id, 'R1');
  await reconnected; // socket.io auto-reconnect
  const hello = await emit(w, 'watch:hello', { watchId: 'watch-1' });
  assert.equal(hello.ok, true);
  assert.equal(hello.activeEmergency.id, r.emergency.id);
  assert.equal(hello.activeEmergency.state, 'RESPONDER_MOVING');
  assert.equal(hello.activeEmergency.responsiblePerson, 'Abhishek');
  const tl = await (await fetch(`${url}/api/emergencies/${r.emergency.id}/timeline`)).json();
  const types = tl.timeline.map((t) => t.type);
  assert.ok(types.includes('WATCH_DISCONNECTED'));
  assert.ok(types.includes('WATCH_CONNECTED'));
  w.close();
});

test('invalid payloads are rejected with an ack error, never crash the server', async () => {
  const w = client();
  await opened(w);
  const bad = await emit(w, 'emergency:create', { triggerType: 'NOPE' });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'INVALID_PAYLOAD');
  const bad2 = await emit(w, 'location:update', { latitude: 999, longitude: 0 });
  assert.equal(bad2.ok, false);
  const bad3 = await emit(w, 'health:update', { bpm: 'fast' });
  assert.equal(bad3.ok, false);
  const bad4 = await emit(w, 'emergency:get', { emergencyId: 42 });
  assert.equal(bad4.ok, false);
  const nf = await emit(w, 'emergency:get', { emergencyId: 'E-does-not-exist' });
  assert.equal(nf.error, 'NOT_FOUND');
  assert.equal((await emit(w, 'watch:hello', { watchId: 'ok-id' })).ok, true, 'still healthy');
  w.close();
});

test('health + location updates are accepted, deduplicated and streamed to dashboards', async () => {
  ctx = await fresh();
  const dash = client({ auth: { role: 'dashboard' } });
  const w = client();
  await Promise.all([opened(dash), opened(w)]);
  await emit(w, 'watch:hello', { watchId: 'watch-1' });
  const hr = nextEvent(dash, 'health:update');
  const t = Date.now();
  const a = await emit(w, 'health:update', { bpm: 74, accuracy: 'HIGH', timestamp: t, eventId: 'hh1' });
  assert.equal(a.accepted, true);
  assert.equal((await hr).summary.bpm, 74);
  const dup = await emit(w, 'health:update', { bpm: 74, accuracy: 'HIGH', timestamp: t, eventId: 'hh1' });
  assert.equal(dup.accepted, false);
  assert.equal(dup.reason, 'DUPLICATE');
  const loc = nextEvent(dash, 'location:update');
  const l = await emit(w, 'location:update', { latitude: 37.4, longitude: -122.1, accuracy: 9, timestamp: Date.now() });
  assert.equal(l.accepted, true);
  assert.equal((await loc).location.latitude, 37.4);
  dash.close();
  w.close();
});

test('user:response OK records nothing dangerous; NEED_HELP creates an emergency immediately', async () => {
  ctx = await fresh();
  const w = client();
  await opened(w);
  await emit(w, 'watch:hello', { watchId: 'watch-1' });
  const ok = await emit(w, 'user:response', { response: 'OK', eventId: 'u1' });
  assert.equal(ok.ok, true);
  assert.equal(ok.recorded, true);
  const list = await (await fetch(`${url}/api/emergencies`)).json();
  assert.equal(list.emergencies.length, 0, 'OK never creates an emergency');
  const help = await emit(w, 'user:response', { response: 'NEED_HELP', eventId: 'u2' });
  assert.equal(help.created, true);
  assert.equal(help.emergency.triggerType, 'USER_NEEDS_HELP');
  assert.ok(ctx.twilio.calls.length >= 1);
  w.close();
});

test('cancel from watch; premature resolve from watch is refused', async () => {
  ctx = await fresh();
  const w = client();
  await opened(w);
  await emit(w, 'watch:hello', { watchId: 'watch-1' });
  const r = await emit(w, 'emergency:create', { ...SOS, eventId: 'cx' });
  const refused = await emit(w, 'emergency:resolve', { emergencyId: r.emergency.id });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'RESOLUTION_REFUSED');
  const c = await emit(w, 'emergency:cancel', { emergencyId: r.emergency.id, reason: 'false alarm' });
  assert.equal(c.emergency.state, 'CANCELLED');
  w.close();
});
