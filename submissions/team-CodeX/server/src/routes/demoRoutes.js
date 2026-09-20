// Demo mode: simulate sensors, falls and responders so the full lifecycle can be shown without real danger.
// Mounted only when CHER_DEMO_MODE=true.
import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { K, deleteByPrefix, safe } from '../redis.js';
import { processHealth } from '../health.js';
import { resetLocationRateLimit, processLocation } from '../location.js';
import { assessSignals } from '../sensors.js';
import { publish } from '../events.js';
import { activeEmergencyForWatch, listEmergencies, getEmergencyResponders, viewOf, ApiError } from '../emergency.js';
import * as chain from '../responseChain.js';
import * as scheduler from '../scheduler.js';
import { sendToWatch } from '../socket.js';
import { TRIGGER_TYPES } from '../validation.js';
import { helperRespond, helperStatus, registerHelper } from '../nearbyHelpers.js';
import { setJson } from '../redis.js';

const DEMO_LAT = Number(process.env.CHER_DEMO_LAT ?? 37.422);
const DEMO_LNG = Number(process.env.CHER_DEMO_LNG ?? -122.084);

const wave = (i, base, amp = 3) => Math.round(base + amp * Math.sin(i * 1.7) + (i % 3) - 1);

export const SCENARIOS = {
  normal: () => Array.from({ length: 60 }, (_, i) => wave(i, 72)),
  high: () => [...Array.from({ length: 50 }, (_, i) => wave(i, 72)), ...Array.from({ length: 9 }, (_, i) => 158 + (i % 3) * 3)],
  low: () => [...Array.from({ length: 50 }, (_, i) => wave(i, 72)), ...Array.from({ length: 9 }, (_, i) => 36 + (i % 3))],
  trend: () => [...Array.from({ length: 50 }, (_, i) => wave(i, 72)), ...Array.from({ length: 12 }, (_, i) => 72 + (i + 1) * 5)],
};

async function feedHealth(watchId, values, spacingMs = 5000) {
  await safe((c) => c.del(K.health(watchId)));
  const now = Date.now();
  let last = null;
  for (let i = 0; i < values.length; i++) {
    last = await processHealth({ watchId, bpm: values[i], accuracy: 'HIGH', timestamp: now - (values.length - 1 - i) * spacingMs, source: 'demo' });
  }
  return last;
}

const targetEmergency = async (watchId, explicitId) => {
  if (explicitId) return explicitId;
  const active = await activeEmergencyForWatch(watchId);
  if (active) return active.id;
  const [latest] = await listEmergencies({ activeOnly: true, limit: 1 });
  if (!latest) throw new ApiError(404, 'NO_ACTIVE_EMERGENCY', 'No active emergency');
  return latest.id;
};

export function demoRoutes() {
  const r = Router();
  const watchOf = (b) => b?.watchId ?? config.defaultWatchId;

  r.post('/api/demo/emergency', async (req, res) => {
    const b = z.object({ triggerType: z.enum(TRIGGER_TYPES).default('MANUAL_SOS'), watchId: z.string().optional() }).parse(req.body ?? {});
    const watchId = watchOf(b);
    await processLocation({ watchId, latitude: DEMO_LAT, longitude: DEMO_LNG, accuracy: 12, timestamp: Date.now() }, { hasActiveEmergency: true });
    const signals = b.triggerType === 'MANUAL_SOS' ? [] : ['HEART_RATE_ABNORMAL', 'IMPACT', 'NO_USER_RESPONSE'];
    const out = await chain.triggerEmergency({ watchId, triggerType: b.triggerType, signals, demo: true });
    await out.started;
    res.status(out.created ? 201 : 200).json({ created: out.created, merged: out.merged, emergency: await viewOf(out.emergency.id) });
  });

  r.post('/api/demo/health', async (req, res) => {
    const b = z.object({ scenario: z.enum(['normal', 'high', 'low', 'trend']).default('normal'), watchId: z.string().optional() }).parse(req.body ?? {});
    const out = await feedHealth(watchOf(b), SCENARIOS[b.scenario]());
    res.json({ scenario: b.scenario, summary: out?.summary, assessment: out?.assessment });
  });

  r.post('/api/demo/fall', async (req, res) => {
    const b = z.object({ viaWatch: z.boolean().default(false), respond: z.enum(['none', 'ok', 'help']).default('none'), watchId: z.string().optional() }).parse(req.body ?? {});
    const watchId = watchOf(b);
    if (b.viaWatch) {
      sendToWatch(watchId, 'demo:command', { command: 'SIMULATE_FALL' });
      return res.json({ sent: true, note: 'Watch will run its own detection flow: impact -> Are you OK? -> escalate' });
    }
    const motion = { event: 'IMPACT_THEN_INACTIVITY', peakG: 4.2, inactivitySeconds: 65 };
    const assessment = assessSignals({ hr: { abnormal: false }, motion: { peakG: motion.peakG, inactivitySeconds: motion.inactivitySeconds }, userResponse: b.respond === 'none' ? 'NO_RESPONSE' : b.respond === 'help' ? 'NEEDS_HELP' : undefined });
    publish('health:update', { watchId, summary: null, assessment, motion }, { watchId });
    if (b.respond === 'ok') return res.json({ emergency: null, note: 'Person answered "I\'m OK": escalation cancelled', assessment });
    await processLocation({ watchId, latitude: DEMO_LAT, longitude: DEMO_LNG, accuracy: 12, timestamp: Date.now() }, { hasActiveEmergency: true });
    const out = await chain.triggerEmergency({
      watchId,
      triggerType: b.respond === 'help' ? 'USER_NEEDS_HELP' : 'AUTO_FALL_NO_RESPONSE',
      signals: b.respond === 'help' ? ['IMPACT', 'USER_REQUESTED_HELP'] : ['IMPACT', 'FALL_LIKE_MOTION', 'INACTIVITY', 'NO_USER_RESPONSE'],
      userResponse: b.respond === 'help' ? 'NEEDS_HELP' : 'NO_RESPONSE',
      motion,
      demo: true,
    });
    await out.started;
    res.status(out.created ? 201 : 200).json({ assessment, created: out.created, merged: out.merged, emergency: await viewOf(out.emergency.id) });
  });

  // Play the human responder's key-presses without a phone: accept, decline, moving, backup, reached, confirm, resolve, followup.
  r.post('/api/demo/responder', async (req, res) => {
    const b = z.object({
      action: z.enum(['accept', 'decline', 'moving', 'backup', 'reached', 'confirm', 'resolve', 'followup']),
      responderId: z.string().optional(),
      emergencyId: z.string().optional(),
      watchId: z.string().optional(),
    }).parse(req.body ?? {});
    const id = await targetEmergency(watchOf(b), b.emergencyId);
    const records = await getEmergencyResponders(id);
    const responderId =
      b.responderId ??
      records.find((x) => x.status === 'CONTACTING')?.responderId ??
      records.find((x) => ['ACCEPTED', 'MOVING', 'REACHED'].includes(x.status))?.responderId ??
      config.contacts[0]?.id;
    if (!responderId) throw new ApiError(400, 'NO_RESPONDER', 'No responder configured (set EMERGENCY_CONTACT_1)');
    let out;
    switch (b.action) {
      case 'accept': out = await chain.responderAccepts(id, responderId, { via: 'DEMO' }); break;
      case 'decline': out = await chain.responderDeclines(id, responderId, { via: 'DEMO' }); break;
      case 'moving': out = await chain.responderMoving(id, responderId, { via: 'DEMO' }); break;
      case 'backup': out = await chain.responderNeedsBackup(id, responderId, { reason: 'Demo: responder needs backup', via: 'DEMO' }); break;
      case 'reached': out = await chain.responderReached(id, responderId, { via: 'DEMO' }); break;
      case 'confirm': out = await chain.helpConfirmed(id, 'Demo responder'); break;
      case 'resolve': out = await chain.resolveEmergency(id, { confirmedBy: 'Demo responder', note: 'Demo' }); break;
      case 'followup': {
        const engaged = new Set(records.filter((x) => ['ACCEPTED', 'MOVING', 'REACHED'].includes(x.status)).map((x) => x.responderId));
        const pending = (await scheduler.listItems(id)).find((i) => i.status === 'PENDING' && (i.type === 'FOLLOWUP_STATUS' || i.type === 'FOLLOWUP_CONFIRM') && engaged.has(i.responderId));
        if (!pending) throw new ApiError(409, 'NO_FOLLOWUP', 'No pending follow-up');
        await scheduler.cancel(id, (i) => i.id === pending.id);
        await scheduler.schedule({ emergencyId: id, responderId: pending.responderId, type: pending.type, delaySeconds: 0, retryCount: pending.retryCount });
        await scheduler.tick();
        out = { note: 'follow-up triggered now' };
        break;
      }
    }
    res.json(out);
  });

  // A virtual nearby helper (no device needed): registers it, gives it a position `distanceM` metres north of the demo spot
  // (or an explicit latitude/longitude) and can answer a pop-up: respond=accept|decline, or status=moving|reached|backup|safe.
  r.post('/api/demo/helper', async (req, res) => {
    const b = z.object({
      watchId: z.string().default('helper-demo'),
      name: z.string().max(40).default('Demo helper'),
      distanceM: z.number().min(0).max(50000).default(300),
      latitude: z.number().optional(),
      longitude: z.number().optional(),
      respond: z.enum(['accept', 'decline']).optional(),
      status: z.enum(['moving', 'reached', 'backup', 'confirmed', 'safe']).optional(),
      emergencyId: z.string().optional(),
    }).parse(req.body ?? {});
    await registerHelper(b.watchId, { name: b.name, available: true });
    await setJson(K.connection(b.watchId), { connected: true, at: Date.now(), virtual: true }, 3600);
    const latitude = b.latitude ?? DEMO_LAT + b.distanceM / 111_320;
    const longitude = b.longitude ?? DEMO_LNG;
    await processLocation({ watchId: b.watchId, latitude, longitude, accuracy: 10, timestamp: Date.now() }, { hasActiveEmergency: true });
    let out = { registered: true, watchId: b.watchId, latitude, longitude };
    if (b.respond || b.status) {
      const id = await targetEmergency(watchOf(b), b.emergencyId);
      if (b.respond) out = { ...out, ...(await helperRespond(b.watchId, { emergencyId: id, response: b.respond.toUpperCase() })) };
      if (b.status) out = { ...out, ...(await helperStatus(b.watchId, { emergencyId: id, status: b.status.toUpperCase() })) };
    }
    res.json(out);
  });

  r.post('/api/demo/reset', async (_req, res) => {
    scheduler.stop();
    const deleted = await deleteByPrefix(`${config.redisPrefix}:`);
    resetLocationRateLimit();
    await chain.initResponders();
    scheduler.start();
    publish('demo:command', { command: 'RESET' });
    res.json({ reset: true, keysDeleted: deleted });
  });

  return r;
}
