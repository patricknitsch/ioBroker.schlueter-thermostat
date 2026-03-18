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

## 🖥️ Admin-Tab

Jede Adapterinstanz stellt einen eigenen **Steuerungs-Tab** direkt in der ioBroker Admin-Oberfläche bereit.

![Admin-Tab Vorschau](https://github.com/user-attachments/assets/5426efe7-685b-4e7c-a77a-7860575d8f44)

### Funktionen

| Bereich | Beschreibung |
| ------- | ------------ |
| **Statusanzeige** | Echtzeit-Anzeige von Raumtemperatur, Fußbodentemperatur, Sollwert, Komfort-Sollwert, Energieverbrauch heute (kWh), Heizbetrieb, Regulierungsmodus und Online/Offline-Status |
| **Schnellmodi** | Ein-Klick-Umschaltung auf *Zeitplan* (Schedule), *Eco* oder *Frostschutz* |
| **Temperatursteuerung** | Manuellen Sollwert setzen, Komfort-Modus (Sollwert + Dauer) oder Boost-Modus (Dauer) aktivieren |
| **Urlaub** | Urlaubsmodus mit Start-/Enddatum und Zieltemperatur aktivieren |
| **Thermostatname** | Thermostat direkt aus der Oberfläche umbenennen |
| **Wochenplan** | Nur-Lese-Ansicht des aktuellen Wochenplans (einklappbare Tages-Ereignisliste) |
| **Konfiguration** | Schaltfläche, die die Instanzkonfiguration direkt öffnet |

### Sprache

Der Tab erkennt die Admin-Sprache automatisch und zeigt alle Beschriftungen auf **Deutsch** (Standard) oder Englisch.

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

## 🐞 Debug

Loglevel **debug** aktivieren für Cloud‑Kommunikation.

## 📌 Notes

- Entwickelt und getestet mit einem Thermostat
- Umgebungen mit mehreren Geräten werden unterstützt, aber Feedback ist willkommen.
