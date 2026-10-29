# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`). It
contains logic ported to JavaScript from the project below. The ported parts
were rewritten, not copied; the changes are described below.

## pyaprilaire

<https://github.com/chamberlain2007/pyaprilaire> (Python library used by the
Home Assistant "AprilAire" integration, version 0.9.1, repository at commit
301e035 of 2026-10-14), by Matthew FitzGerald-Chamberlain. MIT License; its
`LICENSE` file names the copyright holder. Full text below.

Ported in `src/constants.js` and `src/aprilaire/packet.js`: the frame format
of the Aprilaire "Home Automation" protocol (REV, SEQ, CNT, payload, CRC-8 of
polynomial 0x31), the actions, functional domains, attributes and NACK codes,
the temperature encoding (degrees Celsius by 0.5, sign bit), the attribute
maps of the values read (control, sensors, status, identification), the
model numbers, the NACK retries (twice, 0.5 to 1 s apart) and the NULL bytes
of a write ("unchanged"). Changed: one request at a time (never a pipeline),
a frame size bounded on its header, three wrong CRCs in a row end the
session, a sensor value only with the status "no error", the setpoints
bounded and the NULL byte never written as a temperature, no COS
subscription written, no periodic reconnection. The session and the commands
(`src/aprilaire/session.js`, `src/app.js`) are written for Gladys.
The fake thermostat of the tests (`test/fixtures/fakeAprilaire.js`) follows
pyaprilaire's mock server.

```
MIT License

Copyright (c) 2023 Matthew FitzGerald-Chamberlain

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
