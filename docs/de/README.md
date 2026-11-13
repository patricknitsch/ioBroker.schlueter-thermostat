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
| **Kachel** | Online-Status, ID (Seriennummer), Modell und Live-Indikatoren: Verbindung (Cloud / Relay / Lokal), Heizen, Raum- und Bodentemperatur, Sollwert des aktiven Modus (`setpoint.active`: Komfort, Manuell, Urlaub und Frostschutz aus ihren States (Urlaub/Frostschutz 5 °C), Eco fest 20 °C, Boost fest 35 °C; im Zeitplan der Wert des aktuellen Schaltpunkts – `day1` = Montag, Ortszeit des Thermostats), Regelmodus, Urlaub (wenn aktiv), Energie. Energie: Cloud-Wert (`energy.value0`); im Modus „Nur lokal“ der geschätzte Tageswert (`energy.estimatedToday`), weil die Cloud dann keine Daten bekommt; im Relay ist der Schätzwert zusätzlich einblendbar. Jeder Indikator kann in der Toolbar ein- oder ausgeblendet werden |
| **Toolbar der Instanz** | Cloud-Verbindung des Adapters; mit lokaler Steuerung das lokale Gateway (grün mit Anzahl verbundener Thermostate, orange „Kein Thermostat“ = Gateway läuft, aber die DNS-Umleitung greift nicht, rot „Aus“), im Relay zusätzlich der Status des Hersteller-Gateways |
| **Details (Drei-Punkte-Menü)** | Kompakte Steuerseite: oben Thermostat-Nummer und Seriennummer, darunter je Funktion eine Zeile mit Eingabefeldern und kleinem Button |
| **Steuerung** | Manuell (Sollwert), Komfort (Sollwert + Dauer), Boost (Dauer), Modus Zeitplan / Eco, Urlaub (aktiv, Beginn, Ende), Name. Die Urlaubstemperatur fehlt bewusst: WD5 nutzt immer 5 °C |

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
| Customer ID       | In den Thermostatinfos (Standard: 3) |
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
| 5 | **⚠️ Lokale Verbindung verloren** (nur mit lokaler Steuerung; nach 2 Minuten ohne Verbindung, auch „seit 10 Minuten kein Thermostat verbunden“)
| 6 | **✅ Lokale Verbindung wiederhergestellt** (nur nach einer Meldung „verloren“)


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

> ⚠️ **Beta.** Bestätigt an einem OWD5 (WD5-Serie, Firmware 1013W220) in allen drei Modi. Die WG4-Serie
> (Nordamerika) wird unterstützt, ist an echter Hardware aber noch nicht getestet. Wir beobachten das Verhalten
> in der Beta und reagieren auf Rückmeldungen.

Das Thermostat hält neben der App-Cloud eine eigene TLS-Verbindung zum **Geräte-Gateway** des Herstellers offen.
Der Adapter kann dieses Gateway selbst bereitstellen. Am Thermostat wird nichts verändert – ein lokaler DNS-Eintrag
leitet die Verbindung auf den ioBroker-Host um. Wird der Eintrag gelöscht, ist alles wieder wie vorher.

### Stand WD5 (OWD5/MWD5)

- TLS-Verbindung und Framing sind bestätigt (TLS 1.2, AES256-SHA256), Port **9513**.
- Im **Relay**-Modus wird jede Nachricht unverändert weitergeleitet und lesbar im Debug-Log protokolliert.
- Dekodiert werden: Raum- und Bodentemperatur, Heizen, Regelmodus, Komfort- und Manuell-Sollwert,
  Komfort- und Boost-Ende, Urlaub, Frostschutz-Sollwert, Name, Firmware.
- Lokale Befehle (Option „Befehle lokal senden“): Zeitplan, Manuell, Komfort, Boost, Eco, Frostschutz, Urlaub.
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

### Überblick der Modi (getestet mit OWD5)

| Modus | Steuerung über App | Steuerung über Adapter | Werte im Adapter | Hinweis |
| --- | --- | --- | --- | --- |
| **Aus (Cloud)** | ✔ | ✔ über die Cloud | aus der Cloud | Der DNS-Eintrag muss gelöscht sein, sonst ist das Thermostat offline (der Adapter warnt beim Start). |
| **Relay** | ✔ | ✔ lokal, App bleibt synchron | lokal, sofort | Empfohlener Dauerbetrieb. Ohne Internet übernimmt der Adapter automatisch. |
| **Nur lokal** | ✘ App zeigt offline | ✔ lokal | lokal | Cloud und App werden nicht mehr synchronisiert. |

Es gibt **eine** Struktur pro Thermostat (`groups.<G>.thermostats.<T>.*`), die Cloud und lokale Verbindung
gemeinsam befüllen. Solange das Thermostat lokal verbunden ist, gewinnen die lokalen Werte und die Cloud-Abfrage
überspringt diese States; bricht die lokale Verbindung ab, übernimmt wieder die Cloud. Lokal geliefert werden:
`online`, `heating`, `temperature.*`, `regulationMode`, `setpoint.manual`, `setpoint.comfort`,
`setpoint.frostProtection`, `endTime.*`, `vacation.enabled`, `vacation.temperature`, `thermostatName`,
`softwareVersion` und der Zeitplan `schedule.day<N>.event<N>.*`.

Nur lokal verfügbar:

- `connection`: `cloud`, `relay` oder `local`.
- `energy.loadWatts`: Heizlast laut Thermostat (z. B. 350 W).
- `energy.estimatedToday` / `energy.estimatedTotal`: **geschätzter** Verbrauch aus Heizzeit × Heizlast. Das
  Thermostat meldet selbst keine Energie; es meldet etwa minütlich, ob es heizt. Lücken über 5 Minuten werden
  nicht gezählt. Der Zähler übersteht Neustarts. Die Cloud-Energiewerte (`energy.value<N>`) bleiben unverändert.

**Cloud-Abfrage bei lokaler Verbindung:** Solange **alle** Thermostate lokal verbunden sind, fragt der Adapter
die Cloud nur noch im Abstand „Cloud-Abfrage bei lokaler Verbindung“ ab (Standard 300 s; 0 = normales
Intervall). Lokal liefert das Thermostat Messwerte selbst etwa minütlich und Änderungen sofort; die Cloud wird
dann nur noch für Energie und Urlaubsdaten gebraucht. Verliert ein Thermostat die lokale Verbindung, wird sofort
wieder im normalen Takt abgefragt.

### Einrichtung

1. ioBroker-Host eine feste IP geben.
2. Hostnamen des Hersteller-Gateways ermitteln: im DNS-Log (Router / Pi-hole / AdGuard) nach Anfragen des
   Thermostats an `*.ojelectronics.com` suchen (bisher beobachtet: `owd5-sl003-thermostat.ojelectronics.com`,
   ist als Standard eingetragen). Laut Handbuch nutzt die WD5-Serie Port **9513**.
3. DNS-Eintrag anlegen: dieser Hostname → IP des ioBroker-Hosts.
4. Im Tab **Lokal (Beta)** Modus **Relay** wählen, Hostname und Port eintragen, Instanz speichern.
5. Thermostat stromlos neu starten, damit es den Namen neu auflöst.
   Vorher mit dem Button **„DNS prüfen“** testen: Er zeigt, auf welche Adresse der Hostname aus Sicht des
   ioBroker-Hosts zeigt und ob der Port antwortet (bei Docker mit eigenem DNS kann er „Cloud“ melden, obwohl der
   Eintrag für das Thermostat greift) (Instanz muss laufen; im Log erscheint dabei eine kurze
   `TCP connection from …` des Tests selbst).
6. Unter `schlueter-thermostat.0.info.local*` prüfen: `localListening`, `localConnected`, `localUpstreamStatus`,
   `localLastEvent`.

Die echte Adresse des Hersteller-Gateways ermittelt der Adapter über öffentliches DNS (1.1.1.1 / 8.8.8.8),
alternativ kann sie fest eingetragen werden. Das Zertifikat des Hersteller-Gateways wird beim ersten Kontakt
gespeichert (Fingerabdruck in `info.localUpstreamFingerprint`). Ändert es sich, wird nichts mehr weitergeleitet.

**Prüfungen und Hinweise:**

- Beim Start (Relay / Nur lokal) prüft der Adapter, wie der Hostname **auf dem ioBroker-Host** aufgelöst wird
  (`DNS check – …`). Das ist nur ein Hinweis: Nutzt der ioBroker-Host einen anderen DNS-Server als das Thermostat
  (typisch bei Docker), zeigt der Name dort auf die Cloud, obwohl das Thermostat korrekt umgeleitet wird.
  Entscheidend ist, ob sich das Thermostat verbindet.
- Verbindet sich 10 Minuten nach dem Start kein Thermostat, kommt eine Warnung und – bei aktiven
  Benachrichtigungen und „Thermostat offline“ – eine Nachricht. Sobald ein Thermostat verbindet, wird das im Log
  bestätigt.
- Modus „Aus“ mit noch aktivem DNS-Eintrag: Wurde die lokale Steuerung schon einmal benutzt, lauscht der Adapter
  passiv auf dem Gateway-Port. Versucht sich ein Thermostat dort zu verbinden, kommt eine Warnung (und ggf. eine
  Nachricht): Der DNS-Eintrag leitet es noch hierher, es erreicht die Cloud nicht. Das funktioniert auch, wenn der
  ioBroker-Host einen anderen DNS-Server nutzt (Docker).

**Mehrere Thermostate** (an einem echten System mit mehreren Geräten **noch nicht getestet** – Rückmeldungen
willkommen):

- Ein DNS-Eintrag für alle: alle Thermostate verbinden sich auf denselben Hostnamen und Port; der Adapter
  erkennt jedes an seiner Seriennummer und ordnet es dem passenden Gerät der Cloud zu.
- Befehle, Werte, Energiezähler, Zeitplan und Zeitzone sind pro Thermostat getrennt; fällt eines aus, laufen die
  anderen lokal weiter.
- Die seltenere Cloud-Abfrage greift nur, wenn **alle** Thermostate lokal verbunden sind.
- Bitte im DNS-Log prüfen, ob **alle** Thermostate denselben Hostnamen anfragen. Im Relay werden alle an den
  einen eingetragenen Host weitergeleitet; die Thermostate senden keinen Hostnamen mit (SNI), daher kann der
  Adapter sie vorher nicht unterscheiden.
- Port 9513 kann pro Rechner nur von einer Instanz genutzt werden (eine Instanz mit beliebig vielen Thermostaten
  ist kein Problem).
- „Nur lokal“ lässt nur Thermostate zu, die der Adapter aus der Cloud kennt; ein neues Gerät muss also zuerst in
  der App angelegt und einmal abgerufen worden sein.

### Objekte
### Objekte

- `info.localListening`, `info.localUpstreamStatus`, `info.localUpstreamFingerprint`, `info.localConnected`,
  `info.localLastEvent`
- pro Thermostat: siehe oben (gemeinsame Struktur mit der Cloud)

### Befehle

Mit **„Befehle lokal senden“** gehen die Apply-Befehle direkt an das lokal verbundene Thermostat (mit
Bestätigung, 10 s Timeout): bei WD5 Zeitplan, Manuell, Komfort, Boost, Eco, Frostschutz und Urlaub, bei WG4 Zeitplan und
Manuell. Schlägt das fehl, wird automatisch die Cloud verwendet. Der Name läuft über die Cloud.

**Urlaub (WD5):** gesetzt werden „aktiv“, Beginn und Ende (`YYYY-MM-DD`, `YYYY-MM-DDT00:00:00` oder
`TT.MM.JJJJ`). Die Urlaubstemperatur bleibt wie im Thermostat – genau wie bei der Cloud, die einen anderen Wert in
`apply.vacation.temperature` nicht übernimmt (beobachtet: 18 °C eingestellt, 5 °C gesendet; in der App ist die
Urlaubstemperatur nicht einstellbar). Hat der Urlaub schon begonnen (Beginn ≤ heute ≤ Ende), wird sofort der
Urlaubsmodus gesetzt – wie bei der Cloud beobachtet. Liegt er in der Zukunft, bleibt der Modus unverändert.
Wird ein laufender Urlaub deaktiviert, geht das Thermostat in den Zeitplan (Annahme, noch nicht beobachtet).

Im Modus **Nur lokal** erreicht kein Cloud-Befehl das Thermostat. Befehle, die nicht lokal ausgeführt werden können
(Name, oder alle bei ausgeschalteter Option „Befehle lokal senden“), werden deshalb mit einer Warnung
abgelehnt (`Apply "…" blocked: …`).

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
