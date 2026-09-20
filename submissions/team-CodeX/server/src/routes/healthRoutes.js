// Service health + watch telemetry intake (heart rate, location).
import { Router } from 'express';
import { config, configWarnings } from '../config.js';
import { pingRedis } from '../redis.js';
import { isSimulated } from '../twilio.js';
import { aiEnabled } from '../ai.js';
import { listEmergencies, activeEmergencyForWatch } from '../emergency.js';
import { processHealth } from '../health.js';
import { processLocation } from '../location.js';
import { healthSampleSchema, locationSchema } from '../validation.js';

export function healthRoutes() {
  const r = Router();

  r.get('/health', async (_req, res) => {
    const redis = await pingRedis();
    let active = null;
    if (redis.ok) active = (await listEmergencies({ activeOnly: true }).catch(() => [])).length;
    res.status(redis.ok ? 200 : 503).json({
      status: redis.ok ? 'ok' : 'degraded',
      service: 'cher-server',
      redis,
      ai: { enabled: aiEnabled(), model: aiEnabled() ? config.openai.model : null },
      twilio: { mode: isSimulated() ? 'simulated' : 'live', contacts: config.contacts.length },
      demoMode: config.demoMode,
      activeEmergencies: active,
      uptimeSeconds: Math.round(process.uptime()),
      warnings: configWarnings(config).length,
      timestamp: Date.now(),
    });
  });

  r.post('/api/health', async (req, res) => {
    const data = healthSampleSchema.parse(req.body);
    const out = await processHealth({ ...data, watchId: data.watchId ?? config.defaultWatchId });
    res.status(out.accepted ? 200 : 202).json(out);
  });

  r.post('/api/location', async (req, res) => {
    const data = locationSchema.parse(req.body);
    const watchId = data.watchId ?? config.defaultWatchId;
    const out = await processLocation({ ...data, watchId }, { hasActiveEmergency: Boolean(await activeEmergencyForWatch(watchId)) });
    res.status(out.accepted ? 200 : 202).json(out);
  });

  return r;
}
