import test from 'node:test';
import assert from 'node:assert/strict';
import { io as connect } from 'socket.io-client';
import { advance, fresh, SOS } from './helpers.js';
import { createCher } from '../src/server.js';
import { bearingDegrees, compass8, distanceMeters } from '../src/geo.js';
import { getEmergencyResponders, viewOf } from '../src/emergency.js';
import { K, setJson } from '../src/redis.js';

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

const opened = (c) => new Promise((res) => (c.connected ? res() : c.once('connect', res)));
const emit = (c, ev, payload) => new Promise((res, rej) => c.timeout(4000).emit(ev, payload, (err, r) => (err ? rej(err) : res(r))));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A socket that records every event of interest. */
async function device(watchId, { name, north, helper } = {}) {
  const c = connect(url, { transports: ['websocket'], reconnection: false });
  clients.push(c);
  await opened(c);
  const events = [];
  for (const ev of ['help:request', 'help:update', 'help:checkin', 'help:closed', 'emergency:created', 'emergency:updated']) c.on(ev, (p) => events.push({ ev, ...p }));
  const hello = await emit(c, 'watch:hello', { watchId, ...(name ? { name } : {}), ...(helper === undefined ? {} : { helper }) });
  if (north !== undefined) await emit(c, 'location:update', { latitude: 37.422 + north / 111_320, longitude: -122.084, accuracy: 8 });
  const d = { c, watchId, hello, events };
  d.of = (ev) => events.filter((e) => e.ev === ev);
  d.wait = async (ev, pred = () => true, ms = 2500) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const hit = events.find((e) => e.ev === ev && pred(e));
      if (hit) return hit;
      await sleep(15);
    }
    throw new Error(`timeout waiting for ${ev}; got ${events.map((e) => e.ev).join(',')}`);
  };
  return d;
}

/** The person: connect, then raise an SOS at the SOS fixture location. */
async function person(watchId = 'watch-1') {
  const p = await device(watchId);
  const created = await emit(p.c, 'emergency:create', { ...SOS, eventId: `ev-${Math.random()}`, location: { ...SOS.location, timestamp: Date.now() } });
  p.id = created.emergency.id;
  return p;
}

const calls = () => ctx.twilio.calls.length + ctx.twilio.messages.length;

test('geo: distance, bearing and compass names', () => {
  const a = { latitude: 37.422, longitude: -122.084 };
  const north = { latitude: 37.422 + 300 / 111_320, longitude: -122.084 };
  assert.ok(Math.abs(distanceMeters(a, north) - 300) < 1, 'about 300 m');
  assert.ok(Math.abs(bearingDegrees(a, north)) < 0.01, 'due north');
  assert.equal(compass8(bearingDegrees(a, { latitude: 37.4, longitude: -122.084 })), 'S');
  assert.equal(compass8(bearingDegrees(a, { latitude: 37.423, longitude: -122.083 })), 'NE');
  assert.equal(compass8(359), 'N');
});

test('a nearby watch gets a pop-up first; nobody is phoned and the exact spot is not revealed yet', async () => {
  ctx = await fresh();
  const helper = await device('watch-2', { name: 'Riya', north: 300 });
  const p = await person();
  const req = await helper.wait('help:request');

  assert.equal(req.emergencyId, p.id);
  assert.ok(Math.abs(req.distanceM - 300) <= 2);
  assert.equal(req.direction, 'S', 'the helper is 300 m north of the person, so the person is to the south');
  assert.equal(req.personName, 'the CHER user');
  assert.ok(req.expiresAt > Date.now());
  assert.equal(req.location, undefined, 'no exact location before the helper accepts');
  assert.equal(req.latitude, undefined);
  assert.equal(calls(), 0, 'no call or SMS while a nearby helper is being asked');
  assert.equal(p.of('help:request').length, 0, "the person's own watch never gets help:request");

  const view = await viewOf(p.id);
  assert.equal(view.contactStatus, 'Alerting 1 nearby helper');
  assert.equal(view.state, 'RESPONDER_SEARCHING');
  assert.equal(view.countdown.kind, 'NEARBY', 'the watch can show why nothing is being called yet');
  assert.equal(view.nearbyStage, 'ALERTED');
  assert.equal(view.responders.find((r) => r.responderId === 'H:watch-2').status, 'CONTACTING');
});

test('accepting gives the helper the live location and makes them the responder, without any phone call', async () => {
  ctx = await fresh();
  const helper = await device('watch-2', { name: 'Riya', north: 300 });
  const p = await person();
  await helper.wait('help:request');

  const res = await emit(helper.c, 'help:respond', { emergencyId: p.id, response: 'ACCEPT' });
  assert.equal(res.ok, true);
  assert.equal(res.assignment.state, 'RESPONDER_MOVING');
  assert.equal(res.assignment.role, 'FIRST_RESPONDER');
  assert.ok(Math.abs(res.assignment.location.latitude - 37.422) < 1e-6);

  const view = await viewOf(p.id);
  assert.equal(view.assignedResponder.name, 'Riya');
  assert.equal(view.locationShared, true);
  assert.equal(view.responsiblePerson, 'Riya');
  assert.equal(calls(), 0);

  // the person moves: the helper's map/directions follow, the person's own watch is not spammed
  await emit(p.c, 'location:update', { latitude: 37.4225, longitude: -122.0841, accuracy: 6 });
  const upd = await helper.wait('help:update', (e) => e.location?.latitude === 37.4225);
  assert.equal(upd.emergencyId, p.id);
  assert.equal(p.of('help:update').length, 0);
  await advance(1); // follow-ups that would normally phone a contact become a check-in on the helper's watch
  assert.equal(calls(), 0, 'helpers are never phoned');
  const checkin = await helper.wait('help:checkin');
  assert.equal(checkin.type, 'STATUS');
});

test('helper lifecycle on the watch: arrived -> person confirms/helper closes -> resolved, helper is told', async () => {
  ctx = await fresh();
  const helper = await device('watch-2', { name: 'Riya', north: 200 });
  const p = await person();
  await helper.wait('help:request');
  await emit(helper.c, 'help:respond', { emergencyId: p.id, response: 'ACCEPT' });

  const reached = await emit(helper.c, 'help:status', { emergencyId: p.id, status: 'REACHED' });
  assert.equal(reached.assignment.state, 'PERSON_REACHED');
  assert.equal((await viewOf(p.id)).state, 'PERSON_REACHED');

  const safe = await emit(helper.c, 'help:status', { emergencyId: p.id, status: 'SAFE' });
  assert.equal(safe.ok, true);
  assert.equal((await viewOf(p.id)).state, 'RESOLVED');
  const closed = await helper.wait('help:closed');
  assert.equal(closed.state, 'RESOLVED');
});

test('nobody accepts in time: pop-ups expire and the phone contact is called', async () => {
  ctx = await fresh();
  const helper = await device('watch-2', { north: 300 });
  const p = await person();
  await helper.wait('help:request');
  assert.equal(calls(), 0);

  await advance(1); // NEARBY_TIMEOUT is due
  const closed = await helper.wait('help:closed');
  assert.equal(closed.reason, 'EXPIRED');
  assert.ok(ctx.twilio.calls.length >= 1, 'contact is now phoned');
  assert.equal((await viewOf(p.id)).responders.find((r) => r.responderId === 'H:watch-2').status, 'NO_RESPONSE');
  assert.equal((await emit(helper.c, 'help:respond', { emergencyId: p.id, response: 'ACCEPT' })).error, 'REQUEST_CLOSED');
});

test('when the only nearby helper declines, contacts are called immediately', async () => {
  ctx = await fresh();
  const helper = await device('watch-2', { north: 300 });
  const p = await person();
  await helper.wait('help:request');
  const res = await emit(helper.c, 'help:respond', { emergencyId: p.id, response: 'DECLINE' });
  assert.equal(res.declined, true);
  await sleep(50);
  assert.ok(ctx.twilio.calls.length >= 1, 'no waiting for the timeout once everybody declined');
});

test('one declines, another is still deciding: contacts wait; then the second accepts', async () => {
  ctx = await fresh();
  const a = await device('watch-2', { name: 'A', north: 100 });
  const b = await device('watch-3', { name: 'B', north: 400 });
  const p = await person();
  await a.wait('help:request');
  await b.wait('help:request');
  assert.equal(a.of('help:request')[0].distanceM < b.of('help:request')[0].distanceM, true);

  await emit(a.c, 'help:respond', { emergencyId: p.id, response: 'DECLINE' });
  await sleep(50);
  assert.equal(calls(), 0, 'B has not answered yet');
  const res = await emit(b.c, 'help:respond', { emergencyId: p.id, response: 'ACCEPT' });
  assert.equal(res.assignment.role, 'FIRST_RESPONDER');
  assert.equal(calls(), 0);
});

test('only eligible watches are alerted: in range, connected, available, located, not in their own emergency', async () => {
  ctx = await fresh();
  const near = await device('w-near', { north: 500 });
  const far = await device('w-far', { north: 5000 });
  const off = await device('w-off', { north: 200, helper: false });
  const unlocated = await device('w-noloc');
  const stale = await device('w-stale', { north: 200 });
  await setJson(K.location('w-stale'), { latitude: 37.4221, longitude: -122.084, accuracy: 5, timestamp: Date.now() - 3_600_000 }, 3600);
  const gone = await device('w-gone', { north: 200 });
  gone.c.close();
  await sleep(100);
  const busy = await device('w-busy', { north: 200 });
  await emit(busy.c, 'emergency:create', { triggerType: 'MANUAL_SOS', eventId: 'busy-1', location: { latitude: 37.4221, longitude: -122.084, accuracy: 5, timestamp: Date.now() } });
  await sleep(100);

  const p = await person();
  await near.wait('help:request');
  await sleep(150);
  for (const d of [far, off, unlocated, stale, gone, busy]) assert.equal(d.of('help:request').length, 0, `${d.watchId} must not be alerted`);
  assert.equal((await getEmergencyResponders(p.id)).filter((r) => r.kind === 'HELPER').length, 1);
});

test('no location at all: cannot look for helpers, contacts are called', async () => {
  ctx = await fresh();
  await device('watch-2', { north: 100 });
  const p = await device('watch-1');
  await emit(p.c, 'emergency:create', { triggerType: 'MANUAL_SOS', eventId: 'noloc-1' });
  await sleep(150);
  assert.ok(ctx.twilio.calls.length >= 1);
});

test('enough helpers on the way: remaining pop-ups are withdrawn as covered', async () => {
  ctx = await fresh();
  const [a, b, c] = [await device('h-a', { name: 'A', north: 100 }), await device('h-b', { name: 'B', north: 200 }), await device('h-c', { name: 'C', north: 300 })];
  const p = await person();
  await c.wait('help:request');
  const ra = await emit(a.c, 'help:respond', { emergencyId: p.id, response: 'ACCEPT' });
  const rb = await emit(b.c, 'help:respond', { emergencyId: p.id, response: 'ACCEPT' });
  assert.equal(ra.assignment.role, 'FIRST_RESPONDER');
  assert.equal(rb.assignment.role, 'BACKUP_RESPONDER');
  const closed = await c.wait('help:closed');
  assert.equal(closed.reason, 'COVERED');
  assert.equal((await emit(c.c, 'help:respond', { emergencyId: p.id, response: 'ACCEPT' })).error, 'REQUEST_CLOSED');
});

test('helper asks for backup: the phone contact chain starts', async () => {
  ctx = await fresh();
  const helper = await device('watch-2', { north: 200 });
  const p = await person();
  await helper.wait('help:request');
  await emit(helper.c, 'help:respond', { emergencyId: p.id, response: 'ACCEPT' });
  assert.equal(calls(), 0);
  const res = await emit(helper.c, 'help:status', { emergencyId: p.id, status: 'BACKUP' });
  assert.equal(res.ok, true);
  assert.equal((await viewOf(p.id)).state, 'RESPONDER_SEARCHING');
  assert.ok(ctx.twilio.calls.length >= 1, 'backup is a phone contact');
});

test('helper goes silent on check-ins: never abandoned, the contact chain takes over', async () => {
  ctx = await fresh();
  const helper = await device('watch-2', { north: 200 });
  const p = await person();
  await helper.wait('help:request');
  await emit(helper.c, 'help:respond', { emergencyId: p.id, response: 'ACCEPT' });
  await advance(8);
  await helper.wait('help:checkin');
  const rec = (await getEmergencyResponders(p.id)).find((r) => r.responderId === 'H:watch-2');
  assert.equal(rec.status, 'UNRESPONSIVE');
  assert.ok(ctx.twilio.calls.length >= 1, 'a phone contact was called as the backup');
});

test('answering a check-in (any status) keeps the helper in the loop', async () => {
  ctx = await fresh();
  const helper = await device('watch-2', { north: 200 });
  const p = await person();
  await helper.wait('help:request');
  await emit(helper.c, 'help:respond', { emergencyId: p.id, response: 'ACCEPT' });
  await advance(1);
  await helper.wait('help:checkin');
  const res = await emit(helper.c, 'help:status', { emergencyId: p.id, status: 'MOVING' });
  assert.equal(res.ok, true);
  await advance(1); // the timed-out check-in must not count as missed
  const rec = (await getEmergencyResponders(p.id)).find((r) => r.responderId === 'H:watch-2');
  assert.notEqual(rec.status, 'UNRESPONSIVE');
});

test('the person cancels: every helper watch is told', async () => {
  ctx = await fresh();
  const pending = await device('h-pending', { north: 100 });
  const going = await device('h-going', { north: 200 });
  const p = await person();
  await going.wait('help:request');
  await emit(going.c, 'help:respond', { emergencyId: p.id, response: 'ACCEPT' });
  const res = await emit(p.c, 'emergency:cancel', { emergencyId: p.id, reason: 'False alarm' });
  assert.equal(res.ok, true);
  assert.equal((await pending.wait('help:closed')).reason, 'CANCELLED');
  assert.equal((await going.wait('help:closed')).state, 'CANCELLED');
});

test('reconnecting helper gets its open pop-up and its ongoing assignment back', async () => {
  ctx = await fresh();
  const helper = await device('watch-2', { north: 300 });
  const p = await person();
  await helper.wait('help:request');

  const again = await device('watch-2');
  assert.equal(again.hello.help.request.emergencyId, p.id);
  assert.equal(again.hello.help.assignment, null);

  await emit(again.c, 'help:respond', { emergencyId: p.id, response: 'ACCEPT' });
  const third = await device('watch-2');
  assert.equal(third.hello.help.request, null);
  assert.equal(third.hello.help.assignment.emergencyId, p.id);
  assert.ok(third.hello.help.assignment.location);
  // and it is back in the live-update room
  await emit(p.c, 'location:update', { latitude: 37.4226, longitude: -122.0842, accuracy: 5 });
  await third.wait('help:update', (e) => e.location?.latitude === 37.4226);
});

test('a watch cannot answer, or report status for, an emergency it was never asked about', async () => {
  ctx = await fresh();
  const stranger = await device('w-stranger', { north: 9000 });
  const p = await person();
  assert.equal((await emit(stranger.c, 'help:respond', { emergencyId: p.id, response: 'ACCEPT' })).error, 'NOT_FOUND');
  assert.equal((await emit(stranger.c, 'help:status', { emergencyId: p.id, status: 'REACHED' })).error, 'NOT_FOUND');
  const raw = connect(url, { transports: ['websocket'], reconnection: false });
  clients.push(raw);
  await opened(raw);
  assert.equal((await emit(raw, 'help:respond', { emergencyId: p.id, response: 'ACCEPT' })).error, 'NO_HELLO');
  assert.equal((await emit(stranger.c, 'help:respond', { emergencyId: p.id, response: 'MAYBE' })).error, 'INVALID_PAYLOAD');
});

test('person switched Nearby Responder Alerts off: nobody nearby is asked, contacts are called at once', async () => {
  ctx = await fresh();
  const helper = await device('watch-2', { north: 200 });
  const p = await device('watch-1');
  const r = await emit(p.c, 'emergency:create', { ...SOS, eventId: 'optout-1', nearbyAlerts: false, location: { ...SOS.location, timestamp: Date.now() } });
  await sleep(150);
  assert.equal(helper.of('help:request').length, 0);
  assert.ok(ctx.twilio.calls.length >= 1);
  const { getTimeline } = await import('../src/emergency.js');
  assert.ok((await getTimeline(r.emergency.id)).some((t) => t.type === 'NEARBY_SKIPPED'));
});
