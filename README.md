# gladys-envisalink

[Gladys Assistant](https://gladysassistant.com) external integration for
**DSC PowerSeries** and **Honeywell / Ademco Vista** alarm panels fitted with
an **Envisalink EVL-3 / EVL-4**, locally over the module's TPI interface (TCP
4025), without the EyezOn cloud: partitions (disarmed, armed away / stay /
night, in alarm, ready), zones (open / closed, alarm, tamper, fault), system
troubles (mains, battery, tamper), panic alarms, arming from Gladys,
disarming and panic as opt-ins, scene triggers. Unofficial, not affiliated
with EyezOn, DSC or Honeywell.

User documentation: [docs/fr.md](docs/fr.md) · [docs/en.md](docs/en.md).

> **Work in progress (0.1, not published to the store yet).** Tested against
> an in-memory TPI server shaped after the EyezOn documentation and
> pyenvisalink, not yet on a real module. Feedback is welcome in the
> [GitHub issues](https://github.com/LM1LC3N7/gladys-envisalink/issues).

## How it works

```
Gladys ⇄ SDK ⇄ src/handlers.js ⇄ src/app.js (EnvisalinkApp) ⇄ src/tpi/client.js ⇄ Envisalink (TCP 4025, LAN)
                                   ├─ src/tpi/dsc.js        DSC frames: checksum, decode, encode (pure)
                                   ├─ src/tpi/honeywell.js  Honeywell %00-%03 messages, keypad sequences (pure)
                                   ├─ src/model.js          events -> panel state + transitions (pure)
                                   ├─ src/devices.js        -> Gladys devices and states (pure)
                                   └─ src/publisher.js      states / scene events under the Gladys limits
```

- **One TPI session**, kept open: login (`005` + password for DSC, the
  password after `Login:` for Honeywell), status report (DSC `001`),
  keep-alive every minute (`000` / `^00,$`), watchdog after 3 minutes of
  silence, reconnection with a 5 s → 5 min backoff, logins stopped after
  three refused passwords.
- **Devices**: `ext:<selector>:panel:envisalink`,
  `ext:<selector>:partition:<n>` (mode `text`/`select`, `siren` alarm,
  `input` ready), `ext:<selector>:zone:<n>` (`opening-sensor` /
  `motion-sensor` / `smoke-sensor` / `leak-sensor`, `siren`, `tamper`,
  `input` fault). The ids depend only on the panel's numbering.
- **Safety**: arming allowed by default, disarming and panic opt-in; the
  user code and the password never reach the logs (frames carrying them are
  logged by name only).

## Development

```bash
npm install
npm test                                        # node --test, no network (in-memory TPI, one loopback test)
npm run lint && npm run format:check
npm run audit
npx github:GladysAssistant/integration-store .  # store admission checks
```

`test/helpers/fakeEnvisalink.js` is an in-memory Envisalink: login prompt,
password check, acks, and the panel messages each test pushes.

## Credits

The client is our own (no maintained JavaScript TPI client on npm), written
from:

- [ufodone/pyenvisalink](https://github.com/ufodone/pyenvisalink) (MIT), the
  library behind the Home Assistant Envisalink integration: message codes,
  Honeywell bitfields, keypad sequences, panic keys, keep-alive;
- the EyezOn _Envisalink TPI Programmer's Document_ (DSC and Honeywell
  editions): frame layout, checksum, login, command and error codes.

No code was copied; see [TODO.md](TODO.md), Decisions.

## Releasing

**Actions → Release → Run workflow** (patch / minor / major): bumps the
version in `package.json` and the manifest, rolls `CHANGELOG.md`, tags, builds
the multi-arch image to GHCR and publishes the GitHub Release. The
`gladys-assistant-integration` topic is added at the first real release only.

## License

Apache-2.0. Envisalink and EyezOn are trademarks of EyezOn; DSC and
PowerSeries of Johnson Controls / Tyco; Honeywell, Ademco and Vista of their
owners. This project is not affiliated with any of them.
