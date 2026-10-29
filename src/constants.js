// -----------------------------------------------------------------------------
// Aprilaire constants, manifest keys, limits and timings.
//
// An Aprilaire 8800-series Wi-Fi thermostat (8810, 8820, 8830, 8840, 8910W,
// 6000 zone control; the 8920W reportedly not) in "Automation" connection type serves the
// "Home Automation" protocol published by Aprilaire on one TCP socket (port
// 7000 by default in Home Assistant). pyaprilaire (MIT) implements it; this
// module ports the frame format, the value encodings and the attribute maps
// it documents (spec sections cited as "spec x.y"). The thermostat takes ONE
// automation connection at a time: two at once can make it stop answering
// until it is power cycled (pyaprilaire README, Home Assistant docs).
// -----------------------------------------------------------------------------

/** Feature keys (the last part of the feature external ids): frozen. */
export const FEATURES = {
  TEMPERATURE: 'temperature',
  HUMIDITY: 'humidity',
  OUTDOOR: 'outdoor-temperature',
  OUTDOOR_HUMIDITY: 'outdoor-humidity',
  HEAT_SETPOINT: 'heat-setpoint',
  COOL_SETPOINT: 'cool-setpoint',
  MODE: 'mode',
  FAN: 'fan-mode',
  FAN_RUNNING: 'fan-running',
  OPERATING_STATE: 'operating-state',
  HOLD: 'hold',
  HUMIDIFIER: 'humidifier',
  DEHUMIDIFIER: 'dehumidifier',
  VENTILATION: 'ventilation',
  AIR_CLEANER: 'air-cleaner',
  ERROR: 'error',
};

export const COMMAND_FEATURES = [
  FEATURES.HEAT_SETPOINT,
  FEATURES.COOL_SETPOINT,
  FEATURES.MODE,
  FEATURES.FAN,
];

export const ACTIONS = { TEST_CONNECTION: 'test_connection' };

/** The device type of the external ids: `ext:<selector>:aprilaire:<mac>`. */
export const DEVICE_TYPE = 'aprilaire';

/** Gladys core values (server/utils/constants.js; the SDK does not export them). */
export const THERMOSTAT_MODE = { OFF: 0, HEATING: 1, COOLING: 2, AUTO: 3 };
export const THERMOSTAT_OPERATING_STATE = { IDLE: 0, HEATING: 1, COOLING: 2 };

/** Protocol values (pyaprilaire const.py, spec sections in comments). */
export const ACTION = { WRITE: 1, READ_REQUEST: 2, READ_RESPONSE: 3, COS: 5, NACK: 6 };
export const DOMAIN = {
  SETUP: 1,
  CONTROL: 2,
  SCHEDULING: 3,
  SENSORS: 5,
  STATUS: 7,
  IDENTIFICATION: 8,
};
/** spec 2.1 */
export const HVAC_MODE = { OFF: 1, HEAT: 2, COOL: 3, EMERGENCY_HEAT: 4, AUTO: 5 };
/** spec 2.1 */
export const FAN_MODE = { ON: 1, AUTO: 2, CIRCULATE: 3 };
/** spec 1.1 / 1.3 (display only: the protocol always carries degrees Celsius). */
export const TEMPERATURE_SCALE = { FAHRENHEIT: 0, CELSIUS: 1 };
/** spec 5.1 / 5.2: only 0 is a measurement. */
export const SENSOR_OK = 0;
/** spec H.5: the NACK status codes. */
export const NACK = {
  GENERIC_ERROR: 0x01,
  BUSY: 0x03,
  UNKNOWN_FUNCTIONAL_DOMAIN: 0x06,
  UNKNOWN_ATTRIBUTE: 0x07,
  NOT_IN_CURRENT_MODE: 0x08,
  TIMED_OUT: 0x09,
  UNSUPPORTED_MODEL: 0x0a,
  VALUE_OUT_OF_RANGE: 0x10,
};
/** spec H.5: retried ("2 additional times", 0.5 to 1 s apart). */
export const RETRYABLE_NACKS = new Set([NACK.GENERIC_ERROR, NACK.BUSY, NACK.TIMED_OUT]);
/** The thermostat does not implement the attribute at all: never asked again this session. */
export const UNSUPPORTED_NACKS = new Set([
  NACK.UNKNOWN_FUNCTIONAL_DOMAIN,
  NACK.UNKNOWN_ATTRIBUTE,
  NACK.UNSUPPORTED_MODEL,
]);

/** Known model numbers (spec 8.1, pyaprilaire MODELS). */
export const MODELS = {
  0: '8476W',
  1: '8810',
  2: '8620W',
  3: '8820',
  4: '8910W',
  5: '8830',
  6: '8920W',
  7: '8840',
  14: '8840M',
  28: '6003',
};

/**
 * Setpoint bounds. The manufacturer gives the control range of the 8800 and
 * 8900 series as 40 to 99 °F, and "4 to 32 °C" (spec sheets of the 8910 and
 * 8920W). The protocol carries degrees Celsius by 0.5 °C (spec G); the bounds
 * are the °F range converted exactly ((F - 32) x 5 / 9), brought inside onto
 * the 0.5 °C grid (the low one up, the high one down), then within the °C
 * range given: 4.5 to 32 °C (40.1 to 89.6 °F). Both setpoints take the same
 * range. Checked on the value asked and again on the value written.
 */
export const MAKER_RANGE = { fahrenheit: { min: 40, max: 99 }, celsius: { min: 4, max: 32 } };
export const STEP = 0.5;
const fToC = (f) => ((f - 32) * 5) / 9;
export const SETPOINT_BOUNDS = Object.freeze({
  min: Math.max(Math.ceil(fToC(MAKER_RANGE.fahrenheit.min) / STEP) * STEP, MAKER_RANGE.celsius.min),
  max: Math.min(
    Math.floor(fToC(MAKER_RANGE.fahrenheit.max) / STEP) * STEP,
    MAKER_RANGE.celsius.max,
  ),
});

export const DEFAULT_PORT = 7000;
export const POLL_INTERVAL = { min: 30, max: 600, default: 60 };

export const LIMITS = {
  /** Gladys: 300 states per minute. */
  statesPerMinute: 300,
  statesPerRequest: 100,
  /** The longest payload of a frame we accept (the largest known is 30 bytes). */
  payloadBytes: 256,
  /** Bytes buffered from the thermostat while a frame is incomplete. */
  bufferBytes: 4 * 1024,
  /** Frames with a wrong CRC in a row before the session is closed (lost framing). */
  badFrames: 3,
  /** Requests unanswered in a row before the session is closed. */
  silentRequests: 2,
};

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

export const TIMINGS = {
  connectTimeout: 5 * SECOND,
  /** One request (the thermostat answers within a few hundred ms). */
  requestTimeout: 2 * SECOND,
  /** spec H.5: a busy or generic NACK is tried again after 0.5 to 1 s, twice at most. */
  nackRetry: 600,
  nackRetries: 2,
  /**
   * A request that received no byte for this long is cut by a stop waiting (a
   * new session). pyaprilaire and its mock answer on a 0.5 s cycle: 1.5 s
   * leaves a healthy answer its time.
   */
  stuckRead: 1_500,
  /** /data read at the start: awaited this long at most (read late, it is merged). */
  dataLoad: SECOND,
  /** A socket that never says 'close' is given up after this long (the next one may open). */
  closeWait: 2 * SECOND,
  /** Reconnections after a session was lost or refused: never a loop. */
  backoff: [30 * SECOND, MINUTE, 2 * MINUTE, 5 * MINUTE, 10 * MINUTE],
  /** While a stop waits to be sent, reconnections are tried at least this often. */
  stopBackoff: MINUTE,
  /** A click of the stop tries a connection at once, but never two within this time. */
  stopConnectSpacing: 5 * SECOND,
  /** After a click or a cut for a stop, a refused connection is tried again every second for 10 s. */
  stopConnectRetry: SECOND,
  stopUrgent: 10 * SECOND,
  /** The time of the last connection attempt is written to /data at most this often. */
  attemptSave: MINUTE,
  /** The publisher sends what is pending every second; unchanged states again every 30 min. */
  flushInterval: SECOND,
  stateHeartbeat: 30 * MINUTE,
  /** A value read longer ago is never published (Gladys back after an outage). */
  freshFor: 2 * MINUTE,
  /** The "Test the connection" button answers within 25 s (timeout 30 s). */
  testAnswerBy: 25 * SECOND,
  /**
   * Commands (Gladys waits 5 s for the ack): the answer by 4.3 s; a command
   * still waiting its turn then goes on, 15 s at most after its arrival.
   */
  commandAnswerBy: 4_300,
  commandSendBy: 15 * SECOND,
  /** A command not confirmed keeps its guard until a read shows it, or 90 s. */
  guard: 90 * SECOND,
  /** Reads after a command: its effect, then a check. */
  followUps: [5 * SECOND, 20 * SECOND],
  /**
   * A stop not confirmed is held: checked every 15 s for 3 min after the
   * click, then every minute; sent again when the thermostat still shows the
   * mode of before (by the checks only), three times at most
   * per click; another mode read twice in a row (set at the thermostat) ends
   * it, never the time.
   */
  stopRetry: 15 * SECOND,
  stopFastChecks: 3 * MINUTE,
  stopSlowRetry: MINUTE,
  stopReasserts: 3,
  stopOtherReads: 2,
  /** getConfig() failing: tried again 5 s, 10 s, 30 s, then every minute, without end. */
  configRetry: [5 * SECOND, 10 * SECOND, 30 * SECOND, MINUTE],
};
