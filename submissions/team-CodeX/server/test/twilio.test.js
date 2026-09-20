import test from 'node:test';
import assert from 'node:assert/strict';
import twilio from 'twilio';
import { fresh, advance, SOS } from './helpers.js';
import { createCher } from '../src/server.js';
import { getEmergencyResponders, getEmergency, getTimeline } from '../src/emergency.js';
import * as chain from '../src/responseChain.js';
import { config } from '../src/config.js';
import { maskPhone, log, setLogSink } from '../src/logging.js';

const cidOf = (call) => new URL(call.url).searchParams.get('cid');
let cher;
let base;
let ctx;

test.before(async () => {
  ctx = await fresh();
  cher = createCher();
  base = `http://127.0.0.1:${await cher.listen(0)}`;
});
test.after(async () => {
  await cher.close();
});

async function hook(path, params, { sign = true, url } = {}) {
  const full = `${config.publicUrl}${path}`;
  const headers = { 'content-type': 'application/x-www-form-urlencoded' };
  if (sign) headers['x-twilio-signature'] = twilio.getExpectedTwilioSignature(config.twilio.authToken, url ?? full, params);
  return fetch(`${base}${path}`, { method: 'POST', headers, body: new URLSearchParams(params) });
}

test('webhooks reject missing/forged Twilio signatures (403) and never change state', async () => {
  ctx = await fresh();
  const out = await chain.triggerEmergency(SOS);
  await out.started;
  const cid = cidOf(ctx.twilio.calls[0]);
  const noSig = await hook(`/twilio/gather?cid=${cid}`, { Digits: '1' }, { sign: false });
  assert.equal(noSig.status, 403);
  const forged = await hook(`/twilio/gather?cid=${cid}`, { Digits: '1' }, { url: 'https://evil.test/twilio/gather' });
  assert.equal(forged.status, 403);
  assert.equal((await getEmergency(out.emergency.id)).state, 'RESPONDER_SEARCHING');
});

test('voice webhook returns valid TwiML with Gather; unknown/forged cid is refused', async () => {
  ctx = await fresh();
  const out = await chain.triggerEmergency(SOS);
  await out.started;
  const cid = cidOf(ctx.twilio.calls[0]);
  const ok = await hook(`/twilio/voice?cid=${cid}`, { CallSid: 'CA1' });
  const xml = await ok.text();
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('content-type'), /text\/xml/);
  assert.match(xml, /<Gather[^>]*numDigits="1"/);
  assert.match(xml, /This is CHER emergency coordination\. A person may need assistance\./);
  assert.match(xml, /Press 1 if you can help\. Press 2 if you cannot help\./);
  assert.doesNotMatch(xml, /heart attack|cardiac|diagnos/i);
  const bad = await (await hook('/twilio/voice?cid=' + 'a'.repeat(32), { CallSid: 'CA2' })).text();
  assert.match(bad, /no longer valid/);
  const injected = await (await hook(`/twilio/voice?cid=${encodeURIComponent('../../x')}`, { CallSid: 'CA3' })).text();
  assert.match(injected, /no longer valid/);
});

test('gather webhook: 1 accepts, duplicate is safe, returns TwiML', async () => {
  ctx = await fresh();
  const out = await chain.triggerEmergency(SOS);
  await out.started;
  const cid = cidOf(ctx.twilio.calls[0]);
  const a = await hook(`/twilio/gather?cid=${cid}`, { Digits: '1', CallSid: 'CA1' });
  assert.match(await a.text(), /last known location is latitude 37 point 4220 north/);
  assert.equal((await getEmergency(out.emergency.id)).state, 'RESPONDER_ACCEPTED');
  const b = await hook(`/twilio/gather?cid=${cid}`, { Digits: '1', CallSid: 'CA1' });
  assert.match(await b.text(), /already recorded/);
  assert.equal((await getEmergencyResponders(out.emergency.id)).filter((r) => r.status === 'ACCEPTED').length, 1);
});

test('gather webhook: 2 declines and bridges to next responder', async () => {
  ctx = await fresh();
  const out = await chain.triggerEmergency(SOS);
  await out.started;
  const r = await hook(`/twilio/gather?cid=${cidOf(ctx.twilio.calls[0])}`, { Digits: '2' });
  assert.match(await r.text(), /another responder/);
  assert.equal(ctx.twilio.calls.length, 2);
});

test('followup webhook: TwiML prompt then DTMF handling', async () => {
  ctx = await fresh();
  const out = await chain.triggerEmergency(SOS);
  await out.started;
  await chain.responderAccepts(out.emergency.id, 'R1');
  await advance(1);
  const fu = ctx.twilio.calls.find((c) => c.url.includes('/twilio/followup'));
  const cid = cidOf(fu);
  const prompt = await (await hook(`/twilio/followup?cid=${cid}`, { CallSid: 'CA9' })).text();
  assert.match(prompt, /Press 1 if you have reached the person\. Press 2 if you need backup\. Press 3 if you are still travelling\./);
  const done = await (await hook(`/twilio/followup?cid=${cid}&step=gather`, { Digits: '1', CallSid: 'CA9' })).text();
  assert.match(done, /person reached/i);
  assert.equal((await getEmergency(out.emergency.id)).state, 'PERSON_REACHED');
});

test('status webhook: no-answer triggers a retry; duplicates ignored', async () => {
  ctx = await fresh();
  const out = await chain.triggerEmergency(SOS);
  await out.started;
  const cid = cidOf(ctx.twilio.calls[0]);
  const p = { CallSid: 'CAs', CallStatus: 'no-answer' };
  assert.equal((await hook(`/twilio/status?cid=${cid}`, p)).status, 204);
  assert.equal((await hook(`/twilio/status?cid=${cid}`, p)).status, 204);
  await advance(1);
  assert.equal(ctx.twilio.calls.length, 2);
});

test('inbound SMS webhook returns TwiML message', async () => {
  ctx = await fresh();
  const out = await chain.triggerEmergency(SOS);
  await out.started;
  const r = await hook('/twilio/sms', { From: '+15550000001', Body: 'YES' });
  assert.match(await r.text(), /<Message>CHER: YES recorded/);
  assert.equal((await getEmergency(out.emergency.id)).state, 'RESPONDER_ACCEPTED');
});

test('Twilio call failure: recorded, retried, chain continues (no crash)', async () => {
  ctx = await fresh();
  ctx.twilio.failCalls = true;
  const out = await chain.triggerEmergency(SOS);
  await out.started;
  const id = out.emergency.id;
  const tl = (await getTimeline(id)).map((t) => t.type);
  assert.ok(tl.includes('CALL_FAILED'));
  assert.ok(tl.includes('SMS_SENT'), 'SMS still went out');
  await advance(1);
  ctx.twilio.failCalls = false;
  await advance(1);
  assert.ok(ctx.twilio.calls.length >= 1, 'recovered call goes out on retry');
});

test('Twilio totally down (calls + SMS fail): bounded retries, then UNCONFIRMED with a human next action', async () => {
  ctx = await fresh();
  ctx.twilio.failCalls = true;
  ctx.twilio.failSms = true;
  const out = await chain.triggerEmergency(SOS);
  await out.started;
  for (let i = 0; i < 12; i++) await advance(1);
  const e = await getEmergency(out.emergency.id);
  assert.equal(e.state, 'UNCONFIRMED');
  assert.ok(e.nextAction && e.responsiblePerson);
  assert.equal(ctx.twilio.calls.length, 0);
});

test('logging redacts secrets and phone numbers', () => {
  const lines = [];
  setLogSink((l) => lines.push(l));
  const prev = config.logLevel;
  config.logLevel = 'info';
  log('info', 'x', { authToken: 'sekret', OPENAI_API_KEY: 'sk-123', note: 'call +15551234567 now', nested: { password: 'p' } });
  config.logLevel = prev;
  setLogSink(() => {});
  const out = lines.join('');
  assert.doesNotMatch(out, /sekret|sk-123|15551234567|"p"/);
  assert.match(out, /\[redacted\]/);
  assert.equal(maskPhone('+15551234567').endsWith('567'), true);
});

test('SMS content: concise, id, coordinates, timestamp, instruction; no health details', async () => {
  ctx = await fresh();
  const out = await chain.triggerEmergency({ ...SOS, health: { bpm: 171, trend: 'SUSTAINED_HIGH' } });
  await out.started;
  const body = ctx.twilio.messages[0].body;
  assert.match(body, /CHER emergency #/);
  assert.match(body, /Location: 37\.42200, -122\.08400/);
  assert.match(body, /\d{4}-\d{2}-\d{2}T/);
  assert.match(body, /Press 1/);
  assert.doesNotMatch(body, /171|SUSTAINED/);
  assert.ok(body.length < 480);
});
