#!/usr/bin/env python3
# ==============================================================================
# Ämtli – Push-Dienst „Neues auf der Liste“
# ==============================================================================
# Fragt die Grocy-Einkaufsliste jede Minute ab und meldet neue Zeilen gesammelt
# per Web Push an die angemeldeten Geräte – nicht an den, der sie eingetragen hat.
# HTTP-API auf 127.0.0.1:8090, nginx reicht /push/… unverändert durch.
# Versand: RFC 8291 (aes128gcm) + RFC 8292 (VAPID). `cryptography` wird nur in den
# Krypto-Funktionen importiert: API und Poller laufen auch ohne das Paket.
# Selbsttest: python3 pusher.py --selftest (Testvektor aus RFC 8291 Anhang A).
# ==============================================================================

import base64
import hashlib
import hmac
import http.client
import json
import logging
import os
import ssl
import struct
import sys
import threading
import time
import types
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LISTEN = ("127.0.0.1", 8090)
POLL_SECONDS = 60                # Grocy-Abfrage
CLAIM_TTL = 24 * 3600            # rowId -> Benutzer („Claim“)
KEY_TTL = 3600                   # geprüfter Client-Schlüssel (nur SHA-256 im Speicher)
PRODUCTS_TTL = 600               # Produktnamen-Cache
GROCY_TIMEOUT = 10
PUSH_TIMEOUT = 15
PUSH_TTL = 3600                  # so lange hält der Push-Dienst eine Nachricht vor
RECORD_SIZE = 4096
JWT_LIFETIME = 12 * 3600         # RFC 8292: höchstens 24 h
VAPID_SUB = "https://github.com/JoFMiller/aemtli-ha-addon"
MAX_BODY = 16 * 1024
NAME_MAX = 60                    # Zeichen je Name in der Nachricht

NOT_CONFIGURED = "Push ist im Add-on nicht eingerichtet (Option grocy_api_key)."
TEST_MESSAGE = {"title": "Ämtli", "body": "Benachrichtigungen funktionieren.",
                "tag": "aemtli-test", "url": "./"}


def _env_int(name, default):
    try:
        return int((os.environ.get(name) or "").strip() or default)
    except ValueError:
        return default


UPSTREAM = (os.environ.get("AEMTLI_GROCY_UPSTREAM") or "https://a0d7b954-grocy:80").strip().rstrip("/")
API_KEY = (os.environ.get("AEMTLI_GROCY_API_KEY") or "").strip()
BATCH_SECONDS = max(1, _env_int("AEMTLI_PUSH_BATCH_SECONDS", 600))
DATA_DIR = os.environ.get("AEMTLI_DATA") or "/data/push"
SUBS_PATH = os.path.join(DATA_DIR, "subs.json")
STATE_PATH = os.path.join(DATA_DIR, "state.json")
VAPID_PATH = os.path.join(DATA_DIR, "vapid.json")

log = logging.getLogger("pusher")
_LEVELS = {"trace": logging.DEBUG, "debug": logging.DEBUG, "info": logging.INFO,
           "notice": logging.INFO, "warning": logging.WARNING, "error": logging.ERROR,
           "fatal": logging.CRITICAL}


def _setup_logging():
    h = logging.StreamHandler(sys.stdout)
    h.setFormatter(logging.Formatter("[%(asctime)s] %(levelname)s: [pusher] %(message)s", "%H:%M:%S"))
    log.addHandler(h)
    log.propagate = False
    log.setLevel(_LEVELS.get((os.environ.get("AEMTLI_LOG_LEVEL") or "info").strip().lower(), logging.INFO))


# --- Hilfen -------------------------------------------------------------------

def b64u(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def b64u_dec(text):
    text = "".join(str(text).split())          # Leerraum (Zeilenumbrüche im RFC) entfernen
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _norm(user):
    return " ".join(str(user or "").split()).casefold()


def _int(value):
    """Positive Ganzzahl (int oder Ziffern-String) oder None; bool zählt nicht."""
    if isinstance(value, bool):
        return None
    if isinstance(value, str) and value.strip().isdigit():
        try:
            value = int(value.strip())
        except ValueError:
            return None
    return value if isinstance(value, int) and value > 0 else None


def _short(device):
    return str(device)[:8]


def _host(url):
    try:
        return urllib.parse.urlsplit(url).hostname or "?"
    except ValueError:
        return "?"


def _read_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return default
    except (OSError, ValueError) as e:
        log.warning("%s nicht lesbar (%s) – beginne leer.", path, e)
        return default


def _write_json(path, data):
    """Atomar schreiben (tmp + rename), nur für den Add-on-Benutzer lesbar."""
    tmp = path + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


# P-256 (secp256r1): Punktprüfung ohne cryptography, damit kaputte Schlüssel
# schon beim Anmelden auffallen.
_P256_P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff
_P256_B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b


def is_p256_point(raw):
    if len(raw) != 65 or raw[0] != 4:
        return False
    x = int.from_bytes(raw[1:33], "big")
    y = int.from_bytes(raw[33:], "big")
    if x >= _P256_P or y >= _P256_P:
        return False
    return (y * y - (x * x * x - 3 * x + _P256_B)) % _P256_P == 0


# --- Krypto (RFC 8291 / RFC 8292) ---------------------------------------------

class CryptoMissing(RuntimeError):
    pass


def _crypto():
    """Lazy-Import von cryptography; fehlt das Paket -> CryptoMissing."""
    try:
        from cryptography.exceptions import InvalidSignature
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import ec, utils
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    except ImportError as e:
        raise CryptoMissing("Python-Paket cryptography fehlt") from e
    return types.SimpleNamespace(hashes=hashes, serialization=serialization, ec=ec,
                                 utils=utils, AESGCM=AESGCM, InvalidSignature=InvalidSignature)


def crypto_error():
    try:
        _crypto()
        return ""
    except CryptoMissing as e:
        return str(e)


def _pub_bytes(c, private_key):
    return private_key.public_key().public_bytes(
        c.serialization.Encoding.X962, c.serialization.PublicFormat.UncompressedPoint)


def _hkdf_extract(salt, ikm):
    return hmac.new(salt, ikm, hashlib.sha256).digest()


def _hkdf_expand(prk, info, length):
    out, block, i = b"", b"", 1
    while len(out) < length:
        block = hmac.new(prk, block + info + bytes([i]), hashlib.sha256).digest()
        out += block
        i += 1
    return out[:length]


def _ece_keys(ecdh_secret, auth_secret, ua_public, as_public, salt):
    """RFC 8291 §3.3/§3.4 + RFC 8188 §2.2/§2.3: Schlüsselableitung."""
    key_info = b"WebPush: info\x00" + ua_public + as_public
    prk_key = _hkdf_extract(auth_secret, ecdh_secret)
    ikm = _hkdf_expand(prk_key, key_info, 32)
    prk = _hkdf_extract(salt, ikm)
    return {
        "key_info": key_info, "prk_key": prk_key, "ikm": ikm, "prk": prk,
        "cek": _hkdf_expand(prk, b"Content-Encoding: aes128gcm\x00", 16),
        "nonce": _hkdf_expand(prk, b"Content-Encoding: nonce\x00", 12),
    }


def _ece_header(salt, as_public, rs=RECORD_SIZE):
    """RFC 8188 §2.1: salt(16) | rs(4, big endian) | idlen(1) | keyid (= as_public)."""
    return salt + struct.pack("!IB", rs, len(as_public)) + as_public


def ece_encrypt(plaintext, ua_public, auth_secret, salt=None, as_private=None):
    """Verschlüsselt eine Push-Nachricht als ein einziger aes128gcm-Record."""
    c = _crypto()
    curve = c.ec.SECP256R1()
    if salt is None:
        salt = os.urandom(16)
    if as_private is None:
        as_private = c.ec.generate_private_key(curve)    # pro Nachricht neu (RFC 8291 §3.2)
    if len(salt) != 16 or len(auth_secret) != 16:
        raise ValueError("salt und auth müssen 16 Byte lang sein")
    as_public = _pub_bytes(c, as_private)
    header = _ece_header(salt, as_public)
    if len(header) + len(plaintext) + 1 + 16 > RECORD_SIZE:
        raise ValueError("Nachricht zu lang für einen Record")
    peer = c.ec.EllipticCurvePublicKey.from_encoded_point(curve, ua_public)
    k = _ece_keys(as_private.exchange(c.ec.ECDH(), peer), auth_secret, ua_public, as_public, salt)
    # 0x02 = Padding-Delimiter des letzten (hier einzigen) Records, kein weiteres Padding.
    return header + c.AESGCM(k["cek"]).encrypt(k["nonce"], plaintext + b"\x02", None)


def _ece_decrypt(body, ua_private, auth_secret):
    """Gegenstück zu ece_encrypt (nur für den Selbsttest)."""
    c = _crypto()
    salt, idlen = body[:16], body[20]
    as_public, ciphertext = body[21:21 + idlen], body[21 + idlen:]
    peer = c.ec.EllipticCurvePublicKey.from_encoded_point(c.ec.SECP256R1(), as_public)
    k = _ece_keys(ua_private.exchange(c.ec.ECDH(), peer), auth_secret,
                  _pub_bytes(c, ua_private), as_public, salt)
    record = c.AESGCM(k["cek"]).decrypt(k["nonce"], ciphertext, None).rstrip(b"\x00")
    if not record.endswith(b"\x02"):
        raise ValueError("Padding-Delimiter fehlt")
    return record[:-1]


def _audience(endpoint):
    """Origin des Endpoints (Schema + Host, Port nur wenn nicht Standard)."""
    u = urllib.parse.urlsplit(endpoint)
    port = u.port
    default = {"https": 443, "http": 80}.get(u.scheme)
    return f"{u.scheme}://{u.hostname}" + (f":{port}" if port and port != default else "")


def vapid_header(endpoint, private_key, public_b64, now=None):
    """RFC 8292: Authorization-Header `vapid t=<ES256-JWT>,k=<öffentlicher Schlüssel>`."""
    c = _crypto()

    def seg(obj):
        return b64u(json.dumps(obj, separators=(",", ":")).encode("utf-8"))

    now = int(time.time() if now is None else now)
    signing_input = seg({"typ": "JWT", "alg": "ES256"}) + "." + seg(
        {"aud": _audience(endpoint), "exp": now + JWT_LIFETIME, "sub": VAPID_SUB})
    der = private_key.sign(signing_input.encode("ascii"), c.ec.ECDSA(c.hashes.SHA256()))
    r, s = c.utils.decode_dss_signature(der)
    jwt = signing_input + "." + b64u(r.to_bytes(32, "big") + s.to_bytes(32, "big"))   # JWS: r||s
    return f"vapid t={jwt},k={public_b64}"


VAPID = {"private": None, "public": "", "error": ""}


def load_vapid():
    """VAPID-Schlüsselpaar laden oder einmalig erzeugen (/data/push/vapid.json)."""
    exists = os.path.exists(VAPID_PATH)
    data = _read_json(VAPID_PATH, None) if exists else None
    if isinstance(data, dict) and isinstance(data.get("public_key"), str):
        VAPID["public"] = data["public_key"]
    try:
        c = _crypto()
    except CryptoMissing as e:
        VAPID["error"] = str(e)
        return
    try:
        if exists:
            if not isinstance(data, dict) or not isinstance(data.get("private_pem"), str):
                raise ValueError("Inhalt unvollständig")
            priv = c.serialization.load_pem_private_key(data["private_pem"].encode("ascii"), password=None)
            if not isinstance(priv, c.ec.EllipticCurvePrivateKey) or priv.curve.name != "secp256r1":
                raise ValueError("kein P-256-Schlüssel")
        else:
            priv = c.ec.generate_private_key(c.ec.SECP256R1())
            pem = priv.private_bytes(c.serialization.Encoding.PEM, c.serialization.PrivateFormat.PKCS8,
                                     c.serialization.NoEncryption()).decode("ascii")
            _write_json(VAPID_PATH, {"private_pem": pem, "public_key": b64u(_pub_bytes(c, priv))})
            log.info("VAPID-Schlüssel erzeugt (%s).", VAPID_PATH)
        VAPID.update(private=priv, public=b64u(_pub_bytes(c, priv)), error="")
    except Exception as e:  # noqa: BLE001 – Dienst soll weiterlaufen, status meldet den Grund
        # Nicht neu erzeugen: vorhandene Abos hängen am alten Schlüssel.
        log.error("VAPID-Schlüssel %s nicht nutzbar: %s", VAPID_PATH, e)
        VAPID["error"] = "VAPID-Schlüssel beschädigt. /data/push/vapid.json löschen und Add-on neu starten."


def push_state():
    """(enabled, reason) für /push/status."""
    if not API_KEY:
        return False, NOT_CONFIGURED
    if VAPID["error"]:
        return False, VAPID["error"]
    if not VAPID["private"]:
        return False, "VAPID-Schlüssel fehlt."
    return True, ""


# --- Grocy ---------------------------------------------------------------------

_GROCY_CTX = ssl._create_unverified_context()   # Grocy-Add-on: Self-Signed-Zertifikat


class GrocyError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def _error_message(raw):
    try:
        data = json.loads(raw)
        if isinstance(data, dict) and data.get("error_message"):
            return str(data["error_message"])[:200]
    except ValueError:
        pass
    return ""


def grocy_get(path, key):
    req = urllib.request.Request(UPSTREAM + path, headers={"GROCY-API-KEY": key, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=GROCY_TIMEOUT, context=_GROCY_CTX) as r:
            raw = r.read()
    except urllib.error.HTTPError as e:
        msg = _error_message(e.read(2000)) or str(e.reason)
        raise GrocyError(e.code, f"HTTP {e.code}: {msg}") from None
    except (urllib.error.URLError, OSError, http.client.HTTPException) as e:
        raise GrocyError(0, f"nicht erreichbar ({getattr(e, 'reason', e)})") from None
    try:
        return json.loads(raw)
    except ValueError:
        raise GrocyError(0, "Antwort ist kein JSON") from None


def fetch_list(list_id):
    q = urllib.parse.urlencode({"query[]": f"shopping_list_id={list_id}"})
    rows = grocy_get(f"/api/objects/shopping_list?{q}", API_KEY)
    if not isinstance(rows, list):
        raise GrocyError(0, "unerwartete Antwort auf shopping_list")
    out = {}
    for r in rows:
        rid = _int(r.get("id")) if isinstance(r, dict) else None
        if rid:
            out[rid] = r
    return out


PRODUCTS = {"names": {}, "ts": 0.0}   # nur vom Poller-Thread benutzt


def resolve_names(rows):
    """Anzeigenamen je Zeile: Produktname, bei Notiz-Zeilen die Notiz, sonst #id."""
    need = {pid for pid in (_int(r.get("product_id")) for r in rows) if pid}
    stale = time.time() - PRODUCTS["ts"] > PRODUCTS_TTL
    if need and (stale or not need.issubset(PRODUCTS["names"])):
        try:
            data = grocy_get("/api/objects/products", API_KEY)
            if isinstance(data, list):
                PRODUCTS["names"] = {_int(p.get("id")): str(p.get("name") or "").strip()
                                     for p in data if isinstance(p, dict) and _int(p.get("id"))}
                PRODUCTS["ts"] = time.time()
        except GrocyError as e:
            log.warning("Produktnamen nicht lesbar: %s", e)
    names = {}
    for r in rows:
        pid = _int(r.get("product_id"))
        note = " ".join(str(r.get("note") or "").split())
        name = (PRODUCTS["names"].get(pid) if pid else "") or note or f"#{r.get('id')}"
        names[_int(r.get("id"))] = name if len(name) <= NAME_MAX else name[:NAME_MAX - 1].rstrip() + "…"
    return names


def compose_body(names, users):
    """„Johannes: Milch, Eier und 2 weitere“ (ein Eintragender) bzw. „Neu: Milch, Eier, Hafermilch“.
    Bis 3 Zeilen alle Namen, darüber 2 Namen + „und N weitere“."""
    who = {_norm(u) for u in users}
    first = " ".join(str(users[0] or "").split()) if users else ""
    prefix = f"{first}: " if len(who) == 1 and first else "Neu: "
    if len(names) <= 3:
        return prefix + ", ".join(names)
    return prefix + ", ".join(names[:2]) + f" und {len(names) - 2} weitere"


# --- Zustand -------------------------------------------------------------------

LOCK = threading.Lock()
WAKE = threading.Event()
SUBS = []       # [{endpoint, keys:{p256dh, auth}, device, user, listId, updated}]
CLAIMS = {}     # rowId -> (Benutzer, Ablauf)
KEYS_OK = {}    # sha256(Client-Schlüssel) -> Ablauf (monotonic)
SEEN = {}       # listId -> {rowId}
PENDING = {}    # listId -> {rowId: erstmals gesehen (time)}


def _valid_sub(s):
    try:
        return (isinstance(s, dict) and isinstance(s.get("endpoint"), str)
                and is_p256_point(b64u_dec(s["keys"]["p256dh"])) and len(b64u_dec(s["keys"]["auth"])) == 16
                and isinstance(s.get("device"), str) and s["device"] and _int(s.get("listId")) is not None)
    except (KeyError, TypeError, ValueError):
        return False


def load_subs():
    data = _read_json(SUBS_PATH, [])
    subs = [s for s in data if _valid_sub(s)] if isinstance(data, list) else []
    for s in subs:
        s["listId"] = _int(s["listId"])
        s["user"] = str(s.get("user") or "")
    SUBS[:] = subs


def _save_subs_locked():
    try:
        _write_json(SUBS_PATH, SUBS)
    except OSError as e:
        log.error("%s nicht schreibbar: %s", SUBS_PATH, e)


def load_state():
    data = _read_json(STATE_PATH, {})
    try:
        for k, v in (data.get("seen") or {}).items():
            SEEN[int(k)] = {int(x) for x in v}
        for k, v in (data.get("pending") or {}).items():
            PENDING[int(k)] = {int(i): float(t) for i, t in v.items()}
    except (AttributeError, TypeError, ValueError) as e:
        log.warning("%s unbrauchbar (%s) – beginne leer.", STATE_PATH, e)
        SEEN.clear()
        PENDING.clear()


def _save_state_locked():
    data = {"seen": {str(k): sorted(v) for k, v in SEEN.items()},
            "pending": {str(k): {str(i): t for i, t in v.items()} for k, v in PENDING.items() if v}}
    try:
        _write_json(STATE_PATH, data)
    except OSError as e:
        log.error("%s nicht schreibbar: %s", STATE_PATH, e)


def _remove_sub(endpoint):
    with LOCK:
        before = len(SUBS)
        SUBS[:] = [s for s in SUBS if s["endpoint"] != endpoint]
        if len(SUBS) != before:
            _save_subs_locked()


# --- Versand -------------------------------------------------------------------

class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Push-Dienste antworten direkt. Einer Umleitung (z. B. auf http:// oder ins hassio-Netz)
    darf der Dienst nicht folgen – sonst ließe sich die https-Pflicht des Endpoints umgehen."""

    def redirect_request(self, *args, **kwargs):
        return None


_PUSH_OPENER = urllib.request.build_opener(_NoRedirect)


def send_push(sub, message):
    """Schickt `message` (dict) an eine Subscription. Rückgabe: None oder Fehlertext (deutsch)."""
    dev = _short(sub.get("device"))
    host = _host(sub["endpoint"])
    try:
        if not VAPID["private"]:
            raise CryptoMissing(VAPID["error"] or crypto_error() or "VAPID-Schlüssel fehlt")
        body = ece_encrypt(json.dumps(message, ensure_ascii=False).encode("utf-8"),
                           b64u_dec(sub["keys"]["p256dh"]), b64u_dec(sub["keys"]["auth"]))
        req = urllib.request.Request(sub["endpoint"], data=body, method="POST", headers={
            "Authorization": vapid_header(sub["endpoint"], VAPID["private"], VAPID["public"]),
            "Content-Encoding": "aes128gcm",
            "Content-Type": "application/octet-stream",
            "TTL": str(PUSH_TTL),
            "Urgency": "normal",
        })
        with _PUSH_OPENER.open(req, timeout=PUSH_TIMEOUT) as r:
            r.read()
            log.debug("Gerät %s: Push-Dienst %s antwortet HTTP %s.", dev, host, r.status)
        return None
    except CryptoMissing as e:
        log.error("Versand an Gerät %s nicht möglich: %s.", dev, e)
        return f"Versand nicht möglich: {e}."
    except urllib.error.HTTPError as e:
        detail = e.read(300).decode("utf-8", "replace").strip()
        if e.code in (404, 410):
            _remove_sub(sub["endpoint"])
            log.info("Gerät %s beim Push-Dienst abgemeldet (HTTP %s) – entfernt.", dev, e.code)
            return "Dieses Gerät ist beim Push-Dienst nicht mehr angemeldet. Schalte die Benachrichtigungen aus und wieder an."
        log.warning("Gerät %s: Push-Dienst %s antwortet HTTP %s %s", dev, host, e.code, detail)
        return f"Der Push-Dienst lehnt die Nachricht ab (HTTP {e.code})."
    except (urllib.error.URLError, OSError, http.client.HTTPException) as e:
        log.warning("Gerät %s: Push-Dienst %s nicht erreichbar (%s).", dev, host, getattr(e, "reason", e))
        return "Der Push-Dienst ist gerade nicht erreichbar."
    except Exception:  # noqa: BLE001 – ein kaputtes Abo darf den Dienst nicht stoppen
        log.exception("Gerät %s: Versand fehlgeschlagen.", dev)
        return "Versand fehlgeschlagen (Details im Add-on-Log)."


def send_batch(list_id, ids, rows):
    """Gesammelte neue Zeilen an alle Geräte der Liste – ohne die eigenen Einträge."""
    ids = [i for i in ids if i in rows and str(rows[i].get("done")) != "1"]   # gelöscht oder schon im Wagen -> weg
    if not ids:
        log.info("Liste %s: neue Zeilen sind schon wieder weg – nichts zu senden.", list_id)
        return
    names = resolve_names([rows[i] for i in ids])
    now = time.time()
    with LOCK:
        claims = {i: CLAIMS[i][0] for i in ids if i in CLAIMS and CLAIMS[i][1] > now}
        subs = [dict(s) for s in SUBS if s["listId"] == list_id]
    log.info("Liste %s: %d neue Zeile(n) zum Versand ausgewählt (%s), %d Gerät(e).",
             list_id, len(ids), ", ".join(f"#{i}" for i in ids), len(subs))
    for sub in subs:
        me = _norm(sub.get("user"))
        rest = [i for i in ids if not (me and _norm(claims.get(i)) == me)]
        if not rest:
            log.info("Gerät %s: nur eigene Einträge – keine Nachricht.", _short(sub["device"]))
            continue
        message = {"title": "Einkaufsliste", "tag": "aemtli-list", "url": "./",
                   "body": compose_body([names[i] for i in rest], [claims.get(i, "") for i in rest])}
        if send_push(sub, message) is None:
            log.info("Gerät %s benachrichtigt: %s", _short(sub["device"]), message["body"])


# --- Poller --------------------------------------------------------------------

def poll_once():
    """Ein Durchlauf über alle Listen mit Abonnenten. Rückgabe: Sekunden bis zum nächsten."""
    with LOCK:
        lists = sorted({s["listId"] for s in SUBS})
        gone = [lid for lid in SEEN if lid not in lists]
        for lid in gone:                 # niemand mehr angemeldet -> beim nächsten Mal neu beginnen
            SEEN.pop(lid, None)
            PENDING.pop(lid, None)
        if gone:
            _save_state_locked()
    wait = POLL_SECONDS
    for lid in lists:
        try:
            rows = fetch_list(lid)
        except GrocyError as e:
            log.warning("Liste %s nicht lesbar: %s", lid, e)
            continue
        now = time.time()
        batch = None
        with LOCK:
            current = set(rows)
            if lid not in SEEN:
                SEEN[lid] = current
                PENDING[lid] = {}
                log.info("Liste %s: %d vorhandene Zeile(n) übernommen, ohne Meldung.", lid, len(current))
                changed = True
            else:
                new = current - SEEN[lid]
                pend = PENDING.setdefault(lid, {})
                changed = bool(new) or SEEN[lid] != current
                for i in sorted(new):
                    if str(rows[i].get("done")) == "1":   # gleich im Wagen (Rückgängig legt so an) → nichts Neues
                        continue
                    pend[i] = now
                for i in [i for i in pend if i not in current]:
                    del pend[i]
                SEEN[lid] = current
                if new and pend:
                    log.info("Liste %s: neu %s – Versand in %d s.", lid, ", ".join(f"#{i}" for i in sorted(new)),
                             max(0, int(min(pend.values()) + BATCH_SECONDS - now)))
                if pend and now - min(pend.values()) >= BATCH_SECONDS:
                    batch = sorted(pend)
                    PENDING[lid] = {}
                    changed = True
            if changed:
                _save_state_locked()
        if batch:
            send_batch(lid, batch, rows)
        with LOCK:
            pend = PENDING.get(lid)
            if pend:
                wait = min(wait, min(pend.values()) + BATCH_SECONDS - time.time())
    return wait


def poller():
    log.info("Poller läuft (alle %d s, Sammelfenster %d s).", POLL_SECONDS, BATCH_SECONDS)
    while True:
        try:
            wait = poll_once()
        except Exception:  # noqa: BLE001 – nur loggen, nie abstürzen
            log.exception("Poller-Fehler")
            wait = POLL_SECONDS
        WAKE.wait(max(1.0, wait))
        WAKE.clear()


# --- HTTP-API ------------------------------------------------------------------

class BadRequest(ValueError):
    pass


def _str_field(body, name, required, limit=100):
    value = body.get(name)
    if value is None and not required:
        return ""
    if not isinstance(value, str) or len(value) > limit or (required and not value.strip()):
        raise BadRequest(f"Feld {name} fehlt oder ist ungültig.")
    return value.strip()


def check_client_key(key):
    """None, wenn der Client-Schlüssel gilt; sonst (status, Antwort)."""
    key = (key or "").strip()
    if not key:
        return 401, {"error_message": "Grocy-Schlüssel fehlt."}
    digest = hashlib.sha256(key.encode("utf-8")).hexdigest()
    now = time.monotonic()
    with LOCK:
        if KEYS_OK.get(digest, 0) > now:
            return None
    try:
        grocy_get("/api/user", key)
    except GrocyError as e:
        if e.status == 401:
            return 401, {"error_message": "Dein Grocy-Schlüssel gilt nicht."}
        # /api/user verlangt in Grocy 4.x kein Recht – jeder andere Fehler ist kein gültiger Schlüssel.
        log.warning("Schlüsselprüfung: Grocy %s", e)
        return 503, {"error_message": "Grocy ist gerade nicht erreichbar."}
    with LOCK:
        for d in [d for d, t in KEYS_OK.items() if t <= now]:
            del KEYS_OK[d]
        KEYS_OK[digest] = now + KEY_TTL
    return None


def status_payload():
    enabled, reason = push_state()
    with LOCK:
        n = len(SUBS)
    out = {"enabled": enabled, "publicKey": VAPID["public"], "batchSeconds": BATCH_SECONDS, "subscribers": n}
    if not enabled:
        out["reason"] = reason
    return out


ROUTES = {
    ("GET", "/push/status"): "status",
    ("POST", "/push/subscribe"): "subscribe",
    ("DELETE", "/push/subscribe"): "unsubscribe",
    ("POST", "/push/mine"): "mine",
    ("POST", "/push/test"): "test",
}


class Handler(BaseHTTPRequestHandler):
    server_version = "aemtli-pusher"

    def version_string(self):
        return self.server_version

    def log_message(self, fmt, *args):
        log.debug("http %s", fmt % args)

    def _send(self, code, obj=None):
        body = b"" if code == 204 else json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Cache-Control", "no-store")
        if code != 204:
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body and self.command != "HEAD":
            self.wfile.write(body)

    def _json_body(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            raise BadRequest("Ungültige Anfrage.") from None
        if n > MAX_BODY:
            raise BadRequest("Anfrage zu groß.")
        raw = self.rfile.read(n) if n > 0 else b""
        try:
            data = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            raise BadRequest("Kein gültiges JSON.") from None
        if not isinstance(data, dict):
            raise BadRequest("JSON-Objekt erwartet.")
        return data

    def _route(self):
        try:
            name = ROUTES.get((self.command, urllib.parse.urlsplit(self.path).path))
            if not name:
                return self._send(404, {"error_message": "Unbekannter Aufruf."})
            if name == "status":
                return self._send(200, status_payload())
            if not API_KEY:
                return self._send(503, {"error_message": NOT_CONFIGURED})
            denied = check_client_key(self.headers.get("GROCY-API-KEY"))
            if denied:
                return self._send(*denied)
            getattr(self, "_do_" + name)(self._json_body())
        except BadRequest as e:
            self._send(400, {"error_message": str(e)})
        except Exception:  # noqa: BLE001
            log.exception("Fehler bei %s %s", self.command, self.path)
            self._send(500, {"error_message": "Interner Fehler im Push-Dienst."})

    do_GET = do_POST = do_DELETE = do_PUT = do_PATCH = do_HEAD = do_OPTIONS = _route

    def _do_subscribe(self, body):
        sub = body.get("subscription")
        if not isinstance(sub, dict):
            raise BadRequest("Feld subscription fehlt.")
        endpoint = sub.get("endpoint")
        try:
            u = urllib.parse.urlsplit(endpoint) if isinstance(endpoint, str) and len(endpoint) <= 2048 else None
            ok = bool(u and u.scheme == "https" and u.hostname and _audience(endpoint))
        except ValueError:
            ok = False
        if not ok:
            raise BadRequest("subscription.endpoint muss eine https-Adresse sein.")
        keys = sub.get("keys") if isinstance(sub.get("keys"), dict) else {}
        try:
            p256dh = b64u_dec(keys.get("p256dh") or "")
            auth = b64u_dec(keys.get("auth") or "")
        except (TypeError, ValueError):
            p256dh = auth = b""
        if not is_p256_point(p256dh):
            raise BadRequest("subscription.keys.p256dh ist kein gültiger P-256-Schlüssel.")
        if len(auth) != 16:
            raise BadRequest("subscription.keys.auth muss 16 Byte lang sein.")
        device = _str_field(body, "device", required=True)
        user = _str_field(body, "user", required=False)
        list_id = _int(body.get("listId"))
        if not list_id:
            raise BadRequest("Feld listId fehlt oder ist ungültig.")
        entry = {"endpoint": endpoint, "keys": {"p256dh": b64u(p256dh), "auth": b64u(auth)},
                 "device": device, "user": user, "listId": list_id, "updated": int(time.time())}
        with LOCK:
            new_list = all(s["listId"] != list_id for s in SUBS)
            SUBS[:] = [s for s in SUBS if s["endpoint"] != endpoint and s["device"] != device]
            SUBS.append(entry)
            _save_subs_locked()
        log.info("Gerät %s angemeldet (Liste %s, Nutzer %s, über %s).",
                 _short(device), list_id, user or "?", _host(endpoint))
        if new_list:
            WAKE.set()                   # Liste sofort übernehmen
        self._send(204)

    def _do_unsubscribe(self, body):
        device = _str_field(body, "device", required=True)
        with LOCK:
            before = len(SUBS)
            SUBS[:] = [s for s in SUBS if s["device"] != device]
            if len(SUBS) != before:
                _save_subs_locked()
                log.info("Gerät %s abgemeldet.", _short(device))
        self._send(204)

    def _do_mine(self, body):
        ids = body.get("ids")
        if not isinstance(ids, list) or len(ids) > 500 or any(_int(i) is None for i in ids):
            raise BadRequest("Feld ids muss eine Liste von Zeilen-IDs sein.")
        user = _str_field(body, "user", required=False)
        if user and ids:
            now = time.time()
            with LOCK:
                for i in [i for i, (_, t) in CLAIMS.items() if t <= now]:
                    del CLAIMS[i]
                for i in ids:
                    CLAIMS[_int(i)] = (user, now + CLAIM_TTL)
            log.debug("Claim %s: %s", user, ", ".join(f"#{_int(i)}" for i in ids))
        self._send(204)

    def _do_test(self, body):
        device = _str_field(body, "device", required=True)
        with LOCK:
            sub = next((dict(s) for s in SUBS if s["device"] == device), None)
        if not sub:
            return self._send(404, {"ok": False, "error_message": "Dieses Gerät ist für Benachrichtigungen nicht angemeldet."})
        err = send_push(sub, TEST_MESSAGE)
        if err:
            return self._send(200, {"ok": False, "error_message": err})
        log.info("Testnachricht an Gerät %s gesendet.", _short(device))
        self._send(200, {"ok": True})


# --- Selbsttest ----------------------------------------------------------------

# RFC 8291 Anhang A / Abschnitt 5, Werte wörtlich (Leerraum wie im RFC, wird entfernt).
RFC8291 = {
    "plaintext": "V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24",
    "as_public": "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIg"
                 "Dll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
    "as_private": "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
    "ua_public": "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-"
                 "JvLexhqUzORcx aOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
    "ua_private": "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
    "salt": "DGv6ra1nlYgDCS1FRnbzlw",
    "auth_secret": "BTBZMqHH6r4Tts7J_aSIgg",
    "ecdh_secret": "kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs",
    "prk_key": "Snr3JMxaHVDXHWJn5wdC52WjpCtd2EIEGBykDcZW32k",
    "key_info": "V2ViUHVzaDogaW5mbwAEJXGyvs3942BVG"
                "q8e0PTNNmwR zr5VX4m8t7GGpTM5FzFo7OLr4BhZe9MEebhuPI-OztV3"
                "ylkYfpJGmQ22ggCLDgT-M_SrDepxkU21WCP3O1SUj0Ew"
                "bZIHMtu5pZpTKGSCIA5Zent7wmC6HCJ5mFgJkuk5cwAv MBKiiujwa7t45ewP",
    "ikm": "S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg",
    "prk": "09_eUZGrsvxChDCGRCdkLiDXrReGOEVeSCdCcPBSJSc",
    "cek_info": "Q29udGVudC1FbmNvZGluZzogYWVzMTI4Z2NtAA",
    "cek": "oIhVW04MRdy2XN9CiKLxTg",
    "nonce_info": "Q29udGVudC1FbmNvZGluZzogbm9uY2UA",
    "nonce": "4h_95klXJ5E_qnoN",
    "header": "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z 9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml"
              "mlMoZIIgDll6e3vCYLocInmYWAmS6Tlz AC8wEqKK6PBru3jl7A8",
    "padded": "V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0 byBiZSBhIHdhdGVybWVsb24C",
    "ciphertext": "8pfeW0KbunFT06SuDKoJH9Ql87S1QUrd irN6GcG7sFz1y1sqLgVi1VhjVkHsUoEs"
                  "bI_0LpXMuGvnzQ",
    "message": "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml"
               "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT"
               "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
}
RFC8291_ENDPOINT = "https://push.example.net/push/JzLQ3raZJfFBR0aqvOMsLrt54w4rJUsV"


def selftest():
    v = {k: b64u_dec(x) for k, x in RFC8291.items()}
    failed = []

    def check(name, ok, detail=""):
        print(("OK      " if ok else "FEHLER  ") + name + ("" if ok or not detail else f" ({detail})"))
        if not ok:
            failed.append(name)

    print("Ämtli-Pusher Selbsttest (RFC 8291 Anhang A, RFC 8292)")
    # Teil 1 – ohne cryptography: HKDF, Info-Strings, Header.
    check("Klartext", v["plaintext"] == b"When I grow up, I want to be a watermelon")
    check("Schlüssel des Testvektors liegen auf P-256", is_p256_point(v["ua_public"]) and is_p256_point(v["as_public"]))
    k = _ece_keys(v["ecdh_secret"], v["auth_secret"], v["ua_public"], v["as_public"], v["salt"])
    for name in ("key_info", "prk_key", "ikm", "prk", "cek", "nonce"):
        check(f"HKDF {name}", k[name] == v[name], b64u(k[name]))
    check("cek_info/nonce_info", v["cek_info"] == b"Content-Encoding: aes128gcm\x00"
          and v["nonce_info"] == b"Content-Encoding: nonce\x00")
    header = _ece_header(v["salt"], v["as_public"])
    check("Header (86 Byte, rs 4096)", header == v["header"] and len(header) == 86, b64u(header))
    check("Padding-Delimiter", v["plaintext"] + b"\x02" == v["padded"])

    # Teil 2 – mit cryptography: ECDH, AES-GCM, VAPID.
    try:
        c = _crypto()
    except CryptoMissing as e:
        check("cryptography vorhanden", False, str(e))
        print("Ergebnis: FEHLER")
        return 1
    curve = c.ec.SECP256R1()
    as_priv = c.ec.derive_private_key(int.from_bytes(v["as_private"], "big"), curve)
    ua_priv = c.ec.derive_private_key(int.from_bytes(v["ua_private"], "big"), curve)
    check("as_private -> as_public", _pub_bytes(c, as_priv) == v["as_public"])
    check("ua_private -> ua_public", _pub_bytes(c, ua_priv) == v["ua_public"])
    peer = c.ec.EllipticCurvePublicKey.from_encoded_point(curve, v["ua_public"])
    check("ECDH-Geheimnis", as_priv.exchange(c.ec.ECDH(), peer) == v["ecdh_secret"])
    msg = ece_encrypt(v["plaintext"], v["ua_public"], v["auth_secret"], salt=v["salt"], as_private=as_priv)
    check("AES-GCM-Ciphertext", msg[86:] == v["ciphertext"], b64u(msg[86:]))
    check("aes128gcm-Nachricht (RFC 8291 Abschnitt 5)", msg == v["message"], b64u(msg))
    plain = b'{"title":"Test","body":"Zufallsschl\xc3\xbcssel"}'
    try:
        roundtrip = _ece_decrypt(ece_encrypt(plain, v["ua_public"], v["auth_secret"]), ua_priv, v["auth_secret"])
    except Exception as e:  # noqa: BLE001
        roundtrip = repr(e)
    check("Zufälliger Salt/Schlüssel: Entschlüsseln ergibt Klartext", roundtrip == plain)

    vapid_priv = c.ec.generate_private_key(curve)
    vapid_pub = b64u(_pub_bytes(c, vapid_priv))
    now = int(time.time())
    hdr = vapid_header(RFC8291_ENDPOINT, vapid_priv, vapid_pub, now=now)
    ok = hdr.startswith("vapid t=") and ",k=" in hdr
    jwt, _, kval = hdr[len("vapid t="):].partition(",k=")
    parts = jwt.split(".")
    check("VAPID-Header vapid t=…,k=…", ok and len(parts) == 3 and kval == vapid_pub)
    try:
        head, claims, sig = json.loads(b64u_dec(parts[0])), json.loads(b64u_dec(parts[1])), b64u_dec(parts[2])
    except (IndexError, ValueError) as e:
        check("JWT lesbar", False, str(e))
        print("Ergebnis: FEHLER")
        return 1
    check("JWT-Kopf", head == {"typ": "JWT", "alg": "ES256"}, json.dumps(head))
    check("JWT aud/sub", claims.get("aud") == "https://push.example.net" and claims.get("sub") == VAPID_SUB,
          json.dumps(claims))
    check("JWT exp (12 h, höchstens 24 h)", claims.get("exp") == now + JWT_LIFETIME and JWT_LIFETIME <= 86400)
    check("Signatur r||s 64 Byte", len(sig) == 64)
    check("k = unkomprimierter P-256-Punkt (65 Byte)", is_p256_point(b64u_dec(kval)))
    try:
        der = c.utils.encode_dss_signature(int.from_bytes(sig[:32], "big"), int.from_bytes(sig[32:], "big"))
        vapid_priv.public_key().verify(der, (parts[0] + "." + parts[1]).encode("ascii"),
                                       c.ec.ECDSA(c.hashes.SHA256()))
        verified = True
    except (c.InvalidSignature, ValueError):
        verified = False
    check("ES256-Signatur prüfbar", verified)
    print("Ergebnis: " + ("OK" if not failed else f"FEHLER ({len(failed)})"))
    return 0 if not failed else 1


# --- Start ---------------------------------------------------------------------

def main():
    if "--selftest" in sys.argv[1:]:
        sys.exit(selftest())
    _setup_logging()
    os.makedirs(DATA_DIR, exist_ok=True)
    load_subs()
    load_state()
    load_vapid()
    enabled, reason = push_state()
    if enabled:
        log.info("Push an: Grocy %s, Sammelfenster %d s, %d Gerät(e).", UPSTREAM, BATCH_SECONDS, len(SUBS))
    else:
        log.warning("Push aus: %s", reason)
    if API_KEY:
        threading.Thread(target=poller, name="poller", daemon=True).start()
    server = ThreadingHTTPServer(LISTEN, Handler)
    server.daemon_threads = True
    log.info("HTTP-API auf %s:%d.", *LISTEN)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
