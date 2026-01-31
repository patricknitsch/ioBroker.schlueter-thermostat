┌──────────────────────────────────────────────────────────────────────────────┐
│ Adapter Start │
│ onReady() │
└──────────────────────────────────────────────────────────────────────────────┘
│
│ 1) Config prüfen
│ 2) client = new OJClient(...)
│ 3) client.login()
▼
┌───────────────────────┐
│ info.connection = true │
└───────────────────────┘
│
│ 4) create groups root
│ 5) optional legacyCleanup()
│ 6) pollOnce() + Timer
│ 7) subscribeStates('...apply._.apply')
▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ Poll Loop │
│ pollOnce() │
└──────────────────────────────────────────────────────────────────────────────┘
│
│ client.getGroupContents()
▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ For each Group (group) │
└──────────────────────────────────────────────────────────────────────────────┘
│
│ ensureGroupObjects() ──► creates:
│ groups.<gid> (device)
│ groups.<gid>.thermostats (channel)
▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ For each Thermostat (t) in group │
│ upsertThermostat(group, t) │
└──────────────────────────────────────────────────────────────────────────────┘
│
│ Cache:
│ - thermostatSerial[tid] = SerialNumber
│ - thermostatNameCache[tid] = ThermostatName
│ - thermostatTimeZoneSec[tid] = TimeZone (e.g. 3600)
▼
┌───────────────────────────────────────────┐
│ ensureThermostatObjects(devId, ...) │
│ creates read-only objects/states: │
│ .online .heating .thermostatName │
│ .temperature._ .setpoint._ .regulationMode│
│ .endTime._ .vacation._ .schedule .energy │
└───────────────────────────────────────────┘
│
▼
┌───────────────────────────────────────────┐
│ ensureApplyObjects(devId) │
│ creates writable apply states: │
│ .apply.schedule._ │
│ .apply.comfort._ │
│ .apply.manual._ │
│ .apply.boost._ │
│ .apply.eco._ │
│ .apply.name._ │
│ .apply.vacation._ │
└───────────────────────────────────────────┘
│
│ deleteOldWritableStates(devId) (1x)
│ offline transition warning
▼
┌───────────────────────────────────────────┐
│ time conversion (incoming) │
│ cloud EndTime -> thermostat local no-Z │
│ toThermostatLocalNoZFromAny(..., TZsec) │
└───────────────────────────────────────────┘
│
▼
┌───────────────────────────────────────────┐
│ writeThermostatStates() │
│ writes read-only states (ack=true) │
│ online/heating/temps/setpoints/mode │
│ endTime._ (local no-Z) │
│ vacation._ (read-only) │
└───────────────────────────────────────────┘
│
▼
┌───────────────────────────────────────────┐
│ prefillApplyNonDestructive() │
│ sets apply fields only if empty │
│ apply.name.value │
│ apply.vacation.\* │
└───────────────────────────────────────────┘
│
▼
┌───────────────────────────────────────────┐
│ writeScheduleStates() │
│ writeEnergyStates() │
└───────────────────────────────────────────┘

────────────────────────────────────────────────────────────────────────────────
User writes (apply-only)
────────────────────────────────────────────────────────────────────────────────

┌──────────────────────────────────────────────────────────────────────────────┐
│ onStateChange(id,state) │
└──────────────────────────────────────────────────────────────────────────────┘
│
│ only if: !state.ack AND id endsWith ".apply"
▼
┌───────────────────────────────────────────┐
│ Guard: thermostat online? │
│ offline -> reset button false (ack) │
└───────────────────────────────────────────┘
│
│ get SerialNumber (cache or object native)
▼
┌───────────────────────────────────────────┐
│ modeFolder = ...apply.<mode>.apply │
│ applyRouter({modeFolder,...}) │
└───────────────────────────────────────────┘
│
▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ Apply Handler Map │
│ (lib/apply-handlers.js) │
└──────────────────────────────────────────────────────────────────────────────┘
│ │ │ │ │ │ │
│schedule │comfort │manual │boost │eco │name │vacation
▼ ▼ ▼ ▼ ▼ ▼ ▼
updateThermostat(...) updateThermostat(...) updateThermostat(...) updateThermostat(...)
(RegMode=1) (RegMode=2 + EndTime) (RegMode=8 + EndTime) (Vacation\*)
EndTime outgoing:
nowPlusMinutesUtcNoZ(dur)
=> UTC without "Z" / without ms

                  │
                  ▼
        ┌───────────────────────────────────────────┐
        │ finally: reset apply button false (ack)    │
        └───────────────────────────────────────────┘

────────────────────────────────────────────────────────────────────────────────
Shutdown
────────────────────────────────────────────────────────────────────────────────

┌──────────────────────────────────────────────────────────────────────────────┐
│ onUnload() │
└──────────────────────────────────────────────────────────────────────────────┘
│
│ unloading=true, stop timer
│ wait for pollPromise (max 5s)
▼
callback()
