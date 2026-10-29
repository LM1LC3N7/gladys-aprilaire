// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container), in one file readable by the container user only (0600):
//   aprilaire-state.json:
//     attemptAt  the time of the last connection attempt (written at most
//                once a minute, BEFORE the attempt): a restart never connects
//                sooner than the interval after it (unless a stop waits);
//     address    the thermostat of the configuration ("host:port"): a stop
//                kept below is sent there at a restart, before the
//                configuration is even read;
//     identity   the MAC address and model last read at that address;
//     stop       a stop (mode Off) not confirmed yet: when it was clicked,
//                whether and when it was written, how many times it was sent
//                again, the modes read after the click (the "modes of
//                before") and how many reads in a row showed another one. It
//                is held until a read shows Off, a newer mode command from
//                Gladys leaves, or another mode is read twice in a row (set
//                at the thermostat): never dropped by the time.
// No secret (the protocol has none), no personal data. Bounded and repaired
// when read. A file that cannot be read is not an empty one: `load()` says
// so, and the app then never overwrites it with a guess.
// -----------------------------------------------------------------------------

import { readFile, rename, writeFile } from 'node:fs/promises';
import { HVAC_MODE, TIMINGS } from './constants.js';

export const STATE_FILE = '/data/aprilaire-state.json';
export const MAX_BYTES = 16 * 1024;

export function fileStore(path = STATE_FILE) {
  // One write at a time: two saves never share the temporary file.
  let chain = Promise.resolve();
  return {
    /** `{ data }`, `{ data: null }` (no file) or `{ unreadable: true }`. */
    async load() {
      let text;
      try {
        text = await readFile(path, 'utf8');
      } catch (err) {
        return err?.code === 'ENOENT' ? { data: null } : { unreadable: true };
      }
      if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) return { unreadable: true };
      try {
        return { data: JSON.parse(text) };
      } catch {
        return { unreadable: true };
      }
    },
    save(data) {
      const text = JSON.stringify(data);
      const write = chain.then(async () => {
        const temporary = `${path}.tmp`;
        await writeFile(temporary, text, { mode: 0o600 });
        await rename(temporary, path);
      });
      chain = write.catch(() => {});
      return write;
    },
  };
}

/**
 * For the tests: the same JSON round trips as the file. `failing` refuses
 * every save, `unreadable` every load, `hang` keeps every save pending.
 */
export function memoryStore(initial = null, { failing = false, unreadable = false } = {}) {
  return {
    data: initial === null ? null : JSON.parse(JSON.stringify(initial)),
    saves: 0,
    failing,
    unreadable,
    hang: false,
    held: [],
    async load() {
      // `loadGate`: a promise the load waits for (a slow or frozen /data).
      if (this.loadGate) await this.loadGate;
      if (this.unreadable) return { unreadable: true };
      return { data: this.data === null ? null : JSON.parse(JSON.stringify(this.data)) };
    },
    save(data) {
      if (this.hang) {
        return new Promise((resolve, reject) => this.held.push({ data, resolve, reject }));
      }
      if (this.failing) {
        return Promise.reject(Object.assign(new Error('EROFS'), { code: 'EROFS' }));
      }
      this.data = JSON.parse(JSON.stringify(data));
      this.saves += 1;
      return Promise.resolve();
    },
  };
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (object, key) =>
  isObject(object) && Object.hasOwn(object, key) ? object[key] : undefined;
const ADDRESS = /^[a-z0-9.-]{1,253}:\d{1,5}$/;
const MAC = /^[0-9a-f]{12}$/;
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const MODES = Object.values(HVAC_MODE);

/**
 * The persisted state, repaired and bounded: only known keys of the expected
 * shape (never an inherited or `__proto__` key). A date in the future (a
 * clock set back) is invalid: an attempt counts as now, a stop's dates as
 * unknown (the stop itself is kept: it protects).
 */
export function normalizeMemory(raw, now) {
  const attemptAt = own(raw, 'attemptAt');
  const address = own(raw, 'address');
  const identity = own(raw, 'identity');
  const stop = own(raw, 'stop');
  const memory = {
    attemptAt: finite(attemptAt) && attemptAt > 0 ? Math.min(attemptAt, now) : 0,
    address: typeof address === 'string' && ADDRESS.test(address) ? address : undefined,
    identity: undefined,
    stop: undefined,
  };
  if (isObject(identity)) {
    const mac = own(identity, 'mac');
    const key = own(identity, 'address');
    const model = own(identity, 'model');
    if (typeof mac === 'string' && MAC.test(mac) && typeof key === 'string' && ADDRESS.test(key)) {
      memory.identity = {
        address: key,
        mac,
        model: Number.isInteger(model) && model >= 0 && model <= 255 ? model : undefined,
      };
    }
  }
  if (isObject(stop)) {
    // A stop clicked before any address was saved has none: kept all the same.
    const raw = own(stop, 'address');
    const key = typeof raw === 'string' && ADDRESS.test(raw) ? raw : undefined;
    const date = (v) => (finite(v) && v > 0 && v <= now ? v : undefined);
    const count = (v, max) => (Number.isInteger(v) && v >= 0 ? Math.min(v, max) : 0);
    const before = own(stop, 'before');
    memory.stop = {
      address: key,
      clickedAt: date(own(stop, 'clickedAt')),
      written: own(stop, 'written') === true,
      sentAt: date(own(stop, 'sentAt')),
      // An unreadable count is 0: the stop may be sent again (never less protection).
      reasserts: count(own(stop, 'reasserts'), TIMINGS.stopReasserts),
      others: count(own(stop, 'others'), TIMINGS.stopOtherReads - 1),
      before: Array.isArray(before)
        ? [...new Set(before.filter((m) => MODES.includes(m) && m !== HVAC_MODE.OFF))].slice(0, 4)
        : [],
    };
  }
  return memory;
}

/** The persisted form (plain objects of validated keys only). */
export function serializeMemory(memory) {
  const out = { attemptAt: memory.attemptAt };
  if (memory.address) out.address = memory.address;
  if (memory.identity) out.identity = { ...memory.identity };
  if (memory.stop) out.stop = { ...memory.stop, before: [...memory.stop.before] };
  return out;
}
