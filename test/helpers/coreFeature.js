// -----------------------------------------------------------------------------
// The rules Gladys applies to a device feature (t_device_feature, see
// server/models/device_feature.js of the core) and to its supported_options.
// The SDK's fake Gladys does not check them; the real one answers HTTP 422
// and refuses the whole device (a null min or max on a text/select feature,
// toshiba-ac, November 2026). When the core is cloned on the machine (dev VM,
// not GitHub CI), its own lists and normalizeSupportedOptions are applied too.
// -----------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';

const values = (map) => new Set(Object.values(map).flatMap((v) => Object.values(v)));
const CATEGORIES = new Set(Object.values(C));
const TYPES = values(T);
const UNITS = new Set(Object.values(U));

/** The core's own checks, when its clone is on the machine (dev VM; skipped on the CI). */
function coreChecks() {
  const server = join(homedir(), 'code', 'Gladys', 'server');
  if (!existsSync(join(server, 'node_modules', 'joi'))) {
    return null;
  }
  const require = createRequire(join(server, 'index.js'));
  const constants = require('./utils/constants.js');
  const { normalizeSupportedOptions } = require('./utils/normalizeSupportedOptions.js');
  return { constants, normalizeSupportedOptions };
}
const CORE = coreChecks();

/** Asserts one feature has every non-null field of the Gladys model, with a valid value. */
export function assertCoreFeature(f, where) {
  for (const key of ['name', 'external_id']) {
    assert.equal(typeof f[key], 'string', `${where}: ${key}`);
    assert.ok(f[key].trim().length > 0, `${where}: ${key} not empty`);
  }
  assert.ok(CATEGORIES.has(f.category), `${where}: category ${f.category}`);
  assert.ok(TYPES.has(f.type), `${where}: type ${f.type}`);
  for (const key of ['read_only', 'has_feedback']) {
    assert.equal(typeof f[key], 'boolean', `${where}: ${key} is a boolean`);
  }
  if (f.keep_history !== undefined) {
    assert.equal(typeof f.keep_history, 'boolean', `${where}: keep_history is a boolean`);
  }
  for (const key of ['min', 'max']) {
    assert.ok(Number.isFinite(f[key]), `${where}: ${key} is a number (not null), got ${f[key]}`);
  }
  assert.ok(f.min <= f.max, `${where}: min <= max`);
  if (f.unit !== undefined && f.unit !== null) {
    assert.ok(UNITS.has(f.unit), `${where}: unit ${f.unit}`);
  }
  if (f.step !== undefined && f.step !== null) {
    assert.ok(Number.isFinite(f.step) && f.step > 0, `${where}: step > 0`);
  }
  const select = f.category === C.TEXT && f.type === T.TEXT.SELECT;
  if (f.supported_options !== undefined) {
    assert.ok(f.supported_options.length > 0, `${where}: options`);
    const seen = new Set();
    for (const o of f.supported_options) {
      assert.equal(typeof o.label, 'string', `${where}: label is a string`);
      assert.ok(o.label.length > 0 && o.label === o.label.trim(), `${where}: label "${o.label}"`);
      assert.ok(
        Number.isInteger(o.value) || (select && typeof o.value === 'string' && o.value.trim()),
        `${where}: value ${o.value}`,
      );
      assert.ok(!seen.has(String(o.value)), `${where}: value ${o.value} unique`);
      seen.add(String(o.value));
    }
  }
  if (CORE) {
    assert.ok(CORE.constants.DEVICE_FEATURE_CATEGORIES_LIST.includes(f.category), where);
    assert.ok(CORE.constants.DEVICE_FEATURE_TYPES_LIST.includes(f.type), where);
    if (f.unit) assert.ok(CORE.constants.DEVICE_FEATURE_UNITS_LIST.includes(f.unit), where);
    if (f.supported_options) {
      assert.doesNotThrow(
        () => CORE.normalizeSupportedOptions(f.supported_options, { allowStringValues: select }),
        where,
      );
    }
  }
}

/** Asserts every feature of a device, and that their external ids are unique. */
export function assertCoreDevice(device, where) {
  assert.equal(typeof device.name, 'string', `${where}: device name`);
  assert.equal(typeof device.external_id, 'string', `${where}: device external_id`);
  assert.ok(Array.isArray(device.features), `${where}: features`);
  const ids = new Set();
  for (const f of device.features) {
    const at = `${where} ${f.external_id}`;
    assert.ok(!ids.has(f.external_id), `${at}: unique external id`);
    ids.add(f.external_id);
    assertCoreFeature(f, at);
  }
  return device.features.length;
}
