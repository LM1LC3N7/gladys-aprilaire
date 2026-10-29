# TODO

## Decisions

- Version 0.1.0 set by hand in `package.json`, `package-lock.json`, the manifest and the
  `docker_image` tag. The manifest test checks the form and the agreement, never a fixed value.
- Reference: pyaprilaire 0.9.1 (MIT, Matthew FitzGerald-Chamberlain; LICENSE read in the
  repository, commit 301e035), used by the Home Assistant "AprilAire" integration. Ported to
  JavaScript, no Python dependency; notice in `THIRD_PARTY_NOTICES.md`, copied into the image. The
  manufacturer's protocol document (aprilairepartners.com) could not be fetched: the spec sections
  are those pyaprilaire cites; its CRC is checked against pyaprilaire's own test frames.
- Neighbour module followed: LM1LC3N7/gladys-venstar (thermostat features, the fan as
  `text/select`, never a switch); structure, stop guard and tests after LM1LC3N7/gladys-weishaupt
  (approved, lot 18).
- No `keywords` nor `countries` in the manifest (US, CA product): to add if the store asks.
- Category: `climate` only.
- One thermostat per installation. Identifier rule (frozen): `aprilaire:<mac>`, the MAC address
  read (spec 8.2) as 12 lower-case hex digits; an unreadable, all-zero, all-ones or multicast one is
  unknown (nothing shown, no command but the stop), never another thermostat. Another MAC at the
  address: another device, the status says so; commands to the previous one refused.
- ONE session (the thermostat takes one automation connection; two can make it stop answering):
  kept open, one request in flight (no pipeline), a new socket only once the previous one closed
  (bounded wait of 2 s). Reconnection 30 s, 1, 2, 5, 10 min; every minute at most while a stop is
  held; a click of the stop tries at once (5 s apart at most). No periodic reconnection (pyaprilaire
  reconnects every hour: not needed to read). Two requests unanswered in a row end the session.
- Reads never sooner than the interval: at a restart, the first connection waits the interval after
  the attempt kept in `/data` (written at most once a minute, as the attempt starts), unless a stop
  waits; a reconnection, Gladys reconnected, Discovery or the test button never read sooner. The
  identity (MAC, model, scale, equipment) is read at each session.
- No COS subscription written (the thermostat's default is all on, spec J.1): COS messages refresh
  what is shown, never a decision. A COS of the control values with the mode Off is ignored
  (pyaprilaire reads again instead: here the next read shows it).
- Temperatures: the protocol carries °C by 0.5 whatever the display scale: the features are in °C.
  Setpoint bounds 4.5-32 °C: the manufacturer's control range 40-99 °F converted exactly
  ((F - 32) x 5 / 9) and brought inside onto the 0.5 grid (4.5 to 37), then within its "4 to 32 °C";
  checked on the value asked (before rounding) and on the byte written (`setpointByte`). Same range
  for both setpoints. With the display in °F (or unknown), a setpoint read back within 0.5 °C of the
  value asked confirms (the thermostat keeps whole °F), never one equal to the value of before.
- Sensors: only with the status 0 ("no error"); humidity 0-100; a NULL (0) setpoint or mode is
  unknown, never 0.
- Commands: off by default; one at a time; the option checked on arrival and in `beforeSend`;
  decided on a read sent after the click; the field alone written (the other bytes NULL: never a
  value written back); confirmed by the read back and no NACK of the write (it arrives before the
  answer to the read after it); else "sent, without confirmation", a guard of 90 s per field and
  reads 5 s and 20 s later. Answered by 4.3 s; a command waiting its turn leaves within 15 s of the
  click or never. Emergency heat is "heating": a heating command while in emergency heat writes
  nothing.
- Stop (mode Off): see `src/app.js` header. Not subject to the option (the brief of the module:
  "l'arrêt n'est soumis à rien"), nor to the identity (it goes to the configured address, before the
  MAC is read); refused only when the session read another MAC than the device's (review r1, m6).
  /data is awaited 1 s at most (review r1, B1): read later, it is merged (a stop kept there checked at
  once), and nothing is written to it before. No call to Gladys is awaited on the path of the stop
  (r1, I1). A NACK is kept per sequence number until the number is given again (r1, I2). The mode
  of before is the read back of the first write of a click (or the first check); the read back of a
  resend is a read like any other (r1, I5). A write into a session that closed without a byte does
  not count (r1, m3). "Already so" only for the very value read, and in °F display (or an
  unread scale) a read back within 0.5 °C confirms but never the value of before (r2, N1: the r1 m7
  shortcut swallowed a whole °F). A stop read late from /data is dropped when a stop or a mode was
  written since the start (r2, N2). A stop refused for another MAC is said in the status until a stop
  leaves or that device is deleted (r2, N3); /data not read yet is said too (r2, n1). Held until a read shows Off, a newer mode command leaves (lifted in `/data` first,
  bounded at 1 s: `/data` failing = the command refused unsent), or another mode is read twice in a
  row. Three resends per click; a busy NACK does not count; a stop never written is written at every
  check. Waiting clicks are answered only by a write sent after them.
- Humidity setpoints, fresh air, air cleaner and holds are read only (no core feature type for a
  humidity setpoint).

## Next

- Humidity setpoints (dehumidifier 40-90 %, humidifier 10-50 %) and the off of the humidity
  equipment, the fresh air and air cleaner events, the holds (away, vacation), when the core has a
  type for them.
- Several thermostats (one session each).
- The written outdoor temperature (spec 5.4).

## Checked

- Against pyaprilaire's own mock server (its repository, run in a `python:3.14-slim` container, MAC
  changed from 01:02:… to 02:02:… since a multicast MAC is refused as an identity): one session,
  discovery of an 8840, every value, heating and cooling setpoints, fan, mode and the stop confirmed
  by the read back. The mock answers on a 0.5 s cycle (as pyaprilaire sends): the cut of a silent read
  for a stop is at 1.5 s, not 1 s.

## Not verified

- Never tested with a real device (no North American hardware nor tester): everything was tested on
  a fake thermostat built after pyaprilaire and its mock server.
- The setpoint encoding at the edges (4.5 °C), the confirmation in °F display, the NACK of a write
  arriving before the next answer, the behaviour of a thermostat whose session is cut.
- The port (7000 in Home Assistant; 8000 reported on a forum for an 8810).
