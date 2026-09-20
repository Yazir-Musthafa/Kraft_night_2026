// Twilio webhooks. Every request is signature-verified; emergency/responder context comes from the
// server-side call record (random, unguessable `cid`), never from client-supplied emergency IDs.
import { Router, urlencoded } from 'express';
import twilio from 'twilio';
import { logger } from '../logging.js';
import { claimOnce, K } from '../redis.js';
import * as tw from '../twilio.js';
import { findEmergency } from '../emergency.js';
import { onGather, onFollowupAnswer, onCallStatus, onInboundSms, markLocationDelivered } from '../responseChain.js';
import { publish } from '../events.js';

const xml = (res, body, status = 200) => res.status(status).type('text/xml').send(body);
/** cid from the query (webhook mode) or, for TwiML-Bin calls, from the CallSid we recorded when placing the call. */
const cidOf = async (req) => String(req.query.cid ?? '') || (await tw.cidFromCallSid(String(req.body?.CallSid ?? ''))) || '';

export function twilioRoutes() {
  const r = Router();
  r.use('/twilio', urlencoded({ extended: false, limit: '20kb' }));

  // Log every request Twilio makes to us (path only: no query values, no body, no secrets).
  r.use('/twilio', (req, res, next) => {
    const t0 = Date.now();
    res.on('finish', () => logger.info('twilio.webhook', { path: req.path, method: req.method, status: res.statusCode, ms: Date.now() - t0, digits: req.body?.Digits ?? null, ua: String(req.get('user-agent') ?? '').slice(0, 24) }));
    next();
  });

  r.use('/twilio', (req, res, next) => {
    const v = tw.verifyWebhook(req);
    if (!v.ok) {
      logger.warn('twilio.webhook_rejected', { path: req.path, reason: v.reason });
      return res.status(403).type('text/plain').send('Forbidden');
    }
    return next();
  });

  r.post('/twilio/voice', async (req, res) => {
    const cid = String(req.query.cid ?? '');
    const rec = await tw.getCallRecord(cid);
    if (!rec || rec.purpose !== 'INITIAL') return xml(res, tw.sayAndHangup('This call is no longer valid. Goodbye.'));
    const e = await findEmergency(rec.emergencyId);
    if (!e || ['RESOLVED', 'CANCELLED'].includes(e.state)) return xml(res, tw.sayAndHangup('This emergency has already been closed. Thank you.'));
    await tw.updateCallRecord(cid, { answered: true, callSid: req.body?.CallSid });
    await tw.bindCallSid(cid, req.body?.CallSid);
    return xml(res, tw.initialTwiml(cid, tw.safeText(e.messages?.callMessage, tw.fallbackCallMessage(e), 600)));
  });

  r.post('/twilio/gather', async (req, res) => {
    const cid = await cidOf(req);
    const digits = String(req.body?.Digits ?? '').trim();
    const out = await onGather(cid, digits);
    switch (out.kind) {
      case 'ACCEPTED': {
        const rec = await tw.getCallRecord(cid);
        const loc = out.res?.emergency?.location;
        if (loc && rec) await markLocationDelivered(rec.emergencyId, rec.responderId, 'CALL');
        const where = loc ? `The person's last known location is ${tw.spokenCoordinates(loc)}. I repeat: ${tw.spokenCoordinates(loc)}.` : 'The location is not available yet.';
        return xml(res, tw.sayAndHangup(`Thank you. ${where} We will call back shortly to check on the response.`));
      }
      case 'DECLINED':
        return xml(res, tw.sayAndHangup('Understood. CHER will contact another responder. Thank you.'));
      case 'INVALID': {
        const rec = await tw.getCallRecord(cid);
        const e = rec ? await findEmergency(rec.emergencyId) : null;
        return e ? xml(res, tw.initialTwiml(cid, tw.fallbackCallMessage(e))) : xml(res, tw.sayAndHangup('Goodbye.'));
      }
      case 'DUPLICATE':
        return xml(res, tw.sayAndHangup('Your response was already recorded. Thank you.'));
      case 'CLOSED':
        return xml(res, tw.sayAndHangup('This emergency has already been closed. Thank you.'));
      default:
        return xml(res, tw.sayAndHangup('This call is no longer valid. Goodbye.'));
    }
  });

  r.post('/twilio/followup', async (req, res) => {
    const cid = await cidOf(req);
    const rec = await tw.getCallRecord(cid);
    if (!rec || rec.purpose !== 'FOLLOWUP') return xml(res, tw.sayAndHangup('This call is no longer valid. Goodbye.'));
    if (req.query.step !== 'gather') {
      const e = await findEmergency(rec.emergencyId);
      if (!e || ['RESOLVED', 'CANCELLED'].includes(e.state)) return xml(res, tw.sayAndHangup('This emergency has already been closed. Thank you.'));
      await tw.updateCallRecord(cid, { answered: true, callSid: req.body?.CallSid });
      await tw.bindCallSid(cid, req.body?.CallSid);
      return xml(res, tw.followupTwiml(cid, rec.followUpType));
    }
    const out = await onFollowupAnswer(cid, String(req.body?.Digits ?? '').trim());
    if (out.kind === 'OK') {
      const text = {
        STATUS: { 1: 'Thank you. Marked as person reached. CHER will ask for a final confirmation shortly.', 2: 'Understood. CHER is finding backup now.', 3: 'Thank you. Marked as still travelling. CHER will check in again.' },
        CONFIRM: { 1: 'Thank you. Help is confirmed. CHER will keep the emergency open until it is closed.', 2: 'Understood. CHER is finding backup now.', 3: 'Thank you. The emergency is now closed.' },
      }[out.followUpType]?.[out.digits];
      return xml(res, tw.sayAndHangup(text ?? 'Thank you.'));
    }
    if (out.kind === 'INVALID') return xml(res, tw.followupTwiml(cid, rec.followUpType));
    if (out.kind === 'DUPLICATE') return xml(res, tw.sayAndHangup('Your response was already recorded. Thank you.'));
    return xml(res, tw.sayAndHangup('This emergency has already been closed. Thank you.'));
  });

  r.post('/twilio/status', async (req, res) => {
    const b = req.body ?? {};
    if (req.query.kind === 'sms') {
      if (b.MessageSid && (await claimOnce(K.idem('smsstatus', `${b.MessageSid}:${b.MessageStatus}`), 24 * 3600))) {
        publish('twilio:sms', { status: b.MessageStatus, sid: b.MessageSid });
      }
      return res.status(204).end();
    }
    const cid = String(req.query.cid ?? '');
    await onCallStatus({ cid, callSid: String(b.CallSid ?? ''), status: String(b.CallStatus ?? '') });
    return res.status(204).end();
  });

  r.post('/twilio/sms', async (req, res) => {
    const out = await onInboundSms(String(req.body?.From ?? ''), String(req.body?.Body ?? ''));
    const mr = new twilio.twiml.MessagingResponse();
    mr.message(out.reply);
    return xml(res, mr.toString());
  });

  return r;
}
