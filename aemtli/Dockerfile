ARG BUILD_FROM=ghcr.io/hassio-addons/base:18.2.0
# hadolint ignore=DL3006
FROM ${BUILD_FROM}

# nginx installieren
# hadolint ignore=DL3018
RUN apk add --no-cache nginx

# Add-on-Dateien (nginx-Konfig, s6-Services, statische PWA) ins Image backen
COPY rootfs /

# Alpine-Default-Site entfernen + ALLE s6-run/finish-Skripte ausführbar machen
# (Windows-Dateien tragen kein +x -> hier explizit setzen; glob deckt auch
#  später hinzugefügte Services ab. type/up/dependencies.d/contents.d brauchen
#  kein x-Bit, da s6 sie nur liest.)
RUN rm -f /etc/nginx/http.d/default.conf \
    && chmod a+x /etc/s6-overlay/s6-rc.d/*/run \
    && find /etc/s6-overlay/s6-rc.d -name finish -exec chmod a+x {} +

# Build-Metadaten
ARG BUILD_ARCH
ARG BUILD_VERSION
LABEL \
    io.hass.name="Ämtli" \
    io.hass.description="Schlanke PWA für Grocy: Einkauf & Hausarbeiten" \
    io.hass.type="addon" \
    io.hass.version="${BUILD_VERSION}" \
    io.hass.arch="${BUILD_ARCH}"
