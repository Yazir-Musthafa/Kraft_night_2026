// Read-only view of the nearby-helper registry (who could be alerted right now).
import { Router } from 'express';
import { config } from '../config.js';
import { listHelpers } from '../nearbyHelpers.js';

export function nearbyRoutes() {
  const r = Router();
  r.get('/api/helpers', async (_req, res) => {
    const { enabled, radiusMeters, waitSeconds, maxResponders } = config.nearby;
    res.json({ enabled, radiusMeters, waitSeconds, maxResponders, helpers: await listHelpers() });
  });
  return r;
}
