# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [0.1.1] - 2026-10-29

### Added

- Aprilaire 8800-series Wi-Fi thermostats over their local "Home Automation" protocol (one TCP
  session kept open, never two): temperature, humidity, outdoor sensors, heating and cooling
  setpoints, mode, fan, operating state, fan running, hold, humidifier, dehumidifier, fresh air,
  air cleaner and thermostat error; the device known by its MAC address.
- Commands behind "Allow the commands" (off by default): mode heating / cooling / auto, fan,
  setpoints 4.5 to 32 °C (the manufacturer's 40-99 °F converted exactly), each confirmed by a read
  back.
- The stop (mode Off), never behind the option: first on the line, kept in `/data` until confirmed,
  sent again at a restart before the configuration is read.
- "Test the connection" button; status and transport badge.

[Unreleased]: https://github.com/LM1LC3N7/gladys-aprilaire/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/LM1LC3N7/gladys-aprilaire/releases/tag/v0.1.1
