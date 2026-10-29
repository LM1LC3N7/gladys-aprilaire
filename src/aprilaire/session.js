// -----------------------------------------------------------------------------
// One automation session with the thermostat: ONE TCP connection (the
// thermostat takes one at a time), ONE request in flight on it (never a
// pipeline). The app decides the order of the requests (src/app.js, its
// "line"); this file only speaks the protocol:
//
//   - a read resolves with the decoded answer carrying ITS sequence number
//     (an answer to an older request, timed out, is ignored); a NACK of it is
//     tried again twice (busy, generic, timed out: spec H.5), else rejects;
//   - a write resolves once written (the protocol has no acknowledgement);
//     a NACK of it arrives before the answer to the next read, and is kept
//     for `nackOf(sequence)`;
//   - `beforeSend` runs synchronously right before the bytes leave: it may
//     refuse, and nothing is written then;
//   - the thermostat's own messages (COS, sequence 128-255) go to `onCos`;
//   - a frame too large, the framing lost, or two requests in a row without
//     an answer end the session (the app opens the next one only once this
//     one is closed).
// -----------------------------------------------------------------------------

import { createConnection } from 'node:net';
import { ACTION, LIMITS, RETRYABLE_NACKS, TIMINGS } from '../constants.js';
import { FrameReader, buildFrame, decode } from './packet.js';

export const ERROR_KINDS = {
  UNREACHABLE: 'unreachable',
  CLOSED: 'closed',
  TIMEOUT: 'timeout',
  NACK: 'nack',
  PROTOCOL: 'protocol',
  ABORTED: 'aborted',
};

export class AprilaireError extends Error {
  constructor(kind, message, { sent = false, status } = {}) {
    super(message);
    this.kind = kind;
    /** Whether bytes of the request left (a write that may have been applied). */
    this.sent = sent;
    this.status = status;
  }
}

/** A short reason for statuses and logs (never data from the network). */
export function errorReason(err) {
  if (err?.kind === ERROR_KINDS.NACK) {
    return `NACK 0x${(err.status ?? 0).toString(16).padStart(2, '0')}`;
  }
  return err?.kind ?? 'error';
}

export const tcpConnect = (host, port) => {
  const socket = createConnection({ host, port });
  socket.setNoDelay?.(true);
  return socket;
};

/**
 * Opens the connection: `{ promise, abort }`. The promise resolves with the
 * Session once connected, rejects (UNREACHABLE) on a refusal, an error or
 * the timeout; the socket is destroyed then.
 */
export function openSession({ connect = tcpConnect, host, port, timers, monotonic, ...rest }) {
  let socket;
  let settled = false;
  let reject;
  let timer;
  const promise = new Promise((resolve, rejectPromise) => {
    reject = rejectPromise;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      timers.clearTimeout(timer);
      fn(value);
    };
    try {
      socket = connect(host, port);
    } catch {
      done(rejectPromise, new AprilaireError(ERROR_KINDS.UNREACHABLE, 'connection failed'));
      return;
    }
    socket.on('error', () => {});
    timer = timers.setTimeout(() => {
      socket.destroy();
      done(rejectPromise, new AprilaireError(ERROR_KINDS.UNREACHABLE, 'connection timeout'));
    }, rest.timeoutMs ?? TIMINGS.connectTimeout);
    socket.once('connect', () => {
      done(resolve, new Session(socket, { timers, monotonic, ...rest }));
    });
    socket.once('error', (err) => {
      socket.destroy();
      done(
        rejectPromise,
        new AprilaireError(ERROR_KINDS.UNREACHABLE, err?.code ?? 'connection failed'),
      );
    });
    socket.once('close', () => {
      done(rejectPromise, new AprilaireError(ERROR_KINDS.UNREACHABLE, 'connection closed'));
    });
  });
  // A failed connection has no listener yet when it fails: never unhandled.
  promise.catch(() => {});
  return {
    promise,
    /** The socket while connecting (closed() of the app waits for it). */
    get socket() {
      return socket;
    },
    abort() {
      if (settled) return;
      settled = true;
      timers.clearTimeout(timer);
      socket?.destroy();
      reject(new AprilaireError(ERROR_KINDS.ABORTED, 'connection aborted'));
    },
  };
}

/** Resolves once the socket says 'close' (or after TIMINGS.closeWait: never held forever). */
export function socketClosed(socket, timers) {
  if (!socket || socket.closedForGood) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = timers.setTimeout(resolve, TIMINGS.closeWait);
    socket.once('close', () => {
      timers.clearTimeout(timer);
      resolve();
    });
  });
}

export class Session {
  constructor(socket, { timers, monotonic, onCos = () => {}, onClose = () => {} }) {
    this.socket = socket;
    this.timers = timers;
    this.monotonic = monotonic;
    this.onCos = onCos;
    this.onClose = onClose;
    this.reader = new FrameReader();
    this.sequence = 0;
    /** The request in flight: { sequence, action, domain, attribute, resolve, reject, ... }. */
    this.active = undefined;
    this.closed = false;
    this.lastByteAt = monotonic();
    this.unanswered = 0;
    /** NACKs of writes, by sequence (the last 16). */
    this.nacks = new Map();
    this.closedPromise = new Promise((resolve) => {
      socket.once('close', () => {
        socket.closedForGood = true;
        resolve();
      });
    });
    socket.on('data', (chunk) => this.receive(chunk));
    socket.once('close', () => this.down(new AprilaireError(ERROR_KINDS.CLOSED, 'closed')));
  }

  get open() {
    return !this.closed;
  }

  nextSequence() {
    this.sequence = (this.sequence % 127) + 1;
    return this.sequence;
  }

  /** Whether the request in flight got no byte for `ms` (a stop waiting may cut it). */
  stuckFor(ms, mono = this.monotonic()) {
    return (
      this.active !== undefined && mono - Math.max(this.active.sentAt ?? 0, this.lastByteAt) >= ms
    );
  }

  /** The NACK status of a write, once the answer to a later read arrived. */
  nackOf(sequence) {
    return this.nacks.get(sequence);
  }

  /**
   * One request. `kind`: 'read' (READ_REQUEST, resolves with the decoded
   * answer) or 'write' (resolves with { sequence } once written).
   */
  request({ kind, domain, attribute, data = [], timeoutMs = TIMINGS.requestTimeout, beforeSend }) {
    if (this.closed) {
      return Promise.reject(new AprilaireError(ERROR_KINDS.CLOSED, 'closed', { sent: false }));
    }
    if (this.active) {
      return Promise.reject(new Error('one request at a time'));
    }
    const action = kind === 'write' ? ACTION.WRITE : ACTION.READ_REQUEST;
    const sequence = this.nextSequence();
    return new Promise((resolve, reject) => {
      const entry = {
        sequence,
        kind,
        action,
        domain,
        attribute,
        data,
        retries: 0,
        sentAt: undefined,
        resolve,
        reject,
        timer: undefined,
        deadline: this.monotonic() + timeoutMs,
      };
      try {
        beforeSend?.();
      } catch (err) {
        err.notSent = true;
        reject(err);
        return;
      }
      this.active = entry;
      this.send(entry);
      if (this.closed) return;
      if (kind === 'write') {
        this.finish(entry);
        resolve({ sequence });
        return;
      }
      entry.timer = this.timers.setTimeout(() => this.timeout(entry), timeoutMs);
    });
  }

  send(entry) {
    entry.sentAt = this.monotonic();
    try {
      this.socket.write(
        buildFrame(entry.sequence, entry.action, entry.domain, entry.attribute, entry.data),
      );
    } catch {
      this.fail(new AprilaireError(ERROR_KINDS.CLOSED, 'write failed', { sent: true }));
    }
  }

  finish(entry) {
    if (this.active === entry) {
      this.active = undefined;
    }
    if (entry.timer) {
      this.timers.clearTimeout(entry.timer);
      entry.timer = undefined;
    }
  }

  timeout(entry) {
    if (this.active !== entry) return;
    this.finish(entry);
    this.unanswered += 1;
    entry.reject(new AprilaireError(ERROR_KINDS.TIMEOUT, 'no answer', { sent: true }));
    if (this.unanswered >= LIMITS.silentRequests) {
      this.fail(new AprilaireError(ERROR_KINDS.TIMEOUT, 'the thermostat stopped answering'));
    }
  }

  receive(chunk) {
    // After the end, nothing is handled (checked frame by frame below).
    this.lastByteAt = this.monotonic();
    let frames;
    try {
      frames = this.reader.push(chunk);
    } catch (err) {
      this.fail(new AprilaireError(ERROR_KINDS.PROTOCOL, err.message));
      return;
    }
    for (const frame of frames) {
      if (this.closed) return;
      this.handle(frame);
    }
  }

  handle(frame) {
    const entry = this.active;
    if (frame.action === ACTION.NACK) {
      if (entry && entry.kind === 'read' && frame.sequence === entry.sequence) {
        this.nacked(entry, frame.nack);
      } else if (frame.sequence < 128) {
        this.nacks.set(frame.sequence, frame.nack);
        if (this.nacks.size > 16) this.nacks.delete(this.nacks.keys().next().value);
      }
      return;
    }
    if (frame.action === ACTION.COS) {
      const values = decode(frame.domain, frame.attribute, frame.data);
      if (values) this.onCos(frame.domain, frame.attribute, values);
      return;
    }
    if (
      frame.action === ACTION.READ_RESPONSE &&
      entry?.kind === 'read' &&
      frame.sequence === entry.sequence &&
      frame.domain === entry.domain &&
      frame.attribute === entry.attribute
    ) {
      this.finish(entry);
      this.unanswered = 0;
      entry.resolve(decode(frame.domain, frame.attribute, frame.data) ?? {});
    }
    // Anything else (an answer to an older request, an unknown action) is ignored.
  }

  nacked(entry, status) {
    const left = entry.deadline - this.monotonic();
    if (
      RETRYABLE_NACKS.has(status) &&
      entry.retries < TIMINGS.nackRetries &&
      left > TIMINGS.nackRetry + 100
    ) {
      // spec F note 3: a retry keeps its sequence number.
      entry.retries += 1;
      this.timers.clearTimeout(entry.timer);
      entry.timer = this.timers.setTimeout(() => {
        if (this.active !== entry || this.closed) return;
        this.send(entry);
        entry.timer = this.timers.setTimeout(
          () => this.timeout(entry),
          Math.max(1, entry.deadline - this.monotonic()),
        );
      }, TIMINGS.nackRetry);
      return;
    }
    this.finish(entry);
    this.unanswered = 0;
    entry.reject(
      new AprilaireError(ERROR_KINDS.NACK, 'refused by the thermostat', { sent: true, status }),
    );
  }

  /** Ends the session (the socket destroyed); resolves once it is closed. */
  fail(err) {
    if (!this.closed) {
      this.socket.destroy();
      this.down(err);
    }
    return this.close();
  }

  down(err) {
    if (this.closed) return;
    this.closed = true;
    const entry = this.active;
    if (entry) {
      this.finish(entry);
      entry.reject(new AprilaireError(err.kind, err.message, { sent: entry.sentAt !== undefined }));
    }
    this.onClose(err);
  }

  /** Closes the connection; resolves once the socket is closed (bounded). */
  close() {
    if (!this.closed) {
      this.socket.destroy();
      this.down(new AprilaireError(ERROR_KINDS.ABORTED, 'closed by us'));
    }
    return Promise.race([
      this.closedPromise,
      new Promise((resolve) => this.timers.setTimeout(resolve, TIMINGS.closeWait)),
    ]);
  }
}
