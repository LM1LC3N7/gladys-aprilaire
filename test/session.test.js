// -----------------------------------------------------------------------------
// One session (src/aprilaire/session.js) on a scripted socket: answers by
// sequence number only, NACKs retried with the same sequence, a write's NACK
// kept, the thermostat's own messages routed, beforeSend able to refuse.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Session } from '../src/aprilaire/session.js';
import { FrameReader, buildFrame, buildNack } from '../src/aprilaire/packet.js';
import { testClock } from './kit/clock.mjs';

function scripted() {
  const socket = new EventEmitter();
  const reader = new FrameReader();
  socket.sent = [];
  socket.write = (bytes) => {
    socket.sent.push(...reader.push(Buffer.from(bytes)));
    return true;
  };
  socket.destroy = () => setImmediate(() => socket.emit('close'));
  socket.answer = (bytes) => socket.emit('data', bytes);
  return socket;
}

function open() {
  const clock = testClock();
  const socket = scripted();
  const cos = [];
  const session = new Session(socket, {
    timers: clock.timers,
    monotonic: clock.monotonic,
    onCos: (d, a, v) => cos.push([d, a, v]),
  });
  return { clock, socket, session, cos };
}

test('a read resolves only with the answer of its own sequence', async () => {
  const { socket, session } = open();
  const pending = session.request({ kind: 'read', domain: 2, attribute: 1 });
  const [sent] = socket.sent;
  socket.answer(buildFrame(sent.sequence + 1, 3, 2, 1, [3, 3, 10, 30])); // an older request's
  socket.answer(buildFrame(sent.sequence, 3, 5, 2, [0, 1])); // another attribute
  socket.answer(buildFrame(sent.sequence, 3, 2, 1, [2, 2, 20, 25]));
  assert.deepEqual(await pending, { mode: 2, fan: 2, heat: 20, cool: 25 });
});

test('one request at a time; beforeSend refusing sends nothing', async () => {
  const { socket, session } = open();
  const first = session.request({ kind: 'read', domain: 2, attribute: 1 });
  await assert.rejects(session.request({ kind: 'read', domain: 2, attribute: 1 }), /one request/);
  socket.answer(buildFrame(socket.sent[0].sequence, 3, 2, 1, [2, 2, 20, 25]));
  await first;
  await assert.rejects(
    session.request({
      kind: 'write',
      domain: 2,
      attribute: 1,
      data: [1, 0, 0, 0],
      beforeSend: () => {
        throw new Error('no');
      },
    }),
    /no/,
  );
  assert.equal(socket.sent.length, 1);
});

test('a busy NACK is retried with the same sequence (twice at most); a value NACK rejects', async () => {
  const { clock, socket, session } = open();
  const pending = session.request({ kind: 'read', domain: 2, attribute: 1, timeoutMs: 5000 });
  const seq = socket.sent[0].sequence;
  socket.answer(buildNack(seq, 0x03));
  await clock.advance(700);
  assert.equal(socket.sent.length, 2);
  assert.equal(socket.sent[1].sequence, seq);
  socket.answer(buildFrame(seq, 3, 2, 1, [2, 2, 20, 25]));
  assert.equal((await pending).mode, 2);
  const refused = session.request({ kind: 'read', domain: 2, attribute: 1 });
  socket.answer(buildNack(socket.sent[2].sequence, 0x10));
  await assert.rejects(refused, (err) => err.kind === 'nack' && err.status === 0x10);
});

test('a write resolves once written; its NACK is kept for the read after it', async () => {
  const { socket, session } = open();
  const { sequence } = await session.request({
    kind: 'write',
    domain: 2,
    attribute: 1,
    data: [1, 0, 0, 0],
  });
  socket.answer(buildNack(sequence, 0x08));
  assert.equal(session.nackOf(sequence), 0x08);
});

test('change messages go to onCos; a request silent for 1.5 s is stuck', async () => {
  const { clock, socket, session, cos } = open();
  socket.answer(buildFrame(140, 5, 7, 6, [2, 0, 0, 1]));
  assert.deepEqual(cos, [[7, 6, { heating: 2, cooling: 0, fanRunning: 1 }]]);
  session.request({ kind: 'read', domain: 5, attribute: 2 }).catch(() => {});
  await clock.advance(500);
  assert.equal(session.stuckFor(1500), false);
  await clock.advance(600);
  assert.equal(session.stuckFor(1000), true);
});

test('two requests unanswered in a row: the session ends', async () => {
  const { clock, session } = open();
  const a = assert.rejects(
    session.request({ kind: 'read', domain: 2, attribute: 1 }),
    (err) => err.kind === 'timeout' && err.sent,
  );
  await clock.advance(2100);
  await a;
  const b = assert.rejects(
    session.request({ kind: 'read', domain: 2, attribute: 1 }),
    (err) => err.kind === 'timeout',
  );
  await clock.advance(2100);
  await b;
  assert.equal(session.open, false);
});

test('bytes after the session ended are ignored', async () => {
  const { socket, session, cos } = open();
  const pending = session.request({ kind: 'read', domain: 2, attribute: 1 });
  const seq = socket.sent[0].sequence;
  session.close();
  await assert.rejects(pending);
  socket.answer(buildFrame(seq, 3, 2, 1, [2, 2, 20, 25]));
  socket.answer(buildFrame(140, 5, 7, 6, [2, 0, 0, 1]));
  assert.deepEqual(cos, []);
});

test('r1 I2: the NACK of a number is forgotten when the number is given again', async () => {
  const { socket, session } = open();
  const { sequence } = await session.request({
    kind: 'write',
    domain: 2,
    attribute: 1,
    data: [0, 1, 0, 0],
  });
  socket.answer(buildNack(sequence, 0x10));
  assert.equal(session.nackOf(sequence), 0x10);
  for (let i = 0; i < 126; i += 1) {
    const read = session.request({ kind: 'read', domain: 2, attribute: 1 });
    socket.answer(buildFrame(socket.sent.at(-1).sequence, 3, 2, 1, [2, 2, 20, 25]));
    await read;
  }
  const again = await session.request({
    kind: 'write',
    domain: 2,
    attribute: 1,
    data: [1, 0, 0, 0],
  });
  assert.equal(again.sequence, sequence);
  assert.equal(session.nackOf(sequence), undefined);
});
