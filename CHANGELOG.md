# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- DSC PowerSeries and Honeywell / Ademco Vista alarm panels through an
  Envisalink EVL-3 / EVL-4, locally over its TPI interface (TCP 4025): the
  panel family recognised by itself, or chosen by hand.
- One device per partition: mode (disarmed, armed away, stay, night), alarm in
  progress, ready to arm.
- One device per zone, configured (name and kind: opening, motion, smoke,
  leak) or added when the panel reports it: state, alarm, tamper, fault.
- A panel device: Envisalink connected, mains power, low battery, tamper,
  system trouble, panic alarm.
- Arming from Gladys (allowed by default); disarming and panic alarms off by
  default, options of the configuration. The user code and the password are
  never logged; every command, sent or refused, is.
- Scene triggers "Envisalink alarm triggered", "Envisalink partition armed"
  and "Envisalink partition disarmed" (partition, mode, user, asked by
  Gladys); scene actions arm, disarm and panic; "Test the connection" button.
- Keep-alive every minute, watchdog after 3 minutes of silence, automatic
  reconnection with backoff; the logins stop after three refused passwords.
- States and scene events kept under the Gladys limits per minute.
- Device, feature and mode names in French or English.

[Unreleased]: https://github.com/LM1LC3N7/gladys-envisalink/commits/main
