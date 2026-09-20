// Location intake and formatting. Coordinates only: no map SDKs, no routing, no geocoding.
import { config } from './config.js';
import { K, getJson, setJson, claimOnce } from './redis.js';
import { bus, publish } from './events.js';

const lastAcceptedAt = new Map(); // watchId -> ms (server-side rate limit)

export function resetLocationRateLimit() {
  lastAcceptedAt.clear();
}

export async function getLatestLocation(watchId = config.defaultWatchId) {
  return getJson(K.location(watchId));
}

/** Plain text/URL helpers. A URL is only produced when a template is explicitly configured. */
export function locationUrl(loc) {
  if (!loc || !config.locationUrlTemplate) return null;
  return config.locationUrlTemplate.replaceAll('{lat}', loc.latitude.toFixed(6)).replaceAll('{lng}', loc.longitude.toFixed(6));
}

export function formatCoordinates(loc) {
  if (!loc) return 'unavailable';
  const acc = loc.accuracy != null ? ` (±${Math.round(loc.accuracy)}m)` : '';
  return `${loc.latitude.toFixed(5)}, ${loc.longitude.toFixed(5)}${acc}`;
}

/**
 * Accept a location fix. Drops duplicates/stale/too-frequent fixes.
 * `hasActiveEmergency` relaxes the rate limit (higher frequency during an emergency).
 */
export async function processLocation(payload, { hasActiveEmergency = false } = {}) {
  const watchId = payload.watchId ?? config.defaultWatchId;
  const ts = payload.timestamp ?? Date.now();
  if (Date.now() - ts > config.limits.staleEventMs) return { accepted: false, reason: 'STALE' };
  if (payload.eventId && !(await claimOnce(K.idem('location', payload.eventId), 3600))) return { accepted: false, reason: 'DUPLICATE' };

  const prev = await getLatestLocation(watchId);
  if (prev && ts <= prev.timestamp) return { accepted: false, reason: 'STALE' };

  const minGap = hasActiveEmergency ? config.limits.locationMinIntervalMs : config.limits.locationMinIntervalMs * 5;
  const nowMs = Date.now();
  if (lastAcceptedAt.has(watchId) && nowMs - lastAcceptedAt.get(watchId) < minGap) return { accepted: false, reason: 'RATE_LIMITED' };

  const loc = { latitude: payload.latitude, longitude: payload.longitude, accuracy: payload.accuracy ?? null, timestamp: ts, provider: payload.provider ?? null };
  await setJson(K.location(watchId), loc, config.limits.locationTtlSeconds);
  lastAcceptedAt.set(watchId, nowMs);
  publish('location:update', { watchId, location: loc }, { watchId });
  bus.emit('location:accepted', { watchId, location: loc });
  return { accepted: true, location: loc };
}
