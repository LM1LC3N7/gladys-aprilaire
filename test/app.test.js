// -----------------------------------------------------------------------------
// The integration end to end: fake Gladys, fake thermostat, virtual clock.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_TRANSPORTS } from '@gladysassistant/integration-sdk';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { AprilaireApp, PRIORITY } from '../src/app.js';
import { memoryStore } from '../src/store.js';
import { ALLOW, CFG, DEVICE, MINUTE, SECOND, feature, setup } from './helpers.js';
import { HOST, NOW, fakeAprilaire } from './fixtures/fakeAprilaire.js';
import { testClock } from './kit/clock.mjs';

const OFF = 0;
const HEATING = 1;
const COOLING = 2;

test('discovery: one device by its MAC address, the values read and published', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  const [device] = ctx.gladys.fake.discoveredDevices;
  assert.equal(device.external_id, DEVICE);
  assert.equal(device.model, 'Aprilaire 8840');
  const types = device.features.map((f) => `${f.category}/${f.type}`);
  assert.ok(!types.some((x) => x.startsWith('switch/')), 'never a switch');
  for (const f of device.features.filter((f) => !f.read_only)) {
    assert.ok(
      [
        'text/select',
        'thermostat/mode',
        'thermostat/target-temperature',
        'air-conditioning/target-temperature',
      ].includes(`${f.category}/${f.type}`),
      `${f.external_id} is writable`,
    );
  }
  const heat = device.features.find((f) => f.external_id === feature('heat-setpoint'));
  assert.equal(heat.min, 4.5);
  assert.equal(heat.max, 32);
  assert.equal(heat.unit, 'celsius');
  assert.equal(ctx.state('temperature').state, 21.5);
  assert.equal(ctx.state('humidity').state, 41);
  assert.equal(ctx.state('outdoor-temperature').state, -3);
  assert.equal(ctx.state('heat-setpoint').state, 20);
  assert.equal(ctx.state('cool-setpoint').state, 25);
  assert.equal(ctx.state('mode').state, HEATING);
  assert.equal(ctx.state('fan-mode').text, 'auto');
  assert.equal(ctx.state('operating-state').state, 1);
  assert.equal(ctx.state('fan-running').state, 1);
  assert.equal(ctx.state('hold').text, 'Aucune (programme)');
  assert.equal(ctx.state('humidifier').text, 'En marche (consigne 35 %)');
  assert.equal(ctx.state('dehumidifier').text, 'Au repos (consigne 55 %)');
  assert.equal(ctx.state('ventilation').text, 'Au repos (mode automatique)');
  assert.equal(ctx.state('air-cleaner').text, 'Arrêté (mode arrêt)');
  assert.equal(ctx.state('error').text, 'Aucune');
  assert.equal(ctx.gladys.fake.connectionStatus.connected, true);
  assert.equal(ctx.gladys.fake.transports.at(-1).transport, DEVICE_TRANSPORTS.LOCAL);
  assert.equal(ctx.th.maxOpen, 1, 'one connection');
  assert.equal(ctx.th.open.size, 1, 'kept open');
  assert.ok(!ctx.lines.some((l) => /^warn|^error/.test(l)), ctx.lines.join('\n'));
});

const controlWrites = (th) => th.writes().filter((w) => w.domain === 2 && w.attribute === 1);

test('commands off by default: a setpoint refused unsent; the stop goes all the same', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  const reads = ctx.th.log.length;
  const pending = ctx.fire('heat-setpoint', 22);
  await ctx.advance(50, 10);
  assert.equal(ctx.th.log.length, reads, 'refused on arrival: not even a read');
  const ack = await pending;
  assert.equal(ack.success, false);
  assert.match(ack.message ?? ack.error ?? '', /désactivées/);
  assert.equal(controlWrites(ctx.th).length, 0);
  const stop = await ctx.press('mode', OFF);
  assert.equal(stop.success, true, JSON.stringify(stop));
  const [write] = controlWrites(ctx.th);
  assert.deepEqual(write.data, [1, 0, 0, 0], 'the mode alone, the rest NULL');
  assert.equal(ctx.th.state.mode, 1);
  assert.equal(ctx.state('mode').state, OFF);
});

test('a setpoint: only its byte written, bounded, rounded to 0.5 °C, confirmed by the read back', async (t) => {
  const ctx = await setup({ config: ALLOW });
  t.after(ctx.stop);
  const ack = await ctx.press('heat-setpoint', 21.3);
  assert.equal(ack.success, true, JSON.stringify(ack));
  assert.deepEqual(controlWrites(ctx.th)[0].data, [0, 0, 21 + 64, 0]);
  assert.equal(ctx.th.state.heat, 21.5);
  assert.equal(ctx.th.state.cool, 25, 'the other setpoint untouched');
  assert.equal(ctx.state('heat-setpoint').state, 21.5);
  for (const bad of [32.5, 4, -10, 'abc', Number.NaN]) {
    const refused = await ctx.press('heat-setpoint', bad, SECOND);
    assert.equal(refused.success, false, `${bad}`);
  }
  assert.equal(controlWrites(ctx.th).length, 1);
  const same = await ctx.press('heat-setpoint', 21.5);
  assert.equal(same.success, true);
  assert.equal(controlWrites(ctx.th).length, 1, 'already so: nothing written');
  const cool = await ctx.press('cool-setpoint', 32);
  assert.equal(cool.success, true);
  assert.deepEqual(controlWrites(ctx.th)[1].data, [0, 0, 0, 32]);
});

test('the mode and the fan: written alone; a mode the thermostat lacks refused', async (t) => {
  const ctx = await setup({ config: ALLOW });
  t.after(ctx.stop);
  assert.equal((await ctx.press('mode', COOLING)).success, true);
  assert.deepEqual(controlWrites(ctx.th)[0].data, [3, 0, 0, 0]);
  assert.equal((await ctx.press('fan-mode', 'circulate')).success, true);
  assert.deepEqual(controlWrites(ctx.th)[1].data, [0, 3, 0, 0]);
  assert.equal(ctx.state('fan-mode').text, 'circulate');
  ctx.th.state.mode = 4; // emergency heat
  await ctx.advance(MINUTE + SECOND, 100);
  assert.equal(ctx.state('mode').state, HEATING, 'emergency heat shows as heating');
  assert.equal((await ctx.press('mode', HEATING)).success, true);
  assert.equal(controlWrites(ctx.th).length, 2, 'already heating: emergency heat kept');
});

test('a mode the thermostat lacks is refused, and absent from the options', async (t) => {
  const clock = testClock({ start: NOW });
  const th = fakeAprilaire({ timers: clock.timers, now: clock.now });
  th.state.modes = 1; // heat only
  const ctx = await setup({ config: ALLOW, clock, th });
  t.after(ctx.stop);
  const mode = ctx.gladys.fake.discoveredDevices[0].features.find(
    (f) => f.external_id === feature('mode'),
  );
  assert.deepEqual(
    mode.supported_options.map((o) => o.value),
    [OFF, HEATING],
  );
  const refused = await ctx.press('mode', COOLING);
  assert.equal(refused.success, false);
  assert.equal(controlWrites(ctx.th).length, 0);
});

test('a write not shown by the read back: "sent, without confirmation", then reads 5 s and 20 s later', async (t) => {
  const ctx = await setup({ config: ALLOW });
  t.after(ctx.stop);
  ctx.th.applyWrites = false;
  const before = ctx.th.reads('2/1').length;
  const ack = await ctx.press('heat-setpoint', 23, 4 * SECOND);
  assert.equal(ack.success, false);
  assert.match(ack.message ?? ack.error ?? '', /sans confirmation/);
  const afterAck = ctx.th.reads('2/1').length;
  assert.equal(afterAck - before, 2, 'the read before and the read back');
  await ctx.advance(25 * SECOND, 100);
  assert.equal(ctx.th.reads('2/1').length - afterAck, 2, 'two follow-up reads');
  // A guard: the same value asked again is written again (it may not show yet).
  ctx.th.applyWrites = true;
  assert.equal((await ctx.press('heat-setpoint', 23)).success, true);
  assert.equal(controlWrites(ctx.th).length, 2);
});

test('a write NACKed by the thermostat: refused, not applied', async (t) => {
  const ctx = await setup({ config: ALLOW });
  t.after(ctx.stop);
  ctx.th.nack.write = 0x10;
  const ack = await ctx.press('cool-setpoint', 26);
  assert.equal(ack.success, false);
  assert.match(ack.message ?? ack.error ?? '', /refusé.*NACK 0x10/);
  assert.equal(ctx.th.state.cool, 25);
});

const text = (ack) => ack.message ?? ack.error ?? '';
const status = (ctx) => ctx.gladys.fake.connectionStatus?.message?.fr ?? '';

test('a stop with no session: kept, answered so, sent first (before the identity) once the thermostat is back', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  ctx.th.down = true;
  ctx.th.hangUp();
  await ctx.advance(2 * SECOND, 50);
  const ack = await ctx.press('mode', OFF, 5 * SECOND);
  assert.equal(ack.success, false);
  assert.match(ack.message ?? ack.error ?? '', /gardé et part en premier/);
  assert.match(status(ctx), /Un arrêt \(mode Arrêt\) est gardé : pas encore envoyé/);
  assert.equal(controlWrites(ctx.th).length, 0);
  // Held without end: still kept after an hour of a thermostat away, never a loop of connections.
  const tries = ctx.th.connections;
  await ctx.advance(60 * MINUTE, 1000);
  // Every second for the 10 s after the click, then every minute: never a loop.
  assert.ok(ctx.th.connections - tries <= 72, `${ctx.th.connections - tries} attempts in an hour`);
  assert.ok(ctx.th.connections - tries >= 50, 'tried about every minute while a stop waits');
  assert.ok(ctx.app.stopGuard?.mustWrite);
  assert.ok(ctx.store.data.stop, 'in /data');
  ctx.th.down = false;
  const firstLog = ctx.th.log.length;
  await ctx.advance(2 * MINUTE, 100);
  const after = ctx.th.log.slice(firstLog);
  assert.equal(after[0].action, 1, 'the first request of the new session is the stop');
  assert.deepEqual(after[0].data, [1, 0, 0, 0]);
  assert.equal(ctx.th.state.mode, 1);
  assert.equal(ctx.app.stopGuard, undefined, 'confirmed by the read back');
  assert.equal(ctx.store.data.stop, undefined);
  assert.equal(ctx.th.maxOpen, 1);
});

test('a stop cuts a read that received nothing for 1.5 s: a new session, the old one closed first', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  // The next read of the sensors is never answered (a thermostat stuck).
  ctx.th.silentFor = (frame) => frame.action === 2 && frame.domain === 5;
  const sessions = ctx.th.connections;
  // At the next poll the control values are read, then the sensors hang.
  for (let i = 0; i < 700 && ctx.app.running?.request.domain !== 5; i += 1) {
    await ctx.advance(100, 100);
  }
  assert.equal(ctx.app.running?.request.domain, 5, 'a read in flight');
  ctx.th.silentFor = undefined;
  const firedAt = ctx.clock.now();
  const ack = ctx.fire('mode', OFF);
  await ctx.advance(4 * SECOND, 10);
  const answer = await ack;
  assert.equal(answer.success, true, JSON.stringify(answer));
  assert.equal(ctx.th.connections, sessions + 1, 'one new session');
  const stopWrite = ctx.th.writes().find((w) => w.data[0] === 1);
  const fresh = ctx.th.log.filter((r) => r.socket === ctx.th.connections);
  assert.equal(fresh[0].action, 1, 'the first request of the new session is the stop');
  assert.ok(
    stopWrite.at - firedAt < 1500,
    `stop written ${stopWrite.at - firedAt} ms after the click`,
  );
  assert.equal(ctx.th.maxOpen, 1, 'never two at once');
  assert.equal(ctx.th.state.mode, 1);
});

test('a stop not applied: sent again while the mode of before shows, 3 times at most, then held without writing', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  ctx.th.applyWrites = false;
  const ack = await ctx.press('mode', OFF, 5 * SECOND);
  assert.equal(ack.success, false);
  assert.match(ack.message ?? ack.error ?? '', /sans confirmation/);
  await ctx.advance(10 * MINUTE, 500);
  assert.equal(controlWrites(ctx.th).length, 4, 'the click and 3 resends');
  assert.match(status(ctx), /envoyé 4 fois et le thermostat montre toujours le mode d’avant/);
  const commands = await ctx.press('heat-setpoint', 22, SECOND);
  assert.equal(commands.success, false, 'other commands refused while the stop is held');
  await ctx.advance(30 * MINUTE, 1000);
  assert.equal(controlWrites(ctx.th).length, 4, 'never by the time, never more');
  assert.ok(ctx.app.stopGuard, 'still held');
  // Off shown at last (set at the thermostat): the stop ends.
  ctx.th.state.mode = 1;
  await ctx.advance(2 * MINUTE, 500);
  assert.equal(ctx.app.stopGuard, undefined);
});

test('a stop held ends when another mode is read twice in a row (set at the thermostat)', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  ctx.th.applyWrites = false;
  await ctx.press('mode', OFF, 5 * SECOND);
  ctx.th.state.mode = 3; // cooling, chosen at the thermostat
  await ctx.advance(2 * MINUTE, 500);
  assert.equal(ctx.app.stopGuard, undefined);
  const writes = controlWrites(ctx.th).length;
  await ctx.advance(10 * MINUTE, 1000);
  assert.equal(controlWrites(ctx.th).length, writes, 'never sent over it');
});

test('a "busy" NACK of the stop does not count: written again', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  ctx.th.nack.write = 0x03;
  const ack = await ctx.press('mode', OFF, 5 * SECOND);
  assert.equal(ack.success, false);
  assert.ok(ctx.app.stopGuard.mustWrite, 'still to write');
  await ctx.advance(20 * SECOND, 100);
  assert.equal(ctx.th.state.mode, 1);
  assert.equal(ctx.app.stopGuard, undefined);
});

test('commands that arrived before a stop and have not left are dropped; none leaves after it', async (t) => {
  const clock = testClock({ start: NOW });
  const th = fakeAprilaire({ timers: clock.timers, now: clock.now });
  const ctx = await setup({ config: ALLOW, clock, th });
  t.after(ctx.stop);
  th.delay = 600;
  const a = ctx.fire('heat-setpoint', 24);
  const b = ctx.fire('cool-setpoint', 27);
  const c = ctx.fire('fan-mode', 'on');
  await ctx.advance(100, 10);
  const stop = ctx.fire('mode', OFF);
  await ctx.advance(20 * SECOND, 50);
  const acks = await Promise.all([a, b, c, stop]);
  assert.equal(acks[3].success, true, JSON.stringify(acks[3]));
  const writes = controlWrites(th);
  const stopAt = writes.findIndex((w) => w.data[0] === 1);
  assert.ok(stopAt >= 0);
  assert.equal(writes.length, stopAt + 1, 'nothing written after the stop');
  assert.equal(th.state.mode, 1);
  assert.equal(th.state.cool, 25);
  assert.equal(th.state.fan, 2);
});

test('a new mode ends a stop held only once it leaves, after /data lifted it; /data refusing: nothing sent', async (t) => {
  const store = memoryStore();
  const ctx = await setup({ config: ALLOW, store });
  t.after(ctx.stop);
  ctx.th.applyWrites = false;
  await ctx.press('mode', OFF, 5 * SECOND);
  assert.ok(ctx.store.data.stop);
  ctx.th.applyWrites = true;
  assert.equal((await ctx.press('heat-setpoint', 22, SECOND)).success, false, 'refused while held');
  store.failing = true;
  const writes = controlWrites(ctx.th).length;
  const refused = await ctx.press('mode', COOLING, 2 * SECOND);
  assert.equal(refused.success, false);
  assert.match(refused.message ?? refused.error ?? '', /non inscriptible/);
  assert.equal(controlWrites(ctx.th).length, writes, 'nothing sent');
  assert.ok(ctx.app.stopGuard, 'the stop still held');
  store.failing = false;
  const ok = await ctx.press('mode', COOLING);
  assert.equal(ok.success, true, JSON.stringify(ok));
  assert.equal(ctx.th.state.mode, 3);
  assert.equal(ctx.app.stopGuard, undefined);
  assert.equal(ctx.store.data.stop, undefined);
  const settled = controlWrites(ctx.th).length;
  await ctx.advance(10 * MINUTE, 1000);
  assert.equal(controlWrites(ctx.th).length, settled, 'the stop never sent again over it');
});

test('a slow /data never holds a stop: written at once, several in a row', async (t) => {
  const store = memoryStore();
  const ctx = await setup({ store });
  t.after(ctx.stop);
  store.hang = true;
  for (let i = 0; i < 3; i += 1) {
    ctx.th.state.mode = 2;
    const ack = await ctx.press('mode', OFF, 5 * SECOND);
    assert.equal(ack.success, true, `stop ${i}: ${JSON.stringify(ack)}`);
  }
  assert.equal(controlWrites(ctx.th).length, 3);
});

test('a restart with a stop in /data: sent before Gladys and the configuration are even read', async (t) => {
  const store = memoryStore({
    attemptAt: NOW - 10 * SECOND,
    address: `${HOST}:7000`,
    stop: { address: `${HOST}:7000`, clickedAt: NOW - 20 * SECOND, written: false, reasserts: 0 },
  });
  const ctx = await setup({ store, boot: true, connectGladys: false });
  t.after(ctx.stop);
  await ctx.advance(2 * SECOND, 10);
  const [write] = controlWrites(ctx.th);
  assert.deepEqual(write?.data, [1, 0, 0, 0]);
  assert.equal(ctx.th.log[0].action, 1, 'the stop is the first request, before any read');
  assert.equal(ctx.th.state.mode, 1);
  assert.equal(ctx.app.stopGuard, undefined);
  assert.equal(store.data.stop, undefined);
});

test('a restart: never connected sooner than the interval after the last attempt', async (t) => {
  const store = memoryStore({ attemptAt: NOW - 10 * SECOND, address: `${HOST}:7000` });
  const ctx = await setup({ store, create: false });
  t.after(ctx.stop);
  assert.equal(ctx.th.connections, 0);
  assert.match(status(ctx), /Première connexion dans/);
  await ctx.advance(45 * SECOND, 500);
  assert.equal(ctx.th.connections, 0);
  await ctx.advance(10 * SECOND, 500);
  assert.equal(ctx.th.connections, 1);
  assert.ok(store.data.attemptAt >= NOW + 50 * SECOND, 'the attempt in /data');
});

test('getConfig failing in "connected": tried again without end, the status says so, then it starts', async (t) => {
  const ctx = await setup({ getConfigFails: 3, create: false });
  t.after(ctx.stop);
  assert.match(status(ctx), /configuration n’a pas pu être lue/);
  assert.equal(ctx.th.connections, 0);
  await ctx.advance(60 * SECOND, 500);
  assert.equal(ctx.th.connections, 1);
  assert.equal(ctx.gladys.fake.discoveredDevices.length, 1);
  assert.equal(ctx.gladys.fake.connectionStatus.connected, true);
});

test('a lost session: opened again after 30 s, 1, 2, 5, 10 min; never a loop, never two sockets', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  ctx.th.down = true;
  ctx.th.hangUp();
  const from = ctx.th.connections;
  await ctx.advance(20 * MINUTE, 1000);
  const tries = ctx.th.connectAt.slice(from).map((at, i, list) => (i ? at - list[i - 1] : at));
  assert.equal(tries.length, 5, `${tries.length} attempts`);
  assert.match(status(ctx), /Pas de session avec 192\.168\.1\.40:7000/);
  assert.equal(ctx.gladys.fake.connectionStatus.connected, false);
  ctx.th.down = false;
  await ctx.advance(11 * MINUTE, 1000);
  assert.equal(ctx.gladys.fake.connectionStatus.connected, true);
  assert.equal(ctx.th.maxOpen, 1);
});

test('two requests in a row unanswered: the session ends; the next one opens once it is closed', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  ctx.th.silent = true;
  await ctx.advance(MINUTE + 10 * SECOND, 100);
  assert.equal(ctx.th.open.size, 0, 'the silent session closed');
  ctx.th.silent = false;
  await ctx.advance(MINUTE, 500);
  assert.equal(ctx.th.open.size, 1);
  assert.equal(ctx.th.maxOpen, 1);
});

test('an oversized frame ends the session before it is read whole', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  const [socket] = ctx.th.open;
  socket.emit('data', Buffer.from([1, 0x81, 0xff, 0xff, 5]));
  await ctx.advance(100, 10);
  assert.equal(ctx.th.open.size, 0);
});

test('change messages (COS) refresh the values shown', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  ctx.th.state.indoor = 23;
  ctx.th.push(5, 2);
  await ctx.advance(1500, 50);
  assert.equal(ctx.state('temperature').state, 23);
});

test('another thermostat at the address: another device; the commands to the first refused', async (t) => {
  const ctx = await setup({ config: ALLOW });
  t.after(ctx.stop);
  ctx.th.state.mac = [0x0a, 0, 0, 0, 0, 1];
  ctx.th.hangUp();
  await ctx.advance(70 * SECOND, 500);
  assert.match(status(ctx), /Un autre thermostat répond à cette adresse/);
  assert.equal(
    ctx.gladys.fake.discoveredDevices[0].external_id,
    'ext:test-integration:aprilaire:0a0000000001',
  );
  const ack = await ctx.press('heat-setpoint', 22);
  assert.equal(ack.success, false);
  assert.equal(controlWrites(ctx.th).length, 0);
});

test('a scene on a slow thermostat (700 ms an answer): every command set', async (t) => {
  const ctx = await setup({ config: ALLOW });
  t.after(ctx.stop);
  ctx.th.delay = 700;
  const acks = [
    ctx.fire('heat-setpoint', 19),
    ctx.fire('cool-setpoint', 27),
    ctx.fire('fan-mode', 'on'),
  ];
  await ctx.advance(20 * SECOND, 50);
  await Promise.all(acks);
  assert.equal(ctx.th.state.heat, 19);
  assert.equal(ctx.th.state.cool, 27);
  assert.equal(ctx.th.state.fan, 1);
});

test('°F display: a setpoint kept as whole °F is confirmed within 0.5 °C, never the value of before', async (t) => {
  const clock = testClock({ start: NOW });
  const th = fakeAprilaire({ timers: clock.timers, now: clock.now });
  th.state.scale = 0;
  const ctx = await setup({ config: ALLOW, clock, th });
  t.after(ctx.stop);
  const write = th.handle.bind(th);
  th.handle = (frame) => {
    const out = write(frame);
    // 21.5 °C = 70.7 °F: the thermostat keeps 71 °F, read back as 21.5; 21 °C (69.8) kept 70 °F = 21.
    if (frame.action === 1 && th.state.heat === 22) th.state.heat = 22.5;
    return out;
  };
  assert.equal((await ctx.press('heat-setpoint', 22)).success, true);
  // r2 N1 (a): 70 °F read as 21.0, 71 °F asked (21.5): written, never "already so".
  th.handle = write;
  th.state.heat = 21;
  const writes = controlWrites(th).length;
  assert.equal((await ctx.press('heat-setpoint', 21.5)).success, true);
  assert.equal(controlWrites(th).length, writes + 1, 'written');
  // r2 N1 (b): writes ignored; 23 then 22 under the guard: 22.5, the value of before, never confirms.
  th.applyWrites = false;
  th.state.heat = 22.5;
  assert.equal((await ctx.press('heat-setpoint', 23, 4 * SECOND)).success, false);
  const before = await ctx.press('heat-setpoint', 22, 4 * SECOND);
  assert.equal(before.success, false, 'the value of before is not a confirmation');
});

test('an attribute the thermostat lacks is not asked again; a secondary read failing never blocks the values', async (t) => {
  const clock = testClock({ start: NOW });
  const th = fakeAprilaire({ timers: clock.timers, now: clock.now });
  th.unsupported.add('7/7');
  th.nack['7/8'] = 0x01;
  const ctx = await setup({ clock, th });
  t.after(ctx.stop);
  await ctx.advance(3 * MINUTE, 500);
  assert.equal(th.reads('7/7').length, 1);
  assert.equal(ctx.state('temperature').state, 21.5);
  assert.equal(ctx.gladys.fake.connectionStatus.connected, true);
  const device = ctx.gladys.fake.discoveredDevices[0];
  assert.ok(device.features.some((f) => f.external_id === feature('humidifier')));
  assert.equal(ctx.state('humidifier'), undefined, 'no status read: no text');
});

test('/data unreadable: never overwritten', async (t) => {
  const store = memoryStore({ attemptAt: 1 }, { unreadable: true });
  const ctx = await setup({ store });
  t.after(ctx.stop);
  await ctx.press('mode', OFF);
  await ctx.advance(2 * MINUTE, 1000);
  assert.equal(store.saves, 0);
  assert.match(status(ctx), /illisible/);
});

test('Gladys reconnected: no read, no stale state, the status and Discovery again', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  const reads = ctx.th.log.length;
  const states = ctx.gladys.fake.states.length;
  await ctx.app.connected(CFG);
  await ctx.advance(SECOND, 100);
  assert.equal(ctx.th.log.length, reads);
  assert.equal(ctx.gladys.fake.states.length, states);
  assert.equal(ctx.th.connections, 1);
});

test('the test button: the status, never a connection sooner than the interval', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  const text = await ctx.app.testConnection();
  assert.match(text, /Connecté au thermostat Aprilaire 8840 0a:1b:2c:3d:4e:5f/);
  ctx.th.down = true;
  ctx.th.hangUp();
  await ctx.advance(SECOND, 100);
  const later = await ctx.app.testConnection();
  assert.match(later, /Prochain essai de connexion dans/);
});

test('the option turned off between the click and the write: nothing written', async (t) => {
  const ctx = await setup({ config: ALLOW });
  t.after(ctx.stop);
  ctx.th.delay = 600;
  const ack = ctx.fire('heat-setpoint', 24);
  await ctx.advance(100, 10);
  await ctx.gladys.fake.configUpdated(CFG);
  await ctx.advance(5 * SECOND, 50);
  const answer = await ack;
  assert.equal(answer.success, false);
  assert.match(answer.message ?? answer.error ?? '', /désactivées/);
  assert.equal(controlWrites(ctx.th).length, 0);
  assert.equal(ctx.th.state.heat, 20);
});

test('refusals on arrival send nothing at all (out of range, stop held, another thermostat)', async (t) => {
  const ctx = await setup({ config: ALLOW });
  t.after(ctx.stop);
  const before = ctx.th.log.length;
  assert.match(text(await ctx.press('heat-setpoint', 32.5, SECOND)), /Hors de la plage/);
  assert.match(text(await ctx.press('cool-setpoint', 4, SECOND)), /Hors de la plage/);
  assert.equal(ctx.th.log.length, before, 'not even a read');
  const other = await ctx.gladys.fake.setValue(
    { external_id: 'ext:test-integration:aprilaire:0a0000000009' },
    { external_id: 'ext:test-integration:aprilaire:0a0000000009:heat-setpoint' },
    22,
  );
  assert.equal(other.success, false);
  assert.match(text(other), /n’est pas celui connecté/);
  assert.equal(ctx.th.log.length, before, 'not even a read');
  ctx.th.applyWrites = false;
  await ctx.press('mode', OFF, 5 * SECOND);
  const held = ctx.th.log.length;
  ctx.fire('heat-setpoint', 22);
  await ctx.advance(50, 10);
  assert.equal(ctx.th.log.length, held, 'refused while the stop is held, not even a read');
});

test('a stop held is not ended by ONE read of another mode (it may be a flicker)', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  ctx.th.applyWrites = false;
  await ctx.press('mode', OFF, 5 * SECOND);
  ctx.th.state.mode = 3;
  // Exactly one read shows cooling, then heating again.
  const reads = ctx.th.reads('2/1').length;
  for (let i = 0; i < 1000 && ctx.th.reads('2/1').length === reads; i += 1) {
    await ctx.advance(10, 10);
  }
  ctx.th.state.mode = 2;
  await ctx.advance(30 * SECOND, 100);
  assert.ok(ctx.app.stopGuard, 'still held');
  assert.ok(controlWrites(ctx.th).length >= 2, 'and sent again');
});

test('a stop decides only on reads sent after its click', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  const g = { since: 1000, mustWrite: false, sentAt: 0, before: [], reasserts: 0, others: 0 };
  assert.equal(ctx.app.decideStop(g, 3, 999), 'wait');
  assert.deepEqual(g.before, []);
  assert.equal(ctx.app.decideStop(g, 1, 999), 'wait', 'Off read before the click says nothing');
  assert.equal(ctx.app.decideStop(g, 1, 1001), 'done');
});

test('the line: a stop goes before every request waiting, whatever their order', async () => {
  const app = new AprilaireApp({ gladys: createFakeGladys(), store: memoryStore() });
  const order = [];
  const releases = [];
  const session = {
    open: true,
    lastByteAt: 0,
    stuckFor: () => false,
    request: (r) => {
      order.push(r.name);
      return new Promise((resolve) => releases.push(resolve));
    },
  };
  app.conn = { session };
  const all = [
    app.line({ name: 'read-1' }, PRIORITY.read, session),
    app.line({ name: 'read-2' }, PRIORITY.read, session),
    app.line({ name: 'check' }, PRIORITY.check, session),
    app.line({ name: 'command' }, PRIORITY.command, session),
    app.line({ name: 'stop' }, PRIORITY.stop, session),
  ];
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    releases.shift()?.({});
  }
  await Promise.all(all);
  assert.deepEqual(order, ['read-1', 'stop', 'command', 'check', 'read-2']);
});

test('one socket at a time: a session cut for a stop opens again only once closed', async (t) => {
  const clock = testClock({ start: NOW });
  const th = fakeAprilaire({ timers: clock.timers, now: clock.now });
  th.closeDelay = 400;
  const ctx = await setup({ clock, th });
  t.after(ctx.stop);
  th.silentFor = (frame) => frame.action === 2 && frame.domain === 5;
  for (let i = 0; i < 700 && ctx.app.running?.request.domain !== 5; i += 1) {
    await ctx.advance(100, 100);
  }
  th.silentFor = undefined;
  const ack = ctx.fire('mode', OFF);
  await ctx.advance(1200, 10);
  assert.equal(th.open.size, 1, 'the old socket still closing');
  const again = ctx.fire('mode', OFF); // a second click while the old socket closes
  await ctx.advance(4 * SECOND, 10);
  assert.equal((await ack).success, true);
  assert.equal((await again).success, true);
  assert.equal(th.refused, 0, 'never refused: never two at once');
  assert.equal(th.maxOpen, 1);
});

test('a second click during the read back of the first stop gets its own write and answer', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  ctx.th.delay = 1000;
  const first = ctx.fire('mode', OFF);
  await ctx.advance(500, 10); // the write applied, its read back in flight
  ctx.th.applyWrites = false;
  ctx.th.state.mode = 2; // turned on at the thermostat
  const second = ctx.fire('mode', OFF);
  await ctx.advance(6 * SECOND, 50);
  assert.equal((await first).success, true);
  const answer = await second;
  assert.equal(answer.success, false, 'not answered by the read sent before it');
  assert.equal(controlWrites(ctx.th).length, 2, 'the second click written');
  assert.ok(ctx.app.stopGuard, 'held');
});

test('a stop held appearing while a setpoint waits: the setpoint never leaves', async (t) => {
  const ctx = await setup({ config: ALLOW });
  t.after(ctx.stop);
  ctx.th.delay = 600;
  const ack = ctx.fire('heat-setpoint', 24);
  await ctx.advance(100, 10);
  // As a stop kept in /data would be.
  ctx.app.stopGuard = {
    address: `${HOST}:7000`,
    since: ctx.clock.monotonic(),
    mustWrite: false,
    written: true,
    reasserts: 3,
    others: 0,
    before: [],
  };
  await ctx.advance(5 * SECOND, 50);
  assert.equal((await ack).success, false);
  assert.equal(controlWrites(ctx.th).length, 0);
});

test('a value read more than 2 minutes ago is never shown again (texts built of two reads)', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  ctx.th.nack['2/4'] = 0x10;
  ctx.th.state.humidificationStatus = 0;
  await ctx.advance(4 * MINUTE, 1000);
  assert.equal(ctx.state('humidifier').text, 'Au repos');
});

test('a reconnection never reads the values sooner than the interval', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  const lastPoll = ctx.app.lastPollAt;
  ctx.th.hangUp();
  await ctx.advance(35 * SECOND, 500); // reconnected after 30 s
  assert.equal(ctx.th.open.size, 1);
  const since = (ctx.clock.monotonic() - lastPoll) / SECOND;
  const reads = ctx.th.reads('5/2').length;
  await ctx.advance((60 - since - 2) * SECOND, 500);
  assert.equal(ctx.th.reads('5/2').length, reads, 'no read before the interval');
  await ctx.advance(4 * SECOND, 500);
  assert.equal(ctx.th.reads('5/2').length, reads + 1);
});

test('a command waiting more than 15 s for its turn is never sent', async (t) => {
  const ctx = await setup({ config: ALLOW });
  t.after(ctx.stop);
  ctx.th.delay = 1500;
  const acks = [19, 20, 21, 22, 23, 24, 25].map((v) => ctx.fire('heat-setpoint', v));
  await ctx.advance(40 * SECOND, 50);
  await Promise.all(acks);
  const values = controlWrites(ctx.th).map((w) => w.data[2] & 63);
  assert.ok(values.length < 7, `${values.length} written`);
  assert.ok(!values.includes(25));
});

test('a change message saying Off is not shown: the next read says it', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  ctx.th.state.mode = 1;
  ctx.th.push(2, 1);
  await ctx.advance(1500, 50);
  assert.equal(ctx.state('mode').state, HEATING);
  await ctx.advance(MINUTE, 500);
  assert.equal(ctx.state('mode').state, OFF);
});

test('a connection refused right after a click of the stop is tried again every second', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  ctx.th.down = true;
  ctx.th.hangUp();
  await ctx.advance(10 * SECOND, 100);
  const clickedAt = ctx.clock.now();
  const ack = ctx.fire('mode', OFF);
  await ctx.advance(2500, 50);
  ctx.th.down = false;
  await ctx.advance(3 * SECOND, 50);
  await ack;
  const write = controlWrites(ctx.th)[0];
  assert.ok(write && write.at - clickedAt < 4 * SECOND, 'sent within 4 s, not at the backoff');
});

test('a stop clicked while the configuration cannot be read goes to the address kept in /data', async (t) => {
  const store = memoryStore({ attemptAt: NOW - 10 * MINUTE, address: `${HOST}:7000` });
  const ctx = await setup({ store, boot: true, getConfigFails: 100, create: false });
  t.after(ctx.stop);
  assert.match(status(ctx), /configuration n’a pas pu être lue/);
  const ack = await ctx.press('mode', OFF, 5 * SECOND);
  assert.equal(ack.success, true, JSON.stringify(ack));
  assert.deepEqual(controlWrites(ctx.th)[0].data, [1, 0, 0, 0]);
  assert.equal(ctx.th.state.mode, 1);
});

// --- Review r1 ---------------------------------------------------------------

test('r1 B1: /data that never answers: the stop goes to the address of the configuration, several in a row', async (t) => {
  const store = memoryStore({ attemptAt: NOW - 10 * MINUTE });
  store.loadGate = new Promise(() => {});
  const ctx = await setup({ store });
  t.after(ctx.stop);
  for (let i = 0; i < 3; i += 1) {
    ctx.th.state.mode = 2;
    const ack = await ctx.press('mode', OFF, 5 * SECOND);
    assert.equal(ack.success, true, `stop ${i}: ${JSON.stringify(ack)}`);
  }
  assert.equal(controlWrites(ctx.th).length, 3);
  assert.equal(store.saves, 0, 'never written over a file not read');
});

test('r1 B1: /data read 3 s late: started without it, its stop merged and sent', async (t) => {
  const store = memoryStore({
    attemptAt: NOW - 10 * MINUTE,
    address: `${HOST}:7000`,
    stop: { address: `${HOST}:7000`, written: false, reasserts: 0 },
  });
  let release;
  store.loadGate = new Promise((resolve) => {
    release = resolve;
  });
  const clock = testClock({ start: NOW });
  const th = fakeAprilaire({ timers: clock.timers, now: clock.now });
  clock.timers.setTimeout(() => release(), 3 * SECOND);
  const ctx = await setup({ store, clock, th, boot: false, create: false });
  t.after(ctx.stop);
  assert.equal(ctx.gladys.fake.discoveredDevices.length > 0 || th.connections > 0, true, 'started');
  await ctx.advance(5 * SECOND, 50);
  assert.equal(th.state.mode, 1, 'the stop kept in /data was sent once read');
  assert.equal(store.data.stop, undefined);
});

test('r1 I1: a slow Gladys (status 8 s) never delays a stop', async (t) => {
  const clock = testClock({ start: NOW });
  const th = fakeAprilaire({ timers: clock.timers, now: clock.now });
  const ctx = await setup({ clock, th });
  t.after(ctx.stop);
  const original = ctx.gladys.setConnectionStatus.bind(ctx.gladys);
  ctx.gladys.setConnectionStatus = async (...a) => {
    await new Promise((resolve) => clock.timers.setTimeout(resolve, 8 * SECOND));
    return original(...a);
  };
  th.silentFor = (frame) => frame.action === 2 && frame.domain === 5;
  for (let i = 0; i < 700 && ctx.app.running?.request.domain !== 5; i += 1) {
    await ctx.advance(100, 100);
  }
  th.silentFor = undefined;
  const firedAt = clock.now();
  const ack = ctx.fire('mode', OFF);
  await ctx.advance(5 * SECOND, 10);
  assert.equal((await ack).success, true);
  const write = th.writes()[0];
  assert.ok(write.at - firedAt < 3 * SECOND, `${write.at - firedAt} ms`);
});

test('r1 I3: the identity not read once: read again at the next interval, never a mute session', async (t) => {
  const clock = testClock({ start: NOW });
  const th = fakeAprilaire({ timers: clock.timers, now: clock.now });
  let lost = 0;
  th.silentFor = (frame) => frame.domain === 8 && frame.attribute === 2 && lost++ === 0;
  const ctx = await setup({ clock, th, create: false });
  t.after(ctx.stop);
  assert.equal(ctx.gladys.fake.discoveredDevices.length, 0);
  await ctx.advance(70 * SECOND, 500);
  assert.equal(ctx.gladys.fake.discoveredDevices.length, 1);
  assert.equal(ctx.gladys.fake.connectionStatus.connected, true);
});

test('r1 I5: a mode chosen at the thermostat while a resend is read back ends the stop, never resent over it', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  ctx.th.applyWrites = false;
  const handle = ctx.th.handle.bind(ctx.th);
  let offWrites = 0;
  let changedAt;
  ctx.th.handle = (frame) => {
    if (frame.action === 1 && frame.data[0] === 1 && ++offWrites === 2) {
      ctx.th.state.mode = 3; // cooling chosen at the thermostat
      changedAt = ctx.th.log.length;
    }
    return handle(frame);
  };
  await ctx.press('mode', OFF, 5 * SECOND);
  // The read back of the resend (check at 15 s) counts as one read of the new
  // mode; the follow-up read 5 s later is the second in a row (r2 list, R7).
  await ctx.advance(17 * SECOND, 500);
  assert.equal(ctx.app.stopGuard, undefined, 'ended by the follow-up read');
  await ctx.advance(10 * MINUTE, 500);
  assert.ok(changedAt !== undefined, 'a resend happened');
  const after = ctx.th.log.slice(changedAt).filter((r) => r.action === 1);
  assert.equal(after.length, 0, 'never sent again over the new mode');
  assert.equal(ctx.app.stopGuard, undefined, 'ended: another mode read twice');
});

test('r1 I4 (M10): the read back of the stop lost: the mode read later is the mode of before, the stop sent again', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  ctx.th.applyWrites = false;
  // The read back right after the first write of the stop is never answered.
  let lost = false;
  ctx.th.silentFor = (frame) => {
    const last = ctx.th.log.at(-2);
    if (!lost && frame.domain === 2 && frame.attribute === 1 && last?.action === 1) {
      lost = true;
      return true;
    }
    return false;
  };
  await ctx.press('mode', OFF, 5 * SECOND);
  ctx.th.silentFor = undefined;
  await ctx.advance(10 * MINUTE, 500);
  assert.equal(controlWrites(ctx.th).length, 4, 'the click and 3 resends');
  assert.ok(ctx.app.stopGuard, 'still held');
});

test('r1 I4 (M6): a "busy" answer to a resend is not counted', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  ctx.th.applyWrites = false;
  ctx.th.writeNacks = { 2: 0x03 };
  await ctx.press('mode', OFF, 5 * SECOND);
  await ctx.advance(10 * MINUTE, 500);
  assert.equal(controlWrites(ctx.th).length, 5, 'the click, 3 resends and the busy one');
});

test('r1 I4 (M46, M47): a change message never decides the stop; "twice in a row" means in a row', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  ctx.th.applyWrites = false;
  await ctx.press('mode', OFF, 5 * SECOND);
  ctx.th.state.mode = 3;
  ctx.th.push(2, 1);
  ctx.th.push(2, 1);
  ctx.th.state.mode = 2;
  await ctx.advance(SECOND, 50);
  assert.ok(ctx.app.stopGuard, 'not ended by change messages');
  const g = { since: 0, mustWrite: false, sentAt: 0, before: [2], reasserts: 3, others: 0 };
  assert.equal(ctx.app.decideStop(g, 3, 10_000), 'wait');
  assert.equal(ctx.app.decideStop(g, 2, 10_001), 'wait');
  assert.equal(ctx.app.decideStop(g, 3, 10_002), 'wait', 'not in a row');
  assert.equal(ctx.app.decideStop(g, 3, 10_003), 'drop');
});

test('r1 I4 (M51, m1): a click not written yet is kept in /data as never written', async (t) => {
  const store = memoryStore();
  const ctx = await setup({ store });
  t.after(ctx.stop);
  ctx.th.applyWrites = false;
  await ctx.press('mode', OFF, 5 * SECOND);
  assert.equal(store.data.stop.written, true);
  ctx.th.down = true;
  ctx.th.hangUp();
  await ctx.advance(SECOND, 100);
  await ctx.press('mode', OFF, 5 * SECOND);
  assert.equal(store.data.stop.written, false);
});

test('r1 I2: a NACK kept for a sequence number is never read again when the number comes back', async (t) => {
  const ctx = await setup({ config: ALLOW });
  t.after(ctx.stop);
  ctx.th.nack.write = 0x10;
  assert.equal((await ctx.press('fan-mode', 'on')).success, false);
  // About 130 requests later, the same sequence number is given again.
  await ctx.advance(14 * MINUTE, 1000);
  const ack = await ctx.press('heat-setpoint', 23);
  assert.equal(ack.success, true, JSON.stringify(ack));
  const stop = await ctx.press('mode', OFF);
  assert.equal(stop.success, true, JSON.stringify(stop));
});

test('r1 m7: bounds before rounding (32.24 refused); exact read back in °C display; a command overtaken by a stop', async (t) => {
  const ctx = await setup({ config: ALLOW });
  t.after(ctx.stop);
  assert.equal((await ctx.press('heat-setpoint', 32.24, SECOND)).success, false);
  const handle = ctx.th.handle.bind(ctx.th);
  ctx.th.handle = (frame) => {
    const out = handle(frame);
    if (frame.action === 1 && ctx.th.state.heat === 22) ctx.th.state.heat = 22.5;
    return out;
  };
  const near = await ctx.press('heat-setpoint', 22, 4 * SECOND);
  assert.equal(near.success, false, '°C display: 22.5 is not 22');
  ctx.th.handle = (frame) => {
    const out = handle(frame);
    if (frame.action === 1 && frame.data[1] === 1)
      ctx.app.setValue(undefined, { external_id: feature('mode') }, OFF).catch(() => {});
    return out;
  };
  const fan = await ctx.press('fan-mode', 'on');
  assert.equal(fan.success, false);
  assert.match(text(fan), /l’arrêt l’emporte/);
});

test('r1 m3: a connection accepted then closed at once does not count the stop as sent', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  ctx.th.hangUp();
  ctx.th.acceptThenClose = true;
  await ctx.advance(SECOND, 100);
  const clickedAt = ctx.clock.now();
  const ack = ctx.fire('mode', OFF);
  await ctx.advance(3 * SECOND, 50);
  assert.ok(ctx.app.stopGuard.mustWrite, 'still to write');
  assert.doesNotMatch(status(ctx), /envoyé 1 fois/);
  ctx.th.acceptThenClose = false;
  const releasedAt = ctx.clock.now();
  await ctx.advance(8 * SECOND, 50);
  await ack;
  assert.equal(ctx.th.state.mode, 1);
  const off = ctx.th.writes().filter((w) => w.data[0] === 1 && w.at > releasedAt);
  assert.ok(
    off.length > 0 && off[0].at - releasedAt < 3 * SECOND,
    'sent within seconds of the release',
  );
  const offWrites = ctx.th.writes().filter((w) => w.data[0] === 1);
  assert.ok(offWrites.at(-1).at - clickedAt < 12 * SECOND);
});

test('r1 m4: the address erased while a stop is held: the old address is never opened again', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  ctx.th.applyWrites = false;
  await ctx.press('mode', OFF, 5 * SECOND);
  await ctx.gladys.fake.configUpdated({ address: '' });
  await ctx.advance(SECOND, 100);
  const connections = ctx.th.connections;
  const log = ctx.th.log.length;
  await ctx.advance(5 * MINUTE, 1000);
  assert.equal(ctx.th.connections, connections);
  assert.equal(ctx.th.log.length, log);
  assert.equal(ctx.th.open.size, 0);
});

test('r1 m6: a stop for a thermostat no longer at the address is refused, the other one untouched', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  ctx.th.state.mac = [0x0a, 0, 0, 0, 0, 1];
  ctx.th.hangUp();
  await ctx.advance(40 * SECOND, 500);
  const ack = await ctx.press('mode', OFF);
  assert.equal(ack.success, false);
  assert.match(text(ack), /Un autre thermostat répond/);
  assert.equal(controlWrites(ctx.th).length, 0);
});

test('r1 m2: while a stop is held, the status gives the next attempt within a minute', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  ctx.th.down = true;
  ctx.th.hangUp();
  await ctx.advance(20 * MINUTE, 1000); // the backoff is at 10 minutes
  await ctx.press('mode', OFF, 5 * SECOND);
  await ctx.advance(7 * SECOND, 500); // the urgent tries are over, the check not run yet
  const wait = /next try in (\d+) (s|min)/.exec(ctx.gladys.fake.connectionStatus.message.en);
  assert.ok(wait, ctx.gladys.fake.connectionStatus.message.en);
  assert.ok(wait[2] === 's' || Number(wait[1]) <= 1, wait[0]);
});

test('r1 (M9, M13): a stop never applied ("busy") is never ended by a read: neither Off read nor other modes', async (t) => {
  const store = memoryStore({
    attemptAt: NOW - 10 * MINUTE,
    address: `${HOST}:7000`,
    stop: { address: `${HOST}:7000`, written: false, reasserts: 0, before: [2] },
  });
  const clock = testClock({ start: NOW });
  const th = fakeAprilaire({ timers: clock.timers, now: clock.now });
  th.nack.write = 0x03;
  th.nackSticky = true;
  th.state.mode = 3; // set at the thermostat: another mode than the one kept before
  const ctx = await setup({ store, clock, th, boot: true });
  t.after(ctx.stop);
  await ctx.advance(3 * MINUTE, 500);
  assert.ok(ctx.app.stopGuard?.mustWrite, 'still to write after reads of another mode');
  th.state.mode = 1; // Off read, the stop still not applied by Gladys
  await ctx.advance(2 * MINUTE, 500);
  assert.ok(ctx.app.stopGuard?.mustWrite, 'an Off read does not end a stop never written');
  th.nackSticky = false;
  delete th.nack.write;
  await ctx.advance(2 * MINUTE, 500);
  assert.equal(ctx.app.stopGuard, undefined, 'written at last, confirmed');
});

test('r1 (M1): option off: a command refused at once, never waiting behind another one', async (t) => {
  const ctx = await setup({ config: ALLOW });
  t.after(ctx.stop);
  ctx.th.delay = 1500;
  const first = ctx.fire('heat-setpoint', 24);
  await ctx.advance(100, 10);
  await ctx.gladys.fake.configUpdated(CFG);
  const askedAt = ctx.clock.now();
  let answeredAt;
  const second = ctx.fire('cool-setpoint', 26).then((a) => {
    answeredAt = ctx.clock.now();
    return a;
  });
  await ctx.advance(6 * SECOND, 20);
  await first;
  assert.match(text(await second), /désactivées/);
  assert.ok(answeredAt - askedAt < 500, `answered after ${answeredAt - askedAt} ms`);
});

test('r1 I5: first read back lost, then a mode chosen at the thermostat at a resend: still never absorbed', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  ctx.th.applyWrites = false;
  let lost = false;
  ctx.th.silentFor = (frame) => {
    const last = ctx.th.log.at(-2);
    if (!lost && frame.domain === 2 && frame.attribute === 1 && last?.action === 1) {
      lost = true;
      return true;
    }
    return false;
  };
  const handle = ctx.th.handle.bind(ctx.th);
  let offWrites = 0;
  let changedAt;
  ctx.th.handle = (frame) => {
    if (frame.action === 1 && frame.data[0] === 1 && ++offWrites === 2) {
      ctx.th.state.mode = 3;
      changedAt = ctx.th.log.length;
    }
    return handle(frame);
  };
  await ctx.press('mode', OFF, 5 * SECOND);
  await ctx.advance(10 * MINUTE, 500);
  assert.ok(changedAt !== undefined, 'a resend happened');
  assert.equal(ctx.th.log.slice(changedAt).filter((r) => r.action === 1).length, 0);
  assert.equal(ctx.app.stopGuard, undefined);
});

test('r2 N1 (c): the display scale unread: a setpoint 0.5 °C away is written, never "already so"', async (t) => {
  const clock = testClock({ start: NOW });
  const th = fakeAprilaire({ timers: clock.timers, now: clock.now });
  th.unsupported.add('1/1');
  th.state.heat = 21;
  const ctx = await setup({ config: ALLOW, clock, th });
  t.after(ctx.stop);
  assert.equal((await ctx.press('heat-setpoint', 21.5)).success, true);
  assert.equal(controlWrites(th).length, 1);
  assert.equal(th.state.heat, 21.5);
});

test('r2 N2: a stop read late from /data never goes over a mode written since the start', async (t) => {
  const store = memoryStore({
    attemptAt: NOW - 10 * MINUTE,
    address: `${HOST}:7000`,
    stop: { address: `${HOST}:7000`, written: false, reasserts: 0 },
  });
  let release;
  store.loadGate = new Promise((resolve) => {
    release = resolve;
  });
  const clock = testClock({ start: NOW });
  const th = fakeAprilaire({ timers: clock.timers, now: clock.now });
  const ctx = await setup({ store, clock, th, config: ALLOW });
  t.after(ctx.stop);
  assert.match(status(ctx), /pas encore lue/, 'n1: the status says /data is not read');
  assert.equal((await ctx.press('mode', OFF)).success, true);
  assert.equal((await ctx.press('mode', HEATING)).success, true);
  const writes = controlWrites(th).length;
  release();
  await ctx.advance(3 * MINUTE, 500);
  assert.equal(th.state.mode, 2, 'heating kept');
  assert.equal(controlWrites(th).length, writes, 'the old stop never written');
  assert.equal(store.data.stop, undefined, 'and removed from /data');
  assert.doesNotMatch(status(ctx), /pas encore lue/);
});

test('r2 N3: a stop refused for another thermostat stays in the status until a stop leaves', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  ctx.th.state.mac = [0x0a, 0, 0, 0, 0, 1];
  ctx.th.hangUp();
  await ctx.advance(40 * SECOND, 500);
  ctx.th.hangUp(); // a second session with the other thermostat
  await ctx.advance(40 * SECOND, 500);
  assert.equal((await ctx.press('mode', OFF)).success, false);
  assert.match(status(ctx), /Un arrêt du thermostat 0a:1b:2c:3d:4e:5f a été refusé/);
  await ctx.advance(2 * MINUTE, 1000);
  assert.match(status(ctx), /a été refusé/, 'still said');
  const other = ctx.gladys.fake.setValue(
    { external_id: 'ext:test-integration:aprilaire:0a0000000001' },
    { external_id: 'ext:test-integration:aprilaire:0a0000000001:mode' },
    OFF,
  );
  await ctx.advance(5 * SECOND, 50);
  assert.equal((await other).success, true);
  assert.doesNotMatch(status(ctx), /a été refusé/);
});

test('r2 n2 (R11): disconnected, the MAC kept in /data never refuses a stop', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  ctx.th.state.mac = [0x0a, 0, 0, 0, 0, 1];
  ctx.th.hangUp();
  await ctx.advance(40 * SECOND, 500); // /data learns the other MAC
  ctx.th.down = true;
  ctx.th.hangUp();
  await ctx.advance(SECOND, 100);
  const ack = await ctx.press('mode', OFF, 5 * SECOND);
  assert.doesNotMatch(text(ack), /Un autre thermostat/);
  assert.ok(ctx.app.stopGuard, 'kept, sent when the thermostat answers');
});

test('r2 n2 (R6b): a MAC read as zeros is read again at the next interval', async (t) => {
  const clock = testClock({ start: NOW });
  const th = fakeAprilaire({ timers: clock.timers, now: clock.now });
  th.state.mac = [0, 0, 0, 0, 0, 0];
  const ctx = await setup({ clock, th, create: false });
  t.after(ctx.stop);
  assert.equal(ctx.gladys.fake.discoveredDevices.length, 0);
  th.state.mac = [0x0a, 0x1b, 0x2c, 0x3d, 0x4e, 0x5f];
  await ctx.advance(70 * SECOND, 500);
  assert.equal(ctx.gladys.fake.discoveredDevices.length, 1);
});

test('r2 n2 (R4b): a second click is written at once even when Gladys answers the status slowly', async (t) => {
  const clock = testClock({ start: NOW });
  const th = fakeAprilaire({ timers: clock.timers, now: clock.now });
  const ctx = await setup({ clock, th });
  t.after(ctx.stop);
  const original = ctx.gladys.setConnectionStatus.bind(ctx.gladys);
  ctx.gladys.setConnectionStatus = async (...a) => {
    await new Promise((resolve) => clock.timers.setTimeout(resolve, 8 * SECOND));
    return original(...a);
  };
  th.delay = 1000;
  const first = ctx.fire('mode', OFF);
  await ctx.advance(500, 10);
  th.applyWrites = false;
  th.state.mode = 2;
  const clickedAt = clock.now();
  const second = ctx.fire('mode', OFF);
  await ctx.advance(6 * SECOND, 50);
  await Promise.all([first, second]);
  const writes = th.writes().filter((w) => w.data[0] === 1);
  assert.equal(writes.length, 2);
  assert.ok(writes[1].at - clickedAt < 2 * SECOND, `${writes[1].at - clickedAt} ms`);
});

test('r2 n2 (R14): a stop behind a request just sent on an idle session: no spinning timers', async (t) => {
  const clock = testClock({ start: NOW });
  let set = 0;
  const setTimeout = clock.timers.setTimeout;
  clock.timers.setTimeout = (...a) => {
    set += 1;
    return setTimeout(...a);
  };
  const th = fakeAprilaire({ timers: clock.timers, now: clock.now });
  const ctx = await setup({ clock, th });
  t.after(ctx.stop);
  // The first read of a poll, after a minute without a byte, is never answered.
  th.silentFor = (frame) => frame.action === 2 && frame.domain === 2 && frame.attribute === 1;
  for (let i = 0; i < 700 && ctx.app.running?.request.domain !== 2; i += 1) {
    await ctx.advance(100, 100);
  }
  th.silentFor = undefined;
  const before = set;
  const ack = ctx.fire('mode', OFF);
  await ctx.advance(3 * SECOND, 1);
  await ack;
  assert.ok(set - before < 60, `${set - before} timers`);
});

test('r2 N2: a mode command alone (no stop) since the start also drops a stop read late', async (t) => {
  const store = memoryStore({
    attemptAt: NOW - 10 * MINUTE,
    address: `${HOST}:7000`,
    stop: { address: `${HOST}:7000`, written: false, reasserts: 0 },
  });
  let release;
  store.loadGate = new Promise((resolve) => {
    release = resolve;
  });
  const clock = testClock({ start: NOW });
  const th = fakeAprilaire({ timers: clock.timers, now: clock.now });
  th.state.mode = 1;
  const ctx = await setup({ store, clock, th, config: ALLOW });
  t.after(ctx.stop);
  assert.equal((await ctx.press('mode', HEATING)).success, true);
  release();
  await ctx.advance(3 * MINUTE, 500);
  assert.equal(th.state.mode, 2, 'heating kept');
  assert.equal(controlWrites(th).length, 1);
});

// r3 P1: a mode refused by the thermostat (NACK) is not a command that left.
const offWrites = (th) => controlWrites(th).filter((w) => w.data[0] === 1);
const lateStopStore = (attemptAt = NOW - 10 * MINUTE) => {
  const store = memoryStore({
    attemptAt,
    address: `${HOST}:7000`,
    stop: { address: `${HOST}:7000`, written: false, reasserts: 0 },
  });
  store.loadGate = new Promise((resolve) => {
    store.release = resolve;
  });
  return store;
};

test('r3 P1 (b): a mode refused by the thermostat (NACK) never drops a stop read late from /data', async (t) => {
  const store = lateStopStore();
  const clock = testClock({ start: NOW });
  const th = fakeAprilaire({ timers: clock.timers, now: clock.now });
  const ctx = await setup({ store, clock, th, config: ALLOW });
  t.after(ctx.stop);
  th.nack.write = 0x10;
  const cool = await ctx.press('mode', COOLING);
  assert.equal(cool.success, false);
  assert.match(text(cool), /refusé la commande \(NACK 0x10\)/);
  assert.equal(th.state.mode, 2, 'not applied');
  store.release();
  await ctx.advance(3 * MINUTE, 500);
  assert.equal(offWrites(th).length, 1, 'the stop of /data written');
  assert.equal(th.state.mode, 1);
  assert.equal(ctx.app.stopGuard, undefined, 'and confirmed');
  assert.equal(store.data.stop, undefined);
});

test('r3 P1 (c): a mode answered "busy" while a stop never applied is held: the stop held again as it was, then written', async (t) => {
  const ctx = await setup({ config: ALLOW });
  t.after(ctx.stop);
  ctx.th.nack.write = 0x03;
  ctx.th.nackSticky = true;
  const off = await ctx.press('mode', OFF, SECOND);
  assert.equal(off.success, false);
  const held = ctx.app.stopGuard;
  assert.ok(held?.mustWrite, 'busy: still to write');
  const cool = await ctx.press('mode', COOLING, 3 * SECOND);
  assert.equal(cool.success, false);
  assert.match(text(cool), /refusé la commande \(NACK 0x03\)/);
  assert.equal(ctx.app.stopGuard, held, 'the same stop held again');
  assert.ok(held.mustWrite, 'still to write');
  assert.equal(ctx.store.data.stop?.written, false, 'in /data again, as never written');
  assert.match(status(ctx), /Un arrêt \(mode Arrêt\) est gardé/);
  ctx.th.nackSticky = false;
  delete ctx.th.nack.write;
  await ctx.advance(20 * SECOND, 100);
  assert.equal(ctx.th.state.mode, 1, 'the stop written at the next check');
  assert.equal(ctx.app.stopGuard, undefined);
  assert.equal(ctx.store.data.stop, undefined);
});

test('r3 P1: a mode refused, its read back lost: the NACK still says so, the stop held again', async (t) => {
  const ctx = await setup({ config: ALLOW });
  t.after(ctx.stop);
  ctx.th.applyWrites = false;
  await ctx.press('mode', OFF, 5 * SECOND);
  const held = ctx.app.stopGuard;
  assert.ok(held);
  ctx.th.nack.write = 0x10;
  const writes = ctx.th.writes().length;
  let silenced = 0;
  // The read back of the mode only is never answered.
  ctx.th.silentFor = (frame) =>
    frame.action === 2 &&
    frame.domain === 2 &&
    frame.attribute === 1 &&
    ctx.th.writes().length > writes &&
    silenced++ === 0;
  const cool = await ctx.press('mode', COOLING, 4 * SECOND);
  assert.equal(silenced > 0, true, 'the read back lost');
  assert.equal(cool.success, false);
  assert.match(text(cool), /refusé la commande \(NACK 0x10\)/);
  assert.equal(ctx.app.stopGuard, held, 'held again');
  assert.ok(ctx.store.data.stop, 'in /data again');
});

test('r3 P1: a mode that left without any answer counts: the stop it ends is never written over it', async (t) => {
  const ctx = await setup({ config: ALLOW });
  t.after(ctx.stop);
  ctx.th.nack.write = 0x03;
  await ctx.press('mode', OFF, SECOND);
  assert.ok(ctx.app.stopGuard?.mustWrite, 'busy: still to write');
  const writes = ctx.th.writes().length;
  let silenced = 0;
  ctx.th.silentFor = (frame) =>
    frame.action === 2 &&
    frame.domain === 2 &&
    frame.attribute === 1 &&
    ctx.th.writes().length > writes &&
    silenced++ === 0;
  const cool = await ctx.press('mode', COOLING, 4 * SECOND);
  assert.match(text(cool), /sans confirmation/);
  assert.equal(ctx.app.stopGuard, undefined, 'ended: the mode left');
  assert.doesNotMatch(status(ctx), /Un arrêt/, 'the status says so at once');
  await ctx.advance(3 * MINUTE, 500);
  assert.equal(ctx.th.state.mode, 3, 'cooling kept');
  assert.equal(offWrites(ctx.th).length, 1, 'only the stop answered "busy"');
  assert.equal(ctx.store.data.stop, undefined);
});

test('r3 P1: a mode whose bytes the socket refused never left: the stop held again, then written', async (t) => {
  const ctx = await setup({ config: ALLOW });
  t.after(ctx.stop);
  ctx.th.nack.write = 0x03;
  await ctx.press('mode', OFF, SECOND);
  const held = ctx.app.stopGuard;
  assert.ok(held?.mustWrite, 'busy: still to write');
  const socket = ctx.app.conn.session.socket;
  const write = socket.write.bind(socket);
  let refused = 0;
  socket.write = (bytes) => {
    // The write of the mode (action 1, cooling): the socket throws, nothing leaves.
    if (bytes[4] === 1 && bytes[7] === 3) {
      refused += 1;
      throw new Error('EPIPE');
    }
    return write(bytes);
  };
  await ctx.press('mode', COOLING, 3 * SECOND);
  assert.equal(refused, 1, 'the mode never left');
  assert.equal(ctx.th.state.mode, 2);
  assert.equal(ctx.app.stopGuard, held, 'the stop held again');
  await ctx.advance(30 * SECOND, 100);
  assert.equal(ctx.th.state.mode, 1, 'the stop written on the next session');
});

test('r3 P1: a stop clicked while a refused mode is read back keeps its own guard (nothing put back over it)', async (t) => {
  const clock = testClock({ start: NOW });
  const th = fakeAprilaire({ timers: clock.timers, now: clock.now });
  const ctx = await setup({ config: ALLOW, clock, th });
  t.after(ctx.stop);
  th.applyWrites = false;
  await ctx.press('mode', OFF, 5 * SECOND);
  await ctx.advance(2 * MINUTE, 500);
  assert.match(status(ctx), /envoyé 4 fois/, 'given up: the checks write it no more');
  th.applyWrites = true;
  th.nack.write = 0x10;
  th.delay = 1000;
  const writes = th.writes().length;
  const cool = ctx.fire('mode', COOLING);
  for (let i = 0; i < 400 && th.writes().length === writes; i += 1) await ctx.advance(10, 10);
  assert.equal(th.writes().length, writes + 1, 'the mode written, its read back not in yet');
  const off = ctx.fire('mode', OFF);
  await ctx.advance(6 * SECOND, 50);
  assert.equal((await cool).success, false);
  assert.equal((await off).success, true, 'the new click written and confirmed');
  assert.equal(th.state.mode, 1);
});

test('r3 P1: a stop read late from /data while a mode is read back: the mode refused, the stop held and written', async (t) => {
  const store = lateStopStore();
  const clock = testClock({ start: NOW });
  const th = fakeAprilaire({ timers: clock.timers, now: clock.now });
  const ctx = await setup({ store, clock, th, config: ALLOW });
  t.after(ctx.stop);
  th.nack.write = 0x10;
  th.delay = 1000;
  const cool = ctx.fire('mode', COOLING);
  for (let i = 0; i < 400 && th.writes().length === 0; i += 1) await ctx.advance(10, 10);
  assert.equal(th.writes().length, 1, 'the mode written, its read back not in yet');
  store.release();
  await ctx.advance(5 * SECOND, 50);
  assert.equal((await cool).success, false);
  th.delay = 20;
  await ctx.advance(3 * MINUTE, 500);
  assert.equal(offWrites(th).length, 1, 'the stop of /data written');
  assert.equal(th.state.mode, 1);
  assert.equal(store.data.stop, undefined, 'confirmed');
});

test('r3 P1: a stop read late from /data while a mode is read back: the mode applied, the stop dropped', async (t) => {
  const store = lateStopStore();
  const clock = testClock({ start: NOW });
  const th = fakeAprilaire({ timers: clock.timers, now: clock.now });
  const ctx = await setup({ store, clock, th, config: ALLOW });
  t.after(ctx.stop);
  th.delay = 1000;
  const cool = ctx.fire('mode', COOLING);
  for (let i = 0; i < 400 && th.writes().length === 0; i += 1) await ctx.advance(10, 10);
  assert.equal(th.writes().length, 1, 'the mode written, its read back not in yet');
  store.release();
  await ctx.advance(5 * SECOND, 50);
  assert.equal((await cool).success, true);
  th.delay = 20;
  await ctx.advance(3 * MINUTE, 500);
  assert.equal(offWrites(th).length, 0, 'the older stop never written over it');
  assert.equal(th.state.mode, 3);
  assert.equal(store.data.stop, undefined, 'removed from /data');
  assert.ok(ctx.lines.some((l) => /read late from \/data is older/.test(l)));
});

test('r3 m1 (T3): a stop written since the start also drops a stop read late from /data', async (t) => {
  const store = lateStopStore();
  const clock = testClock({ start: NOW });
  const th = fakeAprilaire({ timers: clock.timers, now: clock.now });
  const ctx = await setup({ store, clock, th });
  t.after(ctx.stop);
  assert.equal((await ctx.press('mode', OFF)).success, true);
  th.state.mode = 2; // heating chosen at the thermostat afterwards
  store.release();
  await ctx.advance(3 * MINUTE, 500);
  assert.equal(th.state.mode, 2, 'the choice made at the thermostat kept');
  assert.equal(offWrites(th).length, 1, 'the older stop never written');
  assert.equal(store.data.stop, undefined);
});

test('r3 m1 (T6): deleting the device whose stop was refused clears the status, another device does not', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  ctx.th.state.mac = [0x0a, 0, 0, 0, 0, 1];
  ctx.th.hangUp();
  await ctx.advance(40 * SECOND, 500);
  ctx.th.hangUp(); // a second session with the other thermostat
  await ctx.advance(40 * SECOND, 500);
  assert.equal((await ctx.press('mode', OFF)).success, false);
  assert.match(status(ctx), /a été refusé/);
  await ctx.gladys.fake.deviceDeleted({
    external_id: 'ext:test-integration:aprilaire:0a0000000001',
  });
  await ctx.advance(SECOND, 100);
  assert.match(status(ctx), /a été refusé/, 'another device deleted: still said');
  await ctx.gladys.fake.deviceDeleted(
    ctx.gladys.fake.devices.find((d) => d.external_id === DEVICE),
  );
  await ctx.advance(SECOND, 100);
  assert.doesNotMatch(status(ctx), /a été refusé/);
});

test('r3 P1: the session lost while a refused mode is read back: the stop held again, back in /data at once', async (t) => {
  const ctx = await setup({ config: ALLOW });
  t.after(ctx.stop);
  ctx.th.applyWrites = false;
  await ctx.press('mode', OFF, 5 * SECOND);
  const held = ctx.app.stopGuard;
  assert.ok(held);
  ctx.th.nack.write = 0x10;
  const writes = ctx.th.writes().length;
  ctx.th.silentFor = (frame) =>
    frame.action === 2 &&
    frame.domain === 2 &&
    frame.attribute === 1 &&
    ctx.th.writes().length > writes;
  const cool = ctx.fire('mode', COOLING);
  for (let i = 0; i < 400 && ctx.th.writes().length === writes; i += 1) await ctx.advance(10, 10);
  await ctx.advance(200, 10); // the NACK in, the read back unanswered
  ctx.th.down = true;
  ctx.th.hangUp();
  await ctx.advance(SECOND, 10);
  assert.match(text(await cool), /refusé la commande \(NACK 0x10\)/);
  assert.equal(ctx.app.stopGuard, held, 'held again');
  assert.ok(ctx.store.data.stop, 'back in /data at once, no session needed');
});

test('r3: a stop read late from /data and dropped leaves /data even when the attempt time read is not older', async (t) => {
  // A clock set back: the attempt time of /data is in the future, read as now.
  const store = lateStopStore(NOW + 24 * 60 * MINUTE);
  const clock = testClock({ start: NOW });
  const th = fakeAprilaire({ timers: clock.timers, now: clock.now });
  th.state.mode = 1;
  const ctx = await setup({ store, clock, th, config: ALLOW });
  t.after(ctx.stop);
  assert.equal((await ctx.press('mode', HEATING)).success, true);
  store.release();
  await ctx.advance(3 * MINUTE, 500);
  assert.equal(th.state.mode, 2, 'heating kept');
  assert.equal(controlWrites(th).length, 1);
  assert.equal(store.data.stop, undefined, 'gone from /data: a restart never sends it');
});
