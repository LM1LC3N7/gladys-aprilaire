// -----------------------------------------------------------------------------
// The thermostat -> one Gladys device and its states, and the change a
// Gladys command asks for (pure).
//
// Identifier rule (frozen, it fixes the external ids):
//   `ext:<selector>:aprilaire:<mac>`
//   <mac>: the MAC address the thermostat gives (spec 8.2), 12 lower-case
//     hex digits without separators ("0a1b2c3d4e5f"). It stays the same when
//     the thermostat changes address; another thermostat at the address is
//     another device. Nothing is shown until the MAC address is read in the
//     session (an unreadable one is "unknown", never another thermostat).
// The feature keys and the option values are published forever.
//
// Never a `switch` nor a writable `binary`: the core hands every switch to
// the voice assistants, MCP and the "turn everything off" scene actions. The
// mode is `thermostat/mode` (off, heating, cooling, auto), the setpoints
// `thermostat/target-temperature` (heating) and
// `air-conditioning/target-temperature` (cooling), the fan a `text/select`
// (auto, on, circulate: no core value set names "circulate").
//
// Units: degrees Celsius, the unit of the protocol whatever the display
// scale of the thermostat; Gladys converts for the users who prefer °F.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import {
  COMMAND_FEATURES,
  DEVICE_TYPE,
  FAN_MODE,
  FEATURES,
  HVAC_MODE,
  SETPOINT_BOUNDS,
  STEP,
  THERMOSTAT_MODE,
  THERMOSTAT_OPERATING_STATE,
} from './constants.js';
import {
  DEVICE_NAME,
  ERROR_NAMES,
  FAN_NAMES,
  FEATURE_NAMES,
  HOLD_NAMES,
  MODE_NAMES,
  dehumidifierText,
  humidifierText,
  iaqText,
  modelName,
  word,
} from './i18n.js';

export const deviceIds = (gladys, mac) => gladys.externalIds(DEVICE_TYPE, mac);

export const KEYS = Object.values(FEATURES);

/** The MAC and feature key of one of our feature external ids, else undefined. */
export function parseFeatureId(externalId) {
  if (typeof externalId !== 'string' || externalId.length > 200) {
    return undefined;
  }
  const match = /:aprilaire:([0-9a-f]{12}):([a-z-]{1,40})$/.exec(externalId);
  return match && KEYS.includes(match[2]) ? { mac: match[1], key: match[2] } : undefined;
}

/** The MAC of one of our device external ids, else undefined. */
export function parseDeviceId(externalId) {
  const match = /:aprilaire:([0-9a-f]{12})$/.exec(String(externalId ?? '').slice(0, 200));
  return match ? match[1] : undefined;
}

/** "0a:1b:2c:3d:4e:5f" for the statuses. */
export const macText = (mac) => (mac ? mac.match(/../g).join(':') : '');

/**
 * What the thermostat offers, from "Thermostat Modes" (spec 2.7, as Home
 * Assistant maps it): 1 heat only, 2 cool only, 3-4 heat and cool, 5-6 with
 * auto. Unknown: every mode (the thermostat refuses one it lacks).
 */
export function offers(modes) {
  switch (modes) {
    case 1:
      return { heat: true, cool: false, auto: false };
    case 2:
      return { heat: false, cool: true, auto: false };
    case 3:
    case 4:
      return { heat: true, cool: true, auto: false };
    default:
      return { heat: true, cool: true, auto: true };
  }
}

/** Protocol mode <-> Gladys THERMOSTAT_MODE (emergency heat is heating). */
export const MODE_MAP = [
  ['off', HVAC_MODE.OFF, THERMOSTAT_MODE.OFF],
  ['heat', HVAC_MODE.HEAT, THERMOSTAT_MODE.HEATING],
  ['cool', HVAC_MODE.COOL, THERMOSTAT_MODE.COOLING],
  ['auto', HVAC_MODE.AUTO, THERMOSTAT_MODE.AUTO],
];
export const gladysModeOf = (mode) =>
  mode === HVAC_MODE.EMERGENCY_HEAT
    ? THERMOSTAT_MODE.HEATING
    : MODE_MAP.find((row) => row[1] === mode)?.[2];

export const FAN_MAP = [
  ['auto', FAN_MODE.AUTO],
  ['on', FAN_MODE.ON],
  ['circulate', FAN_MODE.CIRCULATE],
];

const command = (definition) => ({
  read_only: false,
  has_feedback: true,
  keep_history: true,
  ...definition,
});
const sensor = (definition) => ({
  read_only: true,
  has_feedback: false,
  keep_history: true,
  ...definition,
});
const words = () =>
  sensor({ category: C.TEXT, type: T.TEXT.TEXT, min: 0, max: 0, keep_history: false });

/**
 * The features, by key, in display order. `shape`: what the thermostat
 * showed at least once ({ humidity, outdoor, outdoorHumidity, modes,
 * humidifier, dehumidifier, ventilation, airCleaner }).
 */
export function definitions(shape, language) {
  const can = offers(shape.modes);
  const defs = {};
  defs[FEATURES.TEMPERATURE] = sensor({
    category: C.TEMPERATURE_SENSOR,
    type: T.SENSOR.DECIMAL,
    unit: U.CELSIUS,
    min: -20,
    max: 60,
  });
  if (shape.humidity) {
    defs[FEATURES.HUMIDITY] = sensor({
      category: C.HUMIDITY_SENSOR,
      type: T.SENSOR.DECIMAL,
      unit: U.PERCENT,
      min: 0,
      max: 100,
    });
  }
  if (shape.outdoor) {
    // A probe: the core keeps it out of the temperature of the room.
    defs[FEATURES.OUTDOOR] = sensor({
      category: C.TEMPERATURE_SENSOR,
      type: T.TEMPERATURE_SENSOR.PROBE,
      unit: U.CELSIUS,
      min: -60,
      max: 60,
    });
  }
  if (shape.outdoorHumidity) {
    defs[FEATURES.OUTDOOR_HUMIDITY] = sensor({
      category: C.HUMIDITY_SENSOR,
      type: T.SENSOR.DECIMAL,
      unit: U.PERCENT,
      min: 0,
      max: 100,
    });
  }
  // Commands, refused unless the user allowed them (`allow_commands`, off by
  // default), except the stop (mode Off): read_only is fixed when the device
  // is created, so the permission is checked at each command instead.
  if (can.heat) {
    defs[FEATURES.HEAT_SETPOINT] = command({
      category: C.THERMOSTAT,
      type: T.THERMOSTAT.TARGET_TEMPERATURE,
      unit: U.CELSIUS,
      min: SETPOINT_BOUNDS.min,
      max: SETPOINT_BOUNDS.max,
    });
  }
  if (can.cool) {
    defs[FEATURES.COOL_SETPOINT] = command({
      category: C.AIR_CONDITIONING,
      type: T.AIR_CONDITIONING.TARGET_TEMPERATURE,
      unit: U.CELSIUS,
      min: SETPOINT_BOUNDS.min,
      max: SETPOINT_BOUNDS.max,
    });
  }
  const modes = MODE_MAP.filter(([name]) => name === 'off' || can[name]);
  defs[FEATURES.MODE] = command({
    category: C.THERMOSTAT,
    type: T.THERMOSTAT.MODE,
    min: THERMOSTAT_MODE.OFF,
    max: Math.max(...modes.map(([, , value]) => value)),
    supported_options: modes.map(([name, , value], index) => ({
      value,
      label: word(MODE_NAMES[name], language),
      sort_order: index,
    })),
  });
  defs[FEATURES.FAN] = command({
    category: C.TEXT,
    type: T.TEXT.SELECT,
    keep_history: false,
    supported_options: FAN_MAP.map(([name], index) => ({
      value: name,
      label: word(FAN_NAMES[name], language),
      sort_order: index,
    })),
  });
  defs[FEATURES.FAN_RUNNING] = sensor({
    category: C.UNKNOWN,
    type: T.UNKNOWN.UNKNOWN,
    min: 0,
    max: 1,
  });
  defs[FEATURES.OPERATING_STATE] = sensor({
    category: C.THERMOSTAT,
    type: T.THERMOSTAT.OPERATING_STATE,
    min: THERMOSTAT_OPERATING_STATE.IDLE,
    max: THERMOSTAT_OPERATING_STATE.COOLING,
  });
  defs[FEATURES.HOLD] = words();
  if (shape.humidifier) defs[FEATURES.HUMIDIFIER] = words();
  if (shape.dehumidifier) defs[FEATURES.DEHUMIDIFIER] = words();
  if (shape.ventilation) defs[FEATURES.VENTILATION] = words();
  if (shape.airCleaner) defs[FEATURES.AIR_CLEANER] = words();
  defs[FEATURES.ERROR] = words();
  return defs;
}

/** The fields of a feature Gladys stores (what is kept of a created feature). */
const DECLARED = [
  'name',
  'external_id',
  'category',
  'type',
  'unit',
  'min',
  'max',
  'read_only',
  'has_feedback',
  'keep_history',
  'supported_options',
];

/**
 * The device of the thermostat. `created`: the device already created in
 * Gladys: each of its features is kept as it was created (category, type,
 * unit, bounds and options are fixed in Gladys: a change marks the device
 * "structure changed"); new features are added after them.
 */
export function buildDevice(gladys, { mac, model, firmware, shape }, { language, created }) {
  const ids = deviceIds(gladys, mac);
  const defs = definitions(shape, language);
  const name = modelName(model);
  const params = [{ name: 'mac', value: mac }];
  if (name) params.push({ name: 'model', value: name });
  if (firmware) params.push({ name: 'firmware', value: firmware });
  const built = {
    name: word(DEVICE_NAME(name), language),
    external_id: ids.device,
    model: name ? `Aprilaire ${name}` : 'Aprilaire',
    should_poll: false,
    features: Object.entries(defs).map(([key, def]) => ({
      name: word(FEATURE_NAMES[key], language),
      external_id: ids.feature(key),
      ...def,
    })),
    params,
  };
  if (!created || !Array.isArray(created.features)) {
    return built;
  }
  const fresh = new Map(built.features.map((f) => [f.external_id, f]));
  const kept = created.features
    .filter((f) => typeof f?.external_id === 'string')
    .map((f) => {
      const entry = Object.fromEntries(
        DECLARED.filter((k) => f[k] !== undefined && f[k] !== null).map((k) => [k, f[k]]),
      );
      entry.name = fresh.get(f.external_id)?.name ?? f.name;
      return entry;
    });
  const known = new Set(kept.map((f) => f.external_id));
  return {
    ...built,
    features: [...kept, ...built.features.filter((f) => !known.has(f.external_id))],
  };
}

const OPERATING = (heating, cooling) => {
  if (heating === undefined && cooling === undefined) return undefined;
  // spec 7.6: 0 not active, 1 equipment wait, 2 and above a stage running.
  if (heating >= 2) return THERMOSTAT_OPERATING_STATE.HEATING;
  if (cooling >= 2) return THERMOSTAT_OPERATING_STATE.COOLING;
  return THERMOSTAT_OPERATING_STATE.IDLE;
};

/**
 * The states of the values given (only those: a value not read this time is
 * never published again as new), for the features created (`created`: a Set
 * of feature external ids). Unknown values are left out, never sent as
 * undefined, NaN or 0.
 */
export function deviceStates(ids, values, created, language) {
  const states = [];
  const add = (key, value) => {
    const id = ids.feature(key);
    if (value !== undefined && created.has(id)) {
      states.push({ device_feature_external_id: id, ...value });
    }
  };
  const number = (n) => (Number.isFinite(n) ? { state: n } : undefined);
  const text = (t) => (t ? { text: word(t, language) } : undefined);
  const has = (field) => Object.hasOwn(values, field);
  if (has('indoorTemperature')) add(FEATURES.TEMPERATURE, number(values.indoorTemperature));
  if (has('indoorHumidity')) add(FEATURES.HUMIDITY, number(values.indoorHumidity));
  if (has('outdoorTemperature')) add(FEATURES.OUTDOOR, number(values.outdoorTemperature));
  if (has('outdoorHumidity')) add(FEATURES.OUTDOOR_HUMIDITY, number(values.outdoorHumidity));
  if (has('heat')) add(FEATURES.HEAT_SETPOINT, number(values.heat));
  if (has('cool')) add(FEATURES.COOL_SETPOINT, number(values.cool));
  if (has('mode')) add(FEATURES.MODE, number(gladysModeOf(values.mode)));
  if (has('fan')) {
    const fan = FAN_MAP.find((row) => row[1] === values.fan)?.[0];
    add(FEATURES.FAN, fan === undefined ? undefined : { text: fan });
  }
  if (has('fanRunning')) add(FEATURES.FAN_RUNNING, number(values.fanRunning));
  if (has('heating') || has('cooling')) {
    add(FEATURES.OPERATING_STATE, number(OPERATING(values.heating, values.cooling)));
  }
  if (has('hold')) add(FEATURES.HOLD, text(HOLD_NAMES[values.hold]));
  if (has('humidificationStatus')) {
    add(
      FEATURES.HUMIDIFIER,
      text(humidifierText(values.humidificationStatus, values.humidification)),
    );
  }
  if (has('dehumidificationStatus')) {
    add(
      FEATURES.DEHUMIDIFIER,
      text(dehumidifierText(values.dehumidificationStatus, values.dehumidification)),
    );
  }
  if (has('ventilationStatus')) {
    add(
      FEATURES.VENTILATION,
      text(
        iaqText('ventilation', values.ventilationStatus, values.freshAirMode, values.freshAirEvent),
      ),
    );
  }
  if (has('airCleaningStatus')) {
    add(
      FEATURES.AIR_CLEANER,
      text(
        iaqText(
          'airCleaning',
          values.airCleaningStatus,
          values.airCleaningMode,
          values.airCleaningEvent,
        ),
      ),
    );
  }
  if (has('error')) add(FEATURES.ERROR, text(ERROR_NAMES[values.error]));
  return states;
}

/** A command value, strictly: a finite number, or a text that is exactly one. */
export function strictNumber(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string' && /^-?\d{1,3}(?:\.\d{1,3})?$/.test(value)) {
    return Number(value);
  }
  return undefined;
}

/**
 * The change a command asks, checked on its own (before any read), or
 * undefined when the value is not one the feature takes:
 *   { field: 'heat' | 'cool', value }   (°C, on the 0.5 grid, within the bounds)
 *   { field: 'mode', value }            (protocol mode 1, 2, 3 or 5)
 *   { field: 'fan', value }             (protocol fan 1, 2 or 3)
 *   { outOfRange: true }                a setpoint outside the bounds
 */
export function commandValue(key, value) {
  if (!COMMAND_FEATURES.includes(key)) {
    return undefined;
  }
  if (key === FEATURES.FAN) {
    const fan = FAN_MAP.find((row) => row[0] === value)?.[1];
    return fan === undefined ? undefined : { field: 'fan', value: fan };
  }
  const n = strictNumber(value);
  if (n === undefined) {
    return undefined;
  }
  if (key === FEATURES.MODE) {
    const mode = MODE_MAP.find((row) => row[2] === n)?.[1];
    return mode === undefined ? undefined : { field: 'mode', value: mode };
  }
  // The bounds on the value asked, before any rounding; then rounded to the
  // 0.5 °C of the protocol (a bound is on the grid: rounding never leaves them).
  if (n < SETPOINT_BOUNDS.min || n > SETPOINT_BOUNDS.max) {
    return { outOfRange: true };
  }
  const rounded = Math.round(n / STEP) * STEP;
  return { field: key === FEATURES.HEAT_SETPOINT ? 'heat' : 'cool', value: rounded };
}
