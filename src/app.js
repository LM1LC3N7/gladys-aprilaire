// -----------------------------------------------------------------------------
// The integration: the Aprilaire thermostat at the address of the
// configuration, ONE automation session with it (the thermostat takes one
// connection at a time), its Gladys device and states, the transport badge,
// the "Test the connection" button and the commands. index.js only wires the
// SDK handlers to it (src/handlers.js).
//
// The session ("the line"): one TCP connection, kept open; one request in
// flight on it, in order of priority: the stop, then the commands, then the
// checks of a stop, then the reads. A new connection opens only once the
// previous socket is closed. A lost or refused session is opened again after
// 30 s, 1, 2, 5, then 10 minutes (every minute at most while a stop waits):
// never a loop. A restart never connects sooner than the interval after the
// last attempt (kept in /data, written before the attempt), unless a stop
// waits.
//
// Reads: at each session, the MAC address (the identity), the model, the
// display scale and what the thermostat drives; then every interval the
// control values, the sensors, the equipment, humidity and air statuses,
// the hold and the error. A reconnection never reads sooner. Its own change
// messages (COS) refresh what is shown, never a decision. Nothing is shown
// before the MAC address is read in the session; a value not read this time
// is never published as new, nor a value older than 2 minutes.
//
// Commands (mode heating / cooling / auto, fan, heating and cooling
// setpoints):
//   - refused unless "Allow the commands" is on, checked on arrival and again
//     right before the write;
//   - setpoints within 4.5-32 °C (the manufacturer's 40-99 °F converted
//     exactly, within its 4-32 °C), on the value asked and on the byte written;
//   - decided on a read of the control values sent after the click, never on
//     the memory; refused when it fails; not written when already so (unless
//     a guard says a previous command may not show yet);
//   - only the field asked is written: the others are NULL ("unchanged");
//   - refused while a stop is held, except a new mode, which ends the stop
//     when it leaves (the stop lifted in /data first: /data not writable =
//     nothing sent);
//   - one at a time; confirmed only by a read back equal to the value asked
//     (a setpoint within 0.5 °C when the thermostat displays °F) and no NACK
//     of the write; else "sent, without confirmation", a guard (90 s) and
//     reads 5 s and 20 s later;
//   - answered by 4.3 s; a command waiting its turn goes on, 15 s at most
//     after the click; the ack never waits for a publication to Gladys.
// The stop (mode Off) protects: never held back by the option, the bounds, a
// command or read in progress, a failed read, a backoff, a thermostat never
// read, nor a configuration not read yet (after a restart, a stop kept in
// /data is sent before it). Every command that arrived before it and has not
// left is dropped. It leaves first: a read in flight that received nothing
// for 1.5 s is cut (a new session, the old one closed first). Written without
// a read first, then read back. A stop not confirmed is held (in /data, and
// in memory first: a slow /data never delays it): checked every 15 s for
// 3 minutes, then every minute; sent again while the thermostat shows the
// mode of before (three times at most per click; a write the thermostat
// answered "busy" does not count); it ends only when a read shows Off, when
// a newer mode command from Gladys leaves, or when another mode is read
// twice in a row (set at the thermostat): never by the time. A stop never
// sent is never given up.
//
// Times in memory (deadlines, guards, backoffs) are on a monotonic clock;
// the wall clock (`now`) only for /data.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { addressKey, normalizeConfig, parseAddress } from './config.js';
import {
  DOMAIN,
  FEATURES as F,
  HVAC_MODE,
  RETRYABLE_NACKS,
  SECOND,
  TEMPERATURE_SCALE,
  TIMINGS,
  UNSUPPORTED_NACKS,
} from './constants.js';
import {
  buildDevice,
  commandValue,
  deviceIds,
  deviceStates,
  gladysModeOf,
  macText,
  offers,
  parseDeviceId,
  parseFeatureId,
} from './devices.js';
import { ERRORS, T, age, join, modelName, word } from './i18n.js';
import { controlWrite } from './aprilaire/packet.js';
import {
  AprilaireError,
  ERROR_KINDS,
  errorReason,
  openSession,
  socketClosed,
  tcpConnect,
} from './aprilaire/session.js';
import { StatePublisher } from './publisher.js';
import { fileStore, normalizeMemory, serializeMemory } from './store.js';

/** A refusal: the message Gladys shows. */
class Refusal extends Error {}

const key = (domain, attribute) => `${domain}/${attribute}`;
const C1 = key(DOMAIN.CONTROL, 1);
const C3 = key(DOMAIN.CONTROL, 3);
const C4 = key(DOMAIN.CONTROL, 4);
const C5 = key(DOMAIN.CONTROL, 5);
const C6 = key(DOMAIN.CONTROL, 6);
const C7 = key(DOMAIN.CONTROL, 7);
const S2 = key(DOMAIN.SENSORS, 2);
const ST6 = key(DOMAIN.STATUS, 6);
const ST7 = key(DOMAIN.STATUS, 7);
const ST8 = key(DOMAIN.STATUS, 8);
const H4 = key(DOMAIN.SCHEDULING, 4);
const SETUP = key(DOMAIN.SETUP, 1);
const ID1 = key(DOMAIN.IDENTIFICATION, 1);

/** Read once per session, after the identity. */
const SESSION_READS = [
  [DOMAIN.IDENTIFICATION, 1],
  [DOMAIN.SETUP, 1],
  [DOMAIN.CONTROL, 7],
];
/** Read every interval: the first two are the main values, the others secondary. */
const POLL_READS = [
  [DOMAIN.CONTROL, 1],
  [DOMAIN.SENSORS, 2],
  [DOMAIN.STATUS, 6],
  [DOMAIN.STATUS, 7],
  [DOMAIN.CONTROL, 3],
  [DOMAIN.CONTROL, 4],
  [DOMAIN.CONTROL, 5],
  [DOMAIN.CONTROL, 6],
  [DOMAIN.SCHEDULING, 4],
  [DOMAIN.STATUS, 8],
];
const MAIN_READS = new Set([C1, S2]);

/** The attributes each feature is computed from. */
const SOURCES = {
  [F.TEMPERATURE]: [S2],
  [F.HUMIDITY]: [S2],
  [F.OUTDOOR]: [S2],
  [F.OUTDOOR_HUMIDITY]: [S2],
  [F.HEAT_SETPOINT]: [C1],
  [F.COOL_SETPOINT]: [C1],
  [F.MODE]: [C1],
  [F.FAN]: [C1],
  [F.FAN_RUNNING]: [ST6],
  [F.OPERATING_STATE]: [ST6],
  [F.HOLD]: [H4],
  [F.HUMIDIFIER]: [ST7, C4],
  [F.DEHUMIDIFIER]: [ST7, C3],
  [F.VENTILATION]: [ST7, C5],
  [F.AIR_CLEANER]: [ST7, C6],
  [F.ERROR]: [ST8],
};

const PRIORITY = { stop: 0, command: 1, check: 2, read: 3 };

const defaultTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h),
};

export class AprilaireApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'aprilaire' }),
    connect = tcpConnect,
    now = Date.now,
    monotonic = () => performance.now(),
    timers = defaultTimers,
    store = fileStore(),
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.connectFn = connect;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.store = store;
    this.publisher = new StatePublisher({ gladys, logger, now: monotonic, timers });
    this.config = normalizeConfig();
    this.configLoaded = false;
    this.latestAllow = undefined;
    this.memory = normalizeMemory(null, now());
    this.memoryLoaded = false;
    this.memoryUnreadable = false;
    this.generation = 0;
    this.started = false;
    this.lifecycle = Promise.resolve();
    this.configProblem = undefined;
    this.connectedRuns = 0;
    /** The connection to the thermostat of the configuration (or of the stop kept, at boot). */
    this.conn = undefined;
    /** The values read, by attribute: { values, at (monotonic) }. */
    this.attrs = new Map();
    /** What the thermostat showed at least once (features of the device). */
    this.shape = {};
    this.lastPollAt = undefined;
    this.pollTimer = undefined;
    this.lastReadError = undefined;
    this.followUps = new Set();
    /** The requests waiting for the line, by priority. */
    this.queue = [];
    this.running = undefined;
    /** The commands not answered yet, one at a time. */
    this.commandChain = Promise.resolve();
    this.commands = new Set();
    /** field -> { from, expected, moved, until }: a command sent, not seen yet. */
    this.guards = new Map();
    /** The stop held (one thermostat, one mode): see the header. */
    this.stopGuard = undefined;
    this.stopSending = false;
    this.stopWaiters = [];
    this.writeSeq = 0;
    this.lastStopSeq = 0;
    this.published = undefined;
    this.lastStatus = undefined;
    this.lastBadge = undefined;
    this.savedAttemptAt = undefined;
  }

  mono() {
    return this.monotonic();
  }

  // --- /data ---------------------------------------------------------------------

  /** Loads /data once; an unreadable file is never overwritten afterwards. */
  async loadMemory() {
    if (this.memoryLoaded) return;
    this.memoryLoaded = true;
    let loaded;
    try {
      loaded = await this.store.load();
    } catch {
      loaded = { unreadable: true };
    }
    if (loaded?.unreadable) {
      this.memoryUnreadable = true;
      this.logger.warn('Aprilaire: /data cannot be read: it is never overwritten');
      return;
    }
    this.memory = normalizeMemory(loaded?.data ?? null, this.now());
    this.savedAttemptAt = this.memory.attemptAt;
    const kept = this.memory.stop;
    if (kept) {
      // Held from before the restart: checked (and written when needed) at once.
      this.stopGuard = {
        address: kept.address,
        clickedAt: kept.clickedAt,
        since: this.mono(),
        mustWrite: !kept.written,
        written: kept.written,
        sentAt: undefined,
        reasserts: kept.reasserts,
        others: kept.others,
        before: [...kept.before],
        refused: undefined,
        timer: undefined,
      };
    }
  }

  /** Saves the memory; resolves false when /data refused it (or cannot be read). */
  async saveMemory({ withoutStop = false } = {}) {
    if (this.memoryUnreadable) return false;
    const g = withoutStop ? undefined : this.stopGuard;
    this.memory.stop = g
      ? {
          address: g.address,
          clickedAt: g.clickedAt,
          written: g.written,
          sentAt: g.sentWall,
          reasserts: g.reasserts,
          others: g.others,
          before: [...g.before],
        }
      : undefined;
    try {
      await this.store.save(serializeMemory(this.memory));
      return true;
    } catch (err) {
      this.logger.warn(`Aprilaire: saving to /data failed: ${err?.code ?? 'error'}`);
      return false;
    }
  }

  /** In the background: never awaited on the path of a stop. */
  persist() {
    this.saveMemory().catch(() => {});
  }

  /** A save awaited at most `ms` (false when slower or refused). */
  async saveWithin(ms, options) {
    let timer;
    const late = new Promise((resolve) => {
      timer = this.timers.setTimeout(() => resolve(false), ms);
    });
    const result = await Promise.race([this.saveMemory(options), late]);
    this.timers.clearTimeout(timer);
    return result;
  }

  // --- Lifecycle -------------------------------------------------------------------

  serialized(fn) {
    const run = this.lifecycle.then(fn, fn);
    this.lifecycle = run.catch(() => {});
    return run;
  }

  /**
   * Before Gladys and the configuration: a stop kept in /data is checked and
   * sent at once, to the address kept with it.
   */
  boot() {
    return this.serialized(async () => {
      await this.loadMemory();
      const g = this.stopGuard;
      if (!g || this.conn) return;
      const address = parseAddress(g.address);
      if (!address) return;
      this.logger.info('Aprilaire: a stop kept from before the restart is checked');
      this.openConn(address);
      this.armStopCheck(0);
    });
  }

  /** Commands turned off apply at once, before the queue; turning them on waits its turn. */
  disableAtOnce(raw) {
    this.latestAllow = normalizeConfig(raw).allowCommands;
    if (!this.latestAllow && this.config.allowCommands) {
      this.config = { ...this.config, allowCommands: false };
      this.logger.info('Aprilaire commands disabled');
    }
  }

  configOf(raw) {
    const config = normalizeConfig(raw);
    return this.latestAllow === false ? { ...config, allowCommands: false } : config;
  }

  /**
   * Connected to Gladys: the configuration is read, again and again (5 s,
   * 10 s, 30 s, then every minute) until it can be; meanwhile the status says
   * so and a stop kept still goes.
   */
  async onConnected(getConfig) {
    this.connectedRuns += 1;
    const run = this.connectedRuns;
    for (let attempt = 0; ; attempt += 1) {
      try {
        const raw = await getConfig();
        if (run !== this.connectedRuns) return;
        this.configProblem = undefined;
        await this.connected(raw);
        return;
      } catch (err) {
        if (run !== this.connectedRuns) return;
        const wait = TIMINGS.configRetry[Math.min(attempt, TIMINGS.configRetry.length - 1)];
        this.logger.warn(`Aprilaire: reading the configuration failed: ${err?.message ?? err}`);
        this.configProblem = T.configUnreadable(age(wait));
        await this.updateStatus();
        await new Promise((resolve) => this.timers.setTimeout(resolve, wait));
        if (run !== this.connectedRuns) return;
      }
    }
  }

  connected(raw = {}) {
    this.disableAtOnce(raw);
    return this.serialized(() => this.doConnected(raw));
  }

  configUpdated(raw = {}) {
    this.disableAtOnce(raw);
    return this.serialized(() => this.doConfigUpdated(raw));
  }

  async doConnected(raw) {
    await this.loadMemory();
    if (!this.started) {
      this.started = true;
      await this.doStart(raw);
      return;
    }
    if (normalizeConfig(raw).key !== this.config.key) {
      await this.doStart(raw);
      return;
    }
    const previous = this.config;
    this.config = this.configOf(raw);
    this.reschedulePoll(previous);
    // Gladys lost what it keeps in memory: status, Discovery, badge. Never a
    // read nor a state again (the next read publishes the values).
    this.published = undefined;
    this.lastStatus = undefined;
    this.lastBadge = undefined;
    this.gladys.forgetPublishedStates?.();
    await this.publishAll();
  }

  async doConfigUpdated(raw) {
    await this.loadMemory();
    if (normalizeConfig(raw).key !== this.config.key || !this.configLoaded) {
      await this.doStart(raw);
      return;
    }
    const previous = this.config;
    this.config = this.configOf(raw);
    if (this.config.allowCommands !== previous.allowCommands) {
      this.logger.info(`Aprilaire commands ${this.config.allowCommands ? 'allowed' : 'disabled'}`);
    }
    if (this.config.language !== previous.language) {
      this.published = undefined;
    }
    this.reschedulePoll(previous);
    await this.publishAll();
  }

  /** A new address (or the first configuration): a new session, the old one closed first. */
  async doStart(raw) {
    const previousKey = this.config.key;
    this.config = this.configOf(raw);
    this.configLoaded = true;
    this.publisher.start();
    const address = this.config.address;
    if (this.conn && this.conn.key !== this.config.key) {
      await this.dropConn();
    }
    if (address && this.memory.address !== this.config.key) {
      this.memory.address = this.config.key;
      this.persist();
    }
    if (this.stopGuard && address) {
      // The stop follows the thermostat of the configuration.
      this.stopGuard.address = this.config.key;
    }
    if (!address) {
      await this.publishAll();
      return;
    }
    if (!this.conn) {
      this.openConn(address);
      // The first connection: never sooner than the interval after the last
      // attempt (kept in /data, up to a minute old: then a minute at least),
      // unless a stop waits (its check, armed below, connects at once); a new
      // address connects at once.
      const exact = this.lastAttemptMono;
      let wait = 0;
      if (previousKey === undefined || previousKey === this.config.key) {
        if (exact !== undefined) {
          wait = Math.max(0, exact + this.interval - this.mono());
        } else if (this.memory.attemptAt > 0) {
          const since = this.now() - this.memory.attemptAt;
          wait = Math.max(0, Math.max(this.interval, TIMINGS.attemptSave) - since);
        }
      }
      this.conn.firstWaitUntil = this.mono() + wait;
      this.scheduleConnect(wait);
    }
    if (this.stopGuard) this.armStopCheck(0);
    await this.publishAll();
  }

  get interval() {
    return this.config.pollInterval * SECOND;
  }

  /** Stops everything (the session closed); resolves once the socket is closed. */
  async stop() {
    this.generation += 1;
    this.connectedRuns += 1;
    this.publisher.stop();
    this.clearPoll();
    for (const handle of this.followUps) this.timers.clearTimeout(handle);
    this.followUps.clear();
    if (this.stopGuard?.timer) {
      this.timers.clearTimeout(this.stopGuard.timer);
      this.stopGuard.timer = undefined;
    }
    await this.dropConn();
  }

  /** The container stops: what /data keeps is written, then everything stops. */
  async shutdown() {
    await this.saveWithin(2 * SECOND);
    await this.stop();
  }

  // --- The connection ----------------------------------------------------------------

  openConn(address) {
    this.conn = {
      address,
      key: addressKey(address),
      session: undefined,
      opening: undefined,
      closing: Promise.resolve(),
      failures: 0,
      timer: undefined,
      nextAt: undefined,
      lastAttemptAt: undefined,
      firstWaitUntil: undefined,
      error: undefined,
      identity: undefined,
      otherMac: undefined,
      unsupported: new Set(),
    };
    this.attrs.clear();
    return this.conn;
  }

  async dropConn() {
    const conn = this.conn;
    if (!conn) return;
    this.conn = undefined;
    if (conn.timer) this.timers.clearTimeout(conn.timer);
    conn.timer = undefined;
    conn.dropped = true;
    conn.opening?.abort();
    const closing = [conn.closing];
    if (conn.opening?.socket) closing.push(socketClosed(conn.opening.socket, this.timers));
    if (conn.session) closing.push(conn.session.close());
    this.rejectQueue(new AprilaireError(ERROR_KINDS.CLOSED, 'session ended'));
    await Promise.all(closing);
    this.attrs.clear();
  }

  scheduleConnect(delay) {
    const conn = this.conn;
    if (!conn || conn.session || conn.opening) return;
    if (conn.timer) this.timers.clearTimeout(conn.timer);
    conn.nextAt = this.mono() + delay;
    conn.timer = this.timers.setTimeout(() => {
      conn.timer = undefined;
      this.connectNow(conn).catch((err) => this.logger.warn(`Aprilaire: ${err.message}`));
    }, delay);
  }

  /** The delay before the next attempt after `failures` failures (a stop held: see runCheck). */
  backoff(conn) {
    const list = TIMINGS.backoff;
    return list[Math.min(Math.max(conn.failures - 1, 0), list.length - 1)];
  }

  /** The time of the attempt in /data (at most once a minute), before the attempt. */
  async noteAttempt() {
    const at = this.now();
    this.lastAttemptMono = this.mono();
    this.memory.attemptAt = at;
    if (
      this.savedAttemptAt === undefined ||
      at - this.savedAttemptAt >= TIMINGS.attemptSave ||
      at < this.savedAttemptAt
    ) {
      if (await this.saveWithin(SECOND)) this.savedAttemptAt = at;
    }
  }

  async connectNow(conn) {
    // One socket at a time: the previous one closed first (then checked: a
    // session may have opened meanwhile, from another call).
    await conn.closing;
    if (conn !== this.conn || conn.session || conn.opening) return;
    if (conn.timer) {
      this.timers.clearTimeout(conn.timer);
      conn.timer = undefined;
    }
    conn.lastAttemptAt = this.mono();
    conn.nextAt = undefined;
    let session;
    const opening = openSession({
      connect: this.connectFn,
      host: conn.address.host,
      port: conn.address.port,
      timers: this.timers,
      monotonic: this.monotonic,
      onCos: (domain, attribute, values) => this.onCos(conn, domain, attribute, values),
      onClose: (err) => this.onSessionClose(conn, session, err),
    });
    conn.opening = opening;
    this.noteAttempt().catch(() => {});
    this.updateStatus().catch(() => {});
    try {
      session = await opening.promise;
    } catch (err) {
      if (conn.opening === opening) conn.opening = undefined;
      if (opening.socket) conn.closing = socketClosed(opening.socket, this.timers);
      if (conn !== this.conn || err.kind === ERROR_KINDS.ABORTED) return;
      conn.failures += 1;
      conn.error = err;
      this.logger.warn(`Aprilaire: no session with ${conn.key} (${errorReason(err)})`);
      // A stop to write, just clicked or just cut its way: tried again every
      // second for 10 s (the thermostat may still hold the old connection).
      const urgent = this.stopGuard?.mustWrite && this.mono() < (conn.urgentUntil ?? -Infinity);
      this.scheduleConnect(urgent ? TIMINGS.stopConnectRetry : this.backoff(conn));
      await this.updateStatus();
      return;
    }
    conn.opening = undefined;
    if (conn !== this.conn) {
      await session.close();
      return;
    }
    if (!session.open) {
      // Closed as soon as opened: a failure like any other.
      conn.closing = session.closedPromise;
      conn.failures += 1;
      conn.error = new AprilaireError(ERROR_KINDS.CLOSED, 'closed at once');
      this.scheduleConnect(this.backoff(conn));
      await this.updateStatus();
      return;
    }
    conn.session = session;
    conn.closing = session.closedPromise;
    conn.identity = undefined;
    conn.unsupported = new Set();
    conn.error = undefined;
    this.logger.info(`Aprilaire: session open with ${conn.key}`);
    // The stop first (queued before anything else), then the identity.
    if (this.stopGuard?.mustWrite) {
      this.sendStop('click').catch((err) => this.logger.warn(`Aprilaire: stop: ${err.message}`));
    } else if (this.stopGuard) {
      this.armStopCheck(0);
    }
    this.pump();
    this.hello(conn, session).catch((err) => this.logger.warn(`Aprilaire: ${err.message}`));
    await this.updateStatus();
  }

  onSessionClose(conn, session, err) {
    if (conn.session !== session) return;
    conn.session = undefined;
    conn.identity = undefined;
    this.rejectQueue(new AprilaireError(ERROR_KINDS.CLOSED, 'session ended'));
    if (conn !== this.conn || conn.dropped) return;
    if (err?.kind === ERROR_KINDS.ABORTED && conn.cutForStop) {
      // Cut by a stop waiting: open again at once (not a failure).
      conn.cutForStop = false;
      this.scheduleConnect(0);
    } else {
      conn.failures += 1;
      conn.error = err;
      this.logger.warn(`Aprilaire: session with ${conn.key} lost (${errorReason(err)})`);
      this.scheduleConnect(this.backoff(conn));
    }
    this.publishAll().catch(() => {});
  }

  // --- The line: one request at a time, by priority ------------------------------------

  /**
   * A request on the session, when its turn comes. Rejected (nothing sent)
   * when no session is open, or when its turn comes on a session ended. `beforeSend` runs right before the bytes.
   */
  line(request, priority, session = this.conn?.session) {
    if (!session) {
      return Promise.reject(new AprilaireError(ERROR_KINDS.CLOSED, 'no session'));
    }
    return new Promise((resolve, reject) => {
      const item = { request, priority, session, resolve, reject };
      const at = this.queue.findIndex((q) => q.priority > priority);
      if (at < 0) this.queue.push(item);
      else this.queue.splice(at, 0, item);
      if (priority === PRIORITY.stop) this.cutIfStuck();
      this.pump();
    });
  }

  pump() {
    if (this.running || this.queue.length === 0) return;
    // A request of a session ended is refused by that session (nothing sent).
    const item = this.queue.shift();
    this.running = item;
    item.session
      .request(item.request)
      .then(item.resolve, item.reject)
      .finally(() => {
        if (this.running === item) this.running = undefined;
        this.pump();
      });
  }

  rejectQueue(err) {
    const queue = this.queue;
    this.queue = [];
    for (const item of queue) item.reject(err);
  }

  /** A stop waits behind a request that received nothing for 1.5 s: the session is cut. */
  cutIfStuck() {
    const conn = this.conn;
    const session = conn?.session;
    if (!session || !this.running || this.running.priority === PRIORITY.stop) return;
    if (session.stuckFor(TIMINGS.stuckRead)) {
      this.logger.warn('Aprilaire: a request in flight is silent: cut for the stop');
      conn.cutForStop = true;
      conn.urgentUntil = this.mono() + TIMINGS.stopUrgent;
      session.close();
      return;
    }
    // Checked again once it has been silent long enough.
    const wait = Math.max(
      1,
      TIMINGS.stuckRead - (this.mono() - Math.max(this.running.session.lastByteAt, 0)),
    );
    this.timers.setTimeout(() => {
      if (this.queue.some((q) => q.priority === PRIORITY.stop)) this.cutIfStuck();
    }, wait);
  }

  // --- Reads ---------------------------------------------------------------------------

  /** One read; NACKed "unsupported": never asked again this session. */
  async read(conn, session, [domain, attribute], priority = PRIORITY.read, options = {}) {
    if (conn.unsupported.has(key(domain, attribute))) {
      return undefined;
    }
    try {
      return await this.line({ kind: 'read', domain, attribute, ...options }, priority, session);
    } catch (err) {
      if (err?.kind === ERROR_KINDS.NACK && UNSUPPORTED_NACKS.has(err.status)) {
        conn.unsupported.add(key(domain, attribute));
        return undefined;
      }
      throw err;
    }
  }

  /** At each session: the identity first, then what does not change. */
  async hello(conn, session) {
    let ident;
    try {
      ident = await this.read(conn, session, [DOMAIN.IDENTIFICATION, 2]);
    } catch (err) {
      this.lastReadError = err;
      await this.updateStatus();
      return;
    }
    if (conn !== this.conn || conn.session !== session) return;
    if (!ident?.mac) {
      this.logger.warn('Aprilaire: the MAC address could not be read');
      await this.updateStatus();
      return;
    }
    const known = this.memory.identity;
    conn.otherMac =
      known && known.address === conn.key && known.mac !== ident.mac ? ident.mac : undefined;
    if (conn.otherMac) {
      this.logger.warn(`Aprilaire: another thermostat answers at ${conn.key}`);
    }
    if (this.shapeMac !== ident.mac) {
      // Another thermostat: nothing of the previous one is shown for it.
      this.attrs.clear();
      this.shape = {};
      this.shapeMac = ident.mac;
    }
    conn.identity = { mac: ident.mac, model: known?.mac === ident.mac ? known.model : undefined };
    conn.failures = 0;
    for (const read of SESSION_READS) {
      try {
        const values = await this.read(conn, session, read);
        if (values) this.keep(key(...read), values);
      } catch {
        // Secondary: never blocks the values.
      }
      if (conn.session !== session) return;
    }
    await this.updateStatus();
    const model = this.attrs.get(ID1)?.values.model;
    if (model !== undefined) conn.identity.model = model;
    if (
      known?.mac !== ident.mac ||
      known?.address !== conn.key ||
      (model !== undefined && known?.model !== model)
    ) {
      this.memory.identity = { address: conn.key, mac: ident.mac, model: conn.identity.model };
      this.persist();
    }
    // The values: never sooner than the interval after the last poll.
    const due = this.lastPollAt === undefined ? 0 : this.lastPollAt + this.interval - this.mono();
    this.schedulePoll(Math.max(0, due));
  }

  clearPoll() {
    if (this.pollTimer) this.timers.clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
  }

  schedulePoll(delay) {
    this.clearPoll();
    this.pollTimer = this.timers.setTimeout(() => {
      this.pollTimer = undefined;
      this.poll().catch((err) => this.logger.warn(`Aprilaire: read failed: ${err.message}`));
    }, delay);
  }

  /** A new interval: the next poll moves, counted from the last one (never sooner than it). */
  reschedulePoll(previous) {
    if (previous.pollInterval === this.config.pollInterval || !this.pollTimer) return;
    const due = (this.lastPollAt ?? this.mono()) + this.interval - this.mono();
    this.schedulePoll(Math.max(0, due));
  }

  /** One read of the values, then the next one an interval later. */
  async poll() {
    const conn = this.conn;
    const session = conn?.session;
    this.lastPollAt = this.mono();
    this.schedulePoll(this.interval);
    if (!session || !conn.identity) {
      if (session) await this.hello(conn, session);
      return;
    }
    await this.readValues(conn, session, POLL_READS, PRIORITY.read);
  }

  /** Reads `list` and publishes what was read; the main reads failing is the read failing. */
  async readValues(conn, session, list, priority) {
    const read = [];
    let failure;
    for (const entry of list) {
      if (conn.session !== session) break;
      const startedAt = this.mono();
      try {
        const values = await this.read(conn, session, entry, priority);
        if (values) {
          const k = key(...entry);
          this.keep(k, values, startedAt);
          read.push(k);
          if (k === C1) this.observe(values, startedAt);
          // Shown as they come: a slow secondary read never delays the main values.
          if (conn === this.conn && conn.identity) {
            this.publishValues([k]);
            if (k === S2 || entry === list.at(-1)) await this.publishDevices();
          }
        }
      } catch (err) {
        if (MAIN_READS.has(key(...entry))) failure = err;
        if (err?.kind === ERROR_KINDS.CLOSED) break;
      }
    }
    this.lastReadError = failure;
    if (read.length > 0 && conn === this.conn && conn.identity) {
      await this.publishAll();
    } else {
      await this.updateStatus();
    }
  }

  /** Values read for an attribute (replacing those of before: a field not read is gone). */
  keep(attr, values, at = this.mono()) {
    this.attrs.set(attr, { values, at });
    const s = this.shape;
    if (attr === S2) {
      s.humidity ||= values.indoorHumidity !== undefined;
      s.outdoor ||= values.outdoorTemperature !== undefined;
      s.outdoorHumidity ||= values.outdoorHumidity !== undefined;
    } else if (attr === C7) {
      s.modes = values.modes;
      s.humidifier ||= values.humidificationAvailable === 1 || values.humidificationAvailable === 2;
      s.dehumidifier ||= values.dehumidificationAvailable === 1;
      s.ventilation ||= values.ventilationAvailable === 1;
      s.airCleaner ||= values.airCleaningAvailable === 1;
    }
  }

  /** The values read within TIMINGS.freshFor, merged. */
  freshValues() {
    const merged = {};
    const mono = this.mono();
    for (const { values, at } of this.attrs.values()) {
      if (mono - at <= TIMINGS.freshFor) Object.assign(merged, values);
    }
    return merged;
  }

  /** The thermostat's own messages: shown, never a decision. */
  onCos(conn, domain, attribute, values) {
    if (conn !== this.conn || !conn.identity) return;
    const attr = key(domain, attribute);
    if (!Object.values(SOURCES).some((list) => list.includes(attr))) return;
    // pyaprilaire: a change to Off may come incomplete; the next read shows it.
    if (attr === C1 && values.mode === HVAC_MODE.OFF) return;
    this.keep(attr, values);
    this.publishValues([attr]);
    this.flush();
  }

  /** The states of the features computed from the attributes just read. */
  publishValues(read, extra = new Set()) {
    const conn = this.conn;
    if (!conn?.identity) return;
    const ids = deviceIds(this.gladys, conn.identity.mac);
    const created = this.createdFeatures(ids.device);
    for (const id of extra) created.add(id);
    const states = deviceStates(ids, this.freshValues(), created, this.config.language);
    for (const { device_feature_external_id: id, ...value } of states) {
      const featureKey = id.slice(ids.device.length + 1);
      const sources = SOURCES[featureKey] ?? [];
      if (!sources.some((s) => read.includes(s))) continue;
      const at = Math.max(...sources.map((s) => this.attrs.get(s)?.at ?? -Infinity));
      this.publisher.push(id, value, Number.isFinite(at) ? at : this.mono());
    }
  }

  createdDevice(external) {
    return (this.gladys.devices ?? []).find((d) => d.external_id === external);
  }

  createdFeatures(external) {
    const device = this.createdDevice(external);
    return new Set((device?.features ?? []).map((f) => f.external_id));
  }

  // --- Publication -------------------------------------------------------------------

  async publishAll() {
    await this.publishDevices();
    this.flush();
    await this.publishBadge();
    await this.updateStatus();
  }

  flush() {
    this.publisher
      .flush()
      .catch((err) => this.logger.warn(`Aprilaire: sending to Gladys failed: ${err.message}`));
  }

  buildDevices() {
    const ident = this.conn?.identity;
    if (!ident || !this.attrs.has(C1)) return [];
    const id1 = this.attrs.get(ID1)?.values;
    return [
      buildDevice(
        this.gladys,
        { mac: ident.mac, model: ident.model, firmware: id1?.firmware, shape: this.shape },
        {
          language: this.config.language,
          created: this.createdDevice(deviceIds(this.gladys, ident.mac).device),
        },
      ),
    ];
  }

  async publishDevices(force = false) {
    const devices = this.buildDevices();
    if (devices.length === 0) return;
    const json = JSON.stringify(devices);
    if (!force && json === this.published) return;
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.published = json;
    } catch (err) {
      this.logger.warn(`Aprilaire: publishing the discovered device failed: ${err.message}`);
    }
  }

  online() {
    const conn = this.conn;
    const c1 = this.attrs.get(C1);
    return Boolean(
      conn?.session?.open &&
      conn.identity &&
      c1 &&
      this.mono() - c1.at <= Math.max(3 * this.interval, TIMINGS.freshFor),
    );
  }

  async publishBadge() {
    const ident = this.conn?.identity;
    const devices = (this.gladys.devices ?? []).filter((d) => parseDeviceId(d.external_id));
    if (devices.length === 0) return;
    const entries = devices.map((d) => ({
      external_id: d.external_id,
      transport:
        ident && parseDeviceId(d.external_id) === ident.mac && this.online()
          ? DEVICE_TRANSPORTS.LOCAL
          : DEVICE_TRANSPORTS.UNREACHABLE,
    }));
    const json = JSON.stringify(entries);
    if (json === this.lastBadge) return;
    try {
      await this.gladys.publishTransports(entries);
      this.lastBadge = json;
    } catch (err) {
      this.logger.warn(`Aprilaire: publishTransports failed: ${err.message}`);
    }
  }

  /** [connected, { en, fr }] */
  statusText() {
    const parts = [];
    let connected = false;
    if (this.memoryUnreadable) parts.push(T.dataUnreadable);
    if (this.configProblem) parts.push(this.configProblem);
    const conn = this.conn;
    if (!this.configLoaded) {
      // Nothing more to say before the configuration (a boot stop aside).
    } else if (!this.config.address) {
      parts.push(this.config.invalidAddress ? T.invalid(this.config.invalidAddress) : T.noAddress);
    } else if (conn?.session) {
      if (!conn.identity) {
        parts.push(T.identifying);
      } else {
        connected = this.online();
        const model = modelName(conn.identity.model);
        const mac = macText(conn.identity.mac);
        const c1 = this.attrs.get(C1);
        parts.push(
          c1 ? T.connected(model, mac, age(this.mono() - c1.at)) : T.connectedNoRead(model, mac),
        );
        if (conn.otherMac) parts.push(T.otherThermostat(mac));
        if (this.lastReadError) parts.push(T.readFailed(errorReason(this.lastReadError)));
      }
    } else if (conn?.opening) {
      parts.push(T.connecting(conn.key));
    } else if (conn?.error) {
      const wait = Math.max(0, (conn.nextAt ?? this.mono()) - this.mono());
      parts.push(T.unreachable(conn.key, errorReason(conn.error), age(wait)));
    } else if (conn?.nextAt !== undefined) {
      parts.push(T.waiting(age(Math.max(0, conn.nextAt - this.mono()))));
    }
    const g = this.stopGuard;
    if (g) {
      if (g.refused !== undefined) parts.push(T.stopRefused(g.refused));
      if (!g.written || g.mustWrite) parts.push(T.stopNotSent);
      else if (g.reasserts >= TIMINGS.stopReasserts) parts.push(T.stopGivenUp(g.reasserts + 1));
      else parts.push(T.stopUnconfirmed(g.reasserts + 1));
    }
    return [connected, join(...parts)];
  }

  async updateStatus() {
    const [connected, message] = this.statusText();
    const json = JSON.stringify([connected, message]);
    if (json === this.lastStatus) return;
    this.lastStatus = json;
    try {
      await this.gladys.setConnectionStatus(connected, message);
    } catch (err) {
      this.logger.warn(`Aprilaire: setConnectionStatus failed: ${err.message}`);
    }
  }

  // --- Gladys events -----------------------------------------------------------------

  async scan() {
    await this.publishDevices(true);
    await this.updateStatus();
  }

  /**
   * A device created or updated: the values read within the last 2 minutes
   * are published (dated by their read: the publisher drops older ones).
   */
  async deviceCreated(device) {
    if (!parseDeviceId(device?.external_id)) return;
    this.gladys.forgetPublishedStates?.(device.external_id);
    this.lastBadge = undefined;
    const extra = new Set((device.features ?? []).map((f) => f?.external_id));
    this.publishValues([...this.attrs.keys()], extra);
    this.flush();
    await this.publishBadge();
  }

  async deviceDeleted(device) {
    if (!parseDeviceId(device?.external_id)) return;
    this.publisher.forget(device.external_id);
    this.lastBadge = undefined;
  }

  /**
   * "Test the connection": the status, and a connection attempt when none
   * is open nor due within the interval (never sooner than it after the
   * last one). Answered within 25 s.
   */
  async testConnection() {
    const conn = this.conn;
    if (conn && !conn.session && !conn.opening) {
      const since = conn.lastAttemptAt === undefined ? Infinity : this.mono() - conn.lastAttemptAt;
      const firstWait = (conn.firstWaitUntil ?? -Infinity) - this.mono();
      if (since >= this.interval && firstWait <= 0) {
        let timer;
        await Promise.race([
          this.connectNow(conn).then(() =>
            conn.session ? this.waitIdentity(conn, TIMINGS.testAnswerBy) : undefined,
          ),
          new Promise((resolve) => {
            timer = this.timers.setTimeout(resolve, TIMINGS.testAnswerBy);
          }),
        ]);
        this.timers.clearTimeout(timer);
      } else {
        const wait = Math.max(this.interval - since, firstWait, 0);
        return word(join(T.test.later(age(wait)), this.statusText()[1]), this.config.language);
      }
    }
    return word(this.statusText()[1], this.config.language);
  }

  async waitIdentity(conn, ms) {
    const until = this.mono() + ms;
    while (conn.session && !conn.identity && this.mono() < until) {
      await new Promise((resolve) => this.timers.setTimeout(resolve, 100));
    }
  }

  // --- Commands ------------------------------------------------------------------------

  refusal(text) {
    return new Refusal(word(text, this.config.language));
  }

  async setValue(_device, feature, value) {
    const received = this.mono();
    const target = parseFeatureId(feature?.external_id);
    if (!target) {
      throw this.refusal(ERRORS.readOnly);
    }
    const change = commandValue(target.key, value);
    if (change === undefined) {
      throw this.refusal(
        [F.HEAT_SETPOINT, F.COOL_SETPOINT, F.MODE, F.FAN].includes(target.key)
          ? ERRORS.badValue
          : ERRORS.readOnly,
      );
    }
    if (change.field === 'mode' && change.value === HVAC_MODE.OFF) {
      return this.protect(received);
    }
    if (change.outOfRange) {
      throw this.refusal(ERRORS.outOfRange);
    }
    if (!this.config.allowCommands) {
      throw this.refusal(ERRORS.disabled);
    }
    const conn = this.conn;
    if (!conn?.session || !conn.identity) {
      throw this.refusal(ERRORS.notConnected);
    }
    if (conn.identity.mac !== target.mac) {
      throw this.refusal(ERRORS.unknownDevice);
    }
    if (this.stopGuard && change.field !== 'mode') {
      throw this.refusal(ERRORS.stopHeld);
    }
    const entry = { change, mac: target.mac, received, cancelled: false, written: false };
    this.commands.add(entry);
    const run = this.commandChain.then(() => this.command(entry));
    this.commandChain = run.catch(() => {});
    run.finally(() => this.commands.delete(entry)).catch(() => {});
    let timer;
    const late = new Promise((resolve) => {
      timer = this.timers.setTimeout(
        () => resolve('late'),
        Math.max(0, received + TIMINGS.commandAnswerBy - this.mono()),
      );
    });
    const outcome = await Promise.race([run.then(() => 'done'), late]);
    this.timers.clearTimeout(timer);
    if (outcome === 'late') {
      run.catch((err) => this.logger.warn(`Aprilaire: command: ${err.message}`));
      throw this.refusal(
        entry.written
          ? ERRORS.sentUnconfirmed(ERRORS.noAnswerYet[this.config.language])
          : ERRORS.queued,
      );
    }
    return undefined;
  }

  /** One command: a fresh read, the write of the field asked, the read back. */
  async command(entry) {
    const { change } = entry;
    const sendBy = entry.received + TIMINGS.commandSendBy;
    const generation = this.generation;
    const conn = this.conn;
    const session = conn?.session;
    const check = () => {
      if (entry.cancelled) throw this.refusal(ERRORS.cancelled);
      if (!this.config.allowCommands) throw this.refusal(ERRORS.disabled);
      if (generation !== this.generation || conn !== this.conn) {
        throw this.refusal(ERRORS.configChanged);
      }
      if (this.mono() > sendBy) throw this.refusal(ERRORS.tooSlow);
      if (conn.session !== session || conn.identity?.mac !== entry.mac) {
        throw this.refusal(ERRORS.notConnected);
      }
    };
    if (!conn || !session) throw this.refusal(ERRORS.notConnected);
    check();
    // The state now: a read sent after the click.
    let current;
    const readStartedAt = this.mono();
    try {
      current = await this.line(
        { kind: 'read', domain: DOMAIN.CONTROL, attribute: 1, beforeSend: check },
        PRIORITY.command,
        session,
      );
    } catch (err) {
      if (err instanceof Refusal) throw err;
      throw this.refusal(ERRORS.unknownState(errorReason(err)));
    }
    this.keep(C1, current, readStartedAt);
    this.observe(current, readStartedAt);
    const plan = this.plan(change, current);
    if (!plan) {
      // Already so: nothing sent.
      return;
    }
    const data = controlWrite({ [change.field]: change.value });
    if (!data) throw this.refusal(ERRORS.outOfRange);
    let heldStop;
    if (change.field === 'mode' && this.stopGuard) {
      // A new mode ends the stop held: lifted in /data before it leaves, so
      // that a restart never sends the stop again over it.
      heldStop = this.stopGuard;
      const saved = await this.saveWithin(SECOND, { withoutStop: true });
      if (!saved || this.stopGuard !== heldStop) {
        this.persist();
        throw this.refusal(saved ? ERRORS.cancelled : ERRORS.storage);
      }
    }
    let written;
    try {
      written = await this.line(
        {
          kind: 'write',
          domain: DOMAIN.CONTROL,
          attribute: 1,
          data,
          beforeSend: () => {
            check();
            if (heldStop ? this.stopGuard !== heldStop : this.stopGuard) {
              throw this.refusal(ERRORS.stopHeld);
            }
            if (heldStop) this.dropStopGuard({ persist: false });
            this.writeSeq += 1;
            entry.sentSeq = this.writeSeq;
            entry.written = true;
          },
        },
        PRIORITY.command,
        session,
      );
    } catch (err) {
      if (heldStop && this.stopGuard === heldStop) this.persist();
      if (err instanceof Refusal) throw err;
      if (!entry.written) throw this.refusal(ERRORS.notSent(errorReason(err)));
      this.unconfirmed(plan);
      throw this.refusal(ERRORS.sentUnconfirmed(errorReason(err)));
    }
    this.logger.info(`Aprilaire: ${change.field} -> sent`);
    let back;
    const backStartedAt = this.mono();
    try {
      back = await this.line(
        { kind: 'read', domain: DOMAIN.CONTROL, attribute: 1 },
        PRIORITY.command,
        session,
      );
    } catch (err) {
      this.unconfirmed(plan);
      throw this.refusal(ERRORS.sentUnconfirmed(errorReason(err)));
    }
    this.keep(C1, back, backStartedAt);
    this.observe(back, backStartedAt);
    this.publishValues([C1]);
    this.flush();
    const nack = session.nackOf(written.sequence);
    if (nack !== undefined) {
      const reason = `NACK 0x${nack.toString(16).padStart(2, '0')}`;
      throw this.refusal(ERRORS.refused(reason));
    }
    if (this.lastStopSeq > entry.sentSeq) {
      throw this.refusal(ERRORS.superseded);
    }
    if (!this.confirms(plan, back)) {
      this.unconfirmed(plan);
      throw this.refusal(
        ERRORS.sentUnconfirmed(word(ERRORS.readBackDiffers, this.config.language)),
      );
    }
    this.guards.delete(plan.field);
  }

  /**
   * What to write: { field, expected, from }, or null when the thermostat
   * already shows it and no guard says a previous command may change it.
   */
  plan(change, current) {
    const { field, value } = change;
    if (current[field] === undefined) {
      throw this.refusal(ERRORS.unknownState(field));
    }
    const can = offers(this.attrs.get(C7)?.values.modes);
    if (field === 'mode') {
      const name = { [HVAC_MODE.HEAT]: 'heat', [HVAC_MODE.COOL]: 'cool', [HVAC_MODE.AUTO]: 'auto' }[
        value
      ];
      if (!can[name]) throw this.refusal(ERRORS.modeUnavailable);
      // A stop held: the new mode is always written (it ends the stop).
      if (
        gladysModeOf(current.mode) === gladysModeOf(value) &&
        !this.guardActive('mode') &&
        !this.stopGuard
      ) {
        return null;
      }
    } else if (field === 'heat' || field === 'cool') {
      if (!(field === 'heat' ? can.heat : can.cool)) throw this.refusal(ERRORS.modeUnavailable);
      if (current[field] === value && !this.guardActive(field)) return null;
    } else if (current[field] === value && !this.guardActive(field)) {
      return null;
    }
    return { field, expected: value, from: current[field] };
  }

  /**
   * The read back confirms: the value asked (a mode by its Gladys meaning; a
   * setpoint within 0.5 °C when the display is not °C: the thermostat keeps
   * whole °F), never the value of before.
   */
  confirms(plan, back) {
    const got = back[plan.field];
    if (got === undefined) return false;
    if (plan.field === 'mode') {
      return (
        gladysModeOf(got) === gladysModeOf(plan.expected) &&
        (got !== plan.from || plan.from === plan.expected)
      );
    }
    if (plan.field === 'heat' || plan.field === 'cool') {
      if (got === plan.expected) return true;
      const scale = this.attrs.get(SETUP)?.values.scale;
      return (
        scale !== TEMPERATURE_SCALE.CELSIUS &&
        got !== plan.from &&
        Math.abs(got - plan.expected) <= 0.5
      );
    }
    return got === plan.expected;
  }

  unconfirmed(plan) {
    this.guards.set(plan.field, {
      from: plan.from,
      expected: plan.expected,
      until: this.mono() + TIMINGS.guard,
    });
    this.followUp();
  }

  guardActive(field) {
    const guard = this.guards.get(field);
    if (guard && this.mono() >= guard.until) {
      this.guards.delete(field);
      return false;
    }
    return Boolean(guard);
  }

  /** Reads after a command or a stop: its effect, then a check (one series at a time). */
  followUp() {
    for (const handle of this.followUps) this.timers.clearTimeout(handle);
    this.followUps.clear();
    const generation = this.generation;
    for (const delay of TIMINGS.followUps) {
      const handle = this.timers.setTimeout(() => {
        this.followUps.delete(handle);
        const conn = this.conn;
        if (generation !== this.generation || !conn?.session || !conn.identity) return;
        this.readValues(
          conn,
          conn.session,
          [
            [DOMAIN.CONTROL, 1],
            [DOMAIN.STATUS, 6],
          ],
          PRIORITY.check,
        ).catch(() => {});
      }, delay);
      this.followUps.add(handle);
    }
  }

  /**
   * A read of the control values (sent after `readStartedAt`) through the
   * guards. A command guard lifts when the value asked shows (never on an
   * unknown value). The stop: see decideStop;
   * the resending is the job of the checks.
   */
  observe(values, readStartedAt) {
    for (const field of [...this.guards.keys()]) {
      if (!this.guardActive(field) || values[field] === undefined) continue;
      const guard = this.guards.get(field);
      if (values[field] === guard.expected) this.guards.delete(field);
    }
    const g = this.stopGuard;
    if (!g) return;
    const decision = this.decideStop(g, values.mode, readStartedAt);
    if (decision === 'done') {
      this.logger.info('Aprilaire: the stop is confirmed by the thermostat');
      this.dropStopGuard();
    } else if (decision === 'drop') {
      this.logger.info(
        'Aprilaire: the mode changed after the stop (not by Gladys): not sent again',
      );
      this.dropStopGuard();
    } else {
      this.persist();
    }
  }

  // --- The stop ------------------------------------------------------------------------

  /**
   * A click of the stop: held at once (in memory, then /data in the
   * background), every command not sent yet dropped, written first on the
   * line (a session opened at once if none), answered by 4.3 s.
   */
  async protect(received) {
    for (const entry of this.commands) {
      if (!entry.written) entry.cancelled = true;
    }
    let g = this.stopGuard;
    if (!g) {
      g = {
        address: this.conn?.key ?? this.config.key ?? this.memory.address,
        clickedAt: undefined,
        since: undefined,
        mustWrite: true,
        written: false,
        sentAt: undefined,
        sentWall: undefined,
        reasserts: 0,
        others: 0,
        before: [],
        refused: undefined,
        timer: undefined,
      };
      this.stopGuard = g;
    }
    // A new click renews the stop: written again, three resends again, its
    // own modes of before (read after it).
    g.clickedAt = this.now();
    g.since = received;
    g.mustWrite = true;
    g.reasserts = 0;
    g.others = 0;
    g.before = [];
    g.refused = undefined;
    this.armStopCheck();
    this.persist();
    const waiter = { received };
    const done = new Promise((resolve) => {
      waiter.resolve = resolve;
    });
    this.stopWaiters.push(waiter);
    this.kickStop();
    this.updateStatus().catch(() => {});
    let timer;
    const outcome = await Promise.race([
      done,
      new Promise((resolve) => {
        timer = this.timers.setTimeout(
          () => resolve({ late: true }),
          Math.max(0, received + TIMINGS.commandAnswerBy - this.mono()),
        );
      }),
    ]);
    this.timers.clearTimeout(timer);
    this.stopWaiters = this.stopWaiters.filter((w) => w !== waiter);
    if (outcome.confirmed) return undefined;
    if (outcome.refused) throw this.refusal(ERRORS.stopRefused(outcome.refused));
    if (!this.conn) throw this.refusal(ERRORS.stopNoAddress);
    if (outcome.late && !(this.stopGuard === g && g.written && !g.mustWrite)) {
      throw this.refusal(ERRORS.stopKept);
    }
    throw this.refusal(
      ERRORS.sentUnconfirmed(
        word(outcome.late ? ERRORS.noAnswerYet : ERRORS.readBackDiffers, this.config.language),
      ),
    );
  }

  /** Answers the clicks that came before the write `sentAt` (a later click waits for its own). */
  answerStop(outcome, sentAt) {
    const answered = this.stopWaiters.filter((w) => sentAt !== undefined && w.received <= sentAt);
    this.stopWaiters = this.stopWaiters.filter((w) => !answered.includes(w));
    for (const w of answered) w.resolve(outcome);
  }

  /** The stop to the line now: a session opened at once when none (5 s apart at most). */
  kickStop() {
    let conn = this.conn;
    if (!conn) {
      const address = this.config.address ?? parseAddress(this.memory.address ?? '');
      if (!address) return;
      conn = this.openConn(address);
    }
    if (conn.session) {
      this.sendStop('click').catch((err) => this.logger.warn(`Aprilaire: stop: ${err.message}`));
      return;
    }
    if (conn.opening) return;
    conn.urgentUntil = this.mono() + TIMINGS.stopUrgent;
    const since = conn.lastAttemptAt === undefined ? Infinity : this.mono() - conn.lastAttemptAt;
    if (since >= TIMINGS.stopConnectSpacing) {
      if (conn.timer) this.timers.clearTimeout(conn.timer);
      conn.timer = undefined;
      this.connectNow(conn).catch((err) => this.logger.warn(`Aprilaire: ${err.message}`));
    } else {
      if (conn.timer) this.timers.clearTimeout(conn.timer);
      conn.timer = undefined;
      this.scheduleConnect(TIMINGS.stopConnectSpacing - since);
    }
  }

  /**
   * Writes the stop (no read first), then reads it back. `why`: 'click' (a
   * write each click) or 'resend' (a check decided it).
   */
  async sendStop(why) {
    const g = this.stopGuard;
    const conn = this.conn;
    const session = conn?.session;
    if (!g || !session) return;
    if (this.stopSending) {
      // The one running writes again when the click came after its write.
      this.stopAgain = true;
      return;
    }
    this.stopSending = true;
    let outcome;
    try {
      let written;
      let resend = why === 'resend';
      try {
        written = await this.line(
          {
            kind: 'write',
            domain: DOMAIN.CONTROL,
            attribute: 1,
            data: controlWrite({ mode: HVAC_MODE.OFF }),
            beforeSend: () => {
              if (this.stopGuard !== g) throw new Error('stop ended');
              if (resend && !g.mustWrite) g.reasserts += 1;
              resend = g.mustWrite ? false : resend;
              g.mustWrite = false;
              g.written = true;
              g.sentAt = this.mono();
              g.sentWall = this.now();
              this.writeSeq += 1;
              this.lastStopSeq = this.writeSeq;
            },
          },
          PRIORITY.stop,
          session,
        );
      } catch (err) {
        // Not written (no session, closed): kept, the checks and the next session send it.
        if (!err?.sent) g.mustWrite = g.mustWrite || !g.written || why === 'click';
        this.persist();
        await this.updateStatus();
        return;
      }
      this.logger.info('Aprilaire: stop (mode Off) sent');
      this.persist();
      const startedAt = this.mono();
      let back;
      try {
        back = await this.line(
          { kind: 'read', domain: DOMAIN.CONTROL, attribute: 1 },
          PRIORITY.stop,
          session,
        );
      } catch {
        outcome = { written: true };
        return;
      }
      const nack = session.nackOf(written.sequence);
      if (nack !== undefined && this.stopGuard === g) {
        const reason = `NACK 0x${nack.toString(16).padStart(2, '0')}`;
        if (RETRYABLE_NACKS.has(nack)) {
          // Busy: not applied, does not count; written again at the next check.
          g.mustWrite = true;
          if (g.reasserts > 0 && resend) g.reasserts -= 1;
        } else {
          g.refused = reason;
        }
        this.logger.warn(`Aprilaire: the thermostat answered the stop with ${reason}`);
        outcome = { refused: reason };
      }
      this.keep(C1, back, startedAt);
      if (back.mode === HVAC_MODE.OFF && nack === undefined) {
        if (this.stopGuard === g && !g.mustWrite) {
          this.logger.info('Aprilaire: the stop is confirmed by the thermostat');
          this.dropStopGuard();
        }
        outcome = { confirmed: true };
      } else {
        if (this.stopGuard === g && back.mode !== undefined && back.mode !== HVAC_MODE.OFF) {
          if (!g.before.includes(back.mode)) g.before.push(back.mode);
        }
        outcome ??= { written: true };
        this.persist();
        this.followUp();
      }
      if (conn.identity) {
        this.publishValues([C1]);
        this.flush();
      }
    } finally {
      this.stopSending = false;
      if (outcome) this.answerStop(outcome, g.sentAt);
      await this.updateStatus();
      if (this.stopAgain) {
        this.stopAgain = false;
        if (this.stopGuard?.mustWrite) {
          this.sendStop('click').catch(() => {});
        }
      }
    }
  }

  /**
   * What a read of the mode says of the stop held: 'done' (Off), 'wait',
   * 'drop' (another mode than those of before, read twice in a row: set at
   * the thermostat, never overridden) or 'resend'. Only reads sent after the
   * click count; the first mode read after it is the mode of before (an
   * unknown mode never counts as "changed elsewhere"). Written again only 5 s
   * after the last write, three times at most per click; a stop never
   * written is always written. Never 'drop' by the time.
   */
  decideStop(g, mode, readStartedAt) {
    if (mode === undefined || readStartedAt < g.since) return 'wait';
    if (mode === HVAC_MODE.OFF) {
      // Off read before the write of this click says nothing of it.
      return g.mustWrite ? 'resend' : 'done';
    }
    if (g.mustWrite) return 'resend';
    if (g.sentAt !== undefined && readStartedAt < g.sentAt + TIMINGS.applyDelay) return 'wait';
    if (g.before.length === 0) {
      g.before.push(mode);
    } else if (!g.before.includes(mode)) {
      g.others += 1;
      return g.others >= TIMINGS.stopOtherReads ? 'drop' : 'wait';
    }
    g.others = 0;
    return g.reasserts < TIMINGS.stopReasserts ? 'resend' : 'wait';
  }

  dropStopGuard({ persist = true } = {}) {
    const g = this.stopGuard;
    if (!g) return;
    if (g.timer) this.timers.clearTimeout(g.timer);
    this.stopGuard = undefined;
    if (persist) this.persist();
    this.updateStatus().catch(() => {});
  }

  /** The next check of the stop: every 15 s for 3 min after the click, then every minute. */
  armStopCheck(wait) {
    const g = this.stopGuard;
    if (!g) return;
    const delay =
      wait ??
      (this.mono() < (g.since ?? -Infinity) + TIMINGS.stopFastChecks
        ? TIMINGS.stopRetry
        : TIMINGS.stopSlowRetry);
    if (g.timer) this.timers.clearTimeout(g.timer);
    g.timer = this.timers.setTimeout(() => {
      g.timer = undefined;
      if (this.stopGuard !== g) return;
      this.runCheck(g).catch((err) =>
        this.logger.warn(`Aprilaire: check of the stop: ${err.message}`),
      );
    }, delay);
  }

  /**
   * The periodic check of the stop: written at once when it never was (or a
   * click asks it), else a read of the mode and a write again when
   * `decideStop` says so. Without a session, one is asked (the backoff is a
   * minute at most while the stop is held).
   */
  async runCheck(g) {
    this.armStopCheck();
    const conn = this.conn;
    if (!conn) {
      this.kickStop();
      return;
    }
    if (!conn.session) {
      // A minute at most between two attempts while the stop is held: never a loop.
      const due =
        conn.lastAttemptAt === undefined
          ? 0
          : Math.max(0, conn.lastAttemptAt + TIMINGS.stopBackoff - this.mono());
      if (!conn.opening && (!conn.timer || conn.nextAt - this.mono() > due)) {
        this.scheduleConnect(due);
      }
      return;
    }
    if (this.stopSending) return;
    if (g.mustWrite) {
      await this.sendStop('click');
      return;
    }
    const session = conn.session;
    const startedAt = this.mono();
    let values;
    try {
      values = await this.line(
        { kind: 'read', domain: DOMAIN.CONTROL, attribute: 1 },
        PRIORITY.check,
        session,
      );
    } catch {
      return;
    }
    if (this.stopGuard !== g) return;
    this.keep(C1, values, startedAt);
    const decision = this.decideStop(g, values.mode, startedAt);
    if (decision === 'done') {
      this.logger.info('Aprilaire: the stop is confirmed by the thermostat');
      this.dropStopGuard();
    } else if (decision === 'drop') {
      this.logger.info(
        'Aprilaire: the mode changed after the stop (not by Gladys): not sent again',
      );
      this.dropStopGuard();
    } else if (decision === 'resend') {
      this.logger.warn('Aprilaire: the thermostat still shows the mode of before: stop sent again');
      await this.sendStop('resend');
    } else {
      this.persist();
      await this.updateStatus();
    }
    if (conn.identity) {
      this.publishValues([C1]);
      this.flush();
    }
  }
}
