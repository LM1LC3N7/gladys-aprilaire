# gladys-aprilaire

[Gladys Assistant](https://gladysassistant.com) external integration for **Aprilaire 8800-series
Wi-Fi thermostats** (8810, 8820, 8830, 8840, 8910W, 6000 zone
control) over their local "Home Automation" protocol, published by Aprilaire (one TCP connection,
port 7000 by default, no cloud, no password): temperature, humidity, outdoor sensors, setpoints,
mode, fan, operating state, hold, humidifier, dehumidifier, fresh air, air cleaner, errors. Mode,
fan and setpoint commands behind an off-by-default option (setpoints 4.5-32 °C); the stop (mode
Off) never behind it. **Never tested with a real device. Not affiliated with Aprilaire.** The
thermostat takes one automation connection: never two home automation systems on it.

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

## How it works

```
Gladys ⇄ SDK ⇄ src/handlers.js ⇄ src/app.js (AprilaireApp)
                                  ├─ src/aprilaire/session.js  one TCP session, one request in flight, NACKs, COS
                                  ├─ src/aprilaire/packet.js   frames, CRC-8, temperatures, attribute maps (pure)
                                  ├─ src/devices.js            the device, its commands and states (pure)
                                  ├─ src/publisher.js          states within 300/min, never older than 2 min
                                  └─ src/store.js              /data/aprilaire-state.json (last attempt, identity, stop held)
```

- **Session**: one connection, kept open; requests one at a time by priority (stop, commands,
  checks of a stop, reads). Lost or refused: opened again after 30 s, 1, 2, 5, 10 min (every minute
  at most while a stop waits); a new socket only once the previous one is closed. A restart never
  connects sooner than the interval after the last attempt (time kept in `/data`), unless a stop
  waits.
- **Reads**: at each session the MAC address (the identity), model, display scale and equipment;
  every interval (60 s, 30 s – 10 min) the control values, sensors, equipment, humidity and air
  statuses, hold and error; the thermostat's change messages (COS) refresh what is shown.
- **Device**: `ext:<selector>:aprilaire:<mac>` (12 hex digits). Nothing shown before the MAC address
  is read in the session.
- **Commands** (`allow_commands`, off by default): mode heating / cooling / auto, fan, heating and
  cooling setpoints (4.5-32 °C: 40-99 °F converted exactly, within 4-32 °C; checked on the value and
  on the byte). Fresh read, the field alone written (others NULL), read back; one at a time; refused
  while a stop is held, except a new mode, which ends it when it leaves.
- **Stop** (mode Off): never behind the option, a read, a command, a lost session or the
  configuration; first on the line (a silent read is cut after 1.5 s); held in `/data` until a read
  shows Off, sent again while the mode of before shows (three times per click), ended by a newer mode
  from Gladys or another mode read twice in a row; never by the time; a stop never sent is never
  given up.

Logic ported from [pyaprilaire](https://github.com/chamberlain2007/pyaprilaire) (MIT): see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Development

```bash
npm install
npm test              # node --test (fake Gladys, fake thermostat, virtual and real clocks)
npm run lint
npm run format:check
npm run cover         # cover.png (800x534)
```

## License

Apache-2.0 (see [LICENSE](LICENSE)); third-party notices in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
