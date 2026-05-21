# ioBroker.schlueter-thermostat

Cloud‑Adapter für **Schlüter / OJ Microline OWD5 Thermostate**

---

## 🌍 Überblick

Dieser Adapter integriert **Schlüter / OJ Microline OWD5 Thermostate** über die **offiziellen Cloud‑APIs** in ioBroker.

Unterstützt werden:

- 🌡 Temperaturüberwachung
- 🎯 Sollwerte
- 🔄 Modussteuerung
- ⏱ Comfort‑ & Boost‑Timer
- 🏖 Urlaubsmodus
- 📅 Vollständige Zeitpläne
- ⚡ Energieverbrauchswerte
- 🔔 Optionale Adapter-Benachrichtigungen (Telegram, Pushover, WhatsApp, Email, Signal, Matrix, Synology Chat)

> **Nur Cloud** – kein lokales Gateway oder Modbus erforderlich.

---

## 🧠 Architektur

```
ioBroker
   │
   │ HTTPS (REST)
   ▼
schlueter-thermostat Adapter
   │
   ├──► OWD5 Cloud API  (LESEN)
   │      - Gruppen
   │      - Thermostate
   │      - Temperaturen
   │      - Modi
   │      - Zeitpläne
   │      - Energie
   │
   └──► OCD5 Cloud API  (SCHREIBEN)
          - Sollwerte
          - Modi
          - Endzeiten
          - Urlaub
          - Thermostatname
```

---

## 🖥️ Device Manager (Admin)

Der frühere eigene Admin-Tab wurde entfernt und durch den offiziellen ioBroker Admin **Device Manager** ersetzt.

Jede Adapterinstanz wird jetzt im Device Manager angezeigt und listet dort alle Thermostate der Instanz.

### Funktionen

| Bereich | Beschreibung |
| ------- | ------------ |
| **Geräteliste** | Alle Thermostate nach Adapter-Gruppe anzeigen |
| **Kachel** | Verbindungs-Icon auf der Kachel plus Zusammenfassung in den Kachel-Details (Raum-/Bodentemperatur, Heizen, Regelungsmodus, Verbrauch) |
| **Details (Drei-Punkte-Menü)** | Thermostat-Details mit den Tabs **Information** (Gruppen-ID, Thermostat-ID, Modell) und **Steuerung** öffnen |
| **Steuerung** | Manuell-/Komfort-Sollwert setzen, Schedule-/Eco-/Manual-/Comfort-Apply auslösen, Boost-Dauer + Apply setzen, Urlaub konfigurieren und den Thermostatnamen umbenennen |

### Device Manager öffnen

1. ioBroker Admin öffnen
2. Bereich **Device Manager** öffnen
3. Die gewünschte `schlueter-thermostat.X` Instanz aufklappen
4. Über das Drei-Punkte-Menü der Thermostat-Kachel Details/Aktionen öffnen

---

## 🚀 Schnellstart

1. Adapter in ioBroker installieren
2. Instanz öffnen
3. Folgende Daten eintragen:

| Einstellung       | Beschreibung                    |
| ----------------- | ------------------------------- |
| Username          | Cloud Login                     |
| Password          | Cloud Passwort                  |
| API Key           | Standard funktioniert meist     |
| Customer ID       | In den Thermostatinfos          |
| Client SW Version | Numerischer Wert vom Thermostat |
| Poll Interval     | Standard: 60 Sekunden           |

4. Speichern & starten

---

## 🔄 Funktionsweise

### Beim Start

- Login in Cloud
- Objektstruktur erstellen
- Polling starten

### Poll-Zyklus

- Gruppen & Thermostate lesen
- Temperaturen, Modi, Sollwerte aktualisieren
- Comfort/Boost Endzeiten aktualisieren
- Zeitpläne lesen
- Energiedaten lesen

### Beim Drücken eines Apply-Buttons

- Adapter baut vollständiges Update-Payload
- Sendet an Cloud
- Cloud überträgt an Thermostat

---

## 🧩 Objektstruktur

```
schlueter-thermostat.0
└─ groups
   └─ <GroupId>
      └─ thermostats
         └─ <ThermostatId>
```

---

## 📥 Lesbare Zustände

| Kategorie    | Zustände                       |
| ------------ | ------------------------------ |
| Temperaturen | Raum, Boden                    |
| Sollwerte    | Manual, Comfort                |
| Modi         | RegulationMode                 |
| Endzeiten    | Comfort, Boost                 |
| Urlaub       | Aktiv, Start, Ende, Temperatur |
| Zeitplan     | Alle Tage + Events             |
| Energie      | kWh Verlauf                    |

---

## ✍ Schreibbare Funktionen (Apply-Konzept)

Direktes Schreiben wird nicht mehr verwendet.  
Alle Aktionen laufen über **Apply‑Buttons**.

| Apply Modus          | Funktion              |
| -------------------- | --------------------- |
| apply.schedule.apply | Zeitplan aktivieren   |
| apply.comfort.apply  | Comfort mit Dauer     |
| apply.manual.apply   | Manuelle Temperatur   |
| apply.boost.apply    | Boost Modus           |
| apply.eco.apply      | Eco Modus             |
| apply.vacation.apply | Urlaubseinstellungen  |
| apply.name.apply     | Thermostat umbenennen |

---

## 🔥 Heizmodi

| Modus    | Nummer | Verhalten                   |
| -------- | ------ | --------------------------- |
| Schedule | 1      | Wochenplan                  |
| Comfort  | 2      | Temporär erhöhte Temperatur |
| Manual   | 3      | Feste Temperatur            |
| Boost    | 8      | Kurzzeit-Boost max. 60 Min. |
| Eco      | 9      | Energiesparmodus            |

---

## ⏱ Zeitbehandlung

- Endzeiten werden in **Thermostat‑Lokalzeit** gesendet
- Kein `Z` (kein UTC-Suffix)
- Boost & Comfort unterstützen variable Dauer (Boost max. 60 Min.)
- Thermostat‑Timezone wird berücksichtigt

---

## ⚡ Energie

Je Thermostat verfügbar:

```
energy.count
energy.value0
energy.value1
...
```

Werte beginnen mit **heutigem Tag**.

---

## 🛡 Stabilität

- Sichere DB‑Wrapper
- Poll‑Schutz
- Offline‑Erkennung
- Cloud‑Verbindungsüberwachung
- Fehlerbehandlung bei Apply
- Sauberes Shutdown
- Fallback-Polling (automatisches Backoff, siehe unten)

---

## 🔁 Fallback-Polling

Wenn die Cloud nicht erreichbar ist oder **alle** Thermostate offline sind, reduziert der Adapter automatisch die Abfragehäufigkeit:

| Phase | Verhalten |
| ----- | --------- |
| Normal | Abfrage im konfigurierten Intervall (Standard: 60 s) |
| Backoff | Bei jedem weiteren Fehler verdoppelt sich das Intervall (60 s → 120 s → 240 s → … → 1 h) |
| Fester Zeitplan | Nach Erreichen von 1 h wechselt die Abfrage auf einen festen Zeitplan um **12:00** und **00:00** |
| Wiederherstellung | Sobald mindestens ein Thermostat wieder online ist, wird das Intervall auf den konfigurierten Wert zurückgesetzt |

---

## Tab „Benachrichtigungen“

Aktiviere Push-Benachrichtigungen, um über Geräteereignisse informiert zu werden. Alle Meldungen werden in der in ioBroker konfigurierten Systemsprache verschickt.

### Benachrichtigungskategorien

| # | Kategorie |   
|---|---|
| 1 | **Thermostat Offline** 
| 2 | **Thermostat Online** 
| 3 | **Cloud Verbindung verloren**
| 4 | **Cloud Verbindung wieder hergestellt** 


### Unterstützte Anbieter

Für jeden aktivierten Anbieter kann in der Instanzkonfiguration optional eine Adapter-Instanz (`type:instance`) ausgewählt werden.
Wenn keine Instanz ausgewählt ist, erkennt der Adapter automatisch eine laufende Instanz und bevorzugt die kleinste Instanznummer (`.0`, `.1`, ...).

| Anbieter | Optionale Konfiguration |
|---|---|
| **Telegram** | Benutzer oder Chat-ID (optional) |
| **Pushover** | Titel, Gerät (optional) |
| **WhatsApp** (`whatsapp-cmb`) | Telefonnummer (optional) |
| **E-Mail** | Empfänger, Betreff (optional) |
| **Signal** (`signal-cmb`) | Telefonnummer (optional) |
| **Matrix** (`matrix-org`) | Keine weitere Konfiguration |
| **Synology Chat** | Kanalname (erforderlich) |

---

## 🐞 Debug

Loglevel **debug** aktivieren für Cloud‑Kommunikation.

## 📌 Notes

- Entwickelt und getestet mit einem Thermostat
- Umgebungen mit mehreren Geräten werden unterstützt, aber Feedback ist willkommen.
