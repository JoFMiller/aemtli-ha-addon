# Ämtli (Home-Assistant-Add-on)

Schlanke, installierbare PWA für **Grocy** – Einkaufszettel & Hausarbeiten – als
lokales HA-Add-on. nginx liefert die statische PWA aus und proxyt das HA-Grocy-Add-on
server-seitig über das interne `hassio`-Netz (`/grocy/`).

Vollständige Anleitung (Voraussetzungen, Optionen, PWA-Installation, Tests):
siehe **[DOCS.md](DOCS.md)**.

## Kurz
1. Inhalt von `addon/` nach HA `/addons/` kopieren → Add-on Store neu laden → **Ämtli** installieren.
2. **Voraussetzung:** im **Grocy**-Add-on den Direktzugang aktivieren (Port 80 + `ssl: true`, neu starten) – sonst ist Grocys API intern nicht erreichbar (Ingress-Port ist gesperrt).
3. Für die installierbare PWA dem Ämtli-Add-on einen Host-Port für **8080** zuweisen und über **HTTPS** öffnen (Zertifikat in `/ssl` oder `tailscale serve`).
4. In der App: persönlichen **Grocy-API-Key** eintragen, testen, fertig.

## Aufbau
```
aemtli/
├─ config.yaml            Add-on-Manifest (ingress + Direkt-Port, Optionen)
├─ Dockerfile             nginx auf hassio-addons/base (Basis-Image via ARG BUILD_FROM)
├─ DOCS.md / README.md
├─ icon.png / logo.png
└─ rootfs/
   ├─ etc/nginx/          nginx.conf + includes/locations.conf
   ├─ etc/s6-overlay/…    init-nginx (Config-Render) + nginx (longrun)
   └─ var/www/            die PWA (index.html, app.js, sw.js, config.js, manifest, icons)
```

Zustandslos – alle Daten liegen in Grocy. Update: Dateien ersetzen, Add-on neu bauen/starten.
