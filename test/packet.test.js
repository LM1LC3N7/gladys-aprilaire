// -----------------------------------------------------------------------------
// The frames, the encodings and the bounds of the protocol (pure), checked
// against pyaprilaire (MIT): its CRC, its temperature encoding and frames.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAKER_RANGE, SETPOINT_BOUNDS } from '../src/constants.js';
import {
  FrameReader,
  buildFrame,
  buildNack,
  controlWrite,
  crc8,
  decode,
  decodeTemperature,
  encodeTemperature,
  macOf,
  setpointByte,
} from '../src/aprilaire/packet.js';

test('CRC-8 (polynomial 0x31): the check value of the standard, and a frame of the reference', () => {
  // CRC-8/NRSC-5 has polynomial 0x31 but init 0xff; with init 0 the check of "123456789" is 0xa2.
  assert.equal(crc8(Buffer.from('123456789')), 0xa2);
  // A read request of the control values, sequence 1 (pyaprilaire serialize()).
  const frame = buildFrame(1, 2, 2, 1);
  assert.deepEqual([...frame.subarray(0, 7)], [1, 1, 0, 3, 2, 2, 1]);
  assert.equal(frame.at(-1), crc8(frame.subarray(0, -1)));
  // Frames of pyaprilaire's own tests (tests/test_packet.py), CRC included.
  for (const bytes of [
    [1, 0, 0, 5, 1, 7, 2, 1, 0, 0xb6],
    [1, 0, 0, 2, 6, 2, 227],
    [1, 1, 0, 3, 2, 2, 1, 70],
    [1, 1, 0, 7, 3, 2, 1, 1, 2, 10, 20, 107],
    [0x01, 0x00, 0x00, 0x07, 0x01, 0x02, 0x01, 0x00, 0x01, 0x15, 0x5a, 0x46],
  ]) {
    assert.equal(crc8(bytes.slice(0, -1)), bytes.at(-1), `${bytes}`);
  }
  assert.deepEqual([...buildFrame(1, 2, 2, 1)], [1, 1, 0, 3, 2, 2, 1, 70]);
  assert.deepEqual(
    [...buildFrame(0, 1, 2, 1, [0, 1, 0x15, 0x5a])],
    [0x01, 0x00, 0x00, 0x07, 0x01, 0x02, 0x01, 0x00, 0x01, 0x15, 0x5a, 0x46],
  );
  // 0x5a: 26 + a half degree (pyaprilaire writes 26.5 °C so).
  assert.equal(decodeTemperature(0x5a), 26.5);
});

test('temperatures: whole degrees, a half degree, the sign (spec G, pyaprilaire)', () => {
  for (const [byte, celsius] of [
    [20, 20],
    [20 + 64, 20.5],
    [3 + 128, -3],
    [3 + 64 + 128, -3.5],
    [63 + 64, 63.5],
    [0, 0],
  ]) {
    assert.equal(decodeTemperature(byte), celsius, `byte ${byte}`);
    assert.equal(encodeTemperature(celsius), byte, `${celsius} °C`);
  }
  assert.equal(encodeTemperature(20.25), undefined, 'not on the grid');
  assert.equal(encodeTemperature(64), undefined, 'too large');
});

test('the setpoint bounds: the maker 40-99 °F converted exactly, within 4-32 °C', () => {
  const fToC = (f) => ((f - 32) * 5) / 9;
  assert.equal(SETPOINT_BOUNDS.min, 4.5);
  assert.equal(SETPOINT_BOUNDS.max, 32);
  // Checked after the conversion, both ways: inside the °F range and the °C range.
  assert.ok(SETPOINT_BOUNDS.min >= fToC(MAKER_RANGE.fahrenheit.min));
  assert.ok(SETPOINT_BOUNDS.max <= fToC(MAKER_RANGE.fahrenheit.max));
  assert.ok((SETPOINT_BOUNDS.min * 9) / 5 + 32 >= 40);
  assert.ok((SETPOINT_BOUNDS.max * 9) / 5 + 32 <= 99);
  assert.ok(SETPOINT_BOUNDS.min - 0.5 < fToC(40), 'the lowest grid value at or above 40 °F');
  assert.ok(SETPOINT_BOUNDS.min >= MAKER_RANGE.celsius.min);
  assert.ok(SETPOINT_BOUNDS.max <= MAKER_RANGE.celsius.max);
});

test('the byte written: bounded and on the grid, never a NULL', () => {
  assert.equal(setpointByte(4.5), 4 + 64);
  assert.equal(setpointByte(32), 32);
  assert.equal(setpointByte(4), undefined);
  assert.equal(setpointByte(32.5), undefined);
  assert.equal(setpointByte(21.2), undefined);
  assert.equal(setpointByte(Number.NaN), undefined);
  assert.deepEqual(
    controlWrite({ mode: 1 }),
    [1, 0, 0, 0],
    'the stop: the mode alone, others NULL',
  );
  assert.deepEqual(controlWrite({ heat: 21.5 }), [0, 0, 21 + 64, 0]);
  assert.deepEqual(controlWrite({ cool: 24 }), [0, 0, 0, 24]);
  assert.equal(controlWrite({ heat: 33 }), undefined);
  assert.equal(controlWrite({}), undefined, 'an all-NULL write is never sent');
  assert.equal(controlWrite({ mode: 6 }), undefined);
});

test('frames: split, glued, a wrong CRC dropped, an oversized frame refused on its header', () => {
  const reader = new FrameReader();
  const a = buildFrame(1, 3, 2, 1, [2, 2, 20, 25]);
  const b = buildFrame(130, 5, 7, 6, [2, 0, 0, 1]);
  assert.deepEqual(reader.push(a.subarray(0, 5)), []);
  const frames = reader.push(Buffer.concat([a.subarray(5), b]));
  assert.equal(frames.length, 2);
  assert.deepEqual(decode(2, 1, frames[0].data), { mode: 2, fan: 2, heat: 20, cool: 25 });
  assert.equal(frames[1].sequence, 130);
  const bad = Buffer.from(a);
  bad[bad.length - 1] ^= 0xff;
  assert.deepEqual(reader.push(bad), [], 'a wrong CRC: dropped');
  assert.equal(reader.push(a).length, 1, 'the next good frame is read');
  assert.throws(() => reader.push(bad) && reader.push(bad) && reader.push(bad), /framing lost/);
  const huge = new FrameReader();
  assert.throws(() => huge.push(Buffer.from([1, 1, 0x10, 0x00])), /announced/);
  const nack = new FrameReader().push(buildNack(4, 0x10));
  assert.deepEqual(nack, [{ sequence: 4, action: 6, nack: 0x10 }]);
});

test('decoding: a NULL or a sensor in error is unknown, never 0; a short frame leaves fields out', () => {
  assert.deepEqual(decode(2, 1, [0, 0, 0, 0]), {});
  assert.deepEqual(decode(5, 2, [0, 21 + 64, 3, 0, 0, 41, 4, 0]), {
    indoorTemperature: 21.5,
    indoorHumidity: 41,
    outdoorTemperatureStatus: 3,
    outdoorHumidityStatus: 4,
  });
  assert.deepEqual(decode(5, 2, [0, 22]), { indoorTemperature: 22 });
  assert.deepEqual(decode(5, 2, [0, 22, 0, 0, 0, 101]), {
    indoorTemperature: 22,
    outdoorTemperature: 0,
    outdoorTemperatureStatus: 0,
  });
  assert.equal(decode(9, 9, [1]), undefined);
});

test('the MAC address: 6 bytes, never all zero, all ones or multicast', () => {
  assert.equal(macOf([0x0a, 0x1b, 0x2c, 0x3d, 0x4e, 0x5f]), '0a1b2c3d4e5f');
  assert.equal(macOf([0, 0, 0, 0, 0, 0]), undefined);
  assert.equal(macOf([255, 255, 255, 255, 255, 255]), undefined);
  assert.equal(macOf([1, 0, 0x5e, 0, 0, 1]), undefined);
  assert.equal(macOf([1, 2, 3]), undefined);
});
