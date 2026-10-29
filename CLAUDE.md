# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration**: a Node.js service (Node 22+, ESM,
no build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It started from the official JavaScript template.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
node --test --test-name-pattern "stop"    # tests whose name matches
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run cover                             # regenerate cover.png (800x534)
```

## Architecture

```
index.js                     SDK wiring only (src/handlers.js), boot() before connect()
src/handlers.js              the SDK handlers, shared with the end-to-end tests
src/app.js                   the session, reads, device, states, status, commands, the stop
src/aprilaire/session.js     one TCP session, one request in flight, NACK retries, COS
src/aprilaire/packet.js      frames, CRC-8, encodings, attribute maps, bounded writes (pure)
src/devices.js               the thermostat -> one Gladys device; external ids (frozen rule)
src/publisher.js             states to Gladys within 300 per minute
src/store.js                 /data: last attempt, identity, the stop held
src/config.js                DEFAULT_CONFIG (mirrors the manifest defaults) + normalization
src/i18n.js                  runtime texts (English and French)
test/                        node --test: fake Gladys, fake thermostat, virtual and real clocks
test/kit/                    copied from gladys-testkit (clocks, TCP server)
```

Logic ported from pyaprilaire (MIT): keep `THIRD_PARTY_NOTICES.md` up to date.
The thermostat takes ONE automation connection: never open a second socket
before the first is closed. Commands stay off by default; the stop (mode Off)
is never subject to anything. Never a `switch` nor a writable `binary`.

## Rules

- **External ids are forever**: `aprilaire:<mac>` (frozen rule in `src/devices.js`).
- **The container rootfs is read-only.** Write only under `/data`.
- **Versions belong to the Release workflow**; `test/manifest.test.js` checks they agree.
- **Changelog**: every user-visible change under `## [Unreleased]`.
- **User-facing text** is bilingual (manifest, `src/i18n.js`, `docs/en.md`, `docs/fr.md`).
- **Style**: Prettier formats, ESLint catches mistakes; comments explain why, in English; tests
  never touch the network beyond the loopback.
