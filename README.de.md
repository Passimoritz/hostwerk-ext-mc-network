![Minecraft-Servernetzwerk](banner.svg)

# Minecraft-Servernetzwerk

Mehrere Minecraft-Server hinter einer Adresse, Java- und Bedrock-Spieler zusammen – sicher eingerichtet und hält sich selbst aktuell.

[English](README.md) · Offizielle [Hostwerk](https://github.com/Passimoritz/hostwerk-public)-Erweiterung (native Erweiterung, ab Hostwerk 3.1; BungeeCord braucht Hostwerk 3.2)

![Bildschirmfoto](docs/screenshot.de.png)

Löst die Erweiterung **Bedrock-Brücke** und den Minecraft-Teil von **Spiele-Server-Verbund** ab (der bleibt für Spiele-Server allgemein).

## Die Bausteine, kurz erklärt

**Wo:** Minecraft → Netzwerk & Bedrock und Karte „Verbinden“ jedes Servers – seit 1.1.0 ohne eigenen Seitenleisten-Eintrag; die ganze Seite bleibt unter Erweiterungen → Öffnen

| Baustein | Was es ist | Wo es läuft |
|---|---|---|
| **Proxy** (Velocity, BungeeCord) | Die eine Adresse, mit der sich alle verbinden. Er prüft die Konten und schickt die Spieler auf deine Server (Lobby, Survival, Minispiele); mit `/server` wird gewechselt. | Eigener Server in Hostwerk. Von außen erreichbar ist nur der Proxy. |
| **Server hinter dem Proxy** | Normale Paper-/Purpur-/Folia-Server (mit Velocity auch Fabric/NeoForge). | Lauschen nur auf `127.0.0.1` und prüfen keine Konten selbst – sie vertrauen dem Proxy (Velocity beweist sich mit einem Geheimnis). |
| **Geyser** | Die eigentliche *Bedrock-Brücke*: übersetzt zwischen Bedrock Edition (Handy, Konsole, Windows) und Java, damit beide zusammen auf deinen Java-Servern spielen. | **Einmal am Proxy** für das ganze Netzwerk – oder auf einem einzelnen Server ohne Proxy. Nie auf den Servern hinter einem Proxy. |
| **Floodgate** | Lässt Bedrock-Spieler ohne Java-Konto herein. | Am Proxy **und** auf jedem Server dahinter, überall mit **demselben Schlüssel** – sonst werfen die Server Bedrock-Spieler raus. |
| **ViaVersion / ViaBackwards / ViaRewind** | Versions-Brücken: Spieler mit neuerer / älterer / sehr alter Minecraft-Version kommen hinein. | Auf jedem Server hinter dem Proxy (der Proxy selbst nimmt jede Version). |
| **Geyser Standalone** | Geyser als eigenes Programm vor einem Java-Server, der es nicht laden kann (Vanilla, Forge, eigene JARs). Ohne Floodgate brauchen Bedrock-Spieler ein Java-Konto (einmal anmelden). | Neben dem Server (`geyser-standalone/` in seinem Ordner), startet und stoppt mit ihm. |
| **Bedrock Dedicated Server** | Mojangs eigener Server für die Bedrock Edition: eigene Bedrock-Welt, nur Bedrock-Spieler, Add-ons und Redstone genau wie in Bedrock. Keine Java-Spieler. | Seit Hostwerk 3.x ein Servertyp des Kerns (Minecraft-Bereich: Konsole, Einstellungen, Welten, Sicherungen, Erlaubnisliste); bei älterem Hostwerk eigenes Programm auf dieser Seite. |

## Was sie kann

- **Netzwerke**: Velocity (empfohlen, „modern forwarding“ mit Geheimnis) oder BungeeCord (für Plugins, die es nur dafür gibt); neuer oder vorhandener Proxy, auf Wunsch mit Lobby (flach, Abenteuer, friedlich)
- **Server**: Reihenfolge (Lobby zuerst, dann die Ausweich-Reihenfolge), Name im Netzwerk, direkte Adressen je Server (forced hosts, z. B. `survival.example.org`), Wartung je Server (raus aus der Weiterleitung, Spieler in die Lobby, auf Wunsch Server stoppen)
- **Spieler & Rechte**: eine Whitelist, Operatoren und Sperren für jeden Server des Netzwerks (Java-Namen über Mojang, Bedrock-Namen über den Floodgate-Vorsatz); wer wo online ist, Spieler zwischen Servern verschieben
- **Proxy**: MOTD (zwei Zeilen), Server-Symbol (64 × 64 PNG), angezeigte Spielerzahl, Ping durchreichen, „zweite Anmeldung gewinnt“; Änderungen lädt ein laufender Proxy sofort (`velocity reload`/`greload`)
- **Starten/Stoppen der Reihe nach**: erst die Server (jeweils bis bereit), zuletzt der Proxy; Stoppen umgekehrt
- **Prüfung**: nur der Proxy erreichbar, Weiterleitungs-Schlüssel auf jedem Server, `server-ip=127.0.0.1`, `online-mode` richtig, Floodgate-Schlüssel überall
- **Adressen für Freunde**: Java und Bedrock, zu Hause und von außen (DynDNS, Fernzugriffs-Domain oder öffentliche IP), Freigabe über „Router & Portfreigaben“
- **Bedrock** – vier Wege nebeneinander: Geyser + Floodgate am Proxy, auf einem einzelnen Server, Geyser Standalone vor Vanilla/Forge/eigenen JARs oder ein eigener Bedrock Dedicated Server (angelegt im Minecraft-Bereich von Hostwerk, wenn Hostwerk den Typ kennt; ältere Server dieser Erweiterung ziehen mit einem Klick dorthin um – gleiche Welten, gleiche Ports)
- **NetherNet** (Bedrock 26.60 lässt RakNet am 27. Oktober 2026 fallen): Jeder Geyser – Proxy, Einzelserver, Standalone – läuft mit `transport: both`: RakNet für ältere Apps auf dem Bedrock-Port (UDP), die NetherNet-Anmeldung auf demselben Port über TCP und das Spiel über WebRTC auf einem eigenen UDP-Port (gewählt wie der Bedrock-Port, ohne Überschneidung). Vorhandene Konfigs stellt Hostwerk selbst um (kurz nach dem Start, in der Selbstwartung und vor jedem Start); was du bewusst eingestellt hast, bleibt (eigener Port, `nethernet` oder von Hand zurück auf `raknet`). Firewall und Router bekommen TCP und den neuen UDP-Port; die Server-Karte zeigt „NetherNet bereit“, sobald Geysers Anmeldung antwortet (`GET /v1/join`). Braucht Geyser-Build 1237 oder neuer – das normale Update bringt ihn.
- **Ohne Wartung** (alles auch unter Einstellungen → Selbstwartung):
  - Geyser/Floodgate aus der GeyserMC-Download-API mit SHA-256, vorbereitet und eingespielt, wenn niemand online ist; danach muss ein RakNet-Ping antworten – sonst kommen die vorigen JARs zurück und der Build wird übersprungen
  - Erst die Verträglichkeit: Spricht ein neues Geyser eine neuere Java-Version als ein Server, wartet das Update – oder installiert vorher ViaVersion auf diesem Server (abschaltbar)
  - Proxy-Builds (Velocity von PaperMC, BungeeCord vom Build-Server von SpigotMC mit MD5), wenn niemand online ist, mit Rückweg, falls der Proxy nicht bereit wird
  - Geyser Standalone aus der GeyserMC-Download-API (SHA-256): neuer Build eingesetzt, nur Geyser neu gestartet (der Java-Server läuft weiter), RakNet-Ping als Probe, sonst kommt die vorige JAR zurück
  - Bedrock Dedicated Server aus Mojangs offizieller Download-Liste: neue Version neben der alten entpackt, Welten und Einstellungen übernommen, Probe, Rückweg (bei Hostwerk 3.x übernimmt das der Kern)
  - ViaVersion & Co. über Hostwerks eigene Plugin-Updates (Modrinth)

## Umzug aus der „Bedrock-Brücke“

Kopiert wird nichts – die Daten bleiben, wo sie waren (`settings.minecraft.servers[].geyser`, `plugins/floodgate/key.pem`). Beim ersten Start liest die Erweiterung die echten Geyser-/Floodgate-Einstellungen, übernimmt vorhandene Velocity-Netzwerke und zeigt Geyser-Installationen hinter einem Proxy: **„Auf den Proxy umziehen“** legt Geyser mit **demselben UDP-Port** (Freunde behalten ihre Adresse) und **demselben Floodgate-Schlüssel** auf den Proxy. Hostwerk installiert diese Erweiterung von selbst für alle, die die Brücke genutzt haben, und entfernt die Brücke danach (seit 1.5.0, `"replaces": ["bedrock-bridge"]`).

## Installieren

In Hostwerk: **Erweiterungen → Entdecken** und „Installieren“ klicken. Native Erweiterungen laufen als Teil von Hostwerk; Hostwerk installiert sie nur aus dem offiziellen Katalog (mit Prüfsumme) oder im Entwickler-Modus.

## Daten

- `settings.mcNetwork` – Netzwerke, Bedrock Dedicated Server
- `settings.minecraft.servers[].geyser` / `.network` – Geyser-Zustand und Netzwerk-Zugehörigkeit (gemeinsam mit Hostwerks Kern)
- `<Hostwerk>/data/bedrock-servers/<id>` – Bedrock Dedicated Server

Entfernen der Erweiterung löscht nichts.

## Entwickeln

```bash
node --test tests/*.test.js          # Tests (ohne Java, ohne Server, ohne Netz – alles nachgebildet)
# echte Programme (Velocity, Geyser, Floodgate, BungeeCord, Geyser Standalone, Paper, BDS) – im Hostwerk-Repo:
node scripts/real-mc-probes.js       # nur ein Minecraft-Server zugleich: Backend-/BDS-Proben fallen aus, solange ein anderer läuft
node build-native.js .               # Oberfläche bauen (sdk/build-native.js aus hostwerk-public)
node check.js . --strict             # dieselbe Prüfung wie der Katalog (sdk/check.js)
```

Oberflächen-Quelltext in `ui/src`, Server-Teil in `server/`. Texte im Code sind Englisch, Deutsch steht in `locales/de.json`.

## Lizenz

MIT
