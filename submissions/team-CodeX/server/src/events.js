// Internal event bus. Domain modules publish here; socket.js fans events out to Socket.IO clients.
import { EventEmitter } from 'node:events';

export const bus = new EventEmitter();
bus.setMaxListeners(50);

/**
 * Publish a realtime event. `emergencyId`/`watchId` route it to that emergency's and watch's rooms; `room` sends it to
 * exactly one named room (plus dashboards) instead, used for nearby-helper events the person's own watch must not get.
 */
export function publish(event, payload, { emergencyId, watchId, room } = {}) {
  bus.emit('publish', { event, payload, emergencyId, watchId, room });
}
