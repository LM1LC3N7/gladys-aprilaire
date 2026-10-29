// -----------------------------------------------------------------------------
// The frames of the Aprilaire "Home Automation" protocol (pure), ported from
// pyaprilaire packet.py (MIT, Matthew FitzGerald-Chamberlain):
//
//   REV(1)=1  SEQ(1)  CNT(2, high byte first)  PAYLOAD(CNT)  CRC(1)          spec F
//   PAYLOAD = ACTION(1) FUNCTIONAL_DOMAIN(1) ATTRIBUTE(1) DATA...            spec G
//           | NACK(6) STATUS(1)                                             spec H.5
//   CRC-8, polynomial 0x31, initial value 0, no reflection, over REV..PAYLOAD.
//
// Our requests use sequence numbers 1 to 127, the answers echo them; the
// thermostat's own messages (COS, change of state) use 128 to 255 (spec F).
// Temperatures are ALWAYS degrees Celsius on the wire, whatever the display
// scale of the thermostat: bits 0-5 the whole degrees, bit 6 a half degree,
// bit 7 the sign (spec G). In a WRITE, a 0 byte is NULL: "leave unchanged".
//
// Every frame is bounded: a CNT above LIMITS.payloadBytes ends the session at
// once (before its bytes are even read), a wrong CRC drops the frame (three
// in a row: the framing is lost, the session ends), a short DATA leaves the
// missing fields unknown, never 0.
// -----------------------------------------------------------------------------

import { ACTION, DOMAIN, LIMITS, SETPOINT_BOUNDS, STEP } from '../constants.js';

/** CRC-8 (polynomial 0x31, init 0, no reflection, no final xor). */
export function crc8(bytes) {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x80 ? ((crc << 1) ^ 0x31) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc;
}

/** A temperature byte -> degrees Celsius (spec G). */
export function decodeTemperature(byte) {
  if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
    return undefined;
  }
  const value = (byte & 63) + (byte & 64 ? 0.5 : 0);
  return byte & 128 ? -value : value;
}

/** Degrees Celsius on the 0.5 grid -> a temperature byte, or undefined. */
export function encodeTemperature(celsius) {
  if (!Number.isFinite(celsius) || Math.abs(celsius) > 63.5 || (celsius * 2) % 1 !== 0) {
    return undefined;
  }
  const magnitude = Math.abs(celsius);
  return Math.floor(magnitude) + (magnitude % 1 === 0.5 ? 64 : 0) + (celsius < 0 ? 128 : 0);
}

/**
 * The byte of a setpoint to WRITE: on the 0.5 grid and within the bounds
 * (SETPOINT_BOUNDS), else undefined. The last guard before the wire: a value
 * out of bounds never becomes a byte, whatever the caller checked.
 */
export function setpointByte(celsius) {
  if (
    !Number.isFinite(celsius) ||
    celsius < SETPOINT_BOUNDS.min ||
    celsius > SETPOINT_BOUNDS.max ||
    (celsius / STEP) % 1 !== 0
  ) {
    return undefined;
  }
  // Never 0 (a 0 byte means "unchanged", NULL, in a write): the bounds exclude 0 °C.
  return encodeTemperature(celsius);
}

/** A relative humidity byte (0 to 100 %), else undefined (spec G). */
export const decodeHumidity = (byte) =>
  Number.isInteger(byte) && byte >= 0 && byte <= 100 ? byte : undefined;

/** One frame: REV SEQ CNT PAYLOAD CRC. */
export function buildFrame(sequence, action, domain, attribute, data = []) {
  const payload = [action, domain, attribute, ...data];
  const head = [1, sequence & 0xff, (payload.length >> 8) & 0xff, payload.length & 0xff];
  const body = [...head, ...payload];
  return Buffer.from([...body, crc8(body)]);
}

/** A NACK frame (built by the fake thermostat of the tests). */
export function buildNack(sequence, status) {
  const body = [1, sequence & 0xff, 0, 2, ACTION.NACK, status];
  return Buffer.from([...body, crc8(body)]);
}

export class FrameError extends Error {
  constructor(message) {
    super(message);
    this.kind = 'protocol';
  }
}

/**
 * The byte stream of one connection -> frames. `push(chunk)` returns the
 * complete frames with a good CRC; a trailing partial frame stays buffered.
 * Throws FrameError when the stream cannot be trusted any more (a frame too
 * large announced, too many bytes buffered, the framing lost).
 */
export class FrameReader {
  constructor() {
    this.buffer = Buffer.alloc(0);
    this.badInARow = 0;
    this.bad = 0;
  }

  push(chunk) {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const frames = [];
    let offset = 0;
    while (this.buffer.length - offset >= 4) {
      const count = (this.buffer[offset + 2] << 8) | this.buffer[offset + 3];
      if (count > LIMITS.payloadBytes || count < 2) {
        // Checked on the header alone: an oversized frame is never read whole.
        throw new FrameError(`frame of ${count} bytes announced`);
      }
      const end = offset + 4 + count + 1;
      if (end > this.buffer.length) {
        break;
      }
      const frame = this.buffer.subarray(offset, end);
      offset = end;
      if (frame[0] !== 1 || crc8(frame.subarray(0, -1)) !== frame.at(-1)) {
        this.bad += 1;
        this.badInARow += 1;
        if (this.badInARow >= LIMITS.badFrames) {
          throw new FrameError('framing lost (wrong CRC)');
        }
        continue;
      }
      this.badInARow = 0;
      frames.push(parseFrame(frame));
    }
    this.buffer = Buffer.from(this.buffer.subarray(offset));
    if (this.buffer.length > LIMITS.bufferBytes) {
      throw new FrameError('too many bytes without a frame');
    }
    return frames;
  }
}

/** A complete frame with a good CRC -> { sequence, action, domain, attribute, data } | { nack }. */
export function parseFrame(frame) {
  const sequence = frame[1];
  const payload = frame.subarray(4, -1);
  if (payload[0] === ACTION.NACK) {
    return { sequence, action: ACTION.NACK, nack: payload[1] };
  }
  return {
    sequence,
    action: payload[0],
    domain: payload[1],
    attribute: payload[2],
    data: [...payload.subarray(3)],
  };
}

const key = (domain, attribute) => `${domain}/${attribute}`;
const integer = (byte) => (Number.isInteger(byte) ? byte : undefined);
/** A field where 0 is NULL (spec G): unknown. */
const required = (byte) => (Number.isInteger(byte) && byte !== 0 ? byte : undefined);
const temperature = (byte) => (Number.isInteger(byte) ? decodeTemperature(byte) : undefined);
const requiredTemperature = (byte) =>
  Number.isInteger(byte) && byte !== 0 ? decodeTemperature(byte) : undefined;
const humidity = (byte) => (Number.isInteger(byte) ? decodeHumidity(byte) : undefined);
/** A sensor value: only with the status "no error" (spec 5.1 / 5.2). */
const sensor = (status, value, decode) =>
  status === 0 && Number.isInteger(value) ? decode(value) : undefined;

const strip = (object) =>
  Object.fromEntries(Object.entries(object).filter(([, v]) => v !== undefined));

/** The decoders of the attributes this module reads, by "domain/attribute" (pyaprilaire MAPPING). */
const DECODERS = {
  // spec 1.1, Thermostat Installer Settings: byte 2 the temperature scale (display only).
  [key(DOMAIN.SETUP, 1)]: (d) => ({ scale: d[2] === 0 || d[2] === 1 ? d[2] : undefined }),
  // spec 2.1: mode, fan mode, heat and cool setpoints (0 = NULL).
  [key(DOMAIN.CONTROL, 1)]: (d) => ({
    mode: d[0] >= 1 && d[0] <= 5 ? d[0] : undefined,
    fan: d[1] >= 1 && d[1] <= 3 ? d[1] : undefined,
    heat: requiredTemperature(d[2]),
    cool: requiredTemperature(d[3]),
  }),
  // spec 2.3: 0 off, 40-90 % (any other value: unknown).
  [key(DOMAIN.CONTROL, 3)]: (d) => ({
    dehumidification: d[0] === 0 || (d[0] >= 40 && d[0] <= 90) ? d[0] : undefined,
  }),
  // spec 2.4: 0 off, 1-7 an automatic level, 10-50 % (manual).
  [key(DOMAIN.CONTROL, 4)]: (d) => ({
    humidification:
      Number.isInteger(d[0]) && (d[0] <= 7 || (d[0] >= 10 && d[0] <= 50)) ? d[0] : undefined,
  }),
  // spec 2.5 / 2.6: mode and event of the fresh air and the air cleaning.
  [key(DOMAIN.CONTROL, 5)]: (d) => ({ freshAirMode: integer(d[0]), freshAirEvent: integer(d[1]) }),
  [key(DOMAIN.CONTROL, 6)]: (d) => ({
    airCleaningMode: integer(d[0]),
    airCleaningEvent: integer(d[1]),
  }),
  // spec 2.7: what the thermostat drives.
  [key(DOMAIN.CONTROL, 7)]: (d) => ({
    modes: required(d[0]),
    airCleaningAvailable: integer(d[1]),
    ventilationAvailable: integer(d[2]),
    dehumidificationAvailable: integer(d[3]),
    humidificationAvailable: integer(d[4]),
  }),
  // spec 3.4: the hold (0 none, 1 temporary, 2 permanent, 3 away, 4 vacation).
  [key(DOMAIN.SCHEDULING, 4)]: (d) => ({ hold: d[0] >= 0 && d[0] <= 4 ? d[0] : undefined }),
  // spec 5.2: the controlling sensors, each a status (0 = no error) and a value.
  [key(DOMAIN.SENSORS, 2)]: (d) => ({
    indoorTemperature: sensor(d[0], d[1], temperature),
    outdoorTemperature: sensor(d[2], d[3], temperature),
    indoorHumidity: sensor(d[4], d[5], humidity),
    outdoorHumidity: sensor(d[6], d[7], humidity),
    outdoorTemperatureStatus: integer(d[2]),
    outdoorHumidityStatus: integer(d[6]),
  }),
  // spec 7.6: heating, cooling, progressive recovery, fan.
  [key(DOMAIN.STATUS, 6)]: (d) => ({
    heating: d[0] <= 14 ? integer(d[0]) : undefined,
    cooling: d[1] <= 6 ? integer(d[1]) : undefined,
    fanRunning: d[3] === 0 || d[3] === 1 ? d[3] : undefined,
  }),
  // spec 7.7: dehumidification, humidification, ventilation, air cleaning.
  [key(DOMAIN.STATUS, 7)]: (d) => ({
    dehumidificationStatus: d[0] <= 4 ? integer(d[0]) : undefined,
    humidificationStatus: d[1] <= 3 ? integer(d[1]) : undefined,
    ventilationStatus: d[2] <= 6 ? integer(d[2]) : undefined,
    airCleaningStatus: d[3] <= 3 ? integer(d[3]) : undefined,
  }),
  // spec 7.8: the error code (0 none, 1-8 E1-E8).
  [key(DOMAIN.STATUS, 8)]: (d) => ({ error: d[0] <= 8 ? integer(d[0]) : undefined }),
  // spec 8.1: revisions and model.
  [key(DOMAIN.IDENTIFICATION, 1)]: (d) => ({
    hardware: integer(d[0]),
    firmware: Number.isInteger(d[1]) && Number.isInteger(d[2]) ? `${d[1]}.${d[2]}` : undefined,
    protocol: integer(d[3]),
    model: integer(d[4]),
  }),
  // spec 8.2: the MAC address (6 bytes).
  [key(DOMAIN.IDENTIFICATION, 2)]: (d) => ({ mac: macOf(d.slice(0, 6)) }),
};

/**
 * A MAC address read: 12 lower-case hex digits, or undefined when it cannot
 * be one (short, all zero, all ones, or a multicast / broadcast address).
 */
export function macOf(bytes) {
  if (!Array.isArray(bytes) || bytes.length !== 6 || bytes.some((b) => !Number.isInteger(b))) {
    return undefined;
  }
  if (bytes.every((b) => b === 0) || bytes.every((b) => b === 255) || bytes[0] & 1) {
    return undefined;
  }
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Whether this module decodes the attribute. */
export const decodes = (domain, attribute) => Object.hasOwn(DECODERS, key(domain, attribute));

/** The values of a frame's DATA (unknown fields left out), or undefined when not decoded. */
export function decode(domain, attribute, data) {
  const decoder = DECODERS[key(domain, attribute)];
  return decoder ? strip(decoder(data)) : undefined;
}

/**
 * A write of CONTROL 2.1: only the fields given, every other byte NULL
 * (unchanged). `mode` and `fan` as protocol values, setpoints in °C (bounded).
 * Undefined when a value is not one the protocol takes.
 */
export function controlWrite({ mode, fan, heat, cool }) {
  const bytes = [0, 0, 0, 0];
  if (mode !== undefined) {
    if (!Number.isInteger(mode) || mode < 1 || mode > 5) return undefined;
    bytes[0] = mode;
  }
  if (fan !== undefined) {
    if (!Number.isInteger(fan) || fan < 1 || fan > 3) return undefined;
    bytes[1] = fan;
  }
  for (const [index, value] of [
    [2, heat],
    [3, cool],
  ]) {
    if (value !== undefined) {
      const byte = setpointByte(value);
      if (byte === undefined) return undefined;
      bytes[index] = byte;
    }
  }
  // An all-NULL write changes nothing: never sent (pyaprilaire refuses it too).
  return bytes.some((b) => b !== 0) ? bytes : undefined;
}
