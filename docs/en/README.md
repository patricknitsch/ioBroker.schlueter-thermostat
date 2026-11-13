# ioBroker.schlueter-thermostat

Cloud‑Adapter for **Schlüter / OJ Microline OWD5 Thermostats**

---

## 🌍 Overview

This adapter integrates **Schlüter / OJ Microline OWD5 thermostats** into ioBroker via the **official cloud APIs**.

It supports:

- 🌡 Temperature monitoring
- 🎯 Setpoints
- 🔄 Mode control
- ⏱ Comfort & Boost timers
- 🏖 Vacation mode
- 📅 Full schedule readout
- ⚡ Energy statistics
- 🔔 Optional adapter notifications (Telegram, Pushover, WhatsApp, Email, Signal, Matrix, Synology Chat)

> **Cloud-only** — no local gateway, Modbus, or LAN API required.

---

## 🧠 Architecture

```
ioBroker
   │
   │ HTTPS (REST)
   ▼
schlueter-thermostat Adapter
   │
   ├──► OWD5 Cloud API  (READ)
   │      - Groups
   │      - Thermostats
   │      - Temperatures
   │      - Modes
   │      - Schedule
   │      - Energy
   │
   └──► OCD5 Cloud API  (WRITE)
          - Setpoints
          - Modes
          - End times
          - Vacation
          - Thermostat name
```

---

## 🖥️ Device Manager (Admin)

The previous custom Admin tab was removed and replaced by the official ioBroker Admin **Device Manager**.

Each adapter instance is now listed in Device Manager and shows all thermostats of the instance there.

### Features

| Area | What you can do |
| ---- | --------------- |
| **Device list** | See all thermostats grouped by adapter group |
| **Card** | Online status, ID (serial number), model and live indicators: connection (cloud / relay / local, only with local control), heating, room and floor temperature, regulation mode, vacation (when set), energy. Energy: the cloud value (`energy.value0`); in local-only mode the estimated daily value (`energy.estimatedToday`), because the cloud gets no data then; in relay mode the estimate can be shown additionally. Each indicator can be shown or hidden in the toolbar |
| **Instance toolbar** | Cloud connection; with local control also the local gateway and the vendor gateway status |
| **Details (three-dot menu)** | Open thermostat details with an **Information** tab (Group ID, Thermostat ID, Model) and a **Controls** tab |
| **Control** | Set manual/comfort setpoints, trigger schedule/eco/manual/comfort apply actions, configure boost duration + apply, manage vacation settings, and rename the thermostat |

### Open Device Manager

1. Open ioBroker Admin
2. Open the **Device Manager** section
3. Expand your `schlueter-thermostat.X` instance
4. Use the three-dot menu on a thermostat card to open details/actions

---

## 🚀 How to Start

1. Install adapter in ioBroker
2. Open instance configuration
3. Enter:

| Setting           | Description                   |
| ----------------- | ----------------------------- |
| Username          | Your Schlüter/OJ cloud login  |
| Password          | Cloud password                |
| API Key           | Default works in most cases   |
| Customer ID       | Found in thermostat info      |
| Client SW Version | Numeric value from thermostat |
| Poll Interval     | Default: 60 seconds           |

4. Save & start adapter

---

## 🔄 Adapter Workflow

### On Startup

- Login to cloud
- Create object tree
- Start polling

### Poll Cycle

- Reads all Groups and Thermostats
- Updates temperatures, modes, setpoints
- Updates end times (comfort/boost)
- Reads schedule
- Reads energy values

### When You Press an Apply Button

- Adapter builds a **full UpdateThermostat payload**
- Sends to cloud
- Cloud forwards to thermostat

---

## 🧩 Object Structure

```
schlueter-thermostat.0
└─ groups
   └─ <GroupId>
      └─ thermostats
         └─ <ThermostatId>
```

---

## 📥 Readable States

| Category     | States                           |
| ------------ | -------------------------------- |
| Temperatures | Room, Floor                      |
| Setpoints    | Manual, Comfort                  |
| Modes        | RegulationMode                   |
| End Times    | Comfort, Boost                   |
| Vacation     | Enabled, Begin, End, Temperature |
| Schedule     | All days + events                |
| Energy       | kWh history values               |

---

## ✍ Writable States (Apply Concept)

Direct writes are **not used anymore**.  
All actions go through **Apply buttons**.

| Apply Mode           | Function                |
| -------------------- | ----------------------- |
| apply.schedule.apply | Activate schedule       |
| apply.comfort.apply  | Comfort mode + duration |
| apply.manual.apply   | Manual temperature      |
| apply.boost.apply    | Boost mode              |
| apply.eco.apply      | Eco mode                |
| apply.vacation.apply | Vacation settings       |
| apply.name.apply     | Rename thermostat       |

---

## 🔥 Regulation Modes

| Mode     | Number | Behavior                     |
| -------- | ------ | ---------------------------- |
| Schedule | 1      | Uses weekly schedule         |
| Comfort  | 2      | Temporary comfort temp       |
| Manual   | 3      | Fixed temperature            |
| Boost    | 8      | Temporary boost max. 60 Min. |
| Eco      | 9      | Energy saving mode           |

---

## ⏱ Time Handling

- End times are sent in **thermostat local time**
- No timezone suffix (no `Z`)
- Boost and Comfort durations supported (Boost max. 60 Min.)
- Thermostat timezone offset is respected

---

## ⚡ Energy

Each thermostat provides:

```
energy.count
energy.value0
energy.value1
...
```

Values start with **today**.

---

## 🛡 Stability & Safety

- Safe DB wrappers
- Poll protection (no overlapping polls)
- Offline detection
- Cloud connection monitoring
- Apply error handling
- Graceful shutdown
- Fallback polling (automatic backoff, see below)

---

## 🔁 Fallback Polling

When the cloud is unreachable or **all** thermostats are offline, the adapter automatically reduces polling frequency to conserve resources:

| Phase | Behavior |
| ----- | -------- |
| Normal | Polls at the configured interval (default: 60 s) |
| Backoff | On each consecutive failure the interval doubles (60 s → 120 s → 240 s → … → 1 h) |
| Fixed schedule | After reaching 1 h, polling switches to a fixed schedule at **12:00** and **00:00** |
| Recovery | As soon as at least one thermostat is online again, the interval resets to the configured value |

---

## Tab „Notification“

Activates Push-Notifications, to inform about device events. All Notifications will send in preconfigured system language.

### Notification Categories

| # | Category |
|---|---|
| 1 | **⚠️ Thermostat Offline** 
| 2 | **✅ Thermostat Online** 
| 3 | **⚠️ Cloud Connection lost**
| 4 | **✅ Cloud Connection restored** 


### Supported Providers

Each enabled provider supports an optional adapter instance selector (`type:instance`) in the instance config.
If left empty, the adapter automatically detects a running instance and prefers the lowest instance number (`.0`, `.1`, ...).

| Provider | Optional Configuration |
|---|---|
| **Telegram** | User or Chat-ID (optional) |
| **Pushover** | Title, Device (optional) |
| **WhatsApp** (`whatsapp-cmb`) | Phone Nr. (optional) |
| **E-Mail** | Receiver, Subject (optional) |
| **Signal** (`signal-cmb`) | Phone Nr. (optional) |
| **Matrix** (`matrix-org`) | No additional configuration |
| **Synology Chat** | Channelname (necessary) |

---

## 🏠 Local Control (BETA)

> ⚠️ **Experimental.** The device protocol is only documented for WG4-series thermostats.
> Whether WD5 thermostats (OWD5/MWD5) speak the same protocol is **not confirmed yet**.
> We are watching the behaviour during the beta and will react to feedback.

Besides the app cloud, the thermostat keeps its own TLS connection to the vendor's **device gateway**.
The adapter can provide that gateway itself. Nothing on the thermostat is modified – a local DNS record
redirects the connection to the ioBroker host. Deleting the record undoes everything.

### Status WD5 (OWD5/MWD5)

- TLS connection and framing are confirmed (TLS 1.2, AES256-SHA256), port **9513**.
- In **Relay** mode every message is forwarded unchanged and logged in readable form at debug level.
- Decoded: room and floor temperature, heating, regulation mode, comfort and manual setpoint, comfort and
  boost end, vacation, frost protection setpoint, name, firmware.
- Local commands (option "Send commands locally"): schedule, manual, comfort, boost, eco, frost protection,
  vacation.
  They are built exactly like the vendor cloud's commands; the thermostat then reports its new state to the
  cloud itself, so the app stays in sync.
- **Local only (test):** the adapter answers the thermostat itself (login, upload request, acknowledgements with
  server time); WD5 needs no recorded profile. App and cloud show the thermostat offline; in the adapter it
  counts as online while it is connected locally.
- **Relay without internet:** if the vendor cloud is unreachable, the adapter answers the thermostat itself
  as well and tries every 5 minutes to relay to the cloud again.
- If the network blocks DNS to external servers (typical with Pi-hole), the adapter uses DNS over HTTPS and
  remembers the last working IP. Alternatively enter the IP manually.

### Modes

| Mode | Vendor app | Internet down |
| --- | --- | --- |
| **Off** (default) | works | cloud only |
| **Relay** | works | values keep being read locally, local commands possible (if a profile exists) |
| **Local only** | shows offline | no change – the cloud is never contacted |

In **Relay** mode the connection is passed on unchanged to the vendor gateway and read along the way.
The two answers the vendor gateway sends after login are stored as **profile**. With it the adapter can answer
the thermostat itself afterwards ("Local only", or Relay without internet).

If the adapter does not understand the data (e.g. a different protocol on WD5), Relay mode falls back to a
**pure pass-through** and logs the traffic as hex at debug level. The thermostat keeps working as before –
please attach that debug log to an issue.

### Modes at a glance (tested with OWD5)

| Mode | Control via app | Control via adapter | Values in the adapter | Note |
| --- | --- | --- | --- | --- |
| **Off (cloud)** | ✔ | ✔ via the cloud | from the cloud | The DNS record must be removed, otherwise the thermostat is offline (the adapter warns on start). |
| **Relay** | ✔ | ✔ locally, app stays in sync | local, immediately | Recommended. Without internet the adapter takes over automatically. |
| **Local only** | ✘ app shows offline | ✔ locally | local | Cloud and app are no longer synchronised. |

There is **one** structure per thermostat (`groups.<G>.thermostats.<T>.*`), filled by the cloud and the local
connection together. While the thermostat is connected locally, the local values win and the cloud poll skips
those states; if the local connection drops, the cloud takes over again. Delivered locally: `online`, `heating`,
`temperature.*`, `regulationMode`, `setpoint.manual`, `setpoint.comfort`, `setpoint.frostProtection`,
`endTime.*`, `vacation.enabled`, `vacation.temperature`, `thermostatName`, `softwareVersion` and the schedule
`schedule.day<N>.event<N>.*`.

Local only:

- `connection`: `cloud`, `relay` or `local`.
- `energy.loadWatts`: heating load reported by the thermostat (e.g. 350 W).
- `energy.estimatedToday` / `energy.estimatedTotal`: **estimated** consumption from heating time × load. The
  thermostat reports no energy itself; it reports about once a minute whether it heats. Gaps over 5 minutes are
  not counted. The counter survives restarts. The cloud energy values (`energy.value<N>`) stay as they are.

**Cloud poll while connected locally:** while **all** thermostats are connected locally, the adapter polls the
cloud only at the interval "Cloud poll while connected locally" (default 300 s; 0 = normal interval). Locally the
thermostat sends its readings about once a minute and changes immediately; the cloud is then only needed for
energy and vacation dates. If a thermostat loses the local connection, the normal interval applies right away.

### Setup

1. Give the ioBroker host a fixed IP.
2. Find the hostname of the vendor gateway: look in the DNS log (router / Pi-hole / AdGuard) for queries of
   the thermostat to `*.ojelectronics.com` (observed so far: `owd5-sl003-thermostat.ojelectronics.com`, used as
   default). According to the manual the WD5 series uses port **9513**.
3. Add a DNS record: that hostname → IP of the ioBroker host.
4. In tab **Local (Beta)** choose **Relay**, enter hostname and port, save the instance.
5. Power-cycle the thermostat so it resolves the name again.
   Test it first with the **"Check DNS"** button: it shows where the hostname points from the ioBroker host and
   whether the port answers (with Docker using its own DNS it may report the cloud although the record works for
   the thermostat) (instance must be running; the test itself shows up as a short
   `TCP connection from …` in the log).
6. Check `schlueter-thermostat.0.info.local*`: `localListening`, `localConnected`, `localUpstreamStatus`,
   `localLastEvent`.

The real address of the vendor gateway is resolved via public DNS (1.1.1.1 / 8.8.8.8), or can be entered
manually. The vendor gateway certificate is pinned on first contact (fingerprint in `info.localUpstreamFingerprint`).
If it changes, nothing is forwarded any more.

**Checks and hints:**

- On start (relay / local only) the adapter checks how the hostname resolves **on the ioBroker host**
  (`DNS check – …`). This is only a hint: if the ioBroker host uses another DNS server than the thermostat
  (typical for Docker), the name points to the cloud there even though the thermostat is redirected correctly.
  What counts is whether the thermostat connects.
- If no thermostat connects within 10 minutes after the start, a warning is logged and – with notifications and
  "Thermostat offline" enabled – a notification is sent. As soon as a thermostat connects, the log confirms it.
- Mode "off" with the DNS record still active: warning on start.

**Several thermostats** (**not tested yet** on a real system with several devices – feedback welcome):

- One DNS record for all: every thermostat connects to the same hostname and port; the adapter recognises each by
  its serial number and maps it to the matching cloud device.
- Commands, values, energy counter, schedule and time zone are kept per thermostat; if one drops, the others stay
  local.
- The slower cloud poll applies only while **all** thermostats are connected locally.
- Check in the DNS log that **all** thermostats query the same hostname. In relay mode all are forwarded to the one
  configured host; the thermostats send no hostname (SNI), so the adapter cannot tell them apart beforehand.
- Port 9513 can be used by only one instance per host (one instance with any number of thermostats is fine).
- "Local only" accepts only thermostats the adapter knows from the cloud; a new device has to be added in the app
  and polled once first.

### Objects
### Objects

- `info.localListening`, `info.localUpstreamStatus`, `info.localUpstreamFingerprint`, `info.localConnected`,
  `info.localLastEvent`
- per thermostat: see above (shared structure with the cloud)

### Commands

With **"Send commands locally"** the apply commands go directly to the locally connected thermostat
(acknowledged, 10 s timeout): on WD5 schedule, manual, comfort, boost, eco, frost protection and vacation, on WG4
schedule and manual. On failure the cloud is used automatically. The name uses the cloud.

**Vacation (WD5):** "enabled", begin and end are set (`YYYY-MM-DD`, `YYYY-MM-DDT00:00:00` or `DD.MM.YYYY`). The
vacation temperature stays as the thermostat has it – like the cloud, which does not take over another value from
`apply.vacation.temperature` (observed: 18 °C set, 5 °C sent; the app does not offer a vacation temperature). If
the vacation has begun (begin ≤ today ≤ end), vacation mode is set at once – as observed with the cloud. If it lies
in the future, the mode is kept. Disabling a running vacation returns to the schedule (assumed, not observed yet).

In **Local only** mode no cloud command reaches the thermostat. Commands that cannot run locally (name, or all of
them with "Send commands locally" switched off) are therefore refused with a warning
(`Apply "…" blocked: …`).

### Notes

- Port 9513 must be free on the ioBroker host (Docker: host network or publish the port).
- Any device on the network can connect to the port – only use it on trusted networks.
- Certificate and profiles are stored in the instance data directory (`iobroker-data/schlueter-thermostat.0/`).
- Back to cloud: mode **Off**, delete the DNS record, power-cycle the thermostat.

---

## 🐞 Debugging

Set log level to **debug** to see cloud communication.

---

## 📌 Notes

- Developed and tested with a single thermostat
- Multi-device environments supported, but feedback welcome
