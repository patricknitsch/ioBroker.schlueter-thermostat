# ioBroker.schlueter-thermostat

Fußbodenheizung mit **Schlüter DITRA-HEAT / OJ Microline WD5** (OWD5 / MWD5) in ioBroker – über die Hersteller-Cloud
und optional **lokal im eigenen Netz** (Beta).

---

## 🌍 Überblick

- 🌡 Raum- und Bodentemperatur, Heizstatus
- 🎯 Sollwerte und Regelmodi (Zeitplan, Komfort, Manuell, Boost, Eco, Urlaub, Frostschutz)
- 📅 Wochenzeitplan, ⚡ Energieverbrauch
- 🖥️ Device Manager mit Live-Anzeige und kompakter Steuerung
- 🔔 Benachrichtigungen (Telegram, Pushover, WhatsApp, E-Mail, Signal, Matrix, Synology Chat)
- 🏠 **Lokale Steuerung (Beta):** Der Adapter übernimmt die Rolle des Hersteller-Gateways – schneller, und auf
  Wunsch ganz ohne Cloud

---

## 🧠 Architektur

```
                         ┌──────────────── Cloud (Standard) ────────────────┐
ioBroker ── Adapter ─────┤  OWD5-API (lesen) · OCD5-API (schreiben)         ├── Thermostat
            │            └──────────────────────────────────────────────────┘
            │
            └─ Lokales Gateway (Beta, Port 9513) ◄──── Thermostat (per DNS-Eintrag umgeleitet)
                  │
                  └─ Relay: leitet an die Hersteller-Cloud weiter (App funktioniert weiter)
```

Cloud und lokale Verbindung füllen **dieselben** Datenpunkte. Ist ein Thermostat lokal verbunden, kommen seine
Werte von dort – sofort statt per Abfrage.

---

## 🚀 Schnellstart

1. Adapter installieren und Instanz öffnen
2. Zugangsdaten eintragen:

| Einstellung | Hinweis |
| --- | --- |
| Username / Password | Login der Schlüter / OJ App |
| API Key | Standardwert funktioniert in der Regel |
| Customer ID | Standard: **3** |
| Poll interval | Standard: 60 s (mindestens 10 s) |

3. Speichern – die Thermostate erscheinen unter `groups.<Gruppe>.thermostats.<Thermostat>` und im Device Manager.

Lokale Steuerung einrichten: siehe [Lokale Steuerung](#-lokale-steuerung-beta).

---

## 🖥️ Device Manager

Admin → **Device Manager** → Instanz `schlueter-thermostat.X`. Jedes Thermostat ist eine Karte; das
Drei-Punkte-Menü öffnet die Steuerung.

### Karte

| Symbol | Bedeutung |
| --- | --- |
| <img src="../images/cloud.svg" width="20"> Cloud · <img src="../images/relay.svg" width="20"> Relay · <img src="../images/home.svg" width="20"> Lokal | Wie das Thermostat gerade verbunden ist |
| <img src="../images/fire.svg" width="20"> Heizt · <img src="../images/fire-off.svg" width="20"> Aus | Heizung aktiv |
| <img src="../images/thermometer.svg" width="20"> | Raumtemperatur |
| <img src="../images/floor.svg" width="20"> | Bodentemperatur |
| <img src="../images/target.svg" width="20"> | Sollwert des aktiven Modus (Eco 20 °C, Boost 35 °C, Urlaub/Frostschutz 5 °C, Zeitplan: aktueller Schaltpunkt) |
| <img src="../images/mode.svg" width="20"> | Regelmodus |
| <img src="../images/flight.svg" width="20"> | Urlaub geplant oder aktiv |
| <img src="../images/bolt.svg" width="20"> | Energie (Cloud; im Modus „Nur lokal“ geschätzt) |

Jeder Indikator lässt sich in der Toolbar ein- und ausblenden.

### Toolbar der Instanz

| Symbol | Bedeutung |
| --- | --- |
| <img src="../images/cloud-ok.svg" width="20"> / <img src="../images/cloud-error.svg" width="20"> | Adapter mit der Cloud verbunden / nicht verbunden |
| <img src="../images/home.svg" width="20"> **1** | Lokales Gateway: Anzahl lokal verbundener Thermostate |
| <img src="../images/home-warning.svg" width="20"> Kein Thermostat | Gateway läuft, aber kein Thermostat verbunden → DNS-Eintrag prüfen |
| <img src="../images/home-error.svg" width="20"> Aus | Gateway läuft nicht (z. B. Port belegt) |
| <img src="../images/relay.svg" width="20"> / <img src="../images/relay-warning.svg" width="20"> / <img src="../images/relay-error.svg" width="20"> | Nur Relay: Hersteller-Gateway verbunden / nicht erreichbar / Zertifikat nicht vertraut |

### Steuerung

Eine Seite mit Thermostat- und Seriennummer und je Funktion einer Zeile: **Manuell**, **Komfort** (mit Dauer),
**Boost** (Dauer), **Zeitplan / Eco**, **Urlaub** (aktiv, Beginn, Ende), **Name**.

---

## 🧩 Datenpunkte

Pro Thermostat: `groups.<Gruppe>.thermostats.<Thermostat>`

| Bereich | Datenpunkte |
| --- | --- |
| Status | `online`, `heating`, `connection` (cloud / relay / local), `regulationMode`, `thermostatName`, `softwareVersion` |
| Temperaturen | `temperature.room`, `temperature.floor` |
| Sollwerte | `setpoint.active`, `setpoint.manual`, `setpoint.comfort`, `setpoint.frostProtection` |
| Endzeiten | `endTime.comfort`, `endTime.boost` (Ortszeit des Thermostats) |
| Urlaub | `vacation.enabled`, `.begin`, `.end`, `.temperature` |
| Zeitplan | `schedule.day1` (Montag) … `day7`, je `event0…5` |
| Energie | `energy.value0…` (Cloud); mit lokaler Steuerung zusätzlich `energy.estimatedToday` / `estimatedTotal` (Heizzeit × Heizlast) und `energy.loadWatts` |

**Steuern** nur über die Apply-Ordner: Werte unter `apply.<modus>.*` setzen, dann `apply.<modus>.apply` auf
`true`.

| Modus | Nr. | Apply | Sollwert |
| --- | --- | --- | --- |
| Zeitplan | 1 | `apply.schedule` | aktueller Schaltpunkt |
| Komfort | 2 | `apply.comfort` | einstellbar, mit Dauer |
| Manuell | 3 | `apply.manual` | einstellbar |
| Urlaub | 4 | `apply.vacation` | 5 °C (fest im Gerät) |
| Frostschutz | 6 | – (am Gerät) | 5 °C |
| Boost | 8 | `apply.boost` | 35 °C, mit Dauer |
| Eco | 9 | `apply.eco` | 20 °C |
| Name | – | `apply.name` | – |

---

## 🔁 Abfrage und Fallback

| Situation | Cloud-Abfrage |
| --- | --- |
| Normal | im eingestellten Intervall (Standard 60 s) |
| Alle Thermostate **lokal** verbunden (Beta) | seltener, Standard alle 300 s – die Werte kommen lokal |
| Cloud nicht erreichbar oder **alle** Thermostate offline | Intervall verdoppelt sich bis 1 h, danach nur noch 12:00 und 00:00 |
| Ein Thermostat wieder erreichbar | sofort zurück zum normalen Intervall |

Ein lokal verbundenes Thermostat zählt als online – im Modus „Nur lokal“ gibt es also kein Fallback, nur weil die
Cloud das Gerät nicht sieht.

---

## 🔔 Benachrichtigungen

Tab **Benachrichtigungen**: Kanäle aktivieren (Telegram, Pushover, WhatsApp, E-Mail, Signal, Matrix,
Synology Chat). Ohne ausgewählte Instanz wird automatisch eine laufende genutzt.

| Meldung | Wann |
| --- | --- |
| ⚠️ / ✅ Thermostat offline / online | Erreichbarkeit des Thermostats ändert sich |
| ⚠️ / ✅ Cloud-Verbindung verloren / wiederhergestellt | Adapter erreicht die Cloud nicht mehr / wieder |
| ⚠️ / ✅ Lokale Verbindung verloren / wiederhergestellt | **Relay und Nur lokal:** Thermostat 2 min ohne lokale Verbindung, oder 10 min nach dem Start keines verbunden |

---

## 🏠 Lokale Steuerung (Beta)

> Bestätigt an einem **OWD5** (Firmware 1013W220) in allen Modi. Die WG4-Serie (Nordamerika) ist unterstützt,
> aber nicht an echter Hardware getestet. Rückmeldungen willkommen.

Das Thermostat hält eine eigene Verbindung zum **Geräte-Gateway** des Herstellers. Ein DNS-Eintrag leitet sie auf
den ioBroker-Host um – am Thermostat wird nichts verändert. DNS-Eintrag löschen = alles wie vorher.

### Modi

| Modus | App | Steuerung aus ioBroker | Ohne Internet |
| --- | --- | --- | --- |
| **Aus** | ✔ | über die Cloud | ✘ |
| **Relay** ⭐ | ✔ (synchron) | lokal, sofort | ✔ Adapter übernimmt automatisch |
| **Nur lokal** | ✘ (offline) | lokal, sofort | ✔ |

### Einrichtung

1. ioBroker-Host eine **feste IP** geben.
2. Im DNS (Pi-hole, AdGuard, Router) einen Eintrag anlegen:
   `owd5-sl003-thermostat.ojelectronics.com` → **IP des ioBroker-Hosts**
   (Hostname ggf. im DNS-Log des Thermostats nachsehen).
3. Tab **Lokal (Beta)**: Modus **Relay**, „Befehle lokal senden“ an, speichern.
4. Thermostat **stromlos neu starten**.
5. Toolbar prüfen: <img src="../images/home.svg" width="20"> **1** = verbunden.
   <img src="../images/home-warning.svg" width="20"> „Kein Thermostat“ = DNS-Eintrag greift nicht.

Der Button **„DNS prüfen“** zeigt, wohin der Name aus Sicht von ioBroker zeigt. Läuft ioBroker in Docker mit
eigenem DNS, kann dort „Cloud“ stehen, obwohl die Umleitung für das Thermostat funktioniert.

### Gut zu wissen

- **Lokal ausführbar:** Zeitplan, Manuell, Komfort, Boost, Eco, Urlaub. Der Name geht immer über die Cloud
  (im Modus „Nur lokal“ wird er abgelehnt).
- **Fehlschlag eines lokalen Befehls** → automatisch über die Cloud.
- **Energie im Modus „Nur lokal“** kommt nicht aus der Cloud, sondern wird aus Heizzeit × Heizlast geschätzt.
- **Port 9513** muss frei und vom Thermostat erreichbar sein (Docker: Port freigeben, VLAN: Firewall).
- **Mehrere Thermostate:** ein DNS-Eintrag für alle (noch nicht an mehreren echten Geräten getestet).
- **Zurück zur Cloud:** Modus „Aus“, DNS-Eintrag löschen, Thermostat neu starten. Bleibt der Eintrag aktiv,
  warnt der Adapter.
- **Sicherheit:** Jedes Gerät im Netz kann Port 9513 erreichen – nur im vertrauenswürdigen Netz nutzen.

---

## 🐞 Fehlersuche

| Problem | Lösung |
| --- | --- |
| Toolbar <img src="../images/home-warning.svg" width="20"> „Kein Thermostat“ | DNS-Eintrag aktiv? Thermostat stromlos neu gestartet? Port 9513 erreichbar? |
| Thermostat offline im Modus „Aus“ | DNS-Eintrag noch aktiv – löschen und Thermostat neu starten |
| Karte zeigt <img src="../images/cloud.svg" width="20"> Cloud trotz Relay | Thermostat ist nicht mit dem Adapter verbunden (siehe oben) |
| Details nötig | Loglevel **debug**: alle Cloud-Abfragen und – bei lokaler Steuerung – jede Nachricht (`Thermostat (…)` / `Vendor gateway (…)`) |
