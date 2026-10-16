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
- **Own client, no dependency.** The maintained reference is Python:
  [ufodone/pyenvisalink](https://github.com/ufodone/pyenvisalink) (MIT, used
  by Home Assistant), read as protocol documentation together with the
  EyezOn TPI documents; nothing copied. The TPI is a small line protocol, so
  a JavaScript client of our own (with tests) is cheaper than adopting an
  npm package; the npm registry was not searched exhaustively for M1 (to
  confirm before the release). Runtime dependency: the SDK only.
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
  gets the real mode back (forgetPublishedStates + republish). Frames are
  logged by name, never by content (password, code). The DSC `900` code
  request is answered only within 20 s of a Gladys arm.
- **Login guard**: three refused passwords in a row stop the logins until the
  configuration changes or "Test the connection" is clicked; 5 minutes
  between two tries meanwhile.
- **Zones**: configured (`N=Name:type`, ranges) or added when reported; a
  zone's state is unknown (no state published) until the panel says
  something. Honeywell keypad faults expire after 45 s without being shown,
  or at "ready"; the `%01` bitfield wins over the keypad.
- **Ids**: `panel:envisalink`, `partition:<n>`, `zone:<n>`: the module has no
  serial over TPI, and the panel numbering is stable; a new IP keeps them.
- **Rate limits**: states through publishChangedStates and a 240/min budget
  (latest value per feature waits); scene events 120/min, dropped beyond.
- **Scene events**: one per transition; none for the first mode seen after a
  start; partitions sent as strings so the select filters match.
