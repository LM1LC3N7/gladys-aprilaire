// -----------------------------------------------------------------------------
// Every feature of every device the module can build passes the Gladys model
// (t_device_feature): a null min or max makes Gladys answer HTTP 422 and
// refuse the whole thermostat when the user adds it (the fan list had none
// up to 0.1.1). The SDK's fake Gladys does not check it.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { FEATURES } from '../src/constants.js';
import { buildDevice } from '../src/devices.js';
import { assertCoreDevice } from './helpers/coreFeature.js';

const gladys = createFakeGladys();
const MAC = '0a1b2c3d4e5f';
const OPTIONAL = [
  'humidity',
  'outdoor',
  'outdoorHumidity',
  'humidifier',
  'dehumidifier',
  'ventilation',
  'airCleaner',
];

/** Every shape the thermostat can show: each optional part on or off, every mode set. */
function* everyShape() {
  for (let combo = 0; combo < 1 << OPTIONAL.length; combo += 1) {
    for (const modes of [undefined, 0, 1, 2, 3, 4, 5, 6, 7]) {
      const shape = { modes };
      OPTIONAL.forEach((key, i) => {
        shape[key] = Boolean(combo & (1 << i));
      });
      yield shape;
    }
  }
}

test('every feature of every buildable thermostat has what the Gladys model needs', () => {
  let devices = 0;
  let features = 0;
  for (const shape of everyShape()) {
    for (const model of [undefined, 0, 7, 999]) {
      for (const language of ['en', 'fr']) {
        const where = `${JSON.stringify(shape)}/${model}/${language}`;
        const device = buildDevice(
          gladys,
          { mac: MAC, model, firmware: '1.0', shape },
          { language },
        );
        features += assertCoreDevice(device, where);
        // Rebuilt over the device as Gladys created it: the kept features too.
        const again = buildDevice(
          gladys,
          { mac: MAC, model, shape: { ...shape, humidity: true } },
          { language, created: device },
        );
        features += assertCoreDevice(again, `${where} created`);
        devices += 2;
      }
    }
  }
  assert.equal(devices, (1 << OPTIONAL.length) * 9 * 4 * 2 * 2);
  assert.ok(features > devices * 5);
});

test('the fan list has min 0 and max 0, like the other text/select features of Gladys', () => {
  const device = buildDevice(gladys, { mac: MAC, shape: {} }, { language: 'fr' });
  const fan = device.features.find((f) => f.external_id.endsWith(`:${FEATURES.FAN}`));
  assert.deepEqual([fan.category, fan.type, fan.min, fan.max], ['text', 'select', 0, 0]);
});
