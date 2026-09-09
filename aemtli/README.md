# Ämtli (Home-Assistant-Add-on)

Schlanke, installierbare PWA für **Grocy** – Einkaufszettel & Hausarbeiten – als
HA-Add-on. nginx liefert die statische PWA aus und proxyt das HA-Grocy-Add-on
server-seitig über das interne `hassio`-Netz (`/grocy/`).

Vollständige Anleitung (Voraussetzungen, Optionen, PWA-Installation per Tailscale,
Tests, Fehlersuche): siehe **[DOCS.md](DOCS.md)**.

## Kurz
1. Repository `https://github.com/JoFMiller/aemtli-ha-addon` im Add-on-Store hinzufügen → **Ämtli** installieren.
2. **Voraussetzung:** im **Grocy**-Add-on den Direktzugang aktivieren (Port 80 + `ssl: true`, neu starten) – sonst ist Grocys API intern nicht erreichbar (Ingress-Port ist gesperrt).
3. Für die installierbare PWA: Host-Port **8080** vergeben, `ssl: false`, und per Tailscale-Add-on (Option `services`) als `https://aemtli.<tailnet>.ts.net/` veröffentlichen.
4. In der App: persönlichen **Grocy-API-Key** eintragen → fertig.

## Aufbau
```
aemtli/
├─ config.yaml            Add-on-Manifest (ingress + Direkt-Port, Optionen)
├─ Dockerfile             nginx auf hassio-addons/base (Basis-Image via ARG BUILD_FROM)
├─ DOCS.md / README.md
├─ icon.png / logo.png
└─ rootfs/
   ├─ etc/nginx/          nginx.conf + includes/locations.conf + security-headers.conf
   ├─ etc/s6-overlay/…    init-nginx (Config-Render, schreibt Version in config.js) + nginx (longrun)
   └─ var/www/            die PWA (index.html, boot.js, app.js, sw.js, config.js, manifest, icons)
```

Zustandslos – alle Daten liegen in Grocy; der API-Key nur im Browser des Geräts.
Update: `config.yaml`-Version erhöhen → committen → pushen → Add-on-Store „Nach Updates suchen“.

## Entwickeln ohne HA
`rootfs/var/www` mit einem statischen Server ausliefern (z. B. `python3 -m http.server`),
in `config.js` temporär `proxied: false` setzen und in der App `https://demo.grocy.info`
mit Key `demo` eintragen. Vor dem Commit `config.js` zurücksetzen.
