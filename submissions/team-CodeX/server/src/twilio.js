// Twilio voice + SMS. Credentials come ONLY from environment variables.
// With no credentials the module runs in SIMULATED mode so the whole flow can be demonstrated offline.
import crypto from 'node:crypto';
import twilio from 'twilio';
import { config } from './config.js';
import { K, getJson, setJson, safe } from './redis.js';
import { publish } from './events.js';
import { logger, maskPhone } from './logging.js';
import { formatCoordinates, locationUrl } from './location.js';
import { containsDiagnosis } from './validation.js';

let client = null;
let clientOverride = null;

/** Inject a fake Twilio client (tests). */
export function setClientForTests(c) {
  clientOverride = c;
}

export function isSimulated() {
  if (clientOverride) return false;
  const t = config.twilio;
  if (t.forceSimulated) return true;
  return !(t.accountSid && t.authToken && t.phoneNumber && config.publicUrl);
}

function getClient() {
  if (clientOverride) return clientOverride;
  if (!client) client = twilio(config.twilio.accountSid, config.twilio.authToken);
  return client;
}

/** Twilio REST calls resource (callWatcher polls call status with it). */
export const callsApi = () => {
  const api = getClient().calls;
  return typeof api === 'function' ? api : () => { throw new Error('call status not available'); };
};

const fromNumber = () => config.twilio.phoneNumber || '+10000000000';
export const shortId = (id) => String(id).replace(/^E-/, '').slice(0, 8);

// ------------------------------------------------------------------ text helpers
/** Reject AI/user text that asserts a diagnosis; return the fallback instead. */
export function safeText(text, fallback, max = 600) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!t || containsDiagnosis(t)) return fallback;
  return t.slice(0, max);
}

export function fallbackCallMessage(e) {
  const loc = e.location ? 'We have their latest location.' : 'Their location is not currently available.';
  return `This is CHER emergency coordination. A person may need assistance. We have detected an emergency event. ${loc} Are you near the person and can you reach the location? Press 1 if you can help. Press 2 if you cannot help.`;
}

export function composeSms(e, { update = false } = {}) {
  const loc = e.location;
  const ts = new Date(loc?.timestamp ?? e.createdAt).toISOString().replace('.000Z', 'Z');
  const summary = safeText(e.messages?.smsMessage, 'A person may need assistance. Unusual signals were detected.', 200);
  const lines = [
    `CHER ${update ? 'location update' : 'emergency'} #${shortId(e.id)}`,
    summary,
    loc ? `Location: ${formatCoordinates(loc)} @ ${ts}` : 'Location: unavailable',
  ];
  const url = locationUrl(loc);
  if (url) lines.push(url);
  lines.push(update ? 'Reply/callback: keep following the CHER call prompts.' : 'CHER will call you. Press 1 on the call if you can help, 2 if you cannot.');
  return lines.join('\n').slice(0, 480);
}

// ------------------------------------------------------------------ SMS / calls
/**
 * Send an SMS. Never throws: returns {ok, sid?, simulated?, error?} and publishes twilio:sms.
 */
export async function sendSms({ to, body, emergencyId, responderId, watchId, purpose = 'EMERGENCY' }) {
  const meta = { emergencyId, responderId, to: maskPhone(to), purpose };
  try {
    if (isSimulated()) {
      logger.info('twilio.sms.simulated', { ...meta, chars: body.length });
      publish('twilio:sms', { ...meta, status: 'simulated' }, { emergencyId, watchId });
      return { ok: true, simulated: true, sid: `SIM-${crypto.randomUUID().slice(0, 8)}` };
    }
    const msg = await getClient().messages.create({
      to,
      from: fromNumber(),
      body,
      statusCallback: config.publicUrl ? `${config.publicUrl}/twilio/status?kind=sms` : undefined,
    });
    logger.info('twilio.sms.sent', { ...meta, sid: msg.sid });
    publish('twilio:sms', { ...meta, status: msg.status ?? 'queued', sid: msg.sid }, { emergencyId, watchId });
    return { ok: true, sid: msg.sid };
  } catch (err) {
    logger.error('twilio.sms.failed', { ...meta, message: err?.message, code: err?.code });
    publish('twilio:sms', { ...meta, status: 'failed', error: err?.message }, { emergencyId, watchId });
    return { ok: false, error: err?.message ?? 'SMS failed' };
  }
}

/** Call records bind a random unguessable id (cid) to server-side context: webhooks never trust IDs in the request. */
export async function createCallRecord(ctx) {
  const cid = crypto.randomBytes(16).toString('hex');
  await setJson(K.call(cid), { cid, ...ctx, createdAt: Date.now(), answered: false, responded: false, status: 'created' }, 7 * 24 * 3600);
  return cid;
}
export const getCallRecord = (cid) => (cid && /^[a-f0-9]{32}$/.test(cid) ? getJson(K.call(cid)) : Promise.resolve(null));
export async function updateCallRecord(cid, patch) {
  const rec = await getCallRecord(cid);
  if (!rec) return null;
  const next = { ...rec, ...patch };
  await setJson(K.call(cid), next, 7 * 24 * 3600);
  return next;
}
/** Resolve our call-record id from a Twilio CallSid (used when the call was started from a TwiML Bin, which carries no cid). */
export async function cidFromCallSid(sid) {
  if (!sid || !/^CA[0-9a-f]{32}$/i.test(sid)) return null;
  return safe((c) => c.get(K.callBySid(sid)));
}

export const binMode = () => Boolean(config.twilio.bins.initial);

function binFor(kind, followUpType) {
  const b = config.twilio.bins;
  if (kind === 'FOLLOWUP') return followUpType === 'CONFIRM' ? b.followupConfirm : b.followupStatus;
  return b.initial;
}

export async function bindCallSid(cid, sid) {
  if (sid) await safe((c) => c.set(K.callBySid(sid), cid, { expiration: { type: 'EX', value: 7 * 24 * 3600 } }));
}

/**
 * Place a call. The call fetches TwiML from /twilio/voice (initial) or /twilio/followup.
 * Never throws: returns {ok, sid?, simulated?, error?}.
 */
export async function startCall({ to, cid, kind = 'INITIAL', followUpType, emergencyId, responderId, watchId }) {
  const meta = { emergencyId, responderId, to: maskPhone(to), kind, cid: cid.slice(0, 6) };
  try {
    if (isSimulated()) {
      logger.info('twilio.call.simulated', meta);
      publish('twilio:call', { ...meta, status: 'simulated' }, { emergencyId, watchId });
      return { ok: true, simulated: true, sid: `SIM-${crypto.randomUUID().slice(0, 8)}` };
    }
    let params;
    if (binMode()) {
      // Trial-compatible: only a Twilio-hosted URL. The bin's <Gather action> posts the digit back to /twilio/gather
      // or /twilio/followup, and we find our record from the CallSid recorded below.
      const url = binFor(kind, followUpType);
      if (!url) throw new Error(`no TwiML Bin configured for ${kind}${followUpType ? `/${followUpType}` : ''}`);
      params = { to, from: fromNumber(), url };
    } else {
      const path = kind === 'FOLLOWUP' ? '/twilio/followup' : '/twilio/voice';
      params = {
        to,
        from: fromNumber(),
        url: `${config.publicUrl}${path}?cid=${cid}`,
        method: 'POST',
        statusCallback: `${config.publicUrl}/twilio/status?cid=${cid}`,
        statusCallbackMethod: 'POST',
        statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
        timeout: 30,
      };
    }
    const call = await getClient().calls.create(params);
    await bindCallSid(cid, call.sid);
    logger.info('twilio.call.started', { ...meta, sid: call.sid, mode: binMode() ? 'twiml-bin' : 'webhook' });
    publish('twilio:call', { ...meta, status: 'queued', sid: call.sid }, { emergencyId, watchId });
    return { ok: true, sid: call.sid };
  } catch (err) {
    logger.error('twilio.call.failed', { ...meta, message: err?.message, code: err?.code });
    publish('twilio:call', { ...meta, status: 'failed', error: err?.message }, { emergencyId, watchId });
    return { ok: false, error: err?.message ?? 'Call failed' };
  }
}

/** "37.4220 N, 122.0840 W" read aloud unambiguously (used because SMS to India is blocked on trial accounts). */
export function spokenCoordinates(loc) {
  const part = (v, pos, neg) => `${Math.abs(v).toFixed(4).replace('.', ' point ')} ${v >= 0 ? pos : neg}`;
  return `latitude ${part(loc.latitude, 'north', 'south')}, longitude ${part(loc.longitude, 'east', 'west')}`;
}

// ------------------------------------------------------------------ TwiML
const abs = (path) => `${config.publicUrl}${path}`;
const VoiceResponse = twilio.twiml.VoiceResponse;

export function initialTwiml(cid, message) {
  const vr = new VoiceResponse();
  const g = vr.gather({ input: 'dtmf', numDigits: 1, timeout: 8, method: 'POST', action: abs(`/twilio/gather?cid=${cid}`) });
  g.say({ language: 'en-US' }, message);
  g.pause({ length: 1 });
  g.say({ language: 'en-US' }, 'Repeating. Press 1 if you can help the person. Press 2 if you cannot help.');
  vr.say({ language: 'en-US' }, 'We did not receive a response. Goodbye.');
  vr.hangup();
  return vr.toString();
}

export const FOLLOWUP_PROMPTS = {
  STATUS:
    'CHER follow-up. Please confirm the response status. Press 1 if you have reached the person. Press 2 if you need backup. Press 3 if you are still travelling.',
  CONFIRM:
    'CHER follow-up. You reported reaching the person. Press 1 to confirm the person has received help. Press 2 if you need backup. Press 3 to confirm the situation is safe and close this emergency.',
};

export function followupTwiml(cid, type = 'STATUS') {
  const vr = new VoiceResponse();
  const g = vr.gather({ input: 'dtmf', numDigits: 1, timeout: 8, method: 'POST', action: abs(`/twilio/followup?cid=${cid}&step=gather`) });
  g.say({ language: 'en-US' }, FOLLOWUP_PROMPTS[type] ?? FOLLOWUP_PROMPTS.STATUS);
  vr.say({ language: 'en-US' }, 'We did not receive a response. CHER will try again shortly. Goodbye.');
  vr.hangup();
  return vr.toString();
}

export function sayAndHangup(text) {
  const vr = new VoiceResponse();
  vr.say({ language: 'en-US' }, text);
  vr.hangup();
  return vr.toString();
}

export function emptyResponse() {
  return new VoiceResponse().toString();
}

// ------------------------------------------------------------------ webhook verification
/**
 * Verify a Twilio webhook. Fails closed when an auth token is configured.
 * Without a token only demo mode accepts requests (there are no real callers then).
 */
export function verifyWebhook(req) {
  const token = config.twilio.authToken;
  if (!token) return config.demoMode ? { ok: true, reason: 'demo-unsigned' } : { ok: false, reason: 'twilio-not-configured' };
  const sig = req.get('x-twilio-signature');
  if (!sig) return { ok: false, reason: 'missing-signature' };
  if (!config.publicUrl) return { ok: false, reason: 'public-url-not-configured' };
  const url = `${config.publicUrl}${req.originalUrl}`;
  const ok = twilio.validateRequest(token, sig, url, req.body ?? {});
  return ok ? { ok: true } : { ok: false, reason: 'bad-signature' };
}
