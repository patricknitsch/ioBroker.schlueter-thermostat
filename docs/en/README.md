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
| **Card** | Connection icon on the card plus summary values in card details (room/floor temperature, heating, regulation mode, consumption) |
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

### Setup

1. Give the ioBroker host a fixed IP.
2. Find the hostname of the vendor gateway: look in the DNS log (router / Pi-hole / AdGuard) for queries of
   the thermostat to `*.ojelectronics.com`. According to the manual the WD5 series uses port **9513**.
3. Add a DNS record: that hostname → IP of the ioBroker host.
4. In tab **Local (Beta)** choose **Relay**, enter hostname and port, save the instance.
5. Power-cycle the thermostat so it resolves the name again.
6. Check `schlueter-thermostat.0.local.*`: `listening`, `connected`, `upstreamStatus`, `lastEvent`.

The real address of the vendor gateway is resolved via public DNS (1.1.1.1 / 8.8.8.8), or can be entered
manually. The vendor gateway certificate is pinned on first contact (fingerprint in `local.upstreamFingerprint`).
If it changes, nothing is forwarded any more.

### Objects

- `local.listening`, `local.upstreamStatus`, `local.upstreamFingerprint`, `local.connected`, `local.lastEvent`
- per thermostat `…thermostats.<Id>.local.*`: `online`, `relayed`, `floorTemperature`, `heating`,
  `regulationMode`, `manualSetpoint`, `comfortSetpoint`, `targetTemperature`, `room`, `lastSeen`

### Commands

With **"Send schedule/manual commands locally"** `apply.schedule` and `apply.manual` are sent directly to the
locally connected thermostat (acknowledged, 10 s timeout). On failure the cloud is used automatically.
All other modes (comfort with end time, boost, eco, vacation, name) still use the cloud.

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
