import './env.js';
import { setClient } from '../src/redis.js';
import { MemoryRedis } from '../src/memoryRedis.js';
import { setClientForTests as setTwilio } from '../src/twilio.js';
import { setRunnerForTests } from '../src/ai.js';
import { bus } from '../src/events.js';
import { initResponseChain, initResponders } from '../src/responseChain.js';
import { tick } from '../src/scheduler.js';
import { resetLocationRateLimit } from '../src/location.js';
import { setLogSink } from '../src/logging.js';

setLogSink(() => {});
let chainInit = false;

/** Fake Twilio REST client that records everything and can be told to fail. */
export function fakeTwilio() {
  const f = { calls: [], messages: [], failCalls: false, failSms: false };
  f.client = {
    calls: {
      create: async (o) => {
        if (f.failCalls) throw Object.assign(new Error('twilio down'), { code: 20003 });
        f.calls.push(o);
        return { sid: `CA${String(f.calls.length).padStart(4, '0')}` };
      },
    },
    messages: {
      create: async (o) => {
        if (f.failSms) throw Object.assign(new Error('sms down'), { code: 30003 });
        f.messages.push(o);
        return { sid: `SM${String(f.messages.length).padStart(4, '0')}`, status: 'queued' };
      },
    },
  };
  return f;
}

/** Fresh Redis (in-memory), fresh fake Twilio, no AI. Returns handles + event capture. */
export async function fresh({ ai = null } = {}) {
  const redis = new MemoryRedis();
  setClient(redis);
  const twilio = fakeTwilio();
  setTwilio(twilio.client);
  setRunnerForTests(ai);
  resetLocationRateLimit();
  if (!chainInit) {
    initResponseChain();
    chainInit = true;
  }
  await initResponders();
  const events = [];
  const listener = (m) => events.push(m);
  bus.on('publish', listener);
  return { redis, twilio, events, done: () => bus.off('publish', listener) };
}

export const names = (events) => events.map((e) => e.event);

/** Run everything scheduled, repeatedly, as if `hours` had passed. */
export async function advance(rounds = 1, hours = 24) {
  let ran = 0;
  for (let i = 0; i < rounds; i++) ran += await tick(Date.now() + hours * 3600_000);
  return ran;
}

export const SOS = { triggerType: 'MANUAL_SOS', location: { latitude: 37.422, longitude: -122.084, accuracy: 10, timestamp: Date.now() } };
