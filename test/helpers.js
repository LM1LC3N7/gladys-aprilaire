// -----------------------------------------------------------------------------
// The app against the SDK's fake Gladys and the fake thermostat, with the
// exact wiring of the container (src/handlers.js) and the virtual clock of
// the kit: every read of the clock moves it on by 1 µs (a decision reading
// it twice sees it move), timers fire only when the test advances the time.
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { AprilaireApp } from '../src/app.js';
import { registerHandlers } from '../src/handlers.js';
import { memoryStore } from '../src/store.js';
import { HOST, MAC_HEX, NOW, fakeAprilaire } from './fixtures/fakeAprilaire.js';
import { settle, testClock } from './kit/clock.mjs';

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const CFG = { address: HOST };
export const ALLOW = { address: HOST, allow_commands: true };
export const DEVICE = `ext:test-integration:aprilaire:${MAC_HEX}`;
export const feature = (key) => `${DEVICE}:${key}`;

export async function setup({
  config = CFG,
  clock = testClock({ start: NOW }),
  th,
  store = memoryStore(),
  create = true,
  boot = false,
  getConfigFails = 0,
  connectGladys = true,
} = {}) {
  const device = th ?? fakeAprilaire({ timers: clock.timers, now: clock.now });
  const gladys = createFakeGladys({ config });
  if (getConfigFails > 0) {
    // The SDK reads the configuration once before 'connected'; the app's reads fail after.
    let left = getConfigFails;
    let calls = 0;
    const original = gladys.getConfig.bind(gladys);
    gladys.getConfig = async () => {
      calls += 1;
      if (calls > 1 && left > 0) {
        left -= 1;
        throw new Error('Gladys unreachable');
      }
      return original();
    };
  }
  const lines = [];
  const logger = Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((l) => [
      l,
      (...a) => lines.push(`${l}: ${a.map((x) => (x instanceof Error ? x.message : x)).join(' ')}`),
    ]),
  );
  const app = new AprilaireApp({
    gladys,
    logger,
    connect: device.connectFn,
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    store,
  });
  registerHandlers(gladys, app, logger);
  const advance = async (ms, step = 10) => {
    for (let e = 0; e < ms; e += step) {
      await clock.advance(Math.min(step, ms - e));
      await settle(2);
    }
  };
  if (boot) {
    await app.boot();
  }
  if (connectGladys) {
    const connecting = gladys.connect();
    await settle();
    await advance(500);
    await connecting;
    await advance(1000);
    if (create && gladys.fake.discoveredDevices.length > 0) {
      await gladys.fake.deviceCreated(gladys.fake.discoveredDevices[0]);
      await settle();
      await advance(1100);
    }
  }
  const fire = (key, value) => {
    const d = gladys.fake.devices.find((x) => x.external_id === DEVICE) ?? { external_id: DEVICE };
    return gladys.fake.setValue(d, { external_id: feature(key) }, value);
  };
  const press = async (key, value, wait = 5 * SECOND) => {
    const ack = fire(key, value);
    await advance(wait, 50);
    return ack;
  };
  const state = (key) =>
    gladys.fake.states.findLast((s) => s.device_feature_external_id === feature(key));
  // The fake may close its sockets on the test timers: the time moves until it is done.
  const stop = async () => {
    let done = false;
    const stopping = app.stop().finally(() => {
      done = true;
    });
    for (let i = 0; i < 100 && !done; i += 1) await advance(100, 100);
    await stopping;
  };
  return { gladys, app, th: device, clock, advance, lines, fire, press, store, state, stop };
}
