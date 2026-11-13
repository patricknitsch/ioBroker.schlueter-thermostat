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
| 1 | **⚠️ Thermostat Offline** 
| 2 | **✅ Thermostat Online** 
| 3 | **⚠️ Cloud Verbindung verloren**
| 4 | **✅ Cloud Verbindung wieder hergestellt** 


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

## 🏠 Lokale Steuerung (BETA)

> ⚠️ **Experimentell.** Das Geräteprotokoll ist nur für Thermostate der WG4-Serie dokumentiert.
> Ob WD5-Thermostate (OWD5/MWD5) dasselbe Protokoll sprechen, ist **noch nicht bestätigt**.
> Wir beobachten das Verhalten in der Beta und reagieren auf Rückmeldungen.

Das Thermostat hält neben der App-Cloud eine eigene TLS-Verbindung zum **Geräte-Gateway** des Herstellers offen.
Der Adapter kann dieses Gateway selbst bereitstellen. Am Thermostat wird nichts verändert – ein lokaler DNS-Eintrag
leitet die Verbindung auf den ioBroker-Host um. Wird der Eintrag gelöscht, ist alles wieder wie vorher.

### Stand WD5 (OWD5/MWD5)

- TLS-Verbindung und Framing sind bestätigt (TLS 1.2, AES256-SHA256), Port **9513**.
- Im **Relay**-Modus wird jede Nachricht unverändert weitergeleitet und lesbar im Debug-Log protokolliert.
- Dekodiert werden: Raum- und Bodentemperatur, Heizen, Regelmodus, Komfort- und Manuell-Sollwert,
  Komfort- und Boost-Ende, Urlaub, Frostschutz-Sollwert, Name, Firmware.
- Lokale Befehle (Option „Befehle lokal senden“): Zeitplan, Manuell, Komfort, Boost, Eco, Frostschutz.
  Sie werden exakt wie die Befehle der Hersteller-Cloud aufgebaut; das Thermostat meldet den neuen Zustand
  danach selbst an die Cloud, die App bleibt synchron.
- **Nur lokal (Test):** Der Adapter beantwortet das Thermostat selbst (Login, Upload-Aufforderung, Quittungen
  mit Serverzeit), ein aufgezeichnetes Profil ist bei WD5 nicht nötig. App und Cloud zeigen das Thermostat
  dann offline; im Adapter gilt es als online, solange es lokal verbunden ist.
- **Relay ohne Internet:** Ist die Hersteller-Cloud nicht erreichbar, beantwortet der Adapter das Thermostat
  ebenfalls selbst und versucht alle 5 Minuten, wieder an die Cloud weiterzuleiten.
- Blockiert das Netz DNS-Anfragen an externe Server (typisch bei Pi-hole), nutzt der Adapter DNS-over-HTTPS
  und merkt sich die zuletzt funktionierende IP. Alternativ die IP fest eintragen.

### Modi

| Modus | Hersteller-App | Bei Internetausfall |
| --- | --- | --- |
| **Aus** (Standard) | funktioniert | nur Cloud |
| **Relay** | funktioniert | Werte werden lokal weiter gelesen, Befehle lokal möglich (sofern Profil vorhanden) |
| **Nur lokal** | zeigt offline | keine Änderung – Cloud wird nie kontaktiert |

Im **Relay**-Modus wird die Verbindung unverändert an das Hersteller-Gateway weitergereicht und dabei mitgelesen.
Die zwei Antworten, die das Hersteller-Gateway nach dem Login schickt, werden als **Profil** gespeichert.
Mit diesem Profil kann der Adapter das Thermostat anschließend selbst beantworten („Nur lokal“ oder Relay ohne Internet).

Versteht der Adapter die Daten nicht (z. B. abweichendes Protokoll bei WD5), schaltet er im Relay-Modus auf
**reines Durchreichen** um und protokolliert den Datenverkehr als Hex im Debug-Log. Das Thermostat funktioniert dann
weiter wie bisher – bitte in diesem Fall das Debug-Log an ein Issue anhängen.

### Einrichtung

1. ioBroker-Host eine feste IP geben.
2. Hostnamen des Hersteller-Gateways ermitteln: im DNS-Log (Router / Pi-hole / AdGuard) nach Anfragen des
   Thermostats an `*.ojelectronics.com` suchen (bisher beobachtet: `owd5-sl003-thermostat.ojelectronics.com`,
   ist als Standard eingetragen). Laut Handbuch nutzt die WD5-Serie Port **9513**.
3. DNS-Eintrag anlegen: dieser Hostname → IP des ioBroker-Hosts.
4. Im Tab **Lokal (Beta)** Modus **Relay** wählen, Hostname und Port eintragen, Instanz speichern.
5. Thermostat stromlos neu starten, damit es den Namen neu auflöst.
6. Unter `schlueter-thermostat.0.local.*` prüfen: `listening`, `connected`, `upstreamStatus`, `lastEvent`.

Die echte Adresse des Hersteller-Gateways ermittelt der Adapter über öffentliches DNS (1.1.1.1 / 8.8.8.8),
alternativ kann sie fest eingetragen werden. Das Zertifikat des Hersteller-Gateways wird beim ersten Kontakt
gespeichert (Fingerabdruck in `local.upstreamFingerprint`). Ändert es sich, wird nichts mehr weitergeleitet.

### Objekte

- `local.listening`, `local.upstreamStatus`, `local.upstreamFingerprint`, `local.connected`, `local.lastEvent`
- pro Thermostat `…thermostats.<Id>.local.*`: `online`, `relayed`, `floorTemperature`, `heating`,
  `regulationMode`, `manualSetpoint`, `comfortSetpoint`, `targetTemperature`, `room`, `lastSeen`

### Befehle

Mit **„Zeitplan-/Manuell-Befehle lokal senden“** werden `apply.schedule` und `apply.manual` direkt an das
lokal verbundene Thermostat gesendet (mit Bestätigung, 10 s Timeout). Schlägt das fehl, wird automatisch die
Cloud verwendet. Alle anderen Modi (Komfort mit Endzeit, Boost, Eco, Urlaub, Name) laufen weiterhin über die Cloud.

### Hinweise

- Port 9513 muss auf dem ioBroker-Host frei sein (Docker: Host-Netzwerk oder Port freigeben).
- Jedes Gerät im Netz kann sich mit dem Port verbinden – nur in vertrauenswürdigen Netzen nutzen.
- Zertifikat und Profile liegen im Datenverzeichnis der Instanz (`iobroker-data/schlueter-thermostat.0/`).
- Zurück zur Cloud: Modus **Aus**, DNS-Eintrag löschen, Thermostat neu starten.

---

## 🐞 Debug

Loglevel **debug** aktivieren für Cloud‑Kommunikation.

## 📌 Notes

- Entwickelt und getestet mit einem Thermostat
- Umgebungen mit mehreren Geräten werden unterstützt, aber Feedback ist willkommen.
