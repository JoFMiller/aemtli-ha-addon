# Ämtli – Grocy-Client als Home-Assistant-Add-on

Schlanke, installierbare PWA für **Einkaufszettel** und **Hausarbeiten**, die eure
bestehende **Grocy**-Instanz (HA-Add-on) über deren REST-API anspricht. V behält
das volle Grocy, M + Johannes bekommen die reduzierte Oberfläche – **eine
gemeinsame Datenbasis**.

Das Add-on liefert die PWA aus und **proxyt Grocy server-seitig** über das interne
`hassio`-Netz (`/grocy/`). Dadurch greift die App gleich-origin zu: kein Mixed
Content, kein CORS, kein rotierender Ingress-Token, kein Tailscale-Umweg.

---

## ⚠️ Wichtige Voraussetzung: Grocy-Direktzugang aktivieren

Das Community-Grocy-Add-on ist intern abgeriegelt:

- Sein **Ingress-Port (8099)** lässt nur den HA-Supervisor zu (`allow 172.30.32.2; deny all;`).
  Andere Add-ons – auch dieses – bekommen dort **403**. Der API-Key hilft nicht.
- Erreichbar ist die API nur über den **Direktzugang (Port 80)**, und den rendert
  das Grocy-Add-on **nur, wenn Port 80 zugewiesen UND SSL aktiviert ist.**

> Das ist auch der Grund, falls ein früherer „Direktport ohne SSL" mit
> *Connection refused* scheiterte: ohne SSL startet Grocy den Direkt-Serverblock
> gar nicht.

**So aktivieren** (einmalig, im **Grocy-Add-on**):

1. Grocy-Add-on → **Konfiguration** → Abschnitt **Netzwerk**: dem Port **80** einen
   freien Host-Port zuweisen (z. B. `9192`).
2. SSL einschalten: Option **`ssl: true`** und ein Zertifikat in `/ssl` hinterlegen
   (`certfile`/`keyfile`). Wer keins hat, erzeugt ein Self-Signed – das genügt, da
   Ämtli das Upstream-Zertifikat nicht prüft (`proxy_ssl_verify off`).
3. Grocy-Add-on **neu starten**.

Danach ist Grocy intern unter `https://a0d7b954-grocy:80` erreichbar (Standardwert
der Option `grocy_upstream`). Falls dein Grocy-Add-on einen anderen Slug hat, den
Hostnamen anpassen (Unterstriche → Bindestriche, z. B. `a0d7b954_grocy` →
`a0d7b954-grocy`).

---

## Installation des Ämtli-Add-ons

Da es ein **lokales** Add-on ist:

1. Den **Inhalt des `addon/`-Ordners** (also `repository.yaml` + den Ordner
   `aemtli/`) in das HA-Verzeichnis **`/addons/`** kopieren (Samba- oder
   SSH/„Advanced SSH & Web Terminal"-Add-on). Ergebnis: `/addons/aemtli/config.yaml`.
2. HA → **Einstellungen → Add-ons → Add-on Store** → oben rechts **⋮ → Repositories
   neu laden** (bzw. „Check for updates"). Unter **Local add-ons** erscheint **Ämtli**.
3. **Ämtli** öffnen → **Installieren** → Optionen prüfen → **Starten**.

---

## Optionen

| Option | Standard | Bedeutung |
|---|---|---|
| `grocy_upstream` | `https://a0d7b954-grocy:80` | Interne Adresse des Grocy-Add-ons (Schema + Host + Port). Bei `ssl: false` in Grocy: `http://…:80`. |
| `ssl` | `true` | TLS **für die eigenständige PWA** (Direkt-Port 8080). Für die Installierbarkeit auf dem Handy nötig. |
| `certfile` | `fullchain.pem` | Zertifikat in `/ssl` (nur bei `ssl: true`). |
| `keyfile` | `privkey.pem` | Privater Schlüssel in `/ssl`. |
| `log_level` | `info` | Log-Ausführlichkeit. |

> `ssl` betrifft **nur** den eigenen Direkt-Port der PWA, nicht den Grocy-Upstream.

---

## Zugriff & PWA-Installation

Es gibt zwei Wege – beide erreichen dieselbe App und dasselbe Grocy:

- **Über Home Assistant (Ingress):** „Ämtli" erscheint in der Seitenleiste / HA-App,
  läuft hinter dem HA-Login. Praktisch für den schnellen Blick. **Keine** eigenständige
  Home-Screen-Installation (rotierender Ingress-Token; Service Worker aus).
- **Eigenständige, installierbare PWA (Direkt-Port 8080):** Dafür dem Add-on in den
  **Add-on-Einstellungen → Netzwerk** dem Port **8080** einen Host-Port zuweisen.
  Aufruf über **HTTPS** (`ssl: true`):
  - direkt `https://<ha-host>:<port>/` **mit gültigem Zertifikat in `/ssl`**, oder
  - hübscher per Tailscale: auf der HA-Box `tailscale serve` vor den Add-on-Port
    legen → `https://<host>.<tailnet>.ts.net/` mit vertrauenswürdigem `*.ts.net`-Zert.
  Dann im Browser **Menü → „App installieren"** bzw. iOS **Teilen → „Zum Home-Bildschirm"**.

> PWA-Installation/Service Worker brauchen einen **secure context** (gültiges HTTPS).
> Ein nicht vertrautes Self-Signed-Zertifikat verhindert die Installation – dann
> Tailscale/Let's-Encrypt nutzen.

---

## Einrichten in der App

App öffnen → **Einstellungen** → **persönlichen API-Key** eintragen (Grocy → „Manage
API keys", am besten ein eigener pro Person) → **Verbindung testen & speichern**. Die
Grocy-Adresse muss **nicht** eingetragen werden – das Add-on erledigt den Zugriff.

Der API-Key bleibt nur auf dem jeweiligen Gerät (localStorage) und wird vom Proxy
unverändert an Grocy durchgereicht – **nicht** im Add-on gespeichert.

---

## Funktionstest (im „Advanced SSH & Web Terminal"-Add-on)

```bash
# 1) Grocy-Direktport erreichbar? (eigenen Key einsetzen)
curl -sk -H "GROCY-API-KEY: <KEY>" https://a0d7b954-grocy:80/api/system/info
#    -> JSON mit grocy_version = OK.  (bei ssl:false: http:// statt https://)

# 2) Gegenprobe: Ingress-Port ist gesperrt (erwartet 403):
curl -s -o /dev/null -w "%{http_code}\n" http://a0d7b954-grocy:8099/api/system/info
```

Innerhalb des laufenden Ämtli-Add-ons lässt sich `/grocy/` analog testen:
`curl -s -H "GROCY-API-KEY: <KEY>" http://localhost:8099/grocy/api/system/info`.

---

## Fehlersuche

- **App meldet „Keine/blockierte Verbindung":** Grocy-Direktport nicht aktiv → obigen
  Voraussetzungs-Schritt prüfen (Port 80 + SSL, Grocy neu gestartet). Test (1) ausführen.
- **Add-on startet nicht / nginx-Fehler:** Bei `ssl: true` fehlt evtl. `/ssl/<certfile>`
  → Zertifikat hinterlegen oder testweise `ssl: false` setzen.
- **PWA lässt sich nicht installieren:** Du bist über Ingress (Seitenleiste) drin →
  über die HTTPS-Direkt-Port-Adresse mit gültigem Zertifikat öffnen.
- **Anderer Grocy-Slug/Port:** `grocy_upstream` anpassen.
