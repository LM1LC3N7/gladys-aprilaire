// -----------------------------------------------------------------------------
// A fake Aprilaire 8840 thermostat behind the injected `connect` (no network),
// built from pyaprilaire's mock server (MIT) and its packet maps: it answers
// READ_REQUESTs with READ_RESPONSEs echoing the sequence, applies WRITEs of
// the control values (a 0 byte is NULL, "unchanged"), NACKs what it does not
// know (0x07) and sends its own change messages (COS, sequence 128-255). It
// takes ONE connection at a time (a second one is refused and counted), and
// counts the connections open at once. Its timers are those of the test.
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';
import {
  FrameReader,
  buildFrame,
  buildNack,
  decodeTemperature,
  encodeTemperature,
} from '../../src/aprilaire/packet.js';

export const HOST = '192.168.1.40';
export const MAC = [0x0a, 0x1b, 0x2c, 0x3d, 0x4e, 0x5f];
export const MAC_HEX = '0a1b2c3d4e5f';
export const NOW = Date.UTC(2026, 9, 28, 10, 0, 0);

const t = (c) => encodeTemperature(c);

class FakeSocket extends EventEmitter {
  constructor(device) {
    super();
    this.device = device;
    this.destroyed = false;
    this.reader = new FrameReader();
  }

  write(bytes) {
    if (this.destroyed) throw new Error('write after destroy');
    this.device.receive(this, Buffer.from(bytes));
    return true;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    // Closed a moment later (`closeDelay` ms of the test timers): the
    // thermostat sees the connection gone only then.
    const close = () => {
      this.device.open.delete(this);
      this.emit('close');
    };
    if (this.device.closeDelay > 0) this.device.timers.setTimeout(close, this.device.closeDelay);
    else setImmediate(close);
  }

  setNoDelay() {}
}

export function fakeAprilaire({ timers, now } = {}) {
  const device = {
    timers,
    now,
    state: {
      mode: 2, // heat
      fan: 2, // auto
      heat: 20,
      cool: 25,
      scale: 1, // °C display
      modes: 6,
      indoor: 21.5,
      outdoor: -3,
      humidity: 41,
      outdoorHumidity: 70,
      heating: 2,
      cooling: 0,
      fanRunning: 1,
      dehumidificationStatus: 0,
      humidificationStatus: 2,
      ventilationStatus: 0,
      airCleaningStatus: 3,
      dehumidification: 55,
      humidification: 35,
      freshAirMode: 1,
      freshAirEvent: 0,
      airCleaningMode: 0,
      airCleaningEvent: 0,
      hold: 0,
      error: 0,
      mac: [...MAC],
      model: 7,
    },
    /** Latency of every answer (ms of the test timers), or a function of the request. */
    delay: 20,
    connectDelay: 5,
    closeDelay: 0,
    /** Writes are applied (false: ignored, as a thermostat that does not take them). */
    applyWrites: true,
    /** Change messages after a write. */
    cos: true,
    /** Nothing answered (a silent thermostat); `silentFor(request)` per request. */
    silent: false,
    silentFor: undefined,
    /** Refuses new connections. */
    down: false,
    /** NACK status by "domain/attribute" (reads) or "write" (the next write). */
    nack: {},
    /** Attributes it does not know (NACK 0x07). */
    unsupported: new Set(),
    open: new Set(),
    maxOpen: 0,
    connections: 0,
    refused: 0,
    connectAt: [],
    /** Every request received: { at, sequence, action, domain, attribute, data }. */
    log: [],
    cosSequence: 128,
    receive(socket, bytes) {
      let frames;
      try {
        frames = socket.reader.push(bytes);
      } catch {
        socket.destroy();
        return;
      }
      for (const frame of frames) {
        device.log.push({ at: device.now?.(), ...frame });
        const out = device.handle(frame);
        if (out.length === 0) continue;
        if (device.silent || device.silentFor?.(frame)) continue;
        const delay = typeof device.delay === 'function' ? device.delay(frame) : device.delay;
        timers.setTimeout(() => {
          if (!socket.destroyed) {
            for (const chunk of out) socket.emit('data', chunk);
          }
        }, delay);
      }
    },
    /** The answers to one request frame (Buffers). */
    handle(frame) {
      const { sequence, action, domain, attribute, data } = frame;
      const k = `${domain}/${attribute}`;
      if (action === 2) {
        if (device.nack[k] !== undefined) return [buildNack(sequence, device.nack[k])];
        if (device.unsupported.has(k)) return [buildNack(sequence, 0x07)];
        const payload = device.payload(k);
        if (!payload) return [buildNack(sequence, 0x07)];
        return [buildFrame(sequence, 3, domain, attribute, payload)];
      }
      if (action === 1) {
        if (device.nack.write !== undefined) {
          const status = device.nack.write;
          if (!device.nackSticky) delete device.nack.write;
          return [buildNack(sequence, status)];
        }
        if (k !== '2/1') return [buildNack(sequence, 0x07)];
        if (!device.applyWrites) return [];
        const s = device.state;
        if (data[0]) s.mode = data[0];
        if (data[1]) s.fan = data[1];
        if (data[2]) s.heat = decodeTemperature(data[2]);
        if (data[3]) s.cool = decodeTemperature(data[3]);
        device.applied = (device.applied ?? 0) + 1;
        if (!device.cos) return [];
        device.cosSequence = device.cosSequence >= 255 ? 128 : device.cosSequence + 1;
        return [buildFrame(device.cosSequence, 5, 2, 1, device.payload('2/1'))];
      }
      return [];
    },
    payload(k) {
      const s = device.state;
      switch (k) {
        case '1/1':
          return [0, 0, s.scale, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2];
        case '2/1':
          return [s.mode, s.fan, t(s.heat), t(s.cool)];
        case '2/3':
          return [s.dehumidification];
        case '2/4':
          return [s.humidification];
        case '2/5':
          return [s.freshAirMode, s.freshAirEvent];
        case '2/6':
          return [s.airCleaningMode, s.airCleaningEvent];
        case '2/7':
          return [s.modes, 1, 1, 1, 2];
        case '3/4':
          return [s.hold, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        case '5/2':
          return [0, t(s.indoor), 0, t(s.outdoor), 0, s.humidity, 0, s.outdoorHumidity];
        case '7/6':
          return [s.heating, s.cooling, 0, s.fanRunning];
        case '7/7':
          return [
            s.dehumidificationStatus,
            s.humidificationStatus,
            s.ventilationStatus,
            s.airCleaningStatus,
          ];
        case '7/8':
          return [s.error];
        case '8/1':
          return [66, 10, 2, 15, s.model, 14, 3];
        case '8/2':
          return [...s.mac, 0, 1];
        default:
          return undefined;
      }
    },
    /** A change message pushed by the thermostat (to every open connection). */
    push(domain, attribute) {
      device.cosSequence = device.cosSequence >= 255 ? 128 : device.cosSequence + 1;
      const frame = buildFrame(
        device.cosSequence,
        5,
        domain,
        attribute,
        device.payload(`${domain}/${attribute}`),
      );
      for (const socket of device.open) socket.emit('data', frame);
    },
    /** The thermostat closes every connection. */
    hangUp() {
      for (const socket of [...device.open]) socket.destroy();
    },
    connect() {
      const socket = new FakeSocket(device);
      device.connections += 1;
      device.connectAt.push(device.now?.());
      timers.setTimeout(() => {
        if (socket.destroyed) return;
        if (device.down || device.open.size > 0) {
          device.refused += 1;
          socket.emit('error', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }));
          return;
        }
        device.open.add(socket);
        device.maxOpen = Math.max(device.maxOpen, device.open.size);
        socket.emit('connect');
      }, device.connectDelay);
      return socket;
    },
    writes: () => device.log.filter((r) => r.action === 1),
    reads: (k) =>
      device.log.filter(
        (r) => r.action === 2 && (k === undefined || `${r.domain}/${r.attribute}` === k),
      ),
  };
  device.connectFn = () => device.connect();
  return device;
}
