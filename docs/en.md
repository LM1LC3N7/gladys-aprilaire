# Aprilaire thermostat ("Home Automation" protocol)

This integration shows an **Aprilaire 8800-series** Wi-Fi thermostat (8810, 8820, 8830, 8840,
8910W, and the 6000 zone control; users report that the 8920W does not offer
the "Automation" mode) in Gladys over its local "Home
Automation" protocol, published by Aprilaire: one TCP connection on your network, no cloud.

**Never tested with a real device**: the integration was written after the pyaprilaire library (used
by Home Assistant) and tested on a fake thermostat. Not affiliated with Aprilaire.

## What you need

- The thermostat's connection type set to **"Automation"** (contractor menu, "Connection Type");
  some models sold as home automation ready do not offer it and are not supported.
- A fixed address for the thermostat in your router.
- **One automation connection**: the thermostat takes one "Automation" connection at a time (the
  Aprilaire app does not count). Two home automation systems at once can make it stop answering
  until it is power cycled. Do not use Home Assistant or another system on this thermostat at the
  same time. The integration itself opens one connection, kept open, and opens another one only once
  the previous one is closed.
- The protocol has **no password**: keep the thermostat on a trusted network.

## Configuration

- **Address of the thermostat**: IPv4 address or host name, port 7000 by default (add ":8000" for
  example if yours uses another).
- **Allow the commands**: off by default. See below.
- **Refresh interval**: 60 s by default (30 s to 10 min). The thermostat also sends its changes as
  they happen.
- **Language** of the names, options and texts.

Once saved, add the thermostat from the **Discovery** tab. The device is known by its **MAC
address**: it stays the same when its IP address changes; another thermostat at the same address is
another device (the status says so).

## What you see

- Temperature and humidity (the controlling sensors), outdoor temperature and humidity when a sensor
  gives them. A sensor in error, absent or out of range is never published as a measurement.
- Heating and cooling setpoints, in °C (the protocol always carries °C, whatever the display of the
  thermostat; Gladys converts for those who prefer °F).
- Mode (off, heating, cooling, auto as the thermostat offers; emergency heat shows as "heating"), fan
  (auto, on, circulate), operating state (idle, heating, cooling), fan running.
- Hold (none, temporary, permanent, away, vacation), thermostat error (E1 to E8).
- Depending on the equipment: humidifier, dehumidifier, fresh air ventilation, air cleaner, each as a
  text (state, setpoint or mode).

Nothing is shown until the MAC address is read in the session. A value is published when it is read
(or when you add the device, if it was read less than 2 minutes before); never a value older than 2
minutes.

## The commands

With **Allow the commands** on, Gladys may set:

- the **mode** heating, cooling or auto (only those the thermostat offers);
- the **fan** (auto, on, circulate);
- the heating and cooling **setpoints**, from **4.5 to 32 °C** by 0.5 °C. These bounds come from the
  manufacturer's range (40 to 99 °F, "4 to 32 °C"): the °F converted exactly, brought inside onto the
  0.5 °C grid, then within the °C range. A value out of bounds is refused, never brought into range;
  the byte sent is checked a second time.

Each command first reads the state (a read sent after the click), writes only the field asked (the
others stay "unchanged" in the frame), then reads back: it succeeds only when the read back shows the
value asked (within 0.5 °C for a setpoint when the thermostat displays °F: it keeps whole °F) and the
thermostat did not refuse it. Otherwise: "sent, without confirmation", then two reads 5 s and 20 s
later. Commands go one at a time; a command waiting behind others (a scene) leaves at most 15 s after
the click, or not at all. In auto mode, the thermostat may move the other setpoint to keep its
deadband: it decides.

While a stop is not confirmed, setpoints and the fan are refused; a new mode is accepted and ends the
stop when it leaves (after lifting it in `/data`: if `/data` is not writable, nothing is sent) and the
thermostat does not refuse it: refused (NACK code, "busy" included), the stop is held again as it was,
in `/data` too, and checked at once.

## The stop (mode Off)

Choosing the mode **Off** depends on nothing: not on "Allow the commands", a read first, a command
or read in progress, a lost session, a thermostat never read, nor a configuration not read yet after
a restart.

- It goes first: every command clicked before it and not sent yet is dropped; a read in progress that
  received nothing for 1.5 s is cut (the session is closed, then opened again for the stop).
- It is written without a read first, then read back. It goes to the address of the configuration,
  without waiting for the identity of the thermostat nor for `/data` (read 1 s at most at the start,
  merged later).
- When a connection is accepted then closed at once without a byte from the thermostat (another
  system holds it), the write does not count: the stop is written again, every second for the 10 s
  after the click, then every minute.
- Without a session (thermostat unreachable), it is **kept** (in memory and in `/data`) and leaves as
  soon as the thermostat answers; a connection is tried at the click, then at least every minute. A
  stop never sent is never given up, even after a restart (it then leaves before the configuration is
  even read).
- Not confirmed, it is checked every 15 s for 3 minutes then every minute, and sent again while the
  thermostat shows the mode of before, 3 times at most per click (a "busy" refusal of the thermostat
  does not count). It ends when a read shows Off, when a new mode chosen in Gladys leaves and is not
  refused by the thermostat, or when another mode is read twice in a row (chosen at the thermostat);
  never by the time.

When the stop does not leave (the status of the integration says so):

- no valid address in the configuration (kept, it leaves once an address is saved);
- the thermostat does not answer or refuses the connection (kept, it leaves once it answers);
- the thermostat refuses the write (NACK code shown; a "busy" answer does not count and the stop is
  written again at every check);
- another thermostat (another MAC address read in the session) answers at the address: the stop
  asked for the previous device is refused, nothing is sent to the other one; the status says so
  until a stop leaves or that device is deleted (add the new one from Discovery).

While `/data` is not read (slow storage), the status says so: a stop clicked meanwhile leaves, but is
not kept there. A stop kept there and read late is not sent if a stop, or a mode the thermostat did
not refuse, was written since the start (it is older); it is then removed from `/data`.

## Known limits

- Never tested with a real device; no North American thermostat was at hand.
- Humidity setpoints, fresh air, air cleaner, holds and the schedule are shown only in this version.
- One thermostat per installation of the integration.
