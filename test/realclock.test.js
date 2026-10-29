// -----------------------------------------------------------------------------
// The app on the REAL clock, sped up 20 times (30 s of the interval are 1.5 s,
// but it is the real clock: it moves between any two reads of it), against a
// real local TCP server answering the protocol like the fake thermostat and
// taking one client at a time: the polls really start at the interval, never
// sooner, on one connection kept open, and a stop goes at once.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { AprilaireApp } from '../src/app.js';
import { FrameReader } from '../src/aprilaire/packet.js';
import { memoryStore } from '../src/store.js';
import { MAC_HEX, fakeAprilaire } from './fixtures/fakeAprilaire.js';
import { measurePeriod, realClock, spyOn } from './kit/clock.mjs';
import { tcpServer } from './kit/tcp.mjs';

const SPEED = 20;
const INTERVAL = 30_000;

test('real clock x20: a poll every interval on one connection, a stop at once', async () => {
  const th = fakeAprilaire({ timers: { setTimeout() {}, clearTimeout() {} } });
  const readers = new Map();
  const device = await tcpServer({
    singleClient: true,
    latencyMs: 2,
    onData: (chunk, conn) => {
      if (!readers.has(conn.id)) readers.set(conn.id, new FrameReader());
      const out = [];
      for (const frame of readers.get(conn.id).push(chunk)) {
        th.log.push(frame);
        out.push(...th.handle(frame));
      }
      return out.length > 0 ? Buffer.concat(out) : undefined;
    },
  });
  const clock = realClock({ speed: SPEED });
  const gladys = createFakeGladys({ config: {} });
  await gladys.connect();
  const quiet = () => {};
  const app = new AprilaireApp({
    gladys,
    logger: { debug: quiet, info: quiet, warn: quiet, error: quiet },
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    store: memoryStore(),
  });
  const spy = spyOn(app, 'poll', clock);
  try {
    await app.connected({ address: `127.0.0.1:${device.port}`, poll_interval: INTERVAL / 1000 });
    const gaps = await measurePeriod(spy, { count: 3, period: INTERVAL });
    assert.equal(gaps.length, 2);
    assert.equal(device.connections, 1, 'one connection, kept');
    assert.equal(device.peak, 1);
    assert.equal(device.refused, 0);
    assert.equal(gladys.fake.connectionStatus.connected, true);
    const started = clock.monotonic();
    await app.setValue(
      undefined,
      {
        external_id: `ext:test-integration:aprilaire:${MAC_HEX}:mode`,
      },
      0,
    );
    assert.equal(th.state.mode, 1);
    assert.ok(clock.monotonic() - started < 3500, 'within the ack budget');
  } finally {
    spy.restore();
    await app.stop();
    clock.close();
    await device.close();
  }
  assert.ok(clock.timersSet < 400, `${clock.timersSet} timers`);
});
