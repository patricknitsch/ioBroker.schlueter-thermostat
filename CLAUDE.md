# CLAUDE.md

Guidelines for working on **ioBroker.schlueter-thermostat**, an ioBroker adapter for Schlüter DITRA-HEAT / OJ Microline floor heating thermostats. It talks to the OJ cloud (OWD5 read, OCD5 write) and, as a beta, can act as the thermostats' own device gateway on the LAN ("local control").

## Project layout

| Path | Purpose |
|---|---|
| `main.js` | Adapter lifecycle (`onReady`, `onUnload`, `onStateChange`, `onMessage`), cloud polling with fallback backoff, apply routing |
| `lib/oj-client.js` | OJ cloud client: OWD5 login / GroupContents / EnergyUsage, OCD5 UpdateThermostat, re-login on 401/403 |
| `lib/objects.js` | Object tree: groups, thermostat devices, channels, states, apply folders |
| `lib/writers.js` | Writes cloud values into the thermostat states (incl. schedule and energy) |
| `lib/apply-handlers.js` | Cloud writes for the `apply.<mode>.apply` buttons |
| `lib/time.js`, `lib/util.js` | Thermostat-local time strings, unit conversion, `safeId` |
| `lib/device-manager.js` | Device Manager UI (`@iobroker/dm-utils`) |
| `lib/notificationManager.js` | Push notifications (Telegram, Pushover, …) |
| `lib/local-manager.js` | Local control: glue between the gateway and the adapter (config, states, persistence, local apply, energy estimate) |
| `lib/local/gateway.js` | Gateway core: TLS server, links, login detection, relay, local answering, commands with acknowledgement, pass-through |
| `lib/local/handler-wg4.js`, `lib/local/handler-wd5.js` | Device handlers per thermostat series (login, answers, decoding, commands) |
| `lib/local/protocol.js`, `lib/local/wd5.js` | Field layout of the device protocol (WG4 / WD5) |
| `lib/local/upstream.js` | Connection to the vendor gateway: resolving, certificate pin, connect |
| `lib/local/protobuf.js`, `lib/local/net.js`, `lib/local/cert.js` | Protobuf wire format and framing, network helpers, self-signed certificate |
| `test/testLocalGateway.js` | Unit tests of the local gateway (simulated thermostat and vendor gateway over real TLS) |
| `admin/jsonConfig.json`, `admin/i18n/*.json` | Admin UI and its translations |
| `docs/en/README.md`, `docs/de/README.md` | User documentation |
| `README.md` | Overview and changelog |
| `io-package.json` | Adapter metadata, `native` defaults, `news` (maintained by the release script) |

## Code structure

- **Modular:** keep `main.js` focused on the adapter lifecycle and wiring. New self-contained logic goes into its own module under `lib/`. The local gateway hooks into `main.js` only at a few points (start/stop, serial registration, local apply, skip set for cloud writes); keep it that way.
- **Testable modules:** inject dependencies instead of reaching into the adapter. `lib/local/*` must work without ioBroker (no `@iobroker/adapter-core` at module load; `local-manager.js` requires it lazily).
- **Cloud access only through `OJClient`.** Don't call axios directly from `main.js`.
- **Timers:** in the adapter use `this.setTimeout` / `this.clearTimeout` and clear them in `onUnload`. Modules under `lib/local/` use plain timers but must clear every timer in `stop()` / when a link closes.
- **Time:** the cloud expects thermostat-local times without `Z` (`YYYY-MM-DDTHH:MM:SS`), using the thermostat's `TimeZone` in seconds (`lib/time.js`). Device protocol times are seconds since 2000-01-01 UTC; WD5 end times are thermostat-local date/time structs.
- **Units:** cloud temperatures are 1/100 °C. On the device protocol, setpoints are 1/200 °C, measured temperatures and schedule temperatures 1/100 °C. Convert at the edge; states are always °C.
- **Error handling:**
  - A failing thermostat must not abort the poll of the others.
  - A failing optional request (energy, …) must not break the core states.
  - Keep the last known value instead of writing 0 or empty values.
  - Writes are blocked while a thermostat is offline (cloud), unless it is connected locally.
- **Polling:** the poll interval (min 10 s) doubles up to 1 h on errors or when all thermostats are offline, then falls back to 12:00/00:00. Every new cloud request must fit this strategy; never retry in tight loops.
- **Secrets:** never log passwords, session ids or e-mail addresses. The password is in `encryptedNative`. A WG4 login contains the account e-mail: `describe()` names it "login" and never shows it. The gateway's private key lives in the instance data directory with mode `0600`. The vendor certificate pin is a public fingerprint, not a secret.
- **Style:**
  - Match the surrounding code: tabs, single quotes, JSDoc on methods.
  - Comments explain *why*, not *what*.
  - Code, comments, log messages and commit messages are in English.

## Local control (beta)

- **Modes:** `off` (cloud only; warn if the DNS record still points here), `relay` (recommended: frames pass through to the vendor gateway, decoded on the way; answers locally if the vendor gateway is unreachable), `local` (the adapter answers the thermostat; app/cloud show it offline).
- **One state structure:** local values go into the **same** thermostat states as the cloud values (`MAIN_STATES` in `local-manager.js`). While a thermostat is connected locally, those states come from the local connection and the cloud poll skips them (`localStateIds()` → `skip` in `writeThermostatStates`). Don't add separate `local.*` states per thermostat. Gateway status lives in `info.local*`.
- **Field numbers** only in `protocol.js` (WG4) and `wd5.js` (WD5). The gateway core must not know any field number besides sequence/acknowledgement.
- **New thermostat series:** add a handler implementing the interface documented at the top of `gateway.js` and register it in `LocalGateway.handlers`. Don't branch on the series inside the core.
- **Never break a working connection:** decoding errors are logged, the frame is still relayed. Unknown framing falls back to byte-for-byte pass-through. Relay mode never refuses a thermostat because of an unknown serial.
- **Commands** are built exactly like the vendor gateway's (WD5: last vendor state as template), are acknowledged by the thermostat, never queued for later, and fall back to the cloud on failure. The acknowledgement of an own command is not passed on to the vendor gateway.
- **Protocol knowledge comes from real traffic.** Before changing decoding or commands, get debug logs (`Thermostat (…)` / `Vendor gateway (…)` lines) from a real device and add the captured frames to the tests. Document what is confirmed and what is assumed.
- **Confirmed on a real OWD5 (firmware 1013W220):** relay, local-only, decoding of heartbeat/state/schedule, local commands schedule, manual, comfort, boost, eco and vacation. Vacation temperature is kept as the device has it (the cloud ignores `VacationTemperature`; the app offers none). A vacation that has begun sets mode 4 at once (observed); disabling a running vacation sets the schedule (assumed). Not confirmed: frost protection as a command (no apply button), name changes, summer time (time zone 7200?).
- **Several thermostats:** supported by design (one link per serial, one DNS record, per-serial states and commands) and covered by a unit test, but **not yet verified on a real multi-device system**. When a second device is available, verify: both connect and map to the right devices, commands reach only their device, one disconnecting leaves the other local, and all devices query the same gateway hostname (relay forwards to one configured host; the thermostats send no SNI).
- **No references** to third-party projects or repositories in code, docs, commits or PRs.

## States and objects

- Create states with `ensureState` / `ensureContainer` (`lib/objects.js`) or `safeSetObjectNotExists`; write with `safeSetState`. Use proper ioBroker roles (`value.temperature`, `indicator.working`, `value.energy`, …).
- Hierarchy: `groups` (folder) → `<GroupId>` (folder) → `thermostats` (folder) → `<ThermostatId>` (device) → channels → states. Channels must not contain devices.
- **Apply concept:** user writes go only through `apply.<mode>.*`; values are stored with `ack: true`, only pressing `apply.<mode>.apply` sends data. React only to `ack: false` in `onStateChange`.
- Renaming or removing states breaks users' scripts and visualisations. Avoid it, or document it clearly in the changelog and migrate/clean up automatically (see `legacyCleanup`, `_removeOldLocalObjects`).

## Tests and checks

Run all of these before every commit or push. They must pass:

```bash
npm run lint      # ESLint + Prettier (must be free of errors; `npx prettier --write <file>` for formatting)
npm test          # unit tests + package tests
```

- `npm run check` (tsc) currently reports errors in the test files (missing mocha types) and one known error in `main.js` (`Function` passed to an event listener). It must not report **new** errors in `main.js` or `lib/`.
- Every new module or bug fix gets unit tests. Put them under `test/` as `test/test<Name>.js` (picked up by `npm run test:js`; files under `lib/` are shipped to users). Use `node:assert/strict` or chai.
- Tests must not use the network or real credentials. Mock `OJClient` / the adapter; for the local gateway use the simulated thermostat and vendor gateway on loopback (`allowLocalUpstream: true`).
- Integration tests (`npm run test:integration`) run in CI on Node 22/24/26 for Linux, Windows and macOS.

## Documentation

Every user-visible change needs:

1. **Changelog entry in `README.md`** under the `### **WORK IN PROGRESS**` heading. If the heading doesn't exist yet, add it directly below the placeholder comment in the `## Changelog` section.
   - Format: `* (patricknitsch) <short description in English>`.
   - Don't edit released versions, and don't edit `io-package.json` `news` or the version numbers. The release script (`npm run release`) does that.
2. **Docs in both languages**, `docs/en/README.md` **and** `docs/de/README.md`. Keep them in sync:
   - new or changed states
   - modes and setup of local control (including the confirmed WD5 status)
   - polling / fallback strategy
   - notifications
3. **Translations:** new admin texts go into all files under `admin/i18n/` (`npm run translate` helps).
4. **Config:** new options need a default in `io-package.json` `native` and an entry in `admin/jsonConfig.json`.

## Git and pull requests

- Branch from the current `main`. Never commit to `main` directly. Work on a feature branch (`feat/…`, `fix/…`, `chore/…`).
- When the work is done and all checks pass, push the branch and **open the PR automatically**, without asking first.
- PR title: short and fitting, **at most two words**, e.g. `Local Gateway`, `Energy Fix`.
- PR description: summary and test plan; use `Refers to #<issue>`, never a closing keyword.
- One topic per PR. Describe in the PR what changed, why, and how it was tested, including whether it was tested against the live cloud and/or a real thermostat (and in which local mode).
- Keep commit messages descriptive, in English, imperative mood.
- Push only after the checks above are green.
