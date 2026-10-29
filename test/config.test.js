// -----------------------------------------------------------------------------
// The configuration (src/config.js) and /data (src/store.js): strict values,
// bounded and repaired; an unreadable /data is not an empty one.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeConfig, parseAddress } from '../src/config.js';
import { fileStore, normalizeMemory, serializeMemory } from '../src/store.js';

test('the address: IPv4 or a host name, port 7000 by default; never broadcast, multicast, 0.0.0.0', () => {
  assert.deepEqual(parseAddress('192.168.1.40'), { host: '192.168.1.40', port: 7000 });
  assert.deepEqual(parseAddress(' Thermostat.lan:8000 '), { host: 'thermostat.lan', port: 8000 });
  for (const bad of [
    '',
    '0.0.0.0',
    '255.255.255.255',
    '224.0.0.1',
    '192.168.1.255',
    '192.168.1.40:0',
    '192.168.1.40:70000',
    'a b',
    'host\r\nX: y',
    'http://192.168.1.40',
    '300.1.1.1',
    '-bad-.lan',
    123,
    null,
  ]) {
    assert.equal(parseAddress(bad), undefined, JSON.stringify(bad));
  }
});

test('the options: only true turns the commands on; the interval bounded', () => {
  assert.equal(normalizeConfig({}).allowCommands, false);
  assert.equal(normalizeConfig({ allow_commands: 'yes' }).allowCommands, false);
  assert.equal(normalizeConfig({ allow_commands: 'true' }).allowCommands, true);
  assert.equal(normalizeConfig({ poll_interval: 5 }).pollInterval, 30);
  assert.equal(normalizeConfig({ poll_interval: '' }).pollInterval, 60);
  assert.equal(normalizeConfig({ poll_interval: 9999 }).pollInterval, 600);
  assert.equal(normalizeConfig({ address: '192.168.1.40' }).key, '192.168.1.40:7000');
  assert.match(normalizeConfig({ address: 'bad host\u0007' }).invalidAddress, /^bad host\?$/);
  assert.equal(normalizeConfig({ __proto__: { allow_commands: true } }).allowCommands, false);
});

test('/data repaired: unknown keys dropped, a date in the future invalid, a stop kept', () => {
  const now = Date.UTC(2026, 9, 28);
  const memory = normalizeMemory(
    {
      attemptAt: now + 1e9,
      address: '192.168.1.40:7000',
      identity: { address: '192.168.1.40:7000', mac: '0a1b2c3d4e5f', model: 7, extra: 1 },
      stop: {
        address: '192.168.1.40:7000',
        clickedAt: now + 5,
        written: true,
        reasserts: 'x',
        before: [2, 2, 1, 9, 3],
      },
      evil: { __proto__: { polluted: true } },
    },
    now,
  );
  assert.equal(memory.attemptAt, now, 'a future attempt counts as now');
  assert.equal(memory.stop.clickedAt, undefined);
  assert.equal(memory.stop.reasserts, 0, 'an unreadable count is 0');
  assert.deepEqual(memory.stop.before, [2, 3]);
  assert.deepEqual(memory.identity, {
    address: '192.168.1.40:7000',
    mac: '0a1b2c3d4e5f',
    model: 7,
  });
  assert.equal({}.polluted, undefined);
  assert.deepEqual(normalizeMemory(serializeMemory(memory), now), memory);
  assert.equal(normalizeMemory({ stop: { address: 'x y' } }, now).stop.address, undefined);
});

test('the file store: 0600, an unreadable file said so, a missing one empty', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'aprilaire-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json');
  const store = fileStore(path);
  assert.deepEqual(await store.load(), { data: null });
  await store.save({ attemptAt: 1 });
  assert.deepEqual(await store.load(), { data: { attemptAt: 1 } });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  await writeFile(path, '{broken');
  assert.deepEqual(await store.load(), { unreadable: true });
  await writeFile(path, 'x'.repeat(20000));
  assert.deepEqual(await store.load(), { unreadable: true });
  assert.ok((await readFile(path, 'utf8')).length > 0);
});
