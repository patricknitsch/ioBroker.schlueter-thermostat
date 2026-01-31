![Logo](admin/schlueter-thermostat.png)

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
| Boost    | 8      | Kurzzeit-Boost              |
| Eco      | 9      | Energiesparmodus            |

---

## ⏱ Zeitbehandlung

- Endzeiten werden in **Thermostat‑Lokalzeit** gesendet
- Kein `Z` (kein UTC-Suffix)
- Boost & Comfort unterstützen variable Dauer
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

---

## 🐞 Debug

Loglevel **debug** aktivieren für Cloud‑Kommunikation.

## 📌 Notes

- Entwickelt und getestet mit einem Thermostat
- Umgebungen mit mehreren Geräten werden unterstützt, aber Feedback ist willkommen.
