# Ämtli – Grocy-Client als Home-Assistant-Add-on

Schlanke, installierbare PWA für **Einkaufszettel** und **Hausarbeiten**, die eure
bestehende **Grocy**-Instanz (HA-Add-on) über deren REST-API anspricht. V behält
das volle Grocy, M + Johannes bekommen die reduzierte Oberfläche – **eine
gemeinsame Datenbasis**.

Das Add-on liefert die PWA aus und **proxyt Grocy server-seitig** über das interne
`hassio`-Netz (`/grocy/`). Dadurch greift die App gleich-origin zu: kein Mixed
Content, kein CORS, kein Tailscale-Umweg für die Grocy-Anbindung.

---

## Was Ämtli kann (Version 2)

- **Einkauf:** Artikel eintippen (Vorschläge aus den Grocy-Produkten, Menge in der
  Einkaufs-Einheit), im Laden abhaken → „Im Wagen“, zu Hause **ein Tipp auf
  „N Sachen einsortieren“**: Ämtli bucht jede Produktzeile in den Grocy-Vorrat
  (Lager-Einheit, Haltbarkeit aus den Produkt-Defaults) und nimmt sie von der Liste.
  Danach 10 Minuten **Rückgängig**. Über „⋯“ an einer Wagen-Zeile lassen sich
  Menge, Haltbarkeit und Lagerort für diese eine Buchung anpassen.
- **Aufgaben:** Hausarbeiten nach Fälligkeit gruppiert, ein Tipp = erledigt (mit
  Rückgängig). Grocy berechnet die nächste Fälligkeit und rotiert die Zuweisung.
- **Robust:** Netzabbruch mitten im Einsortieren führt nie zu Doppelbuchungen
  (Journal + Abgleich mit Grocys Bestandsprotokoll), Fehler werden in Alltagssprache
  erklärt, jede Meldung hat eine Handlung. Offline zeigt Ämtli den letzten Stand.
- **Oberfläche:** helles und dunkles Design (folgt dem System, umschaltbar), große
  Touch-Ziele, Kontraste nach WCAG AA, Diagnose-Ansicht in den Einstellungen.

Ämtli legt bewusst **keine Produkte, Aufgaben oder Lagerorte an** – Stammdaten
pflegt V in Grocy. Wichtig für gute Ergebnisse: bei Produkten in Grocy die
**Standard-Haltbarkeit (Tage)** pflegen. Fehlt sie, bucht Ämtli „unbegrenzt
haltbar“ und sagt das im Ergebnis („ohne Haltbarkeitsdatum“).

---

## ⚠️ Voraussetzung: Grocy-Direktzugang aktivieren

Das Community-Grocy-Add-on ist intern abgeriegelt:

- Sein **Ingress-Port (8099)** lässt nur den HA-Supervisor zu (`allow 172.30.32.2; deny all;`).
  Andere Add-ons – auch dieses – bekommen dort **403**. Der API-Key hilft nicht.
- Erreichbar ist die API nur über den **Direktzugang (Port 80)**, und den rendert
  das Grocy-Add-on **nur, wenn Port 80 zugewiesen UND SSL aktiviert ist.**

**So aktivieren** (einmalig, im **Grocy-Add-on**):

1. Grocy-Add-on → **Konfiguration** → Abschnitt **Netzwerk**: dem Port **80** einen
   freien Host-Port zuweisen (z. B. `9192`).
2. SSL einschalten: Option **`ssl: true`** und ein Zertifikat in `/ssl` hinterlegen
   (`certfile`/`keyfile`). Ein Self-Signed genügt, da Ämtli das Upstream-Zertifikat
   nicht prüft (`proxy_ssl_verify off`).
3. Grocy-Add-on **neu starten**.

Danach ist Grocy intern unter `https://a0d7b954-grocy:80` erreichbar (Standardwert
der Option `grocy_upstream`). Anderer Slug → Hostnamen anpassen (Unterstriche →
Bindestriche, z. B. `a0d7b954_grocy` → `a0d7b954-grocy`).

---

## Installation des Ämtli-Add-ons

1. HA → **Einstellungen → Add-ons → Add-on Store** → oben rechts **⋮ → Repositories**
   → `https://github.com/JoFMiller/aemtli-ha-addon` hinzufügen.
2. **Ämtli** öffnen → **Installieren** → Optionen prüfen → **Starten**.
3. Updates: **⋮ → Nach Updates suchen** → Update.

(Alternativ als lokales Add-on: Inhalt von `addon/` nach `/addons/` kopieren.)

---

## Optionen

| Option | Standard | Bedeutung |
|---|---|---|
| `grocy_upstream` | `https://a0d7b954-grocy:80` | Interne Adresse des Grocy-Add-ons (Schema + Host + Port). |
| `ssl` | `true` | TLS **für den eigenen Direkt-Port 8080**. Mit Tailscale davor (empfohlen, siehe unten) auf `false` setzen – TLS macht dann Tailscale. |
| `certfile` | `fullchain.pem` | Zertifikat in `/ssl` (nur bei `ssl: true`). |
| `keyfile` | `privkey.pem` | Privater Schlüssel in `/ssl`. |
| `log_level` | `info` | Log-Ausführlichkeit. |

---

## Zugriff & PWA-Installation

Drei Wege, alle erreichen dieselbe App und dasselbe Grocy:

### A) Über Home Assistant (Ingress)
„Ämtli“ in der Seitenleiste / HA-App, hinter dem HA-Login. Praktisch für den
schnellen Blick. **Keine** Installation als eigene App möglich (Ingress-Session
läuft ab, Service Worker aus).

### B) Empfohlen: `https://aemtli.<tailnet>.ts.net/` per Tailscale Services
Ohne IP, ohne Port, echtes Zertifikat, nur per HA-Oberfläche und Tailscale-Admin-Konsole.
Voraussetzung: Tailscale-Add-on **≥ 0.29.0** (August 2026), HTTPS im Tailnet aktiv.

1. **Ämtli-Add-on → Konfiguration:** Netzwerk `8080/tcp` → Host-Port **8080**;
   Option `ssl: false`. Speichern, neu starten.
   (Port 8080 ist dann im Heim-LAN unverschlüsselt erreichbar – nur intern nutzen.)
2. **Tailscale-Admin-Konsole** (login.tailscale.com, Account des Tailnets):
   - **DNS:** MagicDNS an, **HTTPS Certificates** aktivieren.
   - **Access controls** (Policy-Datei) ergänzen – bestehende Regeln behalten:
     ```json
     "tagOwners":     { "tag:homeassistant": ["autogroup:admin"] },
     "autoApprovers": { "services": { "svc:aemtli": ["tag:homeassistant"] } },
     "grants": [ { "src": ["autogroup:member"], "dst": ["svc:aemtli"], "ip": ["tcp:443"] } ]
     ```
   - **Services** → „Define a service“: Name `aemtli`, Port 443 (HTTPS).
   - **Machines** → HA-Box → **⋯ → Edit ACL tags** → `tag:homeassistant`.
3. **Tailscale-Add-on → Konfiguration** (YAML):
   ```yaml
   advertise_tags:
     - "tag:homeassistant"
   services:
     - name: "svc:aemtli"
       target: "http://127.0.0.1:8080"
       protocol: "https"
       port: 443
   ```
   Speichern → Add-on neu starten → Log lesen („Advertising service host for svc:aemtli“).
   Zeigt das Log einen Login-Link (wegen des Tags), Link öffnen und bestätigen.
4. Admin-Konsole → Services → aemtli: Host muss **Active** sein (sonst „Approve“).
5. Handy (Tailscale verbunden): `https://aemtli.<tailnet>.ts.net/` öffnen → Schlüssel
   eintragen → Chrome „App installieren“ / iOS Safari „Zum Home-Bildschirm“.
   Erster Aufruf kann bis ~1 Minute dauern (Zertifikat wird ausgestellt).

Services gelten für **Mitglieder des Tailnets**. Wer die HA-Box nur per
Node-Sharing aus einem anderen Tailnet sieht, nutzt Weg C.

### C) Für geteilte Geräte: `https://<ha-box>.<tailnet>.ts.net/aemtli/`
Tailscale Services sind nur für Mitglieder des Tailnets sichtbar. Wer die HA-Box per
**Node-Sharing** aus einem anderen Tailnet sieht, erreicht Ämtli über den Namen der
Box. Dafür einmalig im Add-on **Advanced SSH & Web Terminal** (Protection Mode aus,
`ssh.password` gesetzt) im Web-Terminal:
```bash
docker ps --format '{{.Names}}' | grep tailscale        # Containername, z. B. app_a0d7b954_tailscale
docker exec -it app_a0d7b954_tailscale /opt/tailscale serve --bg --https=443 --set-path=/aemtli https+insecure://127.0.0.1:8099
docker exec -it app_a0d7b954_tailscale /opt/tailscale serve status
```
`8099` ist der **Host-Port**, der dem Ämtli-Port `8080/tcp` zugewiesen wurde (bei dir
kann er anders heißen). `https+insecure://` erlaubt es, `ssl: true` im Ämtli-Add-on zu
lassen; bei `ssl: false` stattdessen `http://127.0.0.1:<port>`.

Die Einstellung liegt im Tailscale-State (`/data/tailscaled.state`) und überlebt
Neustarts und Updates beider Add-ons; sie verschwindet nur beim Neuinstallieren des
Tailscale-Add-ons oder nach `tailscale serve reset`. Voraussetzungen: die Box ist
getaggt, in der Policy des besitzenden Tailnets erlaubt eine Regel den Gast
(`src: ["autogroup:shared"]` oder sein Login) auf `tag:…:443`, und
`share_homeassistant` bleibt **disabled** – es belegt Port 443 im Vordergrund und
verdeckt jeden Pfad dort (dann `share_on_port: 8443` für HA wählen). Tailscale
strippt den Pfad-Präfix, nginx bleibt auf Root; Ämtli leitet `…/aemtli` ohne
Schluss-Slash selbst um.

> PWA-Installation braucht einen **secure context** (vertrauenswürdiges HTTPS).
> Ein Self-Signed-Zertifikat auf dem Direkt-Port genügt zum Benutzen, aber nicht zum
> Installieren.

---

## Einrichten in der App

App öffnen → **persönlichen API-Key eintragen** (Grocy → Benutzermenü → „Manage API
keys“ → Add, am besten einer pro Person) → **Los geht's**. Die Grocy-Adresse muss
**nicht** eingetragen werden – das Add-on erledigt den Zugriff. Bei mehreren
Einkaufslisten fragt Ämtli einmal, welche eure ist.

Der API-Key bleibt nur auf dem jeweiligen Gerät (localStorage) und wird vom Proxy
unverändert an Grocy durchgereicht – **nicht** im Add-on gespeichert. iPhone: nach
„Zum Home-Bildschirm“ den Schlüssel in der installierten App noch einmal eintragen
(iOS trennt die Speicher von Safari und App).

---

## Funktionstest (im „Advanced SSH & Web Terminal“-Add-on)

```bash
# 1) Grocy-Direktport erreichbar? (eigenen Key einsetzen)
curl -sk -H "GROCY-API-KEY: <KEY>" https://a0d7b954-grocy:80/api/system/info
#    -> JSON mit grocy_version = OK.

# 2) Gegenprobe: Ingress-Port ist gesperrt (erwartet 403):
curl -s -o /dev/null -w "%{http_code}\n" http://a0d7b954-grocy:8099/api/system/info
```

Innerhalb des laufenden Ämtli-Add-ons lässt sich `/grocy/` analog testen:
`curl -s -H "GROCY-API-KEY: <KEY>" http://localhost:8099/grocy/api/system/info`.

---

## Fehlersuche

- **„Grocy ist gerade nicht erreichbar“:** Grocy-Direktport nicht aktiv → Voraussetzung
  oben prüfen (Port 80 + SSL, Grocy neu gestartet). Test (1) ausführen. Der Proxy
  antwortet in diesem Fall mit JSON und dem Header `X-Aemtli-Proxy: down`.
- **„Dein Grocy-Schlüssel gilt nicht mehr“:** Key in Grocy gelöscht/neu → Einstellungen →
  neuen Schlüssel eintragen.
- **„Home-Assistant-Anmeldung abgelaufen“:** Nur unter Ingress; Seite neu laden.
- **Add-on startet nicht / nginx-Fehler:** Bei `ssl: true` fehlt evtl. `/ssl/<certfile>`
  → Zertifikat hinterlegen oder `ssl: false` setzen (mit Tailscale davor).
- **PWA lässt sich nicht installieren:** Du bist über Ingress oder über ein
  Self-Signed-Zertifikat drin → Weg B/C oben.
- **Bestände stimmen nicht:** Einstellungen → „Hilfe & Diagnose“ → Diagnose kopieren
  und schicken. In Grocy zeigt das Bestandsprotokoll Ämtli-Buchungen mit der Notiz
  `aemtli:sl-<Zeile>`; jede lässt sich dort per „Rückgängig“ zurücknehmen.
- **Anderer Grocy-Slug/Port:** `grocy_upstream` anpassen.
