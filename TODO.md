# TODO — Envisalink (DSC, Honeywell) v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `npm run format:check`, `npm run lint`, `npm test`,
  `npm run audit`, `npx github:GladysAssistant/integration-store .`, then
  update README, `docs/fr.md`, `docs/en.md`, `CHANGELOG.md` and this file.
- No topic, no release, no forum post from a module session: the module was
  claimed in /t/10385 (post #226); the main session posts one recap there.

## Status

- [x] **Milestone 1 — core** (2026-10-16): own TPI client on `node:net`
      (login, auto-detection DSC / Honeywell, keep-alive, watchdog,
      reconnection backoff, stop after 3 refused passwords); DSC frames
      (checksum, 500-900) and Honeywell messages (%00 keypad, %01 zones,
      %02 partitions, %03 Contact ID); panel / partition / zone devices;
      arming allowed, disarming and panic opt-in, code and password never
      logged, DSC code sent on 900 only within 20 s of a Gladys command;
      scene triggers `alarm_triggered`, `armed`, `disarmed`; scene actions
      `arm`, `disarm`, `panic`; "Test the connection"; state and event
      budgets under the Gladys limits; fr/en. Tested against an in-memory TPI
      server and one loopback socket only.
- [ ] **Milestone 2 — real module**: run against a real EVL-3/EVL-4 on a DSC
      and on a Vista; fix what differs (see below); capture real lines
      (anonymised) as fixtures.
- [ ] **Milestone 3 — more**: zone bypass, zone timer dump (DSC 008 / 615,
      Honeywell ^02 / %FF) for the initial zone states, keypad text as a
      text feature, chime, DSC 510/511 LEDs of other partitions.
- [ ] **Milestone 4 — first release**: Docker image check, Release workflow,
      topic, GHCR package public.

## To check on a real module

- DSC: does `001` report closed zones (`610`) or only open ones? Does `650`
  ever arrive during the exit delay? Is `652` sent with the mode digit on
  EVL-3 firmwares? Order of `700` / `652` (user credit window of 30 s).
- DSC: is the `040` code accepted with 4 digits on every panel, or must it be
  padded like `200`? Does `032` arm away or stay with no entry delay?
- Honeywell: does `Login:` end with CR LF? Is `%03` 9 or 10 characters? Are
  `^03,1,...` partition numbers accepted unpadded? Do A / B / C pressed three
  times raise the panic (pyenvisalink behaviour) or once?
- Honeywell: the armed icons during the exit delay (armed event at the start
  of the delay rather than at its end, unlike DSC).
- The module's behaviour on a second TPI client (refusal or kick-out).

## Decisions

- **Not a duplicate** (checked by the main session on 2026-10-16 when
  claiming the module in /t/10385 #226): no Envisalink / DSC / Vista
  integration in the Gladys core, the store or the forum.
- **Own client, no dependency.** npm has no stand-alone, maintained TPI
  client: the JavaScript implementations live inside the Homebridge plugins
  `homebridge-envisalink` (DSC) and `homebridge-envisalink-ademco`
  (Honeywell, MIT), bound to Homebridge, not libraries. The maintained
  reference is Python: [ufodone/pyenvisalink](https://github.com/ufodone/pyenvisalink)
  (MIT, used by Home Assistant), read as protocol documentation together
  with the EyezOn TPI documents and, for the `%01` bit order,
  homebridge-envisalink-ademco; nothing copied. Sharing a module between
  clients is envisalink-proxy's job, not ours. Runtime dependency: the SDK
  only.
- **Version 0.1.0, set by hand once**: the template ships 1.0.0; the
  sibling modules start at 0.1.x, so `package.json`, the manifest
  `version` and the `docker_image` tag were set together to 0.1.0 in
  milestone 1, before any release. The exception to "versions belong to the
  Release workflow" (CLAUDE.md) stops there: every later version comes from
  Actions → Release.
- **Protocol-neutral events**: both decoders produce the same events
  (`partition`, `zone`, `zones`, `system`, `panic`, `user`), folded by one
  pure model; the app never sees a protocol code.
- **Mode = `text`/`select`** (`disarmed`, `armed_away`, `armed_stay`,
  `armed_night`, frozen), as the Somfy Protexial and Ajax modules do: Gladys
  has no alarm-panel feature. Night = no entry delay (DSC 032, Honeywell 7
  Instant), the Home Assistant convention. Changing armed mode needs a
  disarm first (refused with a message, never chained by itself).
- **Safety**: `allow_arm` true, `allow_disarm` and `allow_panic` false by
  default (Louis's rule). Refused commands are logged at warn; the dashboard
  gets the real mode back (forget + republish), also after a DSC 659 / 672 /
  670 (failed arm, refused code). Frames are logged by name, never by
  content (password, code). The DSC `900` code request is answered only
  within 20 s of a Gladys arm, for that partition, and the waiting code dies
  with its session. Codes: DSC 4 or 6 digits, Honeywell 4 (checked before
  anything is sent).
- **False alarms**: the docs warn that night = no entry delay, and that a
  monitoring station receives Gladys-made alarms like real ones; panic stays
  opt-in, experimental on Honeywell (one A / B / C key, as pyenvisalink).
- **Alarm kind**: from the configured kind of the zone in alarm (smoke ->
  fire, leak -> leak, opening / motion -> intrusion), or the Honeywell fire
  bit; otherwise `partition` (cause unknown), never a guessed intrusion.
- **Contended TPI**: three sessions in a row dropped within 30 s of their
  login mean another client: 5 minutes between tries, a status message
  that says so.
- **Login guard**: three refused passwords in a row stop the logins until the
  configuration changes or "Test the connection" is clicked; 5 minutes
  between two tries meanwhile.
- **Zones**: configured (`N=Name:type`, ranges) or added when reported; a
  zone's state is unknown (no state published) until the panel says
  something. Honeywell keypad values (FAULT, CHECK, ALARM, TAMPER) expire
  after 45 s without being shown, open / fault also at "ready"; a keypad
  ALARM counts only while armed or with the alarm bit (no alarm memory after
  a disarm); the `%01` bitfield (64 or 128 zones) wins over the keypad. DSC
  510 gives the ready flag only, the mode comes from 650 / 652 / 653 / 655.
  New zones of a burst (DSC 001 dump) are published as one device list.
- **Ids**: `panel:envisalink`, `partition:<n>`, `zone:<n>`: the module has no
  serial over TPI, and the panel numbering is stable; a new IP keeps them.
  The state feature of a zone is keyed by its kind (`zone:<n>:opening`,
  `:motion`, `:smoke`, `:leak`): a kind changed later is a new feature,
  never an existing one changing category.
- **Rate limits**: our own deduplication (`publishStates` of the values that
  changed since Gladys accepted the last one), a heartbeat every 30 min plus
  a per-feature offset over 5 min, a 240/min budget of which 60 are kept for
  the panel and the partitions (latest value per feature waits); scene
  events 120/min, dropped beyond, except alarm_triggered: never dropped,
  3 tries (5 s, 20 s) on an error.
- **Scene events**: one per transition; none for the first mode seen after a
  start; partitions sent as strings so the select filters match.
