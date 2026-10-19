# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [0.1.2] - 2026-10-19

### Fixed

- Armed and disarmed scene triggers lost when a DSC user code is not digits:
  the user was sent as NaN, which the SDK refuses; it is now null, and every
  scene event turns an undefined, non-finite or non-primitive value into
  null.

## [0.1.1] - 2026-10-16

### Added

- DSC PowerSeries and Honeywell / Ademco Vista alarm panels through an
  Envisalink EVL-3 / EVL-4, locally over its TPI interface (TCP 4025): the
  panel family recognised by itself, or chosen by hand.
- One device per partition: mode (disarmed, armed away, stay, night), alarm in
  progress, ready to arm.
- One device per zone, configured (name and kind: opening, motion, smoke,
  leak) or added when the panel reports it: state (a feature per kind),
  alarm, tamper, fault. Honeywell: up to 128 zones from the zone bitfield,
  keypad values that expire when the keypad stops showing them.
- A panel device: Envisalink connected, mains power, low battery, tamper,
  system trouble, panic alarm.
- Arming from Gladys (allowed by default); disarming and panic alarms off by
  default, options of the configuration (Honeywell panic: experimental). The
  user code (DSC 4 or 6 digits, Honeywell 4) and the password are never
  logged; every command, sent or refused, is; a failed or refused command
  puts the real mode back on the dashboard.
- Scene triggers "Envisalink alarm triggered" (kind from the zone in alarm:
  intrusion, fire, leak, or cause unknown; medical, panic, duress),
  "Envisalink partition armed" and "Envisalink partition disarmed"
  (partition, mode, user, asked by Gladys); scene actions arm, disarm and
  panic; "Test the connection" button.
- Keep-alive every minute, watchdog after 3 minutes of silence, automatic
  reconnection with backoff; the logins stop after three refused passwords;
  a longer wait, and a message, when another TPI client seems to share the
  module. Lines prefixed with the time are understood.
- States and scene events kept under the Gladys limits per minute: only
  changed values, spread heartbeats, a share kept for the panel and the
  partitions; "alarm triggered" never dropped and retried on errors.
- Docs: "never tested on a real module" notice, false alarm warnings (night
  mode without entry delay, monitoring station).
- Device, feature and mode names in French or English.

[Unreleased]: https://github.com/LM1LC3N7/gladys-envisalink/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/LM1LC3N7/gladys-envisalink/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/LM1LC3N7/gladys-envisalink/releases/tag/v0.1.1
