import './bin-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import twilio from 'twilio';
import { fresh, advance, SOS } from './helpers.js';
import { createCher } from '../src/server.js';
import * as chain from '../src/responseChain.js';
import * as em from '../src/emergency.js';
import { config } from '../src/config.js';
import { spokenCoordinates } from '../src/twilio.js';

let cher, base, ctx;
test.before(async () => {
  ctx = await fresh();
  cher = createCher();
  base = `http://127.0.0.1:${await cher.listen(0)}`;
});
test.after(async () => cher.close());

const hook = (path, params) => {
  const headers = { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': twilio.getExpectedTwilioSignature(config.twilio.authToken, `${config.publicUrl}${path}`, params) };
  return fetch(`${base}${path}`, { method: 'POST', headers, body: new URLSearchParams(params) });
};
const sidOf = (n) => `CA${String(n).padStart(32, '0')}`;

test('trial mode: the call carries ONLY to/from/url (a Twilio-hosted bin), nothing a trial account rejects', async () => {
  ctx = await fresh();
  const out = await chain.triggerEmergency(SOS);
  await out.started;
  assert.equal(ctx.twilio.calls.length, 1);
  assert.deepEqual(Object.keys(ctx.twilio.calls[0]).sort(), ['from', 'to', 'url']);
  assert.equal(ctx.twilio.calls[0].url, 'https://handlers.twilio.com/twiml/EHinitial');
});

test('trial mode end to end: 1 accepts + speaks coordinates; follow-up uses the STATUS bin; 1 = reached; CONFIRM bin; 3 closes', async () => {
  ctx = await fresh();
  // make the fake client return realistic 34-char sids so the webhook sid check passes
  let n = 0;
  ctx.twilio.client.calls.create = async (o) => { ctx.twilio.calls.push(o); n += 1; return { sid: sidOf(n) }; };
  const out = await chain.triggerEmergency({ ...SOS });
  await out.started;
  const id = out.emergency.id;

  const a = await (await hook('/twilio/gather', { Digits: '1', CallSid: sidOf(1) })).text();
  assert.match(a, /latitude 37 point 4220 north, longitude 122 point 0840 west/);
  assert.equal((await em.getEmergency(id)).state, 'RESPONDER_ACCEPTED');
  assert.equal((await em.getEmergency(id)).responsibilities.LOCATION_SHARED.done, true, 'location delivered by voice counts as shared');
  assert.ok((await em.getTimeline(id)).some((t) => t.type === 'LOCATION_SPOKEN'));

  await advance(1);
  assert.equal(ctx.twilio.calls.at(-1).url, 'https://handlers.twilio.com/twiml/EHstatus');
  const b = await (await hook('/twilio/followup?step=gather', { Digits: '1', CallSid: sidOf(n) })).text();
  assert.match(b, /person reached/i);
  assert.equal((await em.getEmergency(id)).state, 'PERSON_REACHED');

  await advance(1);
  assert.equal(ctx.twilio.calls.at(-1).url, 'https://handlers.twilio.com/twiml/EHconfirm');
  await hook('/twilio/followup?step=gather', { Digits: '3', CallSid: sidOf(n) });
  const e = await em.getEmergency(id);
  assert.equal(e.state, 'RESOLVED');
  assert.equal(e.coverage.percent, 100);
});

test('trial mode: unknown / forged CallSid changes nothing', async () => {
  ctx = await fresh();
  const out = await chain.triggerEmergency(SOS);
  await out.started;
  const t = await (await hook('/twilio/gather', { Digits: '1', CallSid: sidOf(999) })).text();
  assert.match(t, /no longer valid/);
  assert.equal((await em.getEmergency(out.emergency.id)).state, 'RESPONDER_SEARCHING');
});

test('spoken coordinates are unambiguous for every hemisphere', () => {
  assert.equal(spokenCoordinates({ latitude: -33.8688, longitude: 151.2093 }), 'latitude 33 point 8688 south, longitude 151 point 2093 east');
});
