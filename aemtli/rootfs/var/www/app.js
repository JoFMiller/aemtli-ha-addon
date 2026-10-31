/* =====================================================================
   Ämtli 2 – schlanke PWA für Grocy
   Einkaufszettel (zu kaufen → im Wagen → einsortiert) + Hausarbeiten.

   Betriebsarten:
   • Add-on-Modus (window.AEMTLI.proxied): Grocy wird vom HA-Add-on unter dem
     relativen Pfad "grocy" proxyt – es genügt der persönliche API-Key.
   • Standalone-/Dev-Modus: Grocy-URL + API-Key in den Einstellungen.

   Grocy-Fakten, auf denen der Code beruht (verifiziert, Grocy 4.x):
   • shopping_list.amount ist IMMER in der Lager-Einheit (qu_id_stock) des
     Produkts; qu_id ist nur die Anzeigeeinheit. Anzeige = amount × Faktor
     (stock→qu_id) aus quantity_unit_conversions_resolved.
   • POST /stock/products/{id}/add erwartet amount in der Lager-Einheit → 1:1.
   • Fehlendes best_before_date ergibt nie 400: Grocy nimmt -1 → 2999-12-31,
     N>0 → heute+N, 0 → HEUTE (sofort fällig). Deshalb bei 0 explizit
     2999-12-31 senden („ohne MHD“) und sichtbar markieren.
   • Kein Bulk-Endpunkt fürs Buchen; Zeile für Zeile, sequenziell.
   ===================================================================== */
"use strict";
window.__aemtliLoaded = true;   // für den Start-Wächter in boot.js

/* ------------------------------------------------------------ Umgebung */
const AEMTLI = (typeof window !== "undefined" && window.AEMTLI) || {};
const ADDON = !!AEMTLI.proxied;
const APP_VERSION = AEMTLI.version || "2.0.0";
const UNDER_INGRESS = location.pathname.includes("/api/hassio_ingress/");
const NEVER = "2999-12-31";                 // Grocy-Sentinel „läuft nie ab“
const UNDO_WINDOW_MS = 10 * 60 * 1000;      // Rückgängig-Fenster nach dem Einsortieren

function proxyBase() {
  try { return new URL("grocy", document.baseURI).href.replace(/\/+$/, ""); }
  catch (_) { return "/grocy"; }
}

/* ------------------------------------------------- Speicher (robust) */
// localStorage kann gesperrt sein (Safari privat, WebView). Dann In-Memory-
// Fallback + einmalige Warnung – nie ein Absturz, nie ein Aktionsabbruch.
const MEM = new Map();
let storageWarned = false;
const store = {
  get(k) {
    try { const v = localStorage.getItem(k); if (v !== null) return v; } catch (_) {}
    return MEM.has(k) ? MEM.get(k) : null;
  },
  set(k, v) {
    MEM.set(k, v);
    try { localStorage.setItem(k, v); }
    catch (e) {
      if (!storageWarned) {
        storageWarned = true;
        DIAG.push({ kind: "storage", msg: String(e) }, true);
        setTimeout(() => toast("Speicher nicht beschreibbar. Einstellungen gelten nur, bis die App geschlossen wird.", { bad: true }), 0);
      }
    }
  },
  del(k) { MEM.delete(k); try { localStorage.removeItem(k); } catch (_) {} },
  json(k, fallback) { try { const v = this.get(k); return v ? JSON.parse(v) : fallback; } catch (_) { return fallback; } },
};

/* Diagnose-Ringpuffer (letzte 20 Fehler), für „Diagnose kopieren“. */
const DIAG = {
  items: [],
  push(e, noPersist) {
    this.items.unshift({ t: new Date().toISOString(), ...e });
    this.items.length = Math.min(this.items.length, 20);
    if (!noPersist) { try { localStorage.setItem("aemtli.diag", JSON.stringify(this.items)); } catch (_) {} }
  },
  text() {
    const lines = [
      `Ämtli ${APP_VERSION} · Modus: ${ADDON ? (UNDER_INGRESS ? "Add-on/Ingress" : "Add-on/Direkt") : "Standalone"}`,
      `Basis: ${CFG.url || "-"} · Liste ${CFG.listId} · online: ${navigator.onLine}`,
      `Grocy: ${state.grocyVersion || "?"} · Nutzer: ${state.user ? (state.user.display_name || state.user.username) : "?"}`,
      `SW: ${state.swState} · UA: ${navigator.userAgent}`,
      "Letzte Fehler:",
      ...this.items.map((i) => `  ${i.t} ${i.kind}${i.status ? " " + i.status : ""} ${i.path || ""} ${i.msg || ""}`),
    ];
    return lines.join("\n");
  },
};
DIAG.items = store.json("aemtli.diag", []) || [];

/* ---------------------------------------------------------------- Config */
const CFG = {
  get url() {
    const stored = (store.get("grocy.url") || "").trim().replace(/\/+$/, "");
    if (stored) return stored;
    return ADDON ? proxyBase() : "";
  },
  set url(v) { const s = (v || "").trim().replace(/\/+$/, ""); s ? store.set("grocy.url", s) : store.del("grocy.url"); },
  get key() { return (store.get("grocy.key") || "").trim(); },
  set key(v) { store.set("grocy.key", (v || "").trim()); store.del("aemtli.perm.deny"); store.del("aemtli.presets"); },
  get listId() { const n = Number(store.get("grocy.listId")); return Number.isFinite(n) && n > 0 ? n : 1; },
  set listId(v) { store.set("grocy.listId", String(Number(v) || 1)); },
  get listName() { return store.get("grocy.listName") || ""; },
  set listName(v) { store.set("grocy.listName", v || ""); },
  get bookStock() { return store.get("grocy.bookStock") !== "0"; },     // Standard: an
  set bookStock(v) { store.set("grocy.bookStock", v ? "1" : "0"); },
  get theme() { return store.get("aemtli.theme") || "system"; },
  set theme(v) { v === "system" ? store.del("aemtli.theme") : store.set("aemtli.theme", v); },
  // Ämtli 2.1
  get suggest() { return store.get("aemtli.suggest") !== "0"; },              // Vorschläge anzeigen (Standard: an)
  set suggest(v) { store.set("aemtli.suggest", v ? "1" : "0"); },
  get noteHint() { return store.get("aemtli.noteHint") !== "0"; },            // vor dem Einsortieren an Notizen erinnern
  set noteHint(v) { store.set("aemtli.noteHint", v ? "1" : "0"); },
  get expireAuto() { const v = store.get("aemtli.expire.auto"); return v === null ? null : v === "1"; }, // null = noch nie gefragt
  set expireAuto(v) { store.set("aemtli.expire.auto", v ? "1" : "0"); },
  get expireSpoiled() { return store.get("aemtli.expire.spoiled") === "1"; }, // als „verdorben“ statt „verbraucht“ buchen
  set expireSpoiled(v) { store.set("aemtli.expire.spoiled", v ? "1" : "0"); },
  get configured() { return !!this.key && !!this.url; },
};

/* Journal: Wahrheit über laufende/abgebrochene Buchungen, pro Liste.
   { [itemId]: { phase: "booking"|"booked", tx, productId, amount, name, startedAt } } */
const JOURNAL = {
  key() { return "aemtli.journal." + CFG.listId; },
  all() { return store.json(this.key(), {}) || {}; },
  get(id) { return this.all()[id] || null; },
  set(id, patch) { const a = this.all(); a[id] = { ...(a[id] || {}), ...patch, itemId: num(id) }; store.set(this.key(), JSON.stringify(a)); },
  remove(id) { const a = this.all(); if (a[id]) { delete a[id]; store.set(this.key(), JSON.stringify(a)); } },
};

/* Letzter Einsortier-Lauf (für Rückgängig). */
const LAST = {
  get() { const v = store.json("aemtli.lastBatch", null); return v && v.rows && v.rows.length ? v : null; },
  set(v) { v ? store.set("aemtli.lastBatch", JSON.stringify(v)) : store.del("aemtli.lastBatch"); },
};

/* Letzter Datenstand (Cache-first beim Start, Anzeige offline). */
const SNAP = {
  get(k) { return store.json("aemtli.snap." + k, null); },
  set(k, data) { try { const s = JSON.stringify({ t: Date.now(), data }); if (s.length < 600000) store.set("aemtli.snap." + k, s); } catch (_) {} },
};

/* ---------------------------------------------------------------- Icons */
const I = {
  check: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>',
  plus: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M12 5v14"/></svg>',
  pack: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg>',
  more: '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>',
  broom: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/></svg>',
  leaf: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z"/><path d="M2 21c0-3 1.85-5.36 5.08-6"/></svg>',
  warn: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>',
  wifi: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 8.82a15 15 0 0 1 20 0"/><path d="M5 12.86a10 10 0 0 1 14 0"/><path d="M8.5 16.43a5 5 0 0 1 7 0"/><path d="M12 20h.01"/></svg>',
  eye: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>',
  paste: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/></svg>',
  back: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>',
  alert: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5"/><path d="M12 16.5h.01"/></svg>',
  bulb: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.3h6c0-1 .4-1.8 1-2.3A7 7 0 0 0 12 2Z"/></svg>',
  camera: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8a2 2 0 0 1 2-2h2l1.5-2h7L17 6h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><circle cx="12" cy="13" r="3.5"/></svg>',
  link: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.5 1.5"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7L12 19"/></svg>',
  x: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
};

/* ---------------------------------------------------------------- Utils */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const view = $("#view");
const app = $("#app");

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const fmtNum = (n) => num(n).toLocaleString("de-DE", { maximumFractionDigits: 3 });
const normKey = (s) => String(s == null ? "" : s).trim().normalize("NFC").toLowerCase();
const round3 = (n) => Math.round(num(n) * 1000) / 1000;
const pad2 = (n) => String(n).padStart(2, "0");
const isoDate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const addDays = (n) => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + n); return isoDate(d); };
const fmtDate = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || ""); return m ? `${m[3]}.${m[2]}.${m[1]}` : (iso || ""); };
const fmtTime = (ts) => { const d = new Date(ts); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
const agoLabel = (ts) => { const m = Math.max(0, Math.round((Date.now() - ts) / 60000)); return m < 1 ? "gerade eben" : m === 1 ? "vor 1 Min" : `vor ${m} Min`; };
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function initials(name) {
  const p = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!p.length) return "?";
  return ((p[0][0] || "") + (p.length > 1 ? p[p.length - 1][0] : "")).toUpperCase();
}
function applyTheme() {
  const t = CFG.theme;
  if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
  else document.documentElement.removeAttribute("data-theme");
}

/* ---------------------------------------------------------------- Toast */
let toastTimer = null;
let toastAction = null;
function toast(msg, { bad = false, action = null, duration } = {}) {
  const t = $("#toast"), m = $("#toast-msg"), a = $("#toast-act");
  m.textContent = msg;
  t.classList.toggle("bad", bad);
  toastAction = action;
  if (action) { a.textContent = action.label; a.hidden = false; }
  else { a.hidden = true; }
  t.classList.add("show");
  clearTimeout(toastTimer);
  const ms = duration || (action ? 8000 : bad ? 4500 : 2500);
  toastTimer = setTimeout(hideToast, ms);
  if (bad) { const la = $("#live-alert"); la.textContent = ""; setTimeout(() => { la.textContent = msg; }, 50); }
}
function hideToast() { $("#toast").classList.remove("show"); toastAction = null; }

/* --------------------------------------------------------------- Banner */
// Genau ein Banner, nach Priorität: auth > offline > proxy/list.
const bannerState = { auth: null, offline: null, proxy: null, list: null };
function renderBanner() {
  const b = $("#banner");
  const kind = ["auth", "offline", "proxy", "list"].find((k) => bannerState[k]);
  if (!kind) { b.className = "banner"; b.innerHTML = ""; b.removeAttribute("role"); return; }
  const cfg = bannerState[kind];
  b.className = "banner show " + cfg.tone;
  b.setAttribute("role", cfg.tone === "bad" ? "alert" : "status");
  b.innerHTML = `<span aria-hidden="true">${cfg.icon || I.warn}</span><span class="txt">${cfg.html}</span>` +
    (cfg.action ? `<button class="linkbtn" id="banner-act">${esc(cfg.action.label)}</button>` : "");
  const btn = $("#banner-act"); if (btn && cfg.action) btn.addEventListener("click", cfg.action.fn);
}
function setBanner(kind, cfg) { bannerState[kind] = cfg; renderBanner(); }
function reflectOnline() {
  if (navigator.onLine === false) {
    const snapT = (SNAP.get("shopping") || {}).t;
    setBanner("offline", { tone: "warn", icon: I.wifi, html: `<b>Offline.</b> Du siehst ${snapT ? "den Stand von " + fmtTime(snapT) : "den letzten Stand"}.` });
  } else setBanner("offline", null);
}

/* ---------------------------------------------------------------- API */
class ApiError extends Error {
  constructor(status, detail, extra = {}) {
    super(detail || `HTTP ${status}`);
    this.status = status; this.detail = detail || "";
    Object.assign(this, extra);
  }
}

/* fetch mit Timeout, JSON-Prüfung und Fehlerklassifikation.
   Flags am Fehler: offline, timeout, unclear (Mutation, Antwort unbekannt),
   fromGrocy (JSON-Fehler von Grocy), proxyDown, haAuth (HA-Ingress-Session),
   notJson (HTML statt JSON), notConfigured. */
async function api(path, { method = "GET", body, key = CFG.key, base = CFG.url, timeout } = {}) {
  if (!key || !base) throw new ApiError(0, "Nicht konfiguriert", { notConfigured: true });
  const mutation = method !== "GET";
  if (mutation && navigator.onLine === false) throw new ApiError(0, "offline", { offline: true });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout || (mutation ? 40000 : 15000));
  let res;
  try {
    res = await fetch(base + path, {
      method,
      headers: { "GROCY-API-KEY": key, Accept: "application/json", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      mode: "cors", cache: "no-store", credentials: "same-origin", signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    const aborted = !!(e && e.name === "AbortError");
    const err = new ApiError(0, aborted ? "Zeitüberschreitung" : "Netzwerkfehler",
      { offline: navigator.onLine === false, timeout: aborted, unclear: mutation && navigator.onLine !== false });
    state.reachable = false;
    DIAG.push({ kind: "net", path, msg: err.detail });
    throw err;
  }
  clearTimeout(timer);
  state.reachable = true;
  const ct = res.headers.get("content-type") || "";
  const txt = await res.text();
  let data = null, isJson = false;
  if (txt) { try { data = JSON.parse(txt); isJson = true; } catch (_) { isJson = false; } }
  if (!res.ok) {
    const proxyDown = res.headers.get("x-aemtli-proxy") === "down" || !!(data && data.aemtli_proxy);
    // Fehlendes Grocy-Recht: 403 mit JSON „Permission missing: <RECHT>“ (verifiziert an v4.6).
    // Das ist KEIN Schlüsselproblem und darf nie den Auth-Banner auslösen.
    const permMatch = isJson && res.status === 403 ? /permission missing:\s*([A-Z_]+)/i.exec((data && data.error_message) || "") : null;
    if (permMatch) PERM.deny(permMatch[1].toUpperCase());
    const err = new ApiError(res.status, isJson && data ? (data.error_message || data.message || "") : "", {
      fromGrocy: isJson && !proxyDown,
      proxyDown,
      forbidden: !!permMatch,
      permission: permMatch ? permMatch[1].toUpperCase() : null,
      unclear: mutation && [502, 503, 504].includes(res.status),
      // HA-Ingress-Session abgelaufen: nur unter Ingress und nur, wenn HA selbst antwortet
      // („401: Unauthorized“). Grocy liefert bei fehlendem/ungültigem Key 401 mit LEEREM
      // text/html-Body (verifiziert an Grocy 4.6) – das ist ein Schlüsselproblem.
      haAuth: UNDER_INGRESS && !isJson && (res.status === 401 || res.status === 403) && /unauthori[sz]ed|home assistant/i.test(txt),
      bodyHint: isJson ? "" : txt.slice(0, 120),
    });
    DIAG.push({ kind: "http", status: res.status, path, msg: err.detail || err.bodyHint });
    throw err;
  }
  if (res.status === 204 || !txt) return null;
  if (!isJson) {
    const err = new ApiError(res.status, "Antwort ist kein JSON", { notJson: true, bodyHint: txt.slice(0, 120) });
    DIAG.push({ kind: "parse", status: res.status, path, msg: err.bodyHint });
    throw err;
  }
  return data;
}

const GROCY_MSG = [
  [/does not exist or is inactive/i, "Produkt gibt es in Grocy nicht mehr oder es ist deaktiviert"],
  [/no_own_stock/i, "Produkt führt keinen eigenen Bestand"],
  [/tare weight/i, "Menge passt nicht zum Taragewicht des Produkts"],
  [/amount can.?t be/i, "Menge ungültig"],
  [/amount is required/i, "Menge fehlt"],
  [/location does not exist/i, "Lagerort gibt es nicht"],
  [/shopping list does not exist/i, "Einkaufsliste gibt es nicht"],
  [/object not found/i, "Eintrag existiert nicht mehr"],
  [/chore does not exist/i, "Aufgabe gibt es nicht mehr"],
];
function translateGrocy(detail) {
  for (const [re, t] of GROCY_MSG) if (re.test(detail || "")) return t;
  return detail || "";
}
function describeError(e) {
  if (!(e instanceof ApiError)) return "Etwas ist schiefgelaufen.";
  if (e.notConfigured) return "Ämtli ist noch nicht eingerichtet.";
  if (e.status === 0) {
    if (e.offline || navigator.onLine === false) return "Du bist offline. Änderungen gehen erst wieder mit Netz.";
    if (e.timeout) return "Grocy antwortet nicht (Zeitüberschreitung). Gleich nochmal versuchen.";
    return ADDON ? "Ämtli ist gerade nicht erreichbar. WLAN oder VPN prüfen." : "Keine Verbindung zu Grocy. Adresse und Netzwerk prüfen.";
  }
  if (e.haAuth) return "Deine Home-Assistant-Anmeldung ist abgelaufen. Bitte die Seite neu laden.";
  if (e.notJson) return "Unerwartete Antwort (Anmelde- oder WLAN-Portalseite?). Bitte die Seite neu laden.";
  if (e.forbidden) return `Dein Grocy-Konto darf das nicht${e.permission ? " (Recht " + PERM_LABEL(e.permission) + " fehlt)" : ""}. V kann es in Grocy unter Benutzer → Berechtigungen freischalten.`;
  if (e.status === 401 || e.status === 403) return "Dein Grocy-Schlüssel gilt nicht mehr. Vielleicht wurde er in Grocy gelöscht.";
  if (e.proxyDown || e.status === 502 || e.status === 503) return "Grocy ist gerade nicht erreichbar. Läuft das Grocy-Add-on in Home Assistant?";
  if (e.status === 504) return "Grocy antwortet zu langsam. Gleich nochmal versuchen.";
  if (e.status >= 500) return `Grocy meldet einen internen Fehler (${e.status}).`;
  if (e.status === 404) return "Das gibt es in Grocy nicht mehr.";
  if (e.status === 400) return "Grocy hat das abgelehnt" + (e.detail ? ": " + translateGrocy(e.detail) : ".");
  return `Grocy-Fehler ${e.status}${e.detail ? ": " + e.detail : ""}`;
}
const isAuthErr = (e) => e instanceof ApiError && !e.forbidden && (e.status === 401 || e.status === 403 || e.haAuth);
const PERM_LABEL = (p) => ({ MASTER_DATA_EDIT: "Stammdaten bearbeiten", STOCK_CONSUME: "Bestand verbrauchen", STOCK_PURCHASE: "Bestand einkaufen", STOCK_EDIT: "Bestand bearbeiten", SHOPPINGLIST_ITEMS_ADD: "Einkaufsliste bearbeiten" }[p] || p);
// Objekt schon weg? (DELETE auf fehlende ID liefert 400 „Object not found“, GET 404)
const isGone = (e) => e instanceof ApiError && (e.status === 404 || (e.status === 400 && /object not found/i.test(e.detail || "")));

/* ---------------------------------------------------------------- State */
const state = {
  tab: "shopping",
  products: new Map(),    // id -> {id,name,active,quStock,quPurchase,locationId,bbdDays,noOwnStock,groupId}
  units: new Map(),       // id -> {name, plural}
  conv: new Map(),        // productId -> Map("from:to" -> factor)
  locations: new Map(),   // id -> {name, freezer}
  productNames: [],       // aktive Produkte für Vorschläge
  mastersAt: 0,
  shopping: [],
  chores: [],
  busy: new Set(),
  running: false,
  rejected: {},           // itemId -> Grund (Grocy hat Buchung abgelehnt, nur Sitzung)
  user: null,
  grocyVersion: null,
  reachable: true,
  swState: "-",
  addSelected: null,
  fromCache: false,
};

/* ------------------------------------------------------- Stammdaten */
function ingestMasters({ products, units, convs, locs }) {
  state.products.clear(); state.productNames = []; state.units.clear(); state.conv.clear(); state.locations.clear();
  for (const p of Array.isArray(products) ? products : []) {
    const rec = {
      id: num(p.id), name: String(p.name || ""), active: String(p.active) !== "0",
      quStock: p.qu_id_stock != null ? num(p.qu_id_stock) : null,
      quPurchase: p.qu_id_purchase != null ? num(p.qu_id_purchase) : null,
      locationId: p.location_id != null && p.location_id !== "" ? num(p.location_id) : null,
      bbdDays: p.default_best_before_days != null ? num(p.default_best_before_days) : 0,
      noOwnStock: String(p.no_own_stock) === "1",
      parentId: p.parent_product_id != null && p.parent_product_id !== "" ? num(p.parent_product_id) : null,
      dueType: num(p.due_type) === 2 ? 2 : 1,                       // 1 = MHD, 2 = Verbrauchsdatum
      tare: String(p.enable_tare_weight_handling) === "1",
      minStock: num(p.min_stock_amount),
      groupId: p.product_group_id != null && p.product_group_id !== "" ? num(p.product_group_id) : null,
    };
    state.products.set(rec.id, rec);
    if (rec.active && !rec.noOwnStock) state.productNames.push({ id: rec.id, name: rec.name, key: normKey(rec.name) });
  }
  state.productNames.sort((a, b) => a.name.localeCompare(b.name, "de"));
  for (const u of Array.isArray(units) ? units : []) state.units.set(num(u.id), { name: String(u.name || ""), plural: String(u.name_plural || u.name || "") });
  for (const c of Array.isArray(convs) ? convs : []) {
    const pid = num(c.product_id);
    if (!state.conv.has(pid)) state.conv.set(pid, new Map());
    state.conv.get(pid).set(`${num(c.from_qu_id)}:${num(c.to_qu_id)}`, num(c.factor));
  }
  for (const l of Array.isArray(locs) ? locs : []) state.locations.set(num(l.id), { name: String(l.name || ""), freezer: String(l.is_freezer) === "1" });
}
async function loadMasters(force = false) {
  if (state.mastersAt && !force && Date.now() - state.mastersAt < 10 * 60 * 1000) return;
  const [products, units, convs, locs] = await Promise.all([
    api("/api/objects/products"),
    api("/api/objects/quantity_units"),
    api("/api/objects/quantity_unit_conversions_resolved").catch(() => []),
    api("/api/objects/locations").catch(() => []),
  ]);
  ingestMasters({ products, units, convs, locs });
  state.mastersAt = Date.now();
  SNAP.set("masters", { products, units, convs, locs });
}
function mastersFromSnapshot() {
  const s = SNAP.get("masters");
  if (!s || !s.data) return false;
  ingestMasters(s.data);
  return true;
}
// Umrechnungsfaktor zwischen zwei Einheiten eines Produkts (null = unbekannt).
function factor(pid, from, to) {
  if (from == null || to == null) return null;
  if (num(from) === num(to)) return 1;
  const m = state.conv.get(num(pid));
  const f = m ? m.get(`${num(from)}:${num(to)}`) : undefined;
  return f && f > 0 ? f : null;
}
function unitLabel(quId, amount) {
  const u = state.units.get(num(quId));
  if (!u) return "";
  return Math.abs(num(amount) - 1) < 1e-9 ? u.name : (u.plural || u.name);
}
const amountLabel = (value, quId) => `${fmtNum(value)}${quId != null && state.units.has(num(quId)) ? " " + unitLabel(quId, value) : ""}`;

/* ====================================================================== */
/*  EINKAUF                                                               */
/* ====================================================================== */
function mapShoppingItem(it) {
  const pid = it.product_id != null && it.product_id !== "" ? num(it.product_id) : null;
  const prod = pid != null ? state.products.get(pid) : null;
  const amount = (() => { const a = num(it.amount); return a > 0 ? a : 1; })();   // Lager-Einheit!
  const quId = it.qu_id != null && it.qu_id !== "" ? num(it.qu_id) : (prod ? prod.quStock : null);
  let kind = "note";
  if (pid != null) kind = !prod ? "unknown" : (!prod.active ? "inactive" : (prod.noOwnStock ? "nostock" : "product"));
  const name = prod ? prod.name : (pid != null ? `Unbekanntes Produkt #${pid}` : (String(it.note || "").trim() || "(ohne Namen)"));
  // Anzeige: amount (Lager-Einheit) × Faktor(Lager → qu_id)
  let dispValue = amount, dispQu = prod ? prod.quStock : null;
  if (prod && quId != null) {
    const f = factor(pid, prod.quStock, quId);
    if (f != null) { dispValue = round3(amount * f); dispQu = quId; }
  }
  return {
    id: num(it.id), productId: pid, product: prod, name, kind, isProduct: pid != null,
    amount, quId, dispValue, dispQu,
    // Umrechnungshinweis nur, wenn Anzeige- und Lager-Einheit verschieden sind
    stockHint: prod && dispQu != null && prod.quStock != null && dispQu !== prod.quStock ? amountLabel(amount, prod.quStock) : "",
    done: String(it.done) === "1",
    note: it.note != null ? String(it.note) : null,
    raw: it,
  };
}
const shoppingCmp = (a, b) => (a.done - b.done) || a.name.localeCompare(b.name, "de");

async function loadShopping() {
  await loadMasters();
  const lid = CFG.listId;
  const raw = await api(`/api/objects/shopping_list?query%5B%5D=shopping_list_id%3D${lid}`);
  let items = (Array.isArray(raw) ? raw : []).filter((it) => it.shopping_list_id == null || num(it.shopping_list_id) === lid);
  if (items.some((it) => it.product_id != null && it.product_id !== "" && !state.products.has(num(it.product_id)))) {
    await loadMasters(true);                                   // neues Produkt seit dem letzten Laden
  }
  state.shopping = items.map(mapShoppingItem).sort(shoppingCmp);
  state.fromCache = false;
  SNAP.set("shopping", items);
  // Journal-Einträge zu Zeilen, die es nicht mehr gibt, sind erledigt.
  const present = new Set(state.shopping.map((s) => s.id));
  for (const id of Object.keys(JOURNAL.all())) if (!present.has(num(id))) JOURNAL.remove(id);
  if (!state.shopping.length) await checkListExists(lid);
}
function shoppingFromSnapshot() {
  const s = SNAP.get("shopping");
  if (!s || !Array.isArray(s.data)) return false;
  if (!state.products.size && !mastersFromSnapshot()) return false;
  state.shopping = s.data.map(mapShoppingItem).sort(shoppingCmp);
  state.fromCache = true;
  return true;
}
async function checkListExists(lid) {
  try { await api(`/api/objects/shopping_lists/${lid}`); setBanner("list", null); }
  catch (e) {
    if (isGone(e)) {
      const lists = await api("/api/objects/shopping_lists").catch(() => null);
      if (Array.isArray(lists) && lists.length === 1) {           // nur noch eine → übernehmen
        CFG.listId = num(lists[0].id); CFG.listName = lists[0].name || "";
        toast(`Liste „${lists[0].name || lists[0].id}“ übernommen`);
        throw Object.assign(new ApiError(0, "reload"), { reload: true });
      }
      setBanner("list", { tone: "bad", html: "<b>Die Einkaufsliste gibt es in Grocy nicht mehr.</b>", action: { label: "Liste wählen", fn: () => go("settings") } });
    }
  }
}

/* Buchungsplan pro Zeile – alle Entscheidungen fallen hier, sichtbar und deterministisch. */
function plan(it, override = {}) {
  const p = it.product;
  const out = { kind: it.kind, stockAmount: it.amount, bbd: undefined, bbdMode: "none", bbdLabel: "", locationId: undefined, locationName: "", noteOnly: it.kind !== "product" };
  if (!p || it.kind !== "product") return out;
  if (override.amount != null && override.amount > 0) out.stockAmount = round3(override.amount);
  const loc = p.locationId != null ? state.locations.get(p.locationId) : null;
  out.locationName = loc ? loc.name : "";
  if (override.locationId != null && override.locationId !== p.locationId) {
    out.locationId = override.locationId;
    const l = state.locations.get(override.locationId); out.locationName = l ? l.name : "";
  }
  // Das Datum wird IMMER explizit gesendet: Grocy würde sonst bei einem Tiefkühl-Lagerort
  // „heute“ setzen (Gefrier-Regel, verifiziert an v4.6) – unabhängig vom Produkt-Default.
  if (override.bbd === "never") { out.bbd = NEVER; out.bbdMode = "custom"; out.bbdLabel = "unbegrenzt haltbar"; }
  else if (override.bbd) { out.bbd = override.bbd; out.bbdMode = "custom"; out.bbdLabel = "haltbar bis " + fmtDate(override.bbd); }
  else if (p.bbdDays === -1) { out.bbd = NEVER; out.bbdMode = "never"; out.bbdLabel = "unbegrenzt haltbar"; }
  else if (p.bbdDays > 0) { out.bbd = addDays(p.bbdDays); out.bbdMode = "default"; out.bbdLabel = "haltbar bis " + fmtDate(out.bbd); }
  else { out.bbd = NEVER; out.bbdMode = "missing"; out.bbdLabel = "ohne Haltbarkeitsdatum"; }         // sonst würde Grocy HEUTE setzen
  return out;
}

/* ---- Rendering ---- */
function journalMeta(it) {
  const j = JOURNAL.get(it.id);
  if (j && j.phase === "booked") return { cls: "warn", text: "Im Vorrat, noch auf der Liste", btn: { act: "remove-only", label: "Von der Liste nehmen" } };
  if (j && j.phase === "booking") return { cls: "warn", text: "Buchung wird noch geprüft …", btn: { act: "recheck", label: "Jetzt prüfen" } };
  if (state.rejected[it.id]) return { cls: "bad", text: "Grocy hat die Buchung abgelehnt: " + state.rejected[it.id], btn: { act: "remove-only", label: "Ohne Vorrat von der Liste nehmen" } };
  return null;
}
function kindChip(it) {
  if (it.kind === "note") return `<span class="chip">Notiz</span>`;
  if (it.kind === "inactive") return `<span class="chip">in Grocy deaktiviert</span>`;
  if (it.kind === "unknown") return `<span class="chip warn">unbekanntes Produkt</span>`;
  if (it.kind === "nostock") return `<span class="chip">ohne eigenen Bestand</span>`;
  return "";
}
// „!“-Knopf an Notiz-Zeilen: öffnet den Produkt-Wizard.
const wizardBtnHTML = (it, busy) => `<button class="iconbtn warnbtn" data-act="wizard" data-id="${it.id}" aria-label="„${esc(it.name)}“ als Produkt anlegen" title="Als Produkt anlegen" ${busy ? "disabled" : ""}>${I.alert}</button>`;
function openRowHTML(it) {
  const busy = state.busy.has("s" + it.id);
  const amt = it.kind === "note" ? "" : amountLabel(it.dispValue, it.dispQu);
  if (it.kind === "note") return `
    <div class="row">
      <button class="lead" data-act="toggle" data-id="${it.id}" role="checkbox" aria-checked="false"
              aria-label="${esc(it.name)}, in den Wagen legen" ${busy ? 'aria-disabled="true"' : ""}>
        <span class="check" aria-hidden="true"></span>
      </button>
      <span class="body tap" data-act="toggle" data-id="${it.id}">
        <span class="nm">${esc(it.name)} ${kindChip(it)}</span>
        ${it.amount > 1 ? `<span class="meta">${esc(fmtNum(it.amount))}×</span>` : ""}
      </span>
      <span class="trail">${wizardBtnHTML(it, busy)}</span>
    </div>`;
  return `
    <button class="row" data-act="toggle" data-id="${it.id}" role="checkbox" aria-checked="false"
            aria-label="${esc(it.name)}${amt ? ", " + esc(amt) : ""}, in den Wagen legen" ${busy ? 'aria-disabled="true"' : ""}>
      <span class="lead" aria-hidden="true"><span class="check"></span></span>
      <span class="body">
        <span class="nm">${esc(it.name)} ${kindChip(it)}</span>
        ${amt ? `<span class="meta">${esc(amt)}</span>` : ""}
      </span>
    </button>`;
}
function cartRowHTML(it) {
  const busy = state.busy.has("s" + it.id) || state.running;
  const amt = it.kind === "note" ? "" : amountLabel(it.dispValue, it.dispQu);
  const jm = journalMeta(it);
  const hint = it.stockHint ? ` → ${esc(it.stockHint)}` : "";
  return `
    <div class="row done">
      <button class="lead" data-act="toggle" data-id="${it.id}" role="checkbox" aria-checked="true"
              aria-label="${esc(it.name)} zurück auf die Liste" ${busy ? 'aria-disabled="true"' : ""}>
        <span class="check on" aria-hidden="true">${I.check}</span>
      </button>
      <span class="body">
        <span class="nm">${esc(it.name)} ${kindChip(it)}</span>
        ${jm ? `<span class="meta ${jm.cls}">${esc(jm.text)}</span>` : (amt ? `<span class="meta">${esc(amt)}${hint}</span>` : "")}
      </span>
      <span class="trail">
        ${it.kind === "note" ? wizardBtnHTML(it, busy) : `<button class="iconbtn" data-act="adjust" data-id="${it.id}" aria-label="${esc(it.name)} anpassen" ${busy ? "disabled" : ""}>${I.more}</button>`}
      </span>
    </div>
    ${jm && jm.btn ? `<div class="rowbtns"><button class="btn btn-ghost btn-sm" data-act="${jm.btn.act}" data-id="${it.id}" ${busy ? "disabled" : ""}>${esc(jm.btn.label)}</button></div>` : ""}`;
}
function undoLineHTML() {
  const last = LAST.get();
  if (!last || Date.now() - last.at > UNDO_WINDOW_MS) return "";
  return `<div class="undo-line"><span>${esc(agoLabel(last.at))}: ${esc(plural(last.rows.length, "Sache", "Sachen"))} einsortiert</span><button class="linkbtn" data-act="undo-last">Rückgängig</button></div>`;
}
function renderShopping() {
  if (state.tab !== "shopping") return;
  const focusKey = rememberFocus();
  state.shopping.sort(shoppingCmp);
  const open = state.shopping.filter((s) => !s.done);
  const done = state.shopping.filter((s) => s.done);
  const stale = state.fromCache ? " · Stand aus dem Zwischenspeicher" : "";
  view.innerHTML = `
    <div class="phead">
      <h1 class="h1">Einkauf</h1>
      <p class="sub">${open.length} zu kaufen${done.length ? ` · ${done.length} im Wagen` : ""}${stale}</p>
    </div>
    <div class="addwrap">
      <form class="addbar card" id="add-form" autocomplete="off">
        <span class="ic" aria-hidden="true">${I.plus}</span>
        <input type="text" id="add-input" placeholder="Was fehlt?" aria-label="Artikel hinzufügen" autocapitalize="sentences" enterkeyhint="done" role="combobox" aria-expanded="false" aria-controls="suggest" />
        <input type="number" id="add-qty" class="qtybox" value="1" min="0.001" step="any" inputmode="decimal" aria-label="Menge" />
        <button class="btn btn-primary" type="submit" aria-label="Hinzufügen">${I.plus}</button>
      </form>
      <ul class="suggest" id="suggest" role="listbox" hidden></ul>
    </div>
    ${undoLineHTML()}
    ${suggestionsHTML()}
    <h2 class="sect">Zu kaufen <span class="count">${open.length}</span></h2>
    <section class="card" aria-label="Zu kaufen">
      ${open.length ? open.map(openRowHTML).join("") : emptyHTML(I.leaf, done.length ? "Alles im Wagen" : "Alles da", "Schreib oben rein, was fehlt.")}
    </section>
    ${done.length ? `
    <h2 class="sect">Im Wagen <span class="count">${done.length}</span>${done.some((d) => d.kind === "note") ? `<span class="count warn">${esc(plural(done.filter((d) => d.kind === "note").length, "Notiz", "Notizen"))}</span>` : ""}</h2>
    <section class="card" aria-label="Im Wagen">${done.map(cartRowHTML).join("")}</section>` : ""}
  `;
  const form = $("#add-form"); form.addEventListener("submit", onAddSubmit);
  const input = $("#add-input");
  input.addEventListener("input", () => { state.addSelected = null; renderSuggestions(input.value); });
  input.addEventListener("keydown", onSuggestKey);
  input.addEventListener("blur", () => setTimeout(() => hideSuggestions(), 150));
  renderCta();
  restoreFocus(focusKey);
}
function renderCta() {
  const wrap = $("#ctawrap");
  const done = state.tab === "shopping" ? state.shopping.filter((s) => s.done) : [];
  if (!done.length || state.tab !== "shopping") { wrap.hidden = true; wrap.innerHTML = ""; app.classList.remove("has-cta"); view.classList.remove("has-cta"); return; }
  const products = done.filter((d) => d.kind === "product").length;
  const notes = done.filter((d) => d.kind === "note").length;
  const label = (CFG.bookStock && products
    ? `${plural(done.length, "Sache", "Sachen")} einsortieren`
    : `${plural(done.length, "Sache", "Sachen")} von der Liste nehmen`) + (notes && products ? ` · ${plural(notes, "Notiz", "Notizen")}` : "");
  wrap.innerHTML = `<button class="btn btn-primary cta" data-act="putaway-all" ${state.running ? "disabled" : ""}>${I.pack}<span>${esc(label)}</span></button>`;
  wrap.hidden = false; app.classList.add("has-cta"); view.classList.add("has-cta");
}

/* ---- Vorschläge (eigene Liste statt datalist – iOS) ---- */
let suggestIdx = -1;
function suggestions(q) {
  const k = normKey(q);
  if (!k) return [];
  const starts = [], contains = [];
  for (const p of state.productNames) {
    if (p.key.startsWith(k)) starts.push(p); else if (p.key.includes(k)) contains.push(p);
    if (starts.length >= 6) break;
  }
  return starts.concat(contains).slice(0, 6);
}
function renderSuggestions(q) {
  const ul = $("#suggest"), input = $("#add-input");
  if (!ul) return;
  const list = suggestions(q);
  const exact = list.find((p) => p.key === normKey(q));
  if (!q.trim()) { hideSuggestions(); return; }
  suggestIdx = -1;
  ul.innerHTML = list.map((p) => {
    const prod = state.products.get(p.id);
    const unit = prod && prod.quPurchase != null ? unitLabel(prod.quPurchase, 2) : "";
    return `<li role="option" data-pid="${p.id}" aria-selected="false"><span class="nm">${esc(p.name)}</span><span class="chip ok">Produkt${unit ? " · " + esc(unit) : ""}</span></li>`;
  }).join("") + (exact ? "" : `<li role="option" data-note="1" aria-selected="false"><span class="nm">„${esc(q.trim())}“</span><span class="chip">als Notiz</span></li>`);
  ul.hidden = false; input.setAttribute("aria-expanded", "true");
  $$("li", ul).forEach((li) => li.addEventListener("mousedown", (e) => { e.preventDefault(); pickSuggestion(li); }));
}
function hideSuggestions() { const ul = $("#suggest"), input = $("#add-input"); if (ul) { ul.hidden = true; ul.innerHTML = ""; } if (input) input.setAttribute("aria-expanded", "false"); suggestIdx = -1; }
function pickSuggestion(li) {
  const input = $("#add-input");
  if (li.dataset.pid) { const p = state.products.get(num(li.dataset.pid)); state.addSelected = p || null; input.value = p ? p.name : input.value; }
  else state.addSelected = { note: true };
  hideSuggestions();
  $("#add-form").requestSubmit ? $("#add-form").requestSubmit() : onAddSubmit(new Event("submit"));
}
function onSuggestKey(e) {
  const ul = $("#suggest"); if (!ul || ul.hidden) return;
  const items = $$("li", ul); if (!items.length) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    suggestIdx = (suggestIdx + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items.forEach((li, i) => li.setAttribute("aria-selected", i === suggestIdx ? "true" : "false"));
  } else if (e.key === "Enter") {
    e.preventDefault();
    if (suggestIdx >= 0) pickSuggestion(items[suggestIdx]);
    else { const f = $("#add-form"); if (f) (f.requestSubmit ? f.requestSubmit() : onAddSubmit(new Event("submit"))); }
  }
  else if (e.key === "Escape") hideSuggestions();
}

let adding = false;
async function onAddSubmit(e) {
  e.preventDefault();
  if (adding) return;
  const input = $("#add-input"), qtyEl = $("#add-qty"), submit = $("#add-form button[type=submit]");
  const name = (input.value || "").trim();
  if (!name) return;
  let qty = num(qtyEl.value); if (qty <= 0) qty = 1;
  hideSuggestions();

  // Produkt: explizit gewählt, sonst eindeutiger exakter Namenstreffer; sonst Notiz.
  let prod = state.addSelected && !state.addSelected.note ? state.addSelected : null;
  if (!prod && !(state.addSelected && state.addSelected.note)) {
    const k = normKey(name);
    const m = state.productNames.filter((p) => p.key === k);
    if (m.length === 1) prod = state.products.get(m[0].id) || null;
  }
  let body, label;
  if (prod) {
    // Eingabe gilt in der Einkaufs-Einheit; gespeichert wird in der Lager-Einheit.
    const f = prod.quPurchase != null && prod.quStock != null ? factor(prod.id, prod.quPurchase, prod.quStock) : null;
    const amount = f != null ? round3(qty * f) : qty;
    const quId = f != null ? prod.quPurchase : prod.quStock;
    body = { shopping_list_id: CFG.listId, product_id: prod.id, amount, ...(quId != null ? { qu_id: quId } : {}) };
    label = `„${prod.name}“ (${amountLabel(qty, quId)}) ergänzt`;
  } else {
    body = { shopping_list_id: CFG.listId, note: name, amount: qty };
    label = `„${name}“ ergänzt`;
  }
  adding = true; submit.disabled = true; input.disabled = true;
  let created = null;
  try { created = await api("/api/objects/shopping_list", { method: "POST", body }); }
  catch (err) { toast(describeError(err), { bad: true }); return; }          // Eingabe bleibt stehen
  finally { adding = false; submit.disabled = false; input.disabled = false; }
  input.value = ""; qtyEl.value = "1"; state.addSelected = null; input.focus();
  // Notiz angelegt → tipploser Einstieg in den Produkt-Wizard über die Toast-Aktion.
  const newId = created && created.created_object_id != null ? num(created.created_object_id) : null;
  if (!prod && newId) toast(label, { action: { label: "Als Produkt anlegen", fn: () => openWizard(newId) } });
  else toast(label);
  try { await loadShopping(); renderShopping(); updateBadges(); }
  catch (err) { /* hinzugefügt – nur das Nachladen hakt */ toast("Hinzugefügt. Die Liste konnte gerade nicht neu geladen werden.", { bad: true }); }
}

async function toggleShopping(id) {
  if (state.busy.has("s" + id) || state.running) return;
  const it = state.shopping.find((s) => s.id === id);
  if (!it) return;
  if (JOURNAL.get(id)) { toast("Diese Zeile hängt noch in einer Buchung. Erst prüfen oder von der Liste nehmen."); return; }
  if (navigator.onLine === false) { toast("Gerade kein Netz. Probier es gleich nochmal."); return; }
  const next = !it.done;
  it.done = next;                                   // optimistisch
  state.busy.add("s" + id);
  renderShopping(); updateBadges();
  try {
    await api(`/api/objects/shopping_list/${id}`, { method: "PUT", body: { done: next ? 1 : 0 } });
    if (typeof navigator.vibrate === "function") { try { navigator.vibrate(8); } catch (_) {} }
  } catch (err) {
    if (isGone(err)) {
      state.shopping = state.shopping.filter((s) => s.id !== id);
      toast(`„${it.name}“ hat jemand inzwischen von der Liste genommen.`);
      refresh({ quiet: true });
    } else {
      const cur = state.shopping.find((s) => s.id === id); if (cur) cur.done = !next;   // zurückrollen
      toast(describeError(err), { bad: true });
      if (isAuthErr(err)) showAuthBanner(err);
    }
  } finally {
    state.busy.delete("s" + id);
    renderShopping(); updateBadges();
  }
}

/* ---- Abgleich nach unklarer Buchung: hat Grocy den Eintrag? (note-Marker) ---- */
async function reconcile(itemId) {
  const rows = await api(`/api/objects/stock_log?query%5B%5D=note%3D${encodeURIComponent("aemtli:sl-" + itemId)}&query%5B%5D=undone%3D0&query%5B%5D=transaction_type%3Dpurchase&limit=1`);
  const r = Array.isArray(rows) && rows.length ? rows[0] : null;
  return r ? { booked: true, tx: r.transaction_id || null } : { booked: false };
}

/* Eine Zeile einsortieren. Gibt {status, msg, stop} zurück, wirft nie.
   status: ok (gebucht+entfernt) | removed (nur entfernt) | rejected (400) |
           unclear (Antwort unbekannt) | booked-not-removed | failed | offline */
async function putAwayOne(it, useStock, override = {}) {
  const id = it.id;
  const pl = plan(it, override);
  let j = JOURNAL.get(id);
  let tx = j && j.tx ? j.tx : null;
  let booked = !!(j && j.phase === "booked");
  const wantsStock = useStock && it.kind === "product";

  try {
    if (wantsStock && !booked) {
      if (j && j.phase === "booking") {                    // Rest einer unklaren Buchung → erst abgleichen
        const rec = await reconcile(id);
        if (rec.booked) { tx = rec.tx; booked = true; JOURNAL.set(id, { phase: "booked", tx }); }
        else JOURNAL.remove(id);
      }
      if (!booked) {
        JOURNAL.set(id, { phase: "booking", productId: it.productId, amount: pl.stockAmount, name: it.name, startedAt: Date.now() });
        const body = { amount: pl.stockAmount, transaction_type: "purchase", note: "aemtli:sl-" + id };
        if (pl.bbd) body.best_before_date = pl.bbd;
        if (pl.locationId != null) body.location_id = pl.locationId;
        try {
          const res = await api(`/api/stock/products/${it.productId}/add`, { method: "POST", body });
          tx = Array.isArray(res) && res[0] && res[0].transaction_id ? res[0].transaction_id : null;
          booked = true; JOURNAL.set(id, { phase: "booked", tx });
        } catch (e) {
          if (e.offline) { JOURNAL.remove(id); return { status: "offline", msg: describeError(e), stop: "offline" }; }
          if (isAuthErr(e)) { JOURNAL.remove(id); return { status: "failed", msg: describeError(e), stop: "auth", err: e }; }
          if (e.unclear) {
            try {
              const rec = await reconcile(id);
              if (rec.booked) { tx = rec.tx; booked = true; JOURNAL.set(id, { phase: "booked", tx }); }
              else { JOURNAL.remove(id); return { status: "failed", msg: describeError(e), stop: "unclear", err: e }; }
            } catch (_) { return { status: "unclear", msg: "Antwort kam nicht an. Wird geprüft, sobald Grocy wieder antwortet.", stop: "unclear", err: e }; }
          } else {
            JOURNAL.remove(id);
            if (e.status === 400 && e.fromGrocy) { state.rejected[id] = translateGrocy(e.detail) || "ohne Angabe"; return { status: "rejected", msg: "Grocy hat die Buchung abgelehnt: " + state.rejected[id], err: e }; }
            return { status: "failed", msg: describeError(e), err: e };
          }
        }
      }
    }
    // Von der Liste nehmen.
    try { await api(`/api/objects/shopping_list/${id}`, { method: "DELETE" }); }
    catch (e) {
      if (!isGone(e)) {
        if (e.offline) return { status: booked ? "booked-not-removed" : "offline", msg: describeError(e), stop: "offline" };
        if (isAuthErr(e)) return { status: booked ? "booked-not-removed" : "failed", msg: describeError(e), stop: "auth", err: e };
        return { status: booked ? "booked-not-removed" : "failed", msg: booked ? "Im Vorrat, aber noch auf der Liste." : describeError(e), err: e };
      }
    }
    JOURNAL.remove(id); delete state.rejected[id];
    state.shopping = state.shopping.filter((s) => s.id !== id);
    return { status: booked ? "ok" : "removed", tx, noBbd: booked && pl.bbdMode === "missing" };
  } catch (e) {
    DIAG.push({ kind: "js", msg: "putAwayOne: " + String(e && e.message || e) });
    return { status: "failed", msg: "Etwas ist schiefgelaufen.", err: e };
  }
}

/* Einsortier-Lauf über mehrere Zeilen: sequenziell, mit Fortschritts-Sheet. */
async function runPutaway(items, { overrides = {} } = {}) {
  if (state.running || !items.length) return;
  if (navigator.onLine === false) { toast("Gerade kein Netz. Einsortieren geht, sobald du wieder online bist."); return; }
  state.running = true; renderCta(); renderShopping();
  const useStock = CFG.bookStock;
  // Frischer Stand: Zeilen, die andere inzwischen entfernt/zurückgelegt haben, überspringen.
  try { await loadShopping(); } catch (_) {}
  const todo = items.map((x) => state.shopping.find((s) => s.id === x.id)).filter((s) => s && s.done);
  const skippedGone = items.length - todo.length;
  // Beim Auspacken: Kühlschrank/Tiefkühler zuerst, Notizen zuletzt.
  const locKey = (it) => { const p = it.product; const l = p && p.locationId != null ? state.locations.get(p.locationId) : null; return it.kind !== "product" ? "zz" : (l ? (l.freezer ? "0" : "1") + l.name : "y"); };
  todo.sort((a, b) => locKey(a).localeCompare(locKey(b), "de") || a.name.localeCompare(b.name, "de"));

  const bookingNeeded = useStock && todo.some((t) => t.kind === "product");
  const results = [];
  let stopped = null;
  if (bookingNeeded) openProgressSheet(todo);
  try {
    for (const it of todo) {
      if (stopped) { results.push({ item: it, status: "skipped" }); continue; }
      if (navigator.onLine === false) { stopped = "offline"; results.push({ item: it, status: "skipped" }); continue; }
      setProgress(it.id, "running");
      state.busy.add("s" + it.id);
      const r = await putAwayOne(it, useStock, overrides[it.id] || {});
      state.busy.delete("s" + it.id);
      r.item = it; results.push(r);
      if (r.stop) stopped = r.stop;
      setProgress(it.id, r.status, r.msg, it);
      setProgressBar(results.length, todo.length);
    }
  } finally {
    state.running = false;
  }
  // Rückgängig-Paket
  const doneRows = results.filter((r) => r.status === "ok" || r.status === "removed").map((r) => ({
    productId: r.item.productId, note: r.item.note, amount: r.item.amount, quId: r.item.quId, tx: r.tx || null, name: r.item.name,
  }));
  if (doneRows.length) LAST.set({ at: Date.now(), listId: CFG.listId, rows: doneRows });

  renderShopping(); updateBadges();
  const ok = doneRows.length;
  const rejected = results.filter((r) => r.status === "rejected").length;
  const unclear = results.filter((r) => r.status === "unclear").length;
  const failed = results.filter((r) => r.status === "failed" || r.status === "booked-not-removed").length;
  const noBbd = results.filter((r) => r.noBbd).length;
  const skipped = results.filter((r) => r.status === "skipped").length + skippedGone;
  const allGood = !rejected && !unclear && !failed && !skipped && stopped == null;

  if (stopped === "auth") { const r = results.find((x) => x.err && isAuthErr(x.err)); if (r) showAuthBanner(r.err); }
  if (stopped === "offline") reflectOnline();

  if (allGood) {
    sheetLocked = false; closeSheet();
    const extra = noBbd ? ` · ${noBbd} ohne Haltbarkeitsdatum` : "";
    toast(`${plural(ok, "Sache", "Sachen")} einsortiert${extra}`, ok ? { action: { label: "Rückgängig", fn: undoLast } } : {});
  } else {
    const parts = [];
    if (ok) parts.push(`${ok} einsortiert`);
    if (rejected) parts.push(`${rejected} abgelehnt`);
    if (unclear) parts.push(`${unclear} unklar`);
    if (failed) parts.push(`${failed} nicht geschafft`);
    if (skipped) parts.push(`${skipped} übersprungen`);
    const why = stopped === "offline" ? "Du bist offline – der Rest wartet."
      : stopped === "auth" ? "Dein Schlüssel wird nicht mehr akzeptiert – nichts weiter geändert."
      : stopped === "unclear" ? "Grocy hat nicht geantwortet – der Rest wartet, damit nichts doppelt gebucht wird."
      : rejected ? "Abgelehnte Zeilen bleiben im Wagen. Du kannst sie ohne Vorrat von der Liste nehmen." : "";
    if (bookingNeeded) finishProgressSheet(parts.join(", "), why, ok ? undoLast : null);
    else toast(parts.join(", ") + (why ? ". " + why : ""), { bad: true, duration: 6000 });
  }
}
async function putAwayAll() {
  const done = state.shopping.filter((s) => s.done);
  if (!done.length || state.running) return;
  // Vor dem Lauf einmal hinweisen: Notizen sind noch kein Produkt, Produkte ohne Haltbarkeit.
  const notes = CFG.noteHint ? done.filter((d) => d.kind === "note" && !NOTE_SKIP.has(d.id)) : [];
  const noBbd = CFG.bookStock && CFG.noteHint ? done.filter((d) => d.kind === "product" && d.product && d.product.bbdDays === 0 && !NOTE_SKIP.has("p" + d.productId)) : [];
  if (notes.length || noBbd.length) { openPrePutawaySheet(done, notes, noBbd); return; }
  await runPutaway(done);
}
async function removeOnly(id) {
  const it = state.shopping.find((s) => s.id === id);
  if (!it || state.busy.has("s" + id)) return;
  state.busy.add("s" + id); renderShopping();
  const j = JOURNAL.get(id);
  // Bereits gebucht → nur Löschen nachholen; sonst ohne Buchung entfernen.
  const r = await putAwayOne(it, !!(j && j.phase === "booked"), {});
  state.busy.delete("s" + id);
  renderShopping(); updateBadges();
  if (r.status === "ok" || r.status === "removed") {
    LAST.set({ at: Date.now(), listId: CFG.listId, rows: [{ productId: it.productId, note: it.note, amount: it.amount, quId: it.quId, tx: r.tx || null, name: it.name }] });
    toast(`„${it.name}“ von der Liste genommen`, { action: { label: "Rückgängig", fn: undoLast } });
  } else toast(r.msg || describeError(r.err), { bad: true });
}
async function recheck(id) {
  const it = state.shopping.find((s) => s.id === id);
  if (!it) return;
  state.busy.add("s" + id); renderShopping();
  try {
    const rec = await reconcile(id);
    if (rec.booked) { JOURNAL.set(id, { phase: "booked", tx: rec.tx }); toast(`„${it.name}“ ist im Vorrat. Jetzt nur noch von der Liste nehmen.`); }
    else { JOURNAL.remove(id); toast(`„${it.name}“ wurde nicht gebucht. Du kannst es erneut einsortieren.`); }
  } catch (e) { toast(describeError(e), { bad: true }); }
  finally { state.busy.delete("s" + id); renderShopping(); }
}
/* Journal beim Laden still reparieren (booked → löschen, booking → abgleichen). */
async function repairJournal() {
  if (state.running || navigator.onLine === false) return;
  const all = JOURNAL.all();
  let changed = false;
  for (const idStr of Object.keys(all)) {
    const id = num(idStr), j = all[idStr];
    const it = state.shopping.find((s) => s.id === id);
    if (!it) { JOURNAL.remove(id); changed = true; continue; }
    try {
      if (j.phase === "booking") {
        const rec = await reconcile(id);
        if (rec.booked) JOURNAL.set(id, { phase: "booked", tx: rec.tx }); else JOURNAL.remove(id);
        changed = true;
      }
      if ((JOURNAL.get(id) || {}).phase === "booked") {
        try { await api(`/api/objects/shopping_list/${id}`, { method: "DELETE" }); } catch (e) { if (!isGone(e)) throw e; }
        JOURNAL.remove(id); state.shopping = state.shopping.filter((s) => s.id !== id); changed = true;
        toast(`„${it.name}“ von vorhin nachgeholt: ist im Vorrat und von der Liste.`);
      }
    } catch (_) { /* später nochmal */ }
  }
  if (changed) { renderShopping(); updateBadges(); }
}

/* ---- Rückgängig (letzter Lauf) ---- */
async function undoLast() {
  const last = LAST.get();
  if (!last) { toast("Nichts zum Rückgängigmachen."); return; }
  if (state.running) return;
  hideToast();
  state.running = true; renderCta();
  let okN = 0, failN = 0, txFail = 0;
  try {
    for (const r of last.rows) {
      let bookingUndone = !r.tx;
      if (r.tx) {
        try { await api(`/api/stock/transactions/${encodeURIComponent(r.tx)}/undo`, { method: "POST", body: {} }); bookingUndone = true; }
        catch (e) { txFail++; }
      }
      try {
        const body = { shopping_list_id: last.listId, amount: r.amount, done: 1, ...(r.productId != null ? { product_id: r.productId } : { note: r.note || r.name }), ...(r.quId != null ? { qu_id: r.quId } : {}) };
        await api("/api/objects/shopping_list", { method: "POST", body });
        if (bookingUndone) okN++; else failN++;
      } catch (e) { failN++; }
    }
  } finally { state.running = false; }
  LAST.set(null);
  try { await loadShopping(); } catch (_) {}
  renderShopping(); updateBadges();
  if (!failN && !txFail) toast(`${plural(okN, "Sache", "Sachen")} zurück im Wagen`);
  else toast(`Rückgängig nur teilweise: ${okN} zurück, ${txFail ? txFail + " Buchungen ließen sich nicht mehr zurücknehmen" : failN + " nicht geschafft"}. Bitte in Grocy prüfen.`, { bad: true, duration: 7000 });
}

/* ---- Anpassen-Sheet (⋯ auf einer Wagen-Zeile) ---- */
function openAdjustSheet(id) {
  const it = state.shopping.find((s) => s.id === id);
  if (!it || state.running) return;
  const p = it.product;
  const pl = plan(it);
  const jm = journalMeta(it);
  const canBook = CFG.bookStock && it.kind === "product" && !jm;
  const dispUnit = it.dispQu != null ? unitLabel(it.dispQu, 2) : "";
  const stockUnit = p && p.quStock != null ? unitLabel(p.quStock, 2) : "";
  const toStock = (v) => { const f = p && it.dispQu != null ? factor(p.id, it.dispQu, p.quStock) : null; return f != null ? round3(v * f) : round3(v); };
  const locOpts = Array.from(state.locations.entries()).map(([lid, l]) => `<option value="${lid}" ${p && p.locationId === lid ? "selected" : ""}>${esc(l.name)}</option>`).join("");
  const bbdDefault = pl.bbdMode === "default" ? addDays(p.bbdDays) : "";
  const html = `
    <h2 id="sheet-title">${esc(it.name)}</h2>
    <p class="sub">${kindChip(it) || "Im Wagen"}</p>
    ${it.kind !== "note" ? `
    <div class="field" style="padding:8px 0">
      <span class="lbl">Gekaufte Menge${dispUnit ? " in " + esc(dispUnit) : ""}</span>
      <div class="stepper">
        <button type="button" id="adj-minus" aria-label="weniger">−</button>
        <input type="number" id="adj-qty" value="${esc(String(it.dispValue))}" min="0.001" step="any" inputmode="decimal" aria-label="Menge" />
        <button type="button" id="adj-plus" aria-label="mehr">+</button>
      </div>
      <div class="hint" id="adj-stockline" style="text-align:center">${it.stockHint ? `= ${esc(amountLabel(toStock(it.dispValue), p.quStock))} kommen in den Vorrat` : ""}</div>
    </div>` : ""}
    ${canBook ? `
    <details class="help" style="margin:0 0 8px">
      <summary>Mehr: Haltbarkeit · Lagerort</summary>
      <div class="field" style="padding:8px 0">
        <label for="adj-bbd">Haltbar bis</label>
        <div class="inline">
          <input type="date" id="adj-bbd" value="${esc(bbdDefault)}" />
          <button type="button" class="btn btn-ghost btn-sm" id="adj-never">unbegrenzt</button>
        </div>
        <span class="hint" id="adj-bbdhint">${esc(pl.bbdMode === "missing" ? "Grocy kennt für dieses Produkt keine Haltbarkeit. Ohne Angabe wird „unbegrenzt“ gebucht." : "Vorbelegt: " + pl.bbdLabel)}</span>
      </div>
      ${state.locations.size ? `<div class="field" style="padding:8px 0">
        <label for="adj-loc">Lagerort</label>
        <select id="adj-loc">${locOpts}</select>
        <span class="hint">Vorbelegt mit dem Standard aus Grocy.</span>
      </div>` : ""}
    </details>` : ""}
    <div class="btnrow">
      ${canBook ? `<button class="btn btn-primary full" id="adj-book">${I.pack}<span>Nur diesen einsortieren</span></button>` : ""}
      <button class="btn btn-ghost full" id="adj-remove">${jm && jm.btn ? esc(jm.btn.label) : (it.kind === "product" && CFG.bookStock ? "Ohne Vorrat von der Liste nehmen" : "Von der Liste nehmen")}</button>
      <button class="linkbtn" id="adj-back" style="justify-content:center">Doch nicht gekauft – zurück auf die Liste</button>
    </div>`;
  openSheet(html);
  let never = false;
  const qty = $("#adj-qty"), line = $("#adj-stockline");
  const cur = () => { const v = num(qty && qty.value); return v > 0 ? v : 1; };
  const upd = () => { if (line && it.stockHint) line.textContent = `= ${amountLabel(toStock(cur()), p.quStock)} kommen in den Vorrat`; };
  if (qty) {
    $("#adj-minus").addEventListener("click", () => { qty.value = String(Math.max(0.001, round3(cur() - 1))); upd(); });
    $("#adj-plus").addEventListener("click", () => { qty.value = String(round3(cur() + 1)); upd(); });
    qty.addEventListener("input", upd);
  }
  const nv = $("#adj-never"); if (nv) nv.addEventListener("click", () => { never = true; $("#adj-bbd").value = ""; $("#adj-bbdhint").textContent = "Wird als „läuft nie ab“ gebucht."; });
  const bb = $("#adj-bbd"); if (bb) bb.addEventListener("input", () => { never = false; });
  const saveAmount = async () => {
    if (!qty || it.kind === "note") return true;
    const newStock = toStock(cur());
    if (Math.abs(newStock - it.amount) < 1e-9) return true;
    await api(`/api/objects/shopping_list/${it.id}`, { method: "PUT", body: { amount: newStock } });
    it.amount = newStock; it.dispValue = cur();
    if (it.stockHint) it.stockHint = amountLabel(newStock, p.quStock);
    return true;
  };
  const bookBtn = $("#adj-book");
  if (bookBtn) bookBtn.addEventListener("click", async () => {
    bookBtn.disabled = true;
    try { await saveAmount(); } catch (e) { toast(describeError(e), { bad: true }); bookBtn.disabled = false; return; }
    const override = {};
    if (never) override.bbd = "never"; else if (bb && bb.value && bb.value !== bbdDefault) override.bbd = bb.value;
    const loc = $("#adj-loc"); if (loc && num(loc.value) !== (p.locationId || 0)) override.locationId = num(loc.value);
    closeSheet();
    await runPutaway([it], { overrides: { [it.id]: override } });
  });
  $("#adj-remove").addEventListener("click", async () => { closeSheet(); if (jm && jm.btn && jm.btn.act === "recheck") await recheck(it.id); else await removeOnly(it.id); });
  $("#adj-back").addEventListener("click", async () => { closeSheet(); if (jm) { toast("Diese Zeile hängt noch in einer Buchung."); return; } await toggleShopping(it.id); });
}

/* ---- Fortschritts-Sheet ---- */
const STATUS_ICON = { running: '<span class="spin"></span>', ok: "✓", removed: "✓", rejected: "!", unclear: "?", failed: "!", "booked-not-removed": "!", offline: "!", skipped: "·", wait: "○" };
function openProgressSheet(items) {
  const rows = items.map((it) => {
    const pl = plan(it);
    const meta = it.kind !== "product" ? (it.kind === "note" ? "Notiz – kommt nur von der Liste" : "wird nur von der Liste genommen") : `${amountLabel(pl.stockAmount, it.product.quStock)}${pl.locationName ? " · " + pl.locationName : ""} · ${pl.bbdLabel}`;
    return `<li data-pid="${it.id}"><span class="st wait">○</span><span class="b"><div>${esc(it.name)}</div><div class="m ${pl.bbdMode === "missing" ? "warn" : ""}">${esc(meta)}</div></span></li>`;
  }).join("");
  openSheet(`
    <h2 id="sheet-title">Einsortieren …</h2>
    <div class="pbar" aria-hidden="true"><span id="pbar" style="width:0%"></span></div>
    <p class="sub vh" id="progress-live" aria-live="polite">0 von ${items.length}</p>
    <ul class="plist" id="plist">${rows}</ul>
    <div id="progress-foot"></div>`, { locked: true });
}
function setProgress(id, status, msg, it) {
  const li = $(`#plist li[data-pid="${id}"]`); if (!li) return;
  const st = li.querySelector(".st");
  const cls = status === "running" ? "wait" : (status === "ok" || status === "removed") ? "ok" : (status === "unclear" || status === "skipped") ? "warn" : "bad";
  st.className = "st " + cls; st.innerHTML = STATUS_ICON[status] || "·";
  const m = li.querySelector(".m");
  if (status === "ok") { m.className = "m"; m.textContent = it && it.product ? `${amountLabel(it.amount, it.product.quStock)} im Vorrat` : "im Vorrat"; }
  else if (status === "removed") { m.className = "m"; m.textContent = "von der Liste genommen"; }
  else if (status === "skipped") { m.className = "m warn"; m.textContent = "wartet"; }
  else if (status !== "running" && msg) { m.className = "m " + (status === "unclear" ? "warn" : "bad"); m.textContent = msg; }
}
function setProgressBar(done, total) {
  const b = $("#pbar"); if (b) b.style.width = `${Math.round((done / total) * 100)}%`;
  const l = $("#progress-live"); if (l) l.textContent = `${done} von ${total}`;
}
function finishProgressSheet(summary, why, undoFn) {
  const t = $("#sheet-title"); if (t) t.textContent = summary;
  const f = $("#progress-foot");
  if (f) {
    f.innerHTML = `${why ? `<p class="hint" style="margin:10px 0">${esc(why)}</p>` : ""}<div class="btnrow"><button class="btn btn-primary full" id="progress-ok">Verstanden</button>${undoFn ? `<button class="btn btn-ghost full" id="progress-undo">Einsortierte zurück in den Wagen</button>` : ""}</div>`;
    $("#progress-ok").addEventListener("click", closeSheet);
    const u = $("#progress-undo"); if (u) u.addEventListener("click", () => { closeSheet(); undoFn(); });
  }
  sheetLocked = false;
}

/* ====================================================================== */
/*  AUFGABEN (Chores)                                                     */
/* ====================================================================== */
function parseGrocyDate(s) {
  if (!s) return null;
  const str = String(s).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(str.replace(" ", "T"));
  return isNaN(d.getTime()) ? null : d;
}
const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
function dueInfo(s) {
  const d = parseGrocyDate(s);
  if (!d || d.getFullYear() >= 2999) return { status: "manual", label: "Kein fester Termin", days: Infinity };
  const diff = Math.round((startOfDay(d) - startOfDay(new Date())) / 86400000);
  let label;
  if (diff < 0) label = diff === -1 ? "seit gestern fällig" : `seit ${Math.abs(diff)} Tagen fällig`;
  else if (diff === 0) label = "heute fällig";
  else if (diff === 1) label = "morgen fällig";
  else label = `in ${diff} Tagen fällig`;
  return { status: diff < 0 ? "expired" : diff <= 1 ? "soon" : "fresh", label, days: diff };
}
function mapChore(c) {
  const u = c.next_execution_assigned_user;
  return {
    choreId: num(c.chore_id), name: c.chore_name || "(Aufgabe)",
    assignedName: u && (u.display_name || u.username) ? (u.display_name || u.username) : null,
    due: dueInfo(c.next_estimated_execution_time),
  };
}
async function loadChores() {
  const data = await api("/api/chores");
  const rows = (Array.isArray(data) ? data : []).filter((c) => num(c.chore_id) > 0);
  state.chores = rows.map(mapChore);
  const dayKey = (c) => Number.isFinite(c.due.days) ? c.due.days : Number.MAX_SAFE_INTEGER;
  state.chores.sort((a, b) => dayKey(a) - dayKey(b) || a.name.localeCompare(b.name, "de"));
  SNAP.set("chores", rows);
}
function choresFromSnapshot() {
  const s = SNAP.get("chores");
  if (!s || !Array.isArray(s.data)) return false;
  state.chores = s.data.map(mapChore);
  return true;
}
function choreRowHTML(c) {
  const busy = state.busy.has("c" + c.choreId);
  const st = c.due.status;
  return `
    <div class="row">
      <span class="lead" aria-hidden="true"><span class="cstat ${st}"></span></span>
      <span class="body">
        <span class="nm">${esc(c.name)}</span>
        <span class="meta"><span class="due ${st}">${esc(c.due.label)}</span>
          ${c.assignedName ? `<span class="who"><span class="avatar" aria-hidden="true">${esc(initials(c.assignedName))}</span>${esc(c.assignedName)}</span>` : ""}
        </span>
      </span>
      <span class="trail">
        <button class="btn btn-soft btn-sm" data-act="chore-done" data-id="${c.choreId}" ${busy ? "disabled" : ""} aria-label="${esc(c.name)} als erledigt melden">${I.check}<span>Erledigt</span></button>
      </span>
    </div>`;
}
function renderChores() {
  if (state.tab !== "chores") return;
  const focusKey = rememberFocus();
  const groups = [
    ["Überfällig", state.chores.filter((c) => c.due.status === "expired")],
    ["Heute & morgen", state.chores.filter((c) => c.due.status === "soon")],
    ["Demnächst", state.chores.filter((c) => c.due.status === "fresh")],
    ["Ohne Termin", state.chores.filter((c) => c.due.status === "manual")],
  ].filter(([, arr]) => arr.length);
  const overdue = state.chores.filter((c) => c.due.status === "expired").length;
  view.innerHTML = `
    <div class="phead">
      <h1 class="h1">Aufgaben</h1>
      <p class="sub">${overdue ? `${overdue} überfällig · ` : ""}${state.chores.length} wiederkehrend${state.fromCache ? " · Stand aus dem Zwischenspeicher" : ""}</p>
    </div>
    ${groups.length ? groups.map(([title, arr]) => `
      <h2 class="sect">${esc(title)} <span class="count">${arr.length}</span></h2>
      <section class="card" aria-label="${esc(title)}">${arr.map(choreRowHTML).join("")}</section>`).join("")
      : `<section class="card">${emptyHTML(I.broom, "Keine Aufgaben", "In Grocy sind keine Hausarbeiten angelegt.")}</section>`}
  `;
  renderCta();
  restoreFocus(focusKey);
}
async function executeChore(choreId) {
  if (state.busy.has("c" + choreId)) return;
  const c = state.chores.find((x) => x.choreId === choreId);
  if (!c) return;
  if (navigator.onLine === false) { toast("Gerade kein Netz. Probier es gleich nochmal."); return; }
  state.busy.add("c" + choreId); renderChores();
  let executed = false, logId = null;
  try {
    const res = await api(`/api/chores/${choreId}/execute`, { method: "POST", body: {} });
    executed = true; logId = res && res.id ? res.id : null;
    c.due = { status: "manual", label: "gerade erledigt", days: Infinity };
    toast(`„${c.name}“ erledigt`, logId ? { action: { label: "Rückgängig", fn: () => undoChore(c, logId) } } : {});
    await loadChores();
  } catch (err) {
    if (executed) { /* nur das Nachladen scheiterte – Anzeige bleibt optimistisch */ }
    else if (err.unclear) {
      c.due = { status: "manual", label: "Status unklar – wird neu geladen", days: Infinity };
      toast(`„${c.name}“: Antwort kam nicht an. Die Liste wird neu geladen.`, { bad: true });
      setTimeout(() => refresh({ quiet: true }), 2500);
    } else { toast(describeError(err), { bad: true }); if (isAuthErr(err)) showAuthBanner(err); }
  } finally {
    state.busy.delete("c" + choreId);
    renderChores(); updateBadges();
  }
}
async function undoChore(c, logId) {
  hideToast();
  try {
    await api(`/api/chores/executions/${encodeURIComponent(logId)}/undo`, { method: "POST", body: {} });
    toast(`„${c.name}“ wieder offen`);
    await loadChores(); renderChores(); updateBadges();
  } catch (e) { toast("Das ließ sich nicht mehr zurücknehmen. Bitte in Grocy prüfen.", { bad: true }); }
}

/* ====================================================================== */
/*  EINSTELLUNGEN & ONBOARDING                                             */
/* ====================================================================== */
function keyFieldHTML(id) {
  return `<div class="inline">
      <input type="password" id="${id}" placeholder="${CFG.key ? "Gespeichert – zum Ändern neuen Schlüssel einfügen" : "Langer Schlüssel aus Grocy"}" autocomplete="off" autocapitalize="off" spellcheck="false" data-lpignore="true" aria-label="Grocy-Schlüssel" />
      <button type="button" class="iconbtn" id="${id}-eye" aria-label="Schlüssel anzeigen">${I.eye}</button>
      <button type="button" class="iconbtn" id="${id}-paste" aria-label="Aus Zwischenablage einfügen">${I.paste}</button>
    </div>`;
}
function wireKeyField(id) {
  const inp = $("#" + id);
  $("#" + id + "-eye").addEventListener("click", () => { inp.type = inp.type === "password" ? "text" : "password"; });
  $("#" + id + "-paste").addEventListener("click", async () => {
    try { const t = await navigator.clipboard.readText(); if (t) { inp.value = t.trim(); inp.dispatchEvent(new Event("input")); } else toast("Zwischenablage ist leer."); }
    catch (_) { toast("Einfügen ging nicht automatisch. Bitte lange drücken und einfügen."); inp.focus(); }
  });
}
const helpKeyHTML = `
  <details class="help">
    <summary>Wo finde ich den Schlüssel?</summary>
    <ol>
      <li>In Grocy oben rechts auf deinen Namen → <b>„Manage API keys“</b> (direkt: <code>DEINE-GROCY-ADRESSE/manageapikeys</code>).</li>
      <li><b>„Add“</b> tippen – ein langer Code erscheint.</li>
      <li>Kopieren und hier einfügen. Der Schlüssel bleibt nur auf diesem Gerät.</li>
    </ol>
    <p>Am besten hat jede Person ihren eigenen Schlüssel. Verloren? Einfach in Grocy löschen und einen neuen anlegen.</p>
  </details>`;

async function probe(key, base) {
  // Verbindung prüfen, ohne etwas zu speichern. Liefert {user, version, lists}.
  const [user, info, lists] = await Promise.all([
    api("/api/user", { key, base }).catch(() => null),
    api("/api/system/info", { key, base }).catch(() => null),
    api("/api/objects/shopping_lists", { key, base }),
  ]);
  const u = Array.isArray(user) ? user[0] : user;   // manche Instanzen liefern eine Liste
  const userName = u ? String(u.display_name || u.username || [u.first_name, u.last_name].filter(Boolean).join(" ") || "").trim() : "";
  return { user: userName ? { ...u, display_name: userName } : null, version: info && info.grocy_version ? info.grocy_version.Version : null, lists: Array.isArray(lists) ? lists : [] };
}
function applyProbe(res) {
  state.user = res.user; state.grocyVersion = res.version;
  if (res.lists.length && !res.lists.some((l) => num(l.id) === CFG.listId)) { CFG.listId = num(res.lists[0].id); CFG.listName = res.lists[0].name || ""; }
  const cur = res.lists.find((l) => num(l.id) === CFG.listId); if (cur) CFG.listName = cur.name || "";
}

function renderOnboarding() {
  state.tab = "onboarding"; setActiveTab(null); app.classList.add("no-tabs"); renderCta();
  view.innerHTML = `
    <div class="onb">
      <span class="mark" aria-hidden="true">${I.leaf}</span>
      <h1>Ämtli</h1>
      <p>Einkaufszettel und Ämtli der WG, verbunden mit eurem Grocy.<br/>Du brauchst nur deinen persönlichen Grocy-Schlüssel.</p>
      <form class="card" id="onb-form" autocomplete="off">
        ${ADDON ? "" : `<div class="field"><label for="onb-url">Grocy-Adresse</label><input type="url" id="onb-url" placeholder="https://grocy.mein-zuhause.de" value="${esc(store.get("grocy.url") || "")}" inputmode="url" autocapitalize="off" spellcheck="false" /><span class="hint">Die Adresse, unter der ihr Grocy erreicht – ohne <code>/api</code>.</span></div>`}
        <div class="field">
          <label for="onb-key">Dein Grocy-Schlüssel</label>
          ${keyFieldHTML("onb-key")}
          <span class="status" id="onb-status"></span>
        </div>
        <div class="field" id="onb-lists" hidden></div>
        <div class="field"><button class="btn btn-primary full" type="submit" id="onb-go">Los geht's</button></div>
      </form>
      ${helpKeyHTML}
      ${UNDER_INGRESS ? `<p class="hint" style="margin-top:14px">Tipp: Als App aufs Handy geht es nur über die direkte Adresse, nicht über die Home-Assistant-Seitenleiste.</p>` : ""}
    </div>`;
  wireKeyField("onb-key");
  $("#onb-form").addEventListener("submit", onOnboardSubmit);
}
async function onOnboardSubmit(e) {
  e.preventDefault();
  const key = $("#onb-key").value.trim();
  const urlEl = $("#onb-url");
  const url = urlEl ? urlEl.value.trim().replace(/\/+$/, "") : "";
  const status = $("#onb-status"), btn = $("#onb-go");
  if (!key) { status.innerHTML = `<span class="err">Bitte den Schlüssel einfügen.</span>`; return; }
  if (!ADDON && !url) { status.innerHTML = `<span class="err">Bitte die Grocy-Adresse eintragen.</span>`; return; }
  const base = url || (ADDON ? proxyBase() : "");
  btn.disabled = true; status.innerHTML = `<span class="muted"><span class="spin"></span> Verbinde …</span>`;
  try {
    const res = await probe(key, base);
    CFG.url = url; CFG.key = key; applyProbe(res);
    const who = res.user ? ` als ${res.user.display_name || res.user.username}` : "";
    if (res.lists.length > 1 && !$("#onb-lists").dataset.chosen) {
      status.innerHTML = `<span class="ok">✓ Verbunden${esc(who)}. Welche Einkaufsliste ist eure?</span>`;
      const box = $("#onb-lists");
      box.hidden = false; box.dataset.chosen = "1";
      box.innerHTML = res.lists.map((l, i) => `<label class="toggle"><input type="radio" name="onb-list" value="${num(l.id)}" ${num(l.id) === CFG.listId || (i === 0 && !res.lists.some((x) => num(x.id) === CFG.listId)) ? "checked" : ""}/><span class="t">${esc(l.name || "Liste " + l.id)}</span></label>`).join("");
      btn.textContent = "Fertig"; btn.disabled = false;
      return;
    }
    const chosen = $("input[name=onb-list]:checked");
    if (chosen) { CFG.listId = num(chosen.value); const l = res.lists.find((x) => num(x.id) === CFG.listId); CFG.listName = l ? l.name || "" : ""; }
    if (!res.lists.length) { status.innerHTML = `<span class="ok">✓ Verbunden${esc(who)}.</span> <span class="err">In Grocy gibt es noch keine Einkaufsliste – bitte dort eine anlegen.</span>`; btn.disabled = false; return; }
    app.classList.remove("no-tabs");
    toast(`Verbunden${who}. Viel Spaß beim Einkaufen.`);
    go("shopping");
  } catch (err) {
    const msg = (err.status === 401 || err.status === 403) && !err.haAuth
      ? "Diesen Schlüssel kennt Grocy nicht. Kopier ihn bitte nochmal komplett – er ist ziemlich lang."
      : describeError(err);
    status.innerHTML = `<span class="err">✗ ${esc(msg)}</span>`;
    btn.disabled = false;
  }
}

function renderSettings() {
  state.tab = "settings"; setActiveTab(null); renderCta();
  const last = LAST.get();
  const who = state.user ? (state.user.display_name || state.user.username) : null;
  const connLine = state.reachable
    ? `Verbunden${who ? " als " + esc(who) : ""}${state.grocyVersion ? " · Grocy " + esc(state.grocyVersion) : ""}`
    : "Zuletzt keine Verbindung";
  view.innerHTML = `
    <div class="phead"><h1 class="h1">Einstellungen</h1><p class="sub">${ADDON ? "Dein persönlicher Grocy-Zugang" : "Verbindung zu deinem Grocy"}</p></div>

    <h2 class="sect">Verbindung</h2>
    <form class="card" id="set-form" autocomplete="off">
      <div class="kv"><span class="dot ${state.reachable ? "" : "bad"}" aria-hidden="true"></span><span class="k">${connLine}</span><button type="button" class="linkbtn" id="set-check">Prüfen</button></div>
      <div class="field">
        <label for="set-key">Dein Schlüssel</label>
        ${keyFieldHTML("set-key")}
        <span class="hint">${CFG.key ? "Ein Schlüssel ist gespeichert. Nur ausfüllen, wenn du ihn ändern willst." : "In Grocy unter „Manage API keys“ erstellen."}</span>
      </div>
      ${ADDON ? `
      <details class="help" style="margin:0"><summary>Erweitert: eigene Grocy-Adresse</summary>
        <div class="field" style="border:none;padding:8px 0 14px">
          <input type="url" id="set-url" placeholder="leer lassen = über das Add-on" value="${esc(store.get("grocy.url") || "")}" inputmode="url" autocapitalize="off" spellcheck="false" aria-label="Eigene Grocy-Adresse" />
          <span class="hint">Normalerweise leer lassen – das Add-on erreicht Grocy intern.</span>
        </div></details>` : `
      <div class="field"><label for="set-url">Grocy-Adresse</label>
        <input type="url" id="set-url" value="${esc(CFG.url)}" inputmode="url" autocapitalize="off" spellcheck="false" />
        <span class="hint">Ohne <code>/api</code> am Ende.</span></div>`}
      <div class="field" id="set-listbox" ${CFG.listName ? "" : ""}>
        <label for="set-list">Einkaufsliste</label>
        <select id="set-list"><option value="${CFG.listId}">${esc(CFG.listName || "Liste " + CFG.listId)}</option></select>
        <span class="hint">Wird beim Prüfen mit allen Listen aus Grocy befüllt.</span>
      </div>
      <div class="field"><div class="inline"><button class="btn btn-primary" type="submit" id="set-save">Prüfen & speichern</button><span class="status" id="set-status"></span></div></div>
    </form>

    <h2 class="sect">Einsortieren</h2>
    <section class="card">
      <div class="field">
        <label class="toggle"><input type="checkbox" id="set-book" ${CFG.bookStock ? "checked" : ""} /><span class="t">Vorrat mitführen</span></label>
        <span class="hint">Beim Einsortieren Produkte in Grocys Vorrat buchen. Empfohlen, damit der Bestand stimmt. Wirkt nur bei Einträgen, die ein Grocy-Produkt sind.</span>
      </div>
      ${last ? `<button type="button" class="kv" id="set-undo"><span class="k">Letztes Einsortieren rückgängig machen</span><span class="v">${esc(agoLabel(last.at))} · ${last.rows.length}</span></button>` : ""}
    </section>

    <h2 class="sect">Einkauf</h2>
    <section class="card">
      <div class="field">
        <label class="toggle"><input type="checkbox" id="set-suggest" ${CFG.suggest ? "checked" : ""} /><span class="t">Vorschläge anzeigen</span></label>
        <span class="hint">Aus euren Einkäufen der letzten Monate: was sonst regelmäßig gekauft wird und überfällig ist, was unter Mindestbestand liegt.${state.sugg && state.sugg.stats && state.sugg.stats.rhythmProducts === 0 ? " Noch zu wenig Einkäufe für Rhythmus-Vorschläge – Produkte brauchen mindestens drei Käufe." : ""}</span>
      </div>
      <div class="field">
        <label class="toggle"><input type="checkbox" id="set-notehint" ${CFG.noteHint ? "checked" : ""} /><span class="t">Vor dem Einsortieren an Notizen erinnern</span></label>
        <span class="hint">Notizen kommen nicht in den Vorrat. Ämtli fragt pro Notiz einmal, ob sie ein Produkt werden soll.</span>
      </div>
    </section>

    <h2 class="sect">Vorrat</h2>
    <section class="card">
      <div class="field">
        <label class="toggle"><input type="checkbox" id="set-expire" ${CFG.expireAuto ? "checked" : ""} /><span class="t">Abgelaufenes automatisch aus dem Vorrat nehmen</span></label>
        <span class="hint">MHD 7 Tage nach Ablauf, Verbrauchsdatum am Tag danach. Läuft einmal täglich auf dem Gerät, das Ämtli öffnet; die Buchung erscheint in Grocy unter deinem Namen. Am besten nur auf einem Gerät aktiv.</span>
      </div>
      <div class="field">
        <label class="toggle"><input type="checkbox" id="set-spoiled" ${CFG.expireSpoiled ? "checked" : ""} /><span class="t">Dabei als „verdorben“ buchen</span></label>
        <span class="hint">Aus, wenn das meiste einfach aufgegessen wurde (Grocys Verderb-Statistik bleibt dann ehrlich).</span>
      </div>
      ${(() => { const l = store.json("aemtli.expire.last", null); return l && l.rows && Date.now() - l.at < 7 * 86400000 ? `<button type="button" class="kv" id="set-expire-undo"><span class="k">Zuletzt automatisch entfernt</span><span class="v">${esc(plural(l.rows.length, "Sache", "Sachen"))} · ${esc(agoLabel(l.at))}</span><span class="linkbtn">Rückgängig</span></button>` : ""; })()}
      ${(() => { const n = [...state.products.values()].filter((p) => p.active && !p.noOwnStock && p.parentId == null && p.bbdDays === 0).length; return n ? `<button type="button" class="kv" id="set-maintain"><span class="k">${esc(plural(n, "Produkt", "Produkte"))} ohne Haltbarkeit</span><span class="linkbtn">Pflegen</span></button>` : ""; })()}
      ${(() => { const n = [...state.products.values()].filter((p) => p.active && p.tare).length; return n ? `<div class="kv"><span class="k hint">${esc(plural(n, "Produkt mit Waage wird", "Produkte mit Waage werden"))} nicht aufgeräumt</span></div>` : ""; })()}
    </section>

    <h2 class="sect">Darstellung</h2>
    <section class="card"><div class="field">
      <span class="lbl">Design</span>
      <div class="seg" role="group" aria-label="Design">
        ${["system", "light", "dark"].map((t) => `<button type="button" data-theme-pick="${t}" aria-pressed="${CFG.theme === t}">${t === "system" ? "System" : t === "light" ? "Hell" : "Dunkel"}</button>`).join("")}
      </div>
    </div></section>

    <h2 class="sect">App</h2>
    <section class="card">
      <details class="help" style="margin:0 16px"><summary>Auf dem Handy installieren</summary>
        <ol>
          <li><b>Android/Chrome:</b> Menü (⋮) → „App installieren“ bzw. „Zum Startbildschirm hinzufügen“.</li>
          <li><b>iPhone/Safari:</b> Teilen-Symbol → „Zum Home-Bildschirm“. Danach in der installierten App den Schlüssel noch einmal eintragen (iOS trennt die Speicher).</li>
          <li>Installieren geht nur über die <b>direkte HTTPS-Adresse</b>, nicht über die Home-Assistant-Seitenleiste.</li>
        </ol></details>
      ${helpKeyHTML.replace('class="help"', 'class="help" style="margin:0 16px"')}
      <details class="help" style="margin:0 16px"><summary>Hilfe & Diagnose · Version ${esc(APP_VERSION)}</summary>
        <p>Wenn etwas nicht klappt: Diagnose kopieren und im WG-Chat schicken.</p>
        <pre class="diag" id="diag-text"></pre>
        <div class="inline" style="margin-bottom:12px"><button type="button" class="btn btn-ghost btn-sm" id="diag-copy">Diagnose kopieren</button><button type="button" class="btn btn-ghost btn-sm" id="diag-clear">Fehlerliste leeren</button></div>
      </details>
      <button type="button" class="kv" id="set-logout"><span class="k" style="color:var(--danger)">Schlüssel von diesem Gerät entfernen</span></button>
    </section>
  `;
  wireKeyField("set-key");
  $("#set-form").addEventListener("submit", onSettingsSave);
  $("#set-check").addEventListener("click", () => onSettingsSave(new Event("submit"), { checkOnly: true }));
  $("#set-book").addEventListener("change", (e) => { CFG.bookStock = e.target.checked; toast(e.target.checked ? "Vorrat wird mitgeführt" : "Vorrat wird nicht mehr gebucht"); });
  $("#set-suggest").addEventListener("change", (e) => { CFG.suggest = e.target.checked; if (e.target.checked) computeSuggestions(true); });
  $("#set-notehint").addEventListener("change", (e) => { CFG.noteHint = e.target.checked; });
  $("#set-expire").addEventListener("change", (e) => { CFG.expireAuto = e.target.checked; if (e.target.checked) { store.del("aemtli.expire.lastRun"); toast("Läuft beim nächsten Öffnen der Einkaufsliste."); } });
  $("#set-spoiled").addEventListener("change", (e) => { CFG.expireSpoiled = e.target.checked; });
  const eu = $("#set-expire-undo"); if (eu) eu.addEventListener("click", undoCleanup);
  const mt = $("#set-maintain"); if (mt) mt.addEventListener("click", openMaintainSheet);
  $$("[data-theme-pick]").forEach((b) => b.addEventListener("click", () => { CFG.theme = b.dataset.themePick; applyTheme(); $$("[data-theme-pick]").forEach((x) => x.setAttribute("aria-pressed", x === b ? "true" : "false")); }));
  const su = $("#set-undo"); if (su) su.addEventListener("click", () => { go("shopping"); undoLast(); });
  $("#diag-text").textContent = DIAG.text();
  $("#diag-copy").addEventListener("click", async () => { try { await navigator.clipboard.writeText(DIAG.text()); toast("Diagnose kopiert"); } catch (_) { toast("Kopieren ging nicht – Text markieren und kopieren.", { bad: true }); } });
  $("#diag-clear").addEventListener("click", () => { DIAG.items = []; store.del("aemtli.diag"); $("#diag-text").textContent = DIAG.text(); });
  $("#set-logout").addEventListener("click", () => {
    if (!confirm("Schlüssel von diesem Gerät entfernen? Die Liste bleibt in Grocy erhalten.")) return;
    store.del("grocy.key"); state.user = null; setBanner("auth", null);
    toast("Schlüssel entfernt"); renderOnboarding();
  });
}
async function onSettingsSave(e, { checkOnly = false } = {}) {
  e.preventDefault();
  const keyIn = $("#set-key").value.trim();
  const key = keyIn || CFG.key;
  const urlEl = $("#set-url");
  const url = urlEl ? urlEl.value.trim().replace(/\/+$/, "") : "";
  const base = url || (ADDON ? proxyBase() : "");
  const status = $("#set-status"), btn = $("#set-save");
  if (!key || !base) { status.innerHTML = `<span class="err">${ADDON ? "Schlüssel fehlt." : "Adresse und Schlüssel ausfüllen."}</span>`; return; }
  btn.disabled = true; status.innerHTML = `<span class="muted"><span class="spin"></span> Prüfe …</span>`;
  try {
    const res = await probe(key, base);                               // erst prüfen …
    if (!checkOnly) { CFG.url = url; CFG.key = key; }                  // … dann speichern
    applyProbe(res);
    setBanner("auth", null); setBanner("list", null);
    const sel = $("#set-list");
    if (res.lists.length) {
      sel.innerHTML = res.lists.map((l) => `<option value="${num(l.id)}" ${num(l.id) === CFG.listId ? "selected" : ""}>${esc(l.name || "Liste " + l.id)}</option>`).join("");
      sel.onchange = () => { CFG.listId = num(sel.value); const l = res.lists.find((x) => num(x.id) === CFG.listId); CFG.listName = l ? l.name || "" : ""; toast(`Liste „${CFG.listName}“ gewählt`); };
      status.innerHTML = `<span class="ok">✓ Verbunden${res.user ? " als " + esc(res.user.display_name || res.user.username) : ""} · ${plural(res.lists.length, "Liste", "Listen")}</span>`;
      state.mastersAt = 0;
      if (!checkOnly && keyIn) { toast("Gespeichert"); setTimeout(() => { if (state.tab === "settings") go("shopping"); }, 900); }
    } else {
      sel.innerHTML = `<option>– keine Liste gefunden –</option>`;
      status.innerHTML = `<span class="err">✓ Verbunden, aber in Grocy gibt es keine Einkaufsliste. Lege dort eine an und prüfe erneut.</span>`;
    }
  } catch (err) {
    status.innerHTML = `<span class="err">✗ ${esc(describeError(err))}</span>${CFG.configured && !checkOnly ? ` <span class="muted">(bisherige Einstellungen bleiben)</span>` : ""}`;
  } finally { btn.disabled = false; }
}

/* ====================================================================== */
/*  ÄMTLI 2.1 – Produkt-Wizard, Vorschläge, Vorrat                         */
/* ====================================================================== */

/* ---- Rechte-Gedächtnis: 403 „Permission missing: X“ 24 h merken ---- */
const PERM = {
  _all() { return store.json("aemtli.perm.deny", {}) || {}; },
  denied(name) { const d = this._all()[name]; return !!d && Date.now() - d < 24 * 3600 * 1000; },
  deny(name) { if (!name) return; const a = this._all(); a[name] = Date.now(); store.set("aemtli.perm.deny", JSON.stringify(a)); },
};

/* ---- Pro Gerät gemerkt: Notizen/Produkte, für die nicht mehr gefragt wird ---- */
const NOTE_SKIP = {
  _s() { return new Set(store.json("aemtli.noteSkip", []) || []); },
  has(id) { return this._s().has(typeof id === "string" ? id : num(id)); },
  add(ids) { const s = this._s(); for (const id of ids) s.add(typeof id === "string" ? id : num(id)); store.set("aemtli.noteSkip", JSON.stringify([...s])); },
  prune(validRowIds) { const s = this._s(); let ch = false; for (const v of [...s]) if (typeof v === "number" && !validRowIds.has(v)) { s.delete(v); ch = true; } if (ch) store.set("aemtli.noteSkip", JSON.stringify([...s])); },
};

/* ---- Nutzer-Vorgaben aus Grocy (product_presets_*), 24 h gecacht ---- */
let presetsCache = null;
async function presets() {
  if (presetsCache) return presetsCache;
  const c = store.json("aemtli.presets", null);
  if (c && c.v && Date.now() - c.t < 24 * 3600 * 1000) return (presetsCache = c.v);
  let v = { locationId: null, quId: null, dueDays: null, groupId: null };
  try {
    const s = await api("/api/user/settings");
    const n = (k) => { const x = Number(s && s[k]); return Number.isFinite(x) ? x : null; };
    v = { locationId: n("product_presets_location_id"), quId: n("product_presets_qu_id"), dueDays: n("product_presets_default_due_days"), groupId: n("product_presets_product_group_id") };
    if (v.locationId != null && v.locationId <= 0) v.locationId = null;      // -1 = kein Preset
    if (v.quId != null && v.quId <= 0) v.quId = null;
    if (v.groupId != null && v.groupId <= 0) v.groupId = null;
    if (v.dueDays === 0) v.dueDays = null;                                   // 0 = nicht gesetzt
    store.set("aemtli.presets", JSON.stringify({ t: Date.now(), v }));
  } catch (_) {}
  return (presetsCache = v);
}

/* ---- Heuristik aus shelf.js (Keyword/OFF-Kategorie → Haltbarkeit, Einheitstyp, Lagerort-Typ) ---- */
const SHELF = typeof SHELF_LIFE !== "undefined" ? SHELF_LIFE : [];
const UNIT_NAMES = typeof UNIT_TYPE_NAMES !== "undefined" ? UNIT_TYPE_NAMES : {};
const OFF_UNITS = typeof OFF_UNIT_TYPE !== "undefined" ? OFF_UNIT_TYPE : {};
// Längstes passendes Keyword gewinnt („hafermilch“ vor „milch“); kurze Keywords (≤ 4) nur als ganzes Wort
// („eis“ darf nicht in „reis“ treffen). OFF-Tags zählen nur, wenn kein Keyword passt; dann frühere Zeile zuerst.
function heuristic(name, tags) {
  const k = " " + normKey(name).replace(/[()/,.;:]/g, " ").replace(/\s+/g, " ").trim() + " ";
  let best = null, bestScore = -1, bestKey = null;
  SHELF.forEach((row, idx) => {
    for (const m of row.match || []) {
      let s = -1;
      if (m.startsWith("en:")) { if (Array.isArray(tags) && tags.includes(m)) s = 100 - idx; }
      else if (m.length <= 4 ? (k.includes(" " + m + " ") || k.includes(" " + m + "-") || k.includes("-" + m + " ")) : k.includes(m)) s = 1000 + m.length;
      if (s > bestScore) { bestScore = s; best = row; bestKey = m.startsWith("en:") ? null : m; }
    }
  });
  return best ? { days: best.days, unitType: best.unit, locType: best.location, key: bestKey } : null;
}
function unitTypeOf(quId) {
  const u = state.units.get(num(quId)); if (!u) return null;
  const names = [u.name, u.plural].map((x) => normKey(x).replace(/[().]/g, "").trim()).filter(Boolean);
  for (const [type, list] of Object.entries(UNIT_NAMES)) if (names.some((n) => list.includes(n) || list.includes(n.split(" ")[0]))) return type;
  for (const n of names) { if (/liter$/.test(n)) return "liter"; if (/gramm$/.test(n)) return "gramm"; }
  return null;
}
function unitByType(type) {
  const prio = { liter: ["liter", "l", "ltr", "milliliter", "ml", "flasche"], gramm: ["gramm", "g", "kilogramm", "kg"], packung: ["packung", "pack", "päckchen", "pck", "beutel", "tüte"], stueck: ["stück", "stk", "st", "piece", "pc", "dose", "glas", "becher"] }[type] || [];
  for (const want of prio) for (const [id, u] of state.units) { const n = normKey(u.name).replace(/[().]/g, "").trim(); if (n === want || n.split(" ")[0] === want) return id; }
  for (const [id] of state.units) if (unitTypeOf(id) === type) return id;
  return null;
}
function defaultUnit() {
  const s = unitByType("stueck"); if (s != null) return s;
  const p = unitByType("packung"); if (p != null) return p;
  return state.units.size ? [...state.units.keys()][0] : null;
}
function locationByType(type) {
  const locs = [...state.locations.entries()];
  const find = (f) => { const x = locs.find(([, l]) => f(l)); return x ? x[0] : null; };
  if (type === "tiefkuehl") return find((l) => l.freezer);
  if (type === "kuehl") return find((l) => !l.freezer && /k[üu]hl|fridge/i.test(l.name));
  if (type === "bad") return find((l) => /bad|putz|haushalt|wc|wasch|hygiene/i.test(l.name));
  if (type === "vorrat") return find((l) => !l.freezer && /vorrat|speise|kammer|schrank|regal|pantry|küche|kueche/i.test(l.name) && !/k[üu]hl/i.test(l.name));
  return null;
}
function mostCommonLocation() {
  const c = new Map();
  for (const p of state.products.values()) if (p.active && p.locationId != null && state.locations.has(p.locationId)) c.set(p.locationId, (c.get(p.locationId) || 0) + 1);
  let best = null; for (const [id, n] of c) if (!best || n > best.n) best = { id, n };
  if (best) return best.id;
  const nf = [...state.locations.entries()].find(([, l]) => !l.freezer);
  return nf ? nf[0] : (state.locations.size ? [...state.locations.keys()][0] : null);
}

/* ---- Notiztext → Menge, Name, Einheiten-Hinweis ---- */
function parseNote(text) {
  let s = String(text || "").replace(/\s+/g, " ").trim();
  let qty = null;
  const m = /^(\d+(?:[.,]\d+)?)\s*(?:x|×|stk\.?|st\.?)?\s+(.+)$/i.exec(s);
  if (m) { qty = num(m[1].replace(",", ".")); s = m[2].trim(); }
  const sz = /(\d+(?:[.,]\d+)?)\s*(ml|cl|l|g|kg)\b/i.exec(s);
  const unitType = sz ? (OFF_UNITS[sz[2].toLowerCase()] || null) : null;
  const cap = (x) => (x ? x.charAt(0).toUpperCase() + x.slice(1) : "");
  const name = cap(s);
  // base = Name ohne Größenangabe („Hackfleisch 500g“ → „Hackfleisch“) für Ähnlichkeit und Heuristik
  const base = cap(sz ? s.replace(sz[0], " ").replace(/\s+/g, " ").trim() : s) || name;
  return { qty: qty && qty > 0 ? qty : null, name, base, unitType };
}

/* ---- Ähnliche Produkte (stark = verknüpfen, schwach = Vorbelegung) ---- */
function lev(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const prev = new Array(b.length + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]; prev[0] = i;
    for (let j = 1; j <= b.length; j++) { const tmp = prev[j]; prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1)); diag = tmp; }
  }
  return prev[b.length];
}
function similarProducts(name) {
  const k = normKey(name); if (!k) return { strong: null, weak: [], inactive: null };
  const words = k.split(/\s+/).filter((w) => w.length >= 4);
  let strong = null; const weak = [];
  for (const p of state.productNames) {
    const pk = p.key;
    if (pk === k || (k.length >= 5 && pk.length >= 5 && lev(pk, k) <= 2)) { if (!strong) strong = state.products.get(p.id); continue; }
    if ((pk.length >= 4 && k.includes(pk)) || (k.length >= 4 && pk.includes(k)) || words.some((w) => pk.split(/\s+/).includes(w))) weak.push(state.products.get(p.id));
  }
  let inactive = null;
  if (!strong) for (const p of state.products.values()) if (!p.active && normKey(p.name) === k) { inactive = p; break; }
  return { strong, weak: weak.filter(Boolean).slice(0, 4), inactive };
}

/* ---- Vorbelegung: bestehendes Produkt → Barcode/OFF → Notiztext → Heuristik → Lagerort-Typ → Presets → Default ---- */
async function wizardPrefill(rawName, qtyHint, scan) {
  const pr = await presets();
  const parsed = parseNote(scan && scan.name ? scan.name : rawName);
  const sim = similarProducts(parsed.base || parsed.name);
  const weak = sim.weak;
  const tags = scan && scan.off ? scan.off.tags : null;
  const h = heuristic(parsed.base || parsed.name, tags) || (tags && tags.length ? heuristic("", tags) : null);
  // Schwache Treffer („Milch“ zu „Hafermilch“) sind Haushalts-Konvention → Einheit. Lagerort und
  // Haltbarkeit kommen aus der Heuristik, wenn ihr Keyword mindestens so spezifisch ist wie der Treffername.
  const hWins = !!(h && h.key && weak.every((p) => h.key.length >= normKey(p.name).length));
  const median = (xs) => { const a = xs.filter((x) => Number.isFinite(x)).sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : null; };
  const weakLoc = () => { if (!weak.length) return null; const c = new Map(); weak.forEach((p) => p.locationId != null && c.set(p.locationId, (c.get(p.locationId) || 0) + 1)); const top = [...c.entries()].sort((a, b) => b[1] - a[1])[0]; return top ? top[0] : null; };
  let locationId = hWins ? locationByType(h.locType) : weakLoc();
  if (locationId == null) locationId = hWins ? weakLoc() : (h ? locationByType(h.locType) : null);
  if (locationId == null && pr.locationId != null && state.locations.has(pr.locationId)) locationId = pr.locationId;
  if (locationId == null) locationId = mostCommonLocation();
  let quPurchase = null, quStock = null, factorPS = 1;
  const ref = weak.find((p) => p.quPurchase != null && p.quStock != null);
  if (ref) { quPurchase = ref.quPurchase; quStock = ref.quStock; factorPS = factor(ref.id, ref.quPurchase, ref.quStock) || 1; }
  else {
    const t = parsed.unitType || (scan && scan.off && scan.off.unitType) || (h && h.unitType) || null;
    const u = t ? unitByType(t) : null;
    quPurchase = u != null ? u : (pr.quId != null && state.units.has(pr.quId) ? pr.quId : defaultUnit());
    quStock = quPurchase;
  }
  const weakDays = median(weak.map((p) => p.bbdDays).filter((d) => d !== 0));
  let days = hWins ? h.days : weakDays;
  if (days == null) days = hWins ? weakDays : (h ? h.days : null);
  if (days == null && locationId != null) { const l = state.locations.get(locationId); if (l && l.freezer) days = 180; else if (l && /k[üu]hl|fridge/i.test(l.name)) days = 14; }
  if (days == null && pr.dueDays != null) days = pr.dueDays;
  if (days == null) days = -1;                                              // harter Default: „nie“, nie 0
  const dueType = h && h.days <= 2 && /fleisch|hack|fisch|lachs|garnelen|hähnchen|geflügel|pute|wurst/.test(normKey(parsed.name)) ? 2 : 1;
  return { name: parsed.name, qty: qtyHint || parsed.qty || 1, locationId, quPurchase, quStock, factorPS, days, dueType, groupId: pr.groupId, minStock: 0, sim, barcode: scan ? scan.code : null, image: scan ? scan.image : null, hint: h };
}

/* ---- Barcode: Kamera-Scan (nur wo BarcodeDetector existiert) + Nachschlagen ---- */
let scanStream = null, scanTimer = null;
function stopScan() {
  if (scanTimer) { clearTimeout(scanTimer); scanTimer = null; }
  if (scanStream) { try { scanStream.getTracks().forEach((t) => t.stop()); } catch (_) {} scanStream = null; }
  const v = $("#scan-video"); if (v) { try { v.srcObject = null; } catch (_) {} }
  const b = $("#scanbox"); if (b) b.hidden = true;
}
async function scanAvailable() {
  if (UNDER_INGRESS || !window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !("BarcodeDetector" in window)) return false;
  try { const f = await window.BarcodeDetector.getSupportedFormats(); return Array.isArray(f) && f.includes("ean_13"); } catch (_) { return false; }
}
async function startScan(onCode) {
  stopScan();
  const box = $("#scanbox"), video = $("#scan-video"); if (!box || !video) return;
  box.hidden = false;
  let stream = null, err = null;
  try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 } }, audio: false }); }
  catch (e) { err = e; if (e && e.name === "OverconstrainedError") { try { stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false }); err = null; } catch (e2) { err = e2; } } }
  if (!stream) { box.hidden = true; toast(err && err.name === "NotAllowedError" ? "Kamera nicht erlaubt. In den Browser-Einstellungen für diese Seite freigeben." : "Kamera nicht verfügbar.", { bad: true }); return; }
  scanStream = stream; video.srcObject = stream;
  try { await video.play(); } catch (_) {}
  let det; try { det = new window.BarcodeDetector({ formats: ["ean_13", "ean_8", "upc_a", "upc_e"] }); } catch (_) { stopScan(); return; }
  let lastCode = null, hits = 0;
  const tick = async () => {
    if (!scanStream) return;
    try {
      if (video.readyState >= 2) {
        const codes = await det.detect(video);
        const c = codes.find((x) => x.rawValue && /^\d{6,14}$/.test(x.rawValue));
        if (c) { if (c.rawValue === lastCode) hits++; else { lastCode = c.rawValue; hits = 1; } if (hits >= 2) { stopScan(); onCode(lastCode); return; } }
      }
    } catch (_) {}
    scanTimer = setTimeout(tick, 250);
  };
  scanTimer = setTimeout(tick, 300);
}
function offUnitType(p) {
  const u = String(p.product_quantity_unit || "").toLowerCase();
  if (num(p.product_quantity) > 0 && OFF_UNITS[u]) return OFF_UNITS[u];
  const m = /(\d+(?:[.,]\d+)?)\s*([a-zµ]+)/i.exec(String(p.quantity || "").toLowerCase());
  return m && OFF_UNITS[m[2]] ? OFF_UNITS[m[2]] : null;
}
// Reihenfolge: in Grocy bekannt? → Grocys Online-Lookup (Name/Bild, braucht MASTER_DATA_EDIT)
// → Open Food Facts direkt (Kategorie/Größe) über den Add-on-Proxy „off/“.
async function lookupBarcode(code) {
  try {
    const d = await api(`/api/stock/products/by-barcode/${encodeURIComponent(code)}`);
    const pid = d && d.product ? num(d.product.id) : null;
    if (pid) return { known: state.products.get(pid) || { id: pid, name: String(d.product.name || "") }, code };
  } catch (e) { if (!(e.status === 400 && /no product with barcode/i.test(e.detail || "")) && !e.forbidden) throw e; }
  let name = null, image = null;
  if (!PERM.denied("MASTER_DATA_EDIT")) {
    try { const r = await api(`/api/stock/barcodes/external-lookup/${encodeURIComponent(code)}`, { timeout: 8000 }); if (r && r.name) { name = String(r.name); image = r.__image_url || null; } } catch (_) {}
  }
  let off = null;
  try {
    const fields = "fields=product_name,product_name_de,quantity,product_quantity,product_quantity_unit,categories_tags,image_small_url";
    const u = ADDON ? new URL("off/product/" + encodeURIComponent(code) + "?" + fields, document.baseURI).href
                    : `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}.json?${fields}`;
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(u, { signal: ctrl.signal }); clearTimeout(t);
    if (res.ok) {
      const j = await res.json(); const p = j && j.product;
      if (p) { off = { tags: Array.isArray(p.categories_tags) ? p.categories_tags : [], unitType: offUnitType(p), name: p.product_name_de || p.product_name || null, image: p.image_small_url || null }; if (!name && off.name) name = off.name; if (!image && off.image) image = off.image; }
    }
  } catch (_) {}
  return { known: null, code, name, image, off };
}

/* ---- Wizard „Notiz → Produkt“ ---- */
const SHELF_CHIPS = [[-1, "nie"], [3, "3 Tage"], [7, "1 Woche"], [14, "2 Wochen"], [30, "1 Monat"], [90, "3 Monate"], [180, "6 Monate"], [365, "1 Jahr"]];
function shelfChipsHTML(id, days) {
  const items = SHELF_CHIPS.slice();
  if (days != null && !items.some(([v]) => v === days)) { const i = items.findIndex(([v]) => v > days); items.splice(i < 0 ? items.length : i, 0, [days, plural(days, "Tag", "Tage")]); }
  return `<div class="chiprow" id="${id}" role="radiogroup" aria-label="Haltbarkeit">${items.map(([v, l]) => `<button type="button" class="chip pick ${v === days ? "on" : ""}" data-v="${v}" role="radio" aria-checked="${v === days}">${esc(l)}</button>`).join("")}</div>`;
}
function wireChips(id, onPick) {
  const row = $("#" + id); if (!row) return;
  row.addEventListener("click", (e) => { const b = e.target.closest(".chip.pick"); if (!b) return; $$(".chip.pick", row).forEach((x) => { x.classList.toggle("on", x === b); x.setAttribute("aria-checked", x === b ? "true" : "false"); }); if (onPick) onPick(b.dataset.v); });
}
const chipValue = (id) => { const b = $(`#${id} .chip.pick.on`); return b ? b.dataset.v : null; };
const unitOptions = (sel) => [...state.units.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name, "de")).map(([id, u]) => `<option value="${id}" ${id === sel ? "selected" : ""}>${esc(u.name)}</option>`).join("");
const dateLabelFor = (days) => days === -1 ? "unbegrenzt haltbar" : `haltbar bis ${fmtDate(addDays(days))}`;

let wz = null;    // Zustand des offenen Wizards
async function openWizard(rowId, opts = {}) {
  const row = state.shopping.find((s) => s.id === num(rowId));
  if (!row || row.kind !== "note") { toast("Diese Zeile ist keine Notiz mehr."); return; }
  if (JOURNAL.get(row.id)) { toast("Diese Zeile hängt noch in einer Buchung."); return; }
  if (!state.locations.size || !state.units.size) { try { await loadMasters(true); } catch (_) {} }
  openSheet(`<h2 id="sheet-title">${esc(row.name)}</h2><p class="sub"><span class="spin"></span> Vorbelegung wird vorbereitet …</p>`);
  const pf = await wizardPrefill(row.name, row.amount > 1 ? row.amount : null, null);
  const siblings = state.shopping.filter((s) => s.kind === "note" && s.id !== row.id && normKey(s.name) === normKey(row.name)).map((s) => s.id);
  wz = { rowIds: [row.id, ...siblings], rowDone: row.done, note: row.name, noteAmount: row.amount, ...pf, mode: pf.sim.strong ? "link" : "create", linkTo: pf.sim.strong || null, onDone: opts.onDone || null, canScan: await scanAvailable() };
  renderWizard();
}
function renderWizard() {
  if (!wz) return;
  const noRights = PERM.denied("MASTER_DATA_EDIT");
  if (noRights && wz.mode === "create" && !wz.forceCreate) wz.mode = wz.linkTo ? "link" : "search";
  const locs = [...state.locations.entries()];
  const locPick = locs.length <= 6
    ? `<div class="chiprow" id="wz-loc" role="radiogroup" aria-label="Lagerort">${locs.map(([id, l]) => `<button type="button" class="chip pick ${id === wz.locationId ? "on" : ""}" data-v="${id}" role="radio" aria-checked="${id === wz.locationId}">${l.freezer ? "❄ " : ""}${esc(l.name)}</button>`).join("")}</div>`
    : `<select id="wz-loc-sel" aria-label="Lagerort">${locs.map(([id, l]) => `<option value="${id}" ${id === wz.locationId ? "selected" : ""}>${esc(l.name)}</option>`).join("")}</select>`;
  const diffUnits = wz.quPurchase !== wz.quStock;
  const similarHTML = wz.sim.weak.length && wz.mode !== "link"
    ? `<div class="simrow"><span class="hint">Ähnlich:</span>${wz.sim.weak.map((p) => `<button type="button" class="chip pick" data-link="${p.id}">${esc(p.name)}</button>`).join("")}</div>` : "";
  const inactiveHTML = wz.sim.inactive ? `<p class="hint">„${esc(wz.sim.inactive.name)}“ gibt es in Grocy, ist dort aber deaktiviert. Reaktivieren geht nur in Grocy.</p>` : "";
  const amountLine = `<div class="field" style="padding:8px 0"><span class="lbl">Auf der Liste</span><div class="stepper"><button type="button" id="wz-minus" aria-label="weniger">−</button><input type="number" id="wz-qty" value="${esc(String(wz.qty))}" min="0.001" step="any" inputmode="decimal" aria-label="Menge" /><button type="button" id="wz-plus" aria-label="mehr">+</button></div><div class="hint" id="wz-qtyhint" style="text-align:center"></div></div>`;
  let body;
  if (wz.mode === "link") {
    const p = wz.linkTo;
    const loc = p && p.locationId != null ? state.locations.get(p.locationId) : null;
    body = `
      <p class="sub">Notiz mit einem Grocy-Produkt verknüpfen</p>
      <section class="card" style="margin:0 0 10px"><div class="kv"><span class="dot" aria-hidden="true"></span><span class="k">${esc(p.name)}</span><span class="v">${esc([p.quPurchase != null ? unitLabel(p.quPurchase, 2) : "", loc ? loc.name : ""].filter(Boolean).join(" · "))}</span></div></section>
      ${amountLine}
      <div class="btnrow">
        <button class="btn btn-primary full" id="wz-go">${I.link}<span>Verknüpfen</span></button>
        ${noRights ? "" : `<button class="btn btn-ghost full" id="wz-new">Nein, neues Produkt anlegen</button>`}
        ${wz.sim.weak.length ? `<div class="simrow"><span class="hint">Oder:</span>${wz.sim.weak.map((q) => `<button type="button" class="chip pick" data-link="${q.id}">${esc(q.name)}</button>`).join("")}</div>` : ""}
      </div>`;
  } else if (wz.mode === "search") {
    body = `
      <div class="banner show info" role="status" style="margin:0 0 10px"><span aria-hidden="true">${I.alert}</span><span class="txt">Du darfst in Grocy keine Produkte anlegen. Verknüpfe die Notiz mit einem vorhandenen Produkt – oder bitte V, es in Grocy anzulegen.</span></div>
      <div class="field" style="padding:8px 0"><label for="wz-search">Produkt suchen</label><input type="text" id="wz-search" placeholder="Name eingeben …" autocomplete="off" /><div class="simrow" id="wz-search-res"></div></div>
      ${inactiveHTML}`;
  } else {
    body = `
      <p class="sub">${wz.barcode ? "Aus Barcode " + esc(wz.barcode) : "Neues Produkt in Grocy anlegen"}</p>
      ${inactiveHTML}
      <div class="field" style="padding:8px 0"><label for="wz-name">Name</label>
        <div class="inline">${wz.image ? `<img src="${esc(wz.image)}" alt="" width="44" height="44" style="border-radius:10px;object-fit:cover;flex:0 0 auto" />` : ""}<input type="text" id="wz-name" value="${esc(wz.name)}" autocapitalize="sentences" />${wz.canScan ? `<button type="button" class="iconbtn" id="wz-scan" aria-label="Barcode scannen" title="Barcode scannen">${I.camera}</button>` : ""}</div>
        <div id="scanbox" hidden><video id="scan-video" class="scanvideo" playsinline muted></video><p class="hint">Barcode vor die Kamera halten · <button type="button" class="linkbtn" id="wz-scan-stop" style="min-height:32px;padding:2px 8px">Abbrechen</button></p></div>
        ${similarHTML}
      </div>
      <div class="field" style="padding:8px 0"><span class="lbl">Lagerort</span>${locs.length ? locPick : `<span class="hint err">In Grocy fehlt ein Lagerort – bitte dort anlegen.</span>`}</div>
      <div class="field" style="padding:8px 0"><label for="wz-qu">Einheit</label>
        <select id="wz-qu">${unitOptions(wz.quPurchase)}</select>
        <button type="button" class="linkbtn" id="wz-diff" style="justify-content:flex-start">${diffUnits ? "Einkaufs- und Lager-Einheit gleichsetzen" : "Einkaufs- und Lager-Einheit unterscheiden"}</button>
        ${diffUnits ? `<div class="inline" style="margin-top:4px"><span class="hint" style="white-space:nowrap">1 ${esc(unitLabel(wz.quPurchase, 1))} =</span><input type="number" id="wz-factor" value="${esc(String(wz.factorPS || 1))}" min="0.001" step="any" inputmode="decimal" aria-label="Umrechnungsfaktor" style="width:90px" /><select id="wz-qu2" aria-label="Lager-Einheit">${unitOptions(wz.quStock)}</select></div>` : ""}
        <span class="hint">Einheiten verwaltet Grocy.</span>
      </div>
      <div class="field" style="padding:8px 0"><span class="lbl">Haltbarkeit <span class="hint" id="wz-dayslbl">· ${esc(dateLabelFor(wz.days))}</span></span>${shelfChipsHTML("wz-days", wz.days)}
        <div class="inline" style="margin-top:6px"><button type="button" class="linkbtn" id="wz-days-other" style="min-height:36px">andere …</button><input type="number" id="wz-days-in" min="1" max="3650" placeholder="Tage" inputmode="numeric" style="width:110px" hidden /></div>
      </div>
      ${amountLine}
      <details class="help" style="margin:0 0 8px"><summary>Mehr: Produktgruppe · Mindestbestand · Verbrauchsdatum · Barcode</summary>
        <div class="field" style="padding:8px 0"><label for="wz-group">Produktgruppe</label><select id="wz-group"><option value="">– keine –</option></select></div>
        <div class="field" style="padding:8px 0"><label for="wz-min">Mindestbestand</label><input type="number" id="wz-min" value="${esc(String(wz.minStock || 0))}" min="0" step="any" inputmode="decimal" /><span class="hint">Für Vorschläge nicht nötig – Ämtli lernt aus dem Kaufrhythmus.</span></div>
        <div class="field" style="padding:8px 0"><label class="toggle"><input type="checkbox" id="wz-due2" ${wz.dueType === 2 ? "checked" : ""} /><span class="t">Verbrauchsdatum statt Mindesthaltbarkeit</span></label><span class="hint">Nach dem Datum ist es weg (Fleisch, Fisch). Sonst meist noch gut.</span></div>
        <div class="field" style="padding:8px 0"><label for="wz-barcode">Barcode</label><input type="text" id="wz-barcode" value="${esc(wz.barcode || "")}" inputmode="numeric" placeholder="optional" /></div>
      </details>
      <div class="btnrow">
        <button class="btn btn-primary full" id="wz-go" ${locs.length && state.units.size ? "" : "disabled"}>${I.plus}<span>${wz.onDone ? "Anlegen & weiter" : "Produkt anlegen"}</span></button>
      </div>`;
  }
  openSheet(`
    <h2 id="sheet-title">${esc(wz.note)}</h2>
    ${body}
    <div class="btnrow" style="margin-top:4px">
      <button class="linkbtn" id="wz-keep" style="justify-content:center">Als Notiz lassen</button>
      <button class="linkbtn danger" id="wz-remove" style="justify-content:center">Von der Liste nehmen</button>
    </div>`);
  wireWizard();
}
function wireWizard() {
  const qty = $("#wz-qty");
  const cur = () => { const v = num(qty && qty.value); return v > 0 ? v : 1; };
  const updQtyHint = () => {
    const h = $("#wz-qtyhint"); if (!h) return;
    const qu = wz.mode === "link" ? (wz.linkTo.quPurchase != null ? wz.linkTo.quPurchase : wz.linkTo.quStock) : wz.quPurchase;
    const qs = wz.mode === "link" ? wz.linkTo.quStock : wz.quStock;
    const f = wz.mode === "link" ? (factor(wz.linkTo.id, qu, qs) || 1) : (wz.quPurchase === wz.quStock ? 1 : (wz.factorPS || 1));
    h.textContent = `${amountLabel(cur(), qu)}${qu !== qs ? ` = ${amountLabel(round3(cur() * f), qs)} im Vorrat` : ""}`;
  };
  if (qty) { $("#wz-minus").addEventListener("click", () => { qty.value = String(Math.max(0.001, round3(cur() - 1))); wz.qty = cur(); updQtyHint(); }); $("#wz-plus").addEventListener("click", () => { qty.value = String(round3(cur() + 1)); wz.qty = cur(); updQtyHint(); }); qty.addEventListener("input", () => { wz.qty = cur(); updQtyHint(); }); updQtyHint(); }
  $$("[data-link]").forEach((b) => b.addEventListener("click", () => { const p = state.products.get(num(b.dataset.link)); if (p) { wz.linkTo = p; wz.mode = "link"; renderWizard(); } }));
  const go = $("#wz-go"); if (go) go.addEventListener("click", () => (wz.mode === "link" ? wizardLink() : wizardCreate()));
  const nw = $("#wz-new"); if (nw) nw.addEventListener("click", () => { wz.mode = "create"; wz.forceCreate = true; renderWizard(); });
  $("#wz-keep").addEventListener("click", () => { NOTE_SKIP.add(wz.rowIds); closeSheet(); if (wz.onDone) wz.onDone({ skipped: true }); });
  $("#wz-remove").addEventListener("click", async () => { const id = wz.rowIds[0]; closeSheet(); await removeOnly(id); if (wz.onDone) wz.onDone({ removed: true }); });
  if (wz.mode === "search") {
    const inp = $("#wz-search"), res = $("#wz-search-res");
    const show = () => { const list = suggestions(inp.value); res.innerHTML = list.map((p) => `<button type="button" class="chip pick" data-link="${p.id}">${esc(p.name)}</button>`).join("") || `<span class="hint">${inp.value.trim() ? "Nichts gefunden." : ""}</span>`; $$("[data-link]", res).forEach((b) => b.addEventListener("click", () => { const p = state.products.get(num(b.dataset.link)); if (p) { wz.linkTo = p; wz.mode = "link"; renderWizard(); } })); };
    inp.addEventListener("input", show); show(); inp.focus();
    return;
  }
  if (wz.mode !== "create") return;
  $("#wz-name").addEventListener("input", (e) => { wz.name = e.target.value; });
  wireChips("wz-loc", (v) => { wz.locationId = num(v); });
  const ls = $("#wz-loc-sel"); if (ls) ls.addEventListener("change", () => { wz.locationId = num(ls.value); });
  $("#wz-qu").addEventListener("change", (e) => { wz.quPurchase = num(e.target.value); if (wz.quPurchase === wz.quStock || !$("#wz-qu2")) wz.quStock = wz.quPurchase; renderWizard(); });
  const qu2 = $("#wz-qu2"); if (qu2) qu2.addEventListener("change", () => { wz.quStock = num(qu2.value); updQtyHint(); });
  const fac = $("#wz-factor"); if (fac) fac.addEventListener("input", () => { wz.factorPS = num(fac.value) > 0 ? num(fac.value) : 1; updQtyHint(); });
  $("#wz-diff").addEventListener("click", () => { if (wz.quPurchase !== wz.quStock) { wz.quStock = wz.quPurchase; wz.factorPS = 1; } else { const alt = [...state.units.keys()].find((id) => id !== wz.quPurchase); if (alt == null) { toast("Grocy kennt nur eine Einheit."); return; } wz.quStock = alt; wz.factorPS = wz.factorPS > 0 && wz.factorPS !== 1 ? wz.factorPS : 1; } renderWizard(); });
  wireChips("wz-days", (v) => { wz.days = num(v); $("#wz-dayslbl").textContent = "· " + dateLabelFor(wz.days); const di = $("#wz-days-in"); if (di) di.hidden = true; });
  $("#wz-days-other").addEventListener("click", () => { const di = $("#wz-days-in"); di.hidden = false; di.focus(); });
  $("#wz-days-in").addEventListener("change", (e) => { const d = num(e.target.value); if (d > 0) { wz.days = Math.round(d); renderWizard(); } });
  $("#wz-min").addEventListener("input", (e) => { wz.minStock = Math.max(0, num(e.target.value)); });
  $("#wz-due2").addEventListener("change", (e) => { wz.dueType = e.target.checked ? 2 : 1; });
  $("#wz-barcode").addEventListener("input", (e) => { wz.barcode = e.target.value.replace(/\D/g, "") || null; });
  const grp = $("#wz-group");
  const det = grp.closest("details");
  det.addEventListener("toggle", async () => {
    if (!det.open || grp.dataset.loaded) return;
    grp.dataset.loaded = "1";
    try { const gs = await api("/api/objects/product_groups"); grp.innerHTML = `<option value="">– keine –</option>` + (Array.isArray(gs) ? gs : []).sort((a, b) => String(a.name).localeCompare(String(b.name), "de")).map((g) => `<option value="${num(g.id)}" ${num(g.id) === wz.groupId ? "selected" : ""}>${esc(g.name)}</option>`).join(""); } catch (_) {}
  }, { once: false });
  grp.addEventListener("change", () => { wz.groupId = grp.value ? num(grp.value) : null; });
  const sc = $("#wz-scan");
  if (sc) sc.addEventListener("click", () => startScan(async (code) => {
    toast("Barcode erkannt – schlage nach …");
    try {
      const r = await lookupBarcode(code);
      if (r.known) { wz.linkTo = state.products.get(r.known.id) || r.known; wz.mode = "link"; wz.barcode = code; renderWizard(); toast(`„${wz.linkTo.name}“ ist in Grocy schon bekannt.`); return; }
      const pf = await wizardPrefill(r.name || wz.name, wz.qty, { code, name: r.name, image: r.image, off: r.off });
      Object.assign(wz, pf, { mode: "create", barcode: code, qty: wz.qty });
      renderWizard();
      if (!r.name) toast("Barcode unbekannt – wird beim Anlegen am Produkt gespeichert.");
    } catch (e) { toast(describeError(e), { bad: true }); }
  }));
  const ss = $("#wz-scan-stop"); if (ss) ss.addEventListener("click", stopScan);
}
// Grocy-Listenzeile(n) auf ein Produkt umstellen. Menge ist in der Lager-Einheit!
async function linkRows(pid, qtyPurchase, quPurchase, quStock, f) {
  const amountStock = round3(qtyPurchase * (f || 1));
  let linked = 0, gone = 0, taken = 0;
  for (const id of wz.rowIds) {
    try {
      const cur = await api(`/api/objects/shopping_list/${id}`);
      if (cur && cur.product_id != null && cur.product_id !== "") { taken++; continue; }   // jemand anders war schneller
      await api(`/api/objects/shopping_list/${id}`, { method: "PUT", body: { product_id: pid, note: "", amount: amountStock, ...(quPurchase != null ? { qu_id: quPurchase } : {}) } });
      linked++;
    } catch (e) {
      if (isGone(e)) { try { await api("/api/objects/shopping_list", { method: "POST", body: { shopping_list_id: CFG.listId, product_id: pid, amount: amountStock, done: wz.rowDone ? 1 : 0, ...(quPurchase != null ? { qu_id: quPurchase } : {}) } }); gone++; } catch (_) {} }
      else throw e;
    }
  }
  return { linked, gone, taken, amountStock };
}
async function wizardLink() {
  const p = wz.linkTo; if (!p) return;
  const btn = $("#wz-go"); btn.disabled = true;
  const qu = p.quPurchase != null ? p.quPurchase : p.quStock;
  const f = factor(p.id, qu, p.quStock) || 1;
  try {
    const r = await linkRows(p.id, wz.qty, qu, p.quStock, f);
    closeSheet();
    await loadShopping(); renderShopping(); updateBadges();
    toast(r.taken && !r.linked && !r.gone ? `„${p.name}“ hat jemand schon verknüpft.` : `„${p.name}“ steht jetzt als Produkt auf der Liste (${amountLabel(wz.qty, qu)}).`);
    if (wz.onDone) wz.onDone({ linked: true, pid: p.id });
  } catch (e) { btn.disabled = false; toast(describeError(e), { bad: true }); }
}
async function wizardCreate() {
  const name = (wz.name || "").trim();
  if (!name) { toast("Bitte einen Namen eingeben."); return; }
  if (wz.locationId == null || wz.quPurchase == null || wz.quStock == null) { toast("Lagerort und Einheit fehlen."); return; }
  const dupe = [...state.products.values()].find((p) => normKey(p.name) === normKey(name));
  if (dupe) { if (dupe.active && !dupe.noOwnStock) { wz.linkTo = dupe; wz.mode = "link"; renderWizard(); toast(`„${dupe.name}“ gibt es schon – verknüpfen?`); } else toast(`„${dupe.name}“ gibt es in Grocy schon (deaktiviert oder ohne eigenen Bestand).`, { bad: true }); return; }
  const btn = $("#wz-go"); btn.disabled = true; btn.innerHTML = `<span class="spin"></span><span>Lege an …</span>`; sheetLocked = true;
  const loc = state.locations.get(wz.locationId);
  const body = { name, location_id: wz.locationId, qu_id_purchase: wz.quPurchase, qu_id_stock: wz.quStock, default_best_before_days: wz.days, due_type: wz.dueType, min_stock_amount: wz.minStock || 0 };
  if (wz.groupId != null) body.product_group_id = wz.groupId;
  if (loc && loc.freezer) body.default_best_before_days_after_freezing = wz.days;   // sonst setzt Grocy im Tiefkühler „heute“
  let pid = null;
  try {
    const r = await api("/api/objects/products", { method: "POST", body });
    pid = r && r.created_object_id != null ? num(r.created_object_id) : null;
  } catch (e) {
    sheetLocked = false;
    if (e.forbidden) { wz.mode = wz.linkTo ? "link" : "search"; wz.forceCreate = false; renderWizard(); toast(describeError(e), { bad: true, duration: 7000 }); return; }
    if (e.status === 400 && /unique/i.test(e.detail || "")) { try { await loadMasters(true); } catch (_) {} const d = [...state.products.values()].find((p) => normKey(p.name) === normKey(name)); if (d) { wz.linkTo = d; wz.mode = "link"; renderWizard(); toast(`„${d.name}“ gibt es schon – verknüpfen?`); return; } }
    if (e.unclear) { try { await loadMasters(true); } catch (_) {} const d = [...state.products.values()].find((p) => normKey(p.name) === normKey(name)); if (d) pid = d.id; }
    if (!pid) { btn.disabled = false; btn.innerHTML = `${I.plus}<span>Produkt anlegen</span>`; toast(describeError(e), { bad: true }); return; }
  }
  const f = wz.quPurchase === wz.quStock ? 1 : (wz.factorPS > 0 ? wz.factorPS : 1);
  let convWarn = false;
  if (f !== 1) {
    try {
      const rows = await api(`/api/objects/quantity_unit_conversions?query%5B%5D=product_id%3D${pid}`);
      const list = Array.isArray(rows) ? rows : [];
      const put = async (from, to, fac) => { const ex = list.find((c) => num(c.from_qu_id) === from && num(c.to_qu_id) === to); if (ex) await api(`/api/objects/quantity_unit_conversions/${ex.id}`, { method: "PUT", body: { factor: fac } }); else await api("/api/objects/quantity_unit_conversions", { method: "POST", body: { product_id: pid, from_qu_id: from, to_qu_id: to, factor: fac } }); };
      await put(wz.quPurchase, wz.quStock, round3(f) || f);
      await put(wz.quStock, wz.quPurchase, 1 / f);
    } catch (_) { convWarn = true; }
  }
  let barcodeId = null;
  if (wz.barcode) { try { const b = await api("/api/objects/product_barcodes", { method: "POST", body: { product_id: pid, barcode: wz.barcode } }); barcodeId = b && b.created_object_id != null ? num(b.created_object_id) : null; } catch (e) { DIAG.push({ kind: "wizard", msg: "barcode: " + (e.detail || e.message) }); } }
  try { await loadMasters(true); } catch (_) {}
  const prod = state.products.get(pid);
  const fEff = convWarn ? 1 : f;
  let linkRes = { linked: 0, gone: 0, taken: 0 };
  try { linkRes = await linkRows(pid, wz.qty, wz.quPurchase, wz.quStock, fEff); } catch (e) { DIAG.push({ kind: "wizard", msg: "link: " + (e.detail || e.message) }); }
  sheetLocked = false; closeSheet();
  try { await loadShopping(); } catch (_) {}
  renderShopping(); updateBadges();
  const undo = { pid, barcodeId, rows: wz.rowIds.map((id) => ({ id, note: wz.note, amount: wz.noteAmount, done: wz.rowDone })) };
  const n = linkRes.linked + linkRes.gone;
  toast(`„${name}“ angelegt${n ? ` · ${plural(n, "Zeile", "Zeilen")} auf der Liste` : ""}${convWarn ? " · Umrechnung in Grocy prüfen" : ""}`, { action: { label: "Rückgängig", fn: () => undoWizard(undo) } });
  if (wz.onDone) wz.onDone({ created: true, pid });
  if (prod && prod.bbdDays === 0) DIAG.push({ kind: "wizard", msg: "bbdDays 0 nach Anlegen?" });
}
async function undoWizard(u) {
  hideToast();
  let note = 0, fail = 0;
  for (const r of u.rows) {
    try {
      const cur = await api(`/api/objects/shopping_list/${r.id}`).catch(() => null);
      if (cur && num(cur.product_id) === u.pid) {
        await api(`/api/objects/shopping_list/${r.id}`, { method: "DELETE" });
        await api("/api/objects/shopping_list", { method: "POST", body: { shopping_list_id: CFG.listId, note: r.note, amount: r.amount, done: r.done ? 1 : 0 } });
        note++;
      }
    } catch (_) { fail++; }
  }
  if (u.barcodeId) { try { await api(`/api/objects/product_barcodes/${u.barcodeId}`, { method: "DELETE" }); } catch (_) {} }
  let kept = false;
  try { await api(`/api/objects/products/${u.pid}`, { method: "DELETE" }); } catch (_) { kept = true; }
  try { await loadMasters(true); await loadShopping(); } catch (_) {}
  renderShopping(); updateBadges();
  toast(kept ? `Zeile${note === 1 ? " ist" : "n sind"} wieder Notiz. Das Produkt bleibt in Grocy (wird schon verwendet).` : `Rückgängig: ${plural(note, "Zeile", "Zeilen")} wieder Notiz, Produkt gelöscht.${fail ? " Teilweise fehlgeschlagen." : ""}`, { bad: !!fail || kept, duration: 6000 });
}

/* ---- Vor dem Einsortieren: Notizen + Produkte ohne Haltbarkeit ---- */
function openPrePutawaySheet(done, notes, noBbd) {
  const rows = [];
  for (const it of notes) rows.push(`<li data-note="${it.id}"><span class="st warn">${I.alert}</span><span class="b"><div>${esc(it.name)}</div><div class="m">Notiz – kommt nur von der Liste, nicht in den Vorrat</div></span><button class="btn btn-soft btn-sm" data-pre-wizard="${it.id}">${PERM.denied("MASTER_DATA_EDIT") ? "Verknüpfen" : "Anlegen"}</button></li>`);
  for (const it of noBbd) {
    const h = heuristic(it.name) ; const d = h ? h.days : -1;
    rows.push(`<li data-prod="${it.productId}"><span class="st warn">${I.alert}</span><span class="b"><div>${esc(it.name)}</div><div class="m">Produkt ohne Haltbarkeit · Vorschlag: ${esc(dateLabelFor(d))}</div>${shelfChipsHTML("pre-days-" + it.productId, d)}<label class="toggle" style="min-height:36px"><input type="checkbox" data-remember="${it.productId}" checked /><span class="hint">Für dieses Produkt merken</span></label></span></li>`);
  }
  const total = done.length;
  openSheet(`
    <h2 id="sheet-title">${notes.length ? esc(plural(notes.length, "Notiz ist", "Notizen sind")) + " noch kein Produkt" : "Kurz prüfen"}</h2>
    <p class="sub">${noBbd.length ? esc(plural(noBbd.length, "Produkt hat", "Produkte haben")) + " noch keine Haltbarkeit." : "Notizen kommen nur von der Liste, nicht in den Vorrat."}</p>
    <ul class="plist" id="prelist">${rows.join("")}</ul>
    <div class="btnrow">
      <button class="btn btn-primary full" id="pre-go">${I.pack}<span>Trotzdem ${esc(plural(total, "Sache", "Sachen"))} einsortieren</span></button>
      <button class="linkbtn" id="pre-skip" style="justify-content:center">Diese nicht mehr fragen</button>
    </div>`);
  noBbd.forEach((it) => wireChips("pre-days-" + it.productId));
  const startRun = async (skipAll) => {
    const overrides = {};
    const remember = [];
    for (const it of noBbd) {
      const v = chipValue("pre-days-" + it.productId); if (v == null) continue;
      const days = num(v);
      overrides[it.id] = { bbd: days === -1 ? "never" : addDays(days) };
      const cb = $(`[data-remember="${it.productId}"]`); if (cb && cb.checked) remember.push({ pid: it.productId, days });
    }
    if (skipAll) NOTE_SKIP.add([...notes.map((n) => n.id), ...noBbd.map((n) => "p" + n.productId)]);
    closeSheet();
    for (const r of remember) {
      if (PERM.denied("MASTER_DATA_EDIT")) break;
      try { await api(`/api/objects/products/${r.pid}`, { method: "PUT", body: { default_best_before_days: r.days } }); const p = state.products.get(r.pid); if (p) p.bbdDays = r.days; }
      catch (e) { if (!e.forbidden) DIAG.push({ kind: "wizard", msg: "bbd merken: " + (e.detail || e.message) }); }
    }
    // Produkte mit gleichem Produkt im Wagen: dieselbe Haltbarkeit übernehmen
    for (const it of done) if (it.kind === "product" && !overrides[it.id]) { const same = noBbd.find((n) => n.productId === it.productId); if (same && overrides[same.id]) overrides[it.id] = overrides[same.id]; }
    await runPutaway(done, { overrides });
  };
  $("#pre-go").addEventListener("click", () => startRun(false));
  $("#pre-skip").addEventListener("click", () => startRun(true));
  $$("[data-pre-wizard]").forEach((b) => b.addEventListener("click", () => {
    const id = num(b.dataset.preWizard);
    openWizard(id, { onDone: () => {
      // zurück in die Vorprüfung mit frischem Stand
      const d2 = state.shopping.filter((s) => s.done);
      const n2 = d2.filter((s) => s.kind === "note" && !NOTE_SKIP.has(s.id));
      const b2 = CFG.bookStock ? d2.filter((s) => s.kind === "product" && s.product && s.product.bbdDays === 0 && !NOTE_SKIP.has("p" + s.productId)) : [];
      if (!d2.length) return;
      if (n2.length || b2.length) openPrePutawaySheet(d2, n2, b2); else runPutaway(d2);
    } });
  }));
}

/* ---- Vorschläge: Kaufrhythmus + Mindestbestand + „ist alle“ ---- */
const SUGG = { WINDOW: 120, MIN_RHYTHM: 3, MIN_EMPTY: 2, FACTOR: 1.2, STALE: 2.5, M_MIN: 3, M_MAX: 45, MAX_ROWS: 3, RECALC_MS: 6 * 3600 * 1000, SNOOZE_MIN: 14 };
const SNOOZE = {
  all() { return store.json("aemtli.sugg.snooze", {}) || {}; },
  set(pid, until, since) { const a = this.all(); a[pid] = { until, since }; store.set("aemtli.sugg.snooze", JSON.stringify(a)); },
  del(pid) { const a = this.all(); if (a[pid]) { delete a[pid]; store.set("aemtli.sugg.snooze", JSON.stringify(a)); } },
};
function buildSuggestions(log, stock, vol, todayISO) {
  const dayOf = (ts) => String(ts || "").slice(0, 10);
  const dayDiff = (a, b) => Math.round((new Date(a + "T12:00:00") - new Date(b + "T12:00:00")) / 86400000);
  const byPid = new Map();
  for (const r of Array.isArray(log) ? log : []) {
    const pid = num(r.product_id); const d = dayOf(r.row_created_timestamp); if (!pid || !/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    if (!byPid.has(pid)) byPid.set(pid, new Map());
    const m = byPid.get(pid); m.set(d, (m.get(d) || 0) + Math.abs(num(r.amount)));
  }
  const inStock = new Set((Array.isArray(stock) ? stock : []).filter((s) => num(s.amount) > 0).map((s) => num(s.product_id)));
  const snooze = SNOOZE.all();
  const parents = new Set([...state.products.values()].map((p) => p.parentId).filter((x) => x != null));
  const onList = new Set(state.shopping.map((s) => s.productId).filter((x) => x != null));
  const out = new Map(); let rhythmProducts = 0;
  const consider = (pid, score, reason, qtyStock, m) => {
    const p = state.products.get(pid);
    if (!p || !p.active || p.noOwnStock || parents.has(pid) || onList.has(pid)) return;
    const sn = snooze[pid];
    if (sn && sn.until > todayISO) return;
    const cur = out.get(pid);
    if (!cur || score > cur.score) out.set(pid, { pid, name: p.name, score, reason, qtyStock: qtyStock || cur && cur.qtyStock || 1, m: m || (cur && cur.m) || null });
  };
  for (const [pid, days] of byPid) {
    const ds = [...days.keys()].sort(); const n = ds.length; const last = ds[n - 1];
    const sn = snooze[pid]; if (sn && sn.since && last > sn.since) SNOOZE.del(pid);   // neuer Kauf hebt Schlummern auf
    const qtyMedian = (() => { const a = [...days.values()].sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : 1; })();
    if (n >= SUGG.MIN_RHYTHM) {
      rhythmProducts++;
      const iv = []; for (let i = 1; i < n; i++) iv.push(dayDiff(ds[i], ds[i - 1]));
      iv.sort((a, b) => a - b); let m = iv[Math.floor(iv.length / 2)]; m = Math.min(SUGG.M_MAX, Math.max(SUGG.M_MIN, m));
      const since = dayDiff(todayISO, last);
      if (since >= SUGG.FACTOR * m && since < SUGG.STALE * m) consider(pid, since / m, `sonst etwa alle ${m} Tage · zuletzt vor ${since} Tagen`, qtyMedian, m);
    }
    if (n >= SUGG.MIN_EMPTY && !inStock.has(pid)) consider(pid, 1.5, "nichts mehr im Vorrat", qtyMedian, null);
  }
  for (const mp of (vol && Array.isArray(vol.missing_products)) ? vol.missing_products : []) {
    const pid = num(mp.id); const miss = num(mp.amount_missing);
    consider(pid, 2, `unter Mindestbestand${miss ? ` (${fmtNum(miss)} fehlt)` : ""}`, miss > 0 ? miss : null, null);
  }
  for (const ep of (vol && Array.isArray(vol.expired_products)) ? vol.expired_products : []) consider(num(ep.product_id), 1.4, "Verbrauchsdatum überschritten", null, null);
  const items = [...out.values()].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, "de"));
  return { items, stats: { rhythmProducts, purchases: byPid.size } };
}
let suggBusy = false;
async function computeSuggestions(force = false) {
  if (suggBusy || !CFG.suggest || !CFG.configured || navigator.onLine === false) return;
  const cached = SNAP.get("sugg");
  if (!force && cached && Date.now() - cached.t < SUGG.RECALC_MS) { state.sugg = cached.data; return; }
  suggBusy = true;
  try {
    const since = addDays(-SUGG.WINDOW);
    const [log, stock, vol] = await Promise.all([
      api(`/api/objects/stock_log?query%5B%5D=transaction_type%3Dpurchase&query%5B%5D=undone%3D0&query%5B%5D=row_created_timestamp%3E%3D${since}`),
      api("/api/stock").catch(() => []),
      api("/api/stock/volatile?due_soon_days=5").catch(() => null),
    ]);
    state.sugg = buildSuggestions(log, stock, vol, isoDate(new Date()));
    SNAP.set("sugg", state.sugg);
  } catch (e) { DIAG.push({ kind: "sugg", msg: e.detail || e.message }); }
  finally { suggBusy = false; }
}
function visibleSuggestions() {
  if (!CFG.suggest || !state.sugg || !Array.isArray(state.sugg.items)) return [];
  const onList = new Set(state.shopping.map((s) => s.productId).filter((x) => x != null));
  const today = isoDate(new Date()); const sn = SNOOZE.all();
  return state.sugg.items.filter((s) => !onList.has(s.pid) && !(sn[s.pid] && sn[s.pid].until > today) && state.products.has(s.pid));
}
function suggestionsHTML() {
  const items = visibleSuggestions();
  if (!items.length) return "";
  const row = (s) => {
    const p = state.products.get(s.pid);
    const qu = p.quPurchase != null ? p.quPurchase : p.quStock;
    const f = factor(p.id, p.quStock, qu) || 1;
    const qty = Math.max(0.001, round3((s.qtyStock || 1) * f));
    return `<div class="row sugg"><span class="lead" aria-hidden="true">${I.bulb}</span><span class="body"><span class="nm">${esc(s.name)}</span><span class="meta">${esc(s.reason)}</span></span><span class="trail"><button class="btn btn-soft btn-sm" data-act="sugg-add" data-id="${s.pid}" data-qty="${qty}" aria-label="${esc(s.name)} auf die Liste, ${esc(amountLabel(qty, qu))}">${I.plus}<span>${esc(amountLabel(qty, qu))}</span></button><button class="iconbtn" data-act="sugg-snooze" data-id="${s.pid}" aria-label="Vorschlag „${esc(s.name)}“ ausblenden">${I.x}</button></span></div>`;
  };
  const head = items.slice(0, SUGG.MAX_ROWS), rest = items.slice(SUGG.MAX_ROWS);
  return `<h2 class="sect">Vorschläge <span class="count">${items.length}</span></h2>
    <section class="card" aria-label="Vorschläge">${head.map(row).join("")}${rest.length ? `<details class="help" style="margin:0 16px"><summary>${esc(plural(rest.length, "weiterer Vorschlag", "weitere Vorschläge"))}</summary>${rest.map(row).join("")}</details>` : ""}</section>`;
}
async function suggestionAdd(pid) {
  const p = state.products.get(pid); if (!p) return;
  const btn = $(`[data-act="sugg-add"][data-id="${pid}"]`); const qty = btn ? num(btn.dataset.qty) || 1 : 1;
  const qu = p.quPurchase != null ? p.quPurchase : p.quStock;
  const f = factor(p.id, qu, p.quStock) || 1;
  if (btn) btn.disabled = true;
  try {
    await api("/api/objects/shopping_list", { method: "POST", body: { shopping_list_id: CFG.listId, product_id: p.id, amount: round3(qty * f), ...(qu != null ? { qu_id: qu } : {}) } });
    toast(`„${p.name}“ ergänzt`);
    await loadShopping(); renderShopping(); updateBadges();
  } catch (e) { if (btn) btn.disabled = false; toast(describeError(e), { bad: true }); }
}
function suggestionSnooze(pid) {
  const s = (state.sugg && state.sugg.items || []).find((x) => x.pid === pid);
  const days = Math.max(SUGG.SNOOZE_MIN, s && s.m ? Math.round(s.m) : 0);
  SNOOZE.set(pid, addDays(days), isoDate(new Date()));
  renderShopping();
  toast("Erst wieder nach dem nächsten Kauf.");
}

/* ---- Vorrat: Abgelaufenes aufräumen (clientseitig, 1× täglich pro Gerät) ---- */
const EXPIRE = { GRACE_MHD: 7, GRACE_USE: 1, MAX_PER_RUN: 25, KEEP_DAYS: 60 };
const KEEP = {   // nach „Rückgängig“ nicht erneut aufräumen (pro Gerät)
  all() { const a = store.json("aemtli.expire.keep", {}) || {}; const cut = Date.now() - EXPIRE.KEEP_DAYS * 86400000; let ch = false; for (const k of Object.keys(a)) if (a[k] < cut) { delete a[k]; ch = true; } if (ch) store.set("aemtli.expire.keep", JSON.stringify(a)); return a; },
  add(ids) { const a = this.all(); for (const id of ids) a[id] = Date.now(); store.set("aemtli.expire.keep", JSON.stringify(a)); },
};
// Reine Funktion (ohne DOM/API) – später 1:1 in den Server-Worker portierbar.
function cleanupPlan(entries, products, todayISO, { graceMhd = EXPIRE.GRACE_MHD, graceUse = EXPIRE.GRACE_USE, keep = new Set() } = {}) {
  const out = [];
  const dayDiff = (iso) => Math.round((new Date(todayISO + "T12:00:00") - new Date(iso + "T12:00:00")) / 86400000);
  for (const e of Array.isArray(entries) ? entries : []) {
    const bbd = String(e.best_before_date || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(bbd) || bbd >= "2999-01-01") continue;
    const amount = num(e.amount); if (!(amount > 0)) continue;
    if (keep.has(String(e.stock_id))) continue;
    const p = products.get(num(e.product_id));
    if (!p || !p.active || p.tare || p.noOwnStock) continue;
    const over = dayDiff(bbd);
    if (over < (p.dueType === 2 ? graceUse : graceMhd)) continue;
    out.push({ id: num(e.id), stock_id: String(e.stock_id), product_id: num(e.product_id), amount, bbd, over, name: p.name, dueType: p.dueType, quStock: p.quStock });
  }
  return out.sort((a, b) => b.over - a.over);
}
// Genau diesen Bestandseintrag ausbuchen. Idempotent: zweiter Aufruf → „schon weg“.
async function consumeEntry(e, spoiled, retried = false) {
  const body = { amount: round3(e.amount), spoiled: !!spoiled, stock_entry_id: e.stock_id };
  try {
    const r = await api(`/api/stock/products/${e.product_id}/consume`, { method: "POST", body });
    return Array.isArray(r) && r.length && r[0].transaction_id ? { ok: true, tx: r[0].transaction_id } : { ok: false, gone: true };
  } catch (err) {
    if (err.status === 400 && /no transaction was found/i.test(err.detail || "")) return { ok: false, gone: true };
    if (err.status === 400 && /current stock|more than|not available/i.test(err.detail || "") && !retried) {
      const rows = await api(`/api/objects/stock?query%5B%5D=stock_id%3D${encodeURIComponent(e.stock_id)}`).catch(() => null);
      const cur = Array.isArray(rows) ? rows[0] : null;
      if (cur && num(cur.amount) > 0) return consumeEntry({ ...e, amount: num(cur.amount) }, spoiled, true);
      return { ok: false, gone: true };
    }
    throw err;
  }
}
async function fetchExpiredPlan() {
  const today = isoDate(new Date());
  const entries = await api(`/api/objects/stock?query%5B%5D=best_before_date%3C${addDays(-EXPIRE.GRACE_USE + 1)}`);
  return cleanupPlan(entries, state.products, today, { keep: new Set(Object.keys(KEEP.all())) });
}
let cleanupBusy = false;
async function maybeCleanup() {
  if (cleanupBusy || !CFG.configured || !CFG.bookStock || navigator.onLine === false || document.visibilityState !== "visible" || state.running || state.fromCache) return;
  if (CFG.expireAuto === false) return;
  if (PERM.denied("STOCK_CONSUME")) return;
  const today = isoDate(new Date());
  if (store.get("aemtli.expire.lastRun") === today) return;
  cleanupBusy = true;
  try {
    const plan = await fetchExpiredPlan();
    if (!plan.length) { store.set("aemtli.expire.lastRun", today); return; }
    if (CFG.expireAuto === null) { openCleanupConsentSheet(plan); return; }   // erster Lauf: einmal fragen
    store.set("aemtli.expire.lastRun", today);
    await runCleanup(plan);
  } catch (e) { DIAG.push({ kind: "expire", msg: e.detail || e.message }); }
  finally { cleanupBusy = false; }
}
async function runCleanup(plan) {
  const todo = plan.slice(0, EXPIRE.MAX_PER_RUN);
  const rows = []; let gone = 0, failed = 0;
  for (const e of todo) {
    try {
      const r = await consumeEntry(e, CFG.expireSpoiled);
      if (r.ok) rows.push({ tx: r.tx, name: e.name, amount: e.amount, quStock: e.quStock, stock_id: e.stock_id }); else gone++;
    } catch (err) {
      if (err.forbidden) { failed++; break; }
      if (err.status === 0) { store.del("aemtli.expire.lastRun"); failed++; break; }   // Netz weg → morgen erneut
      failed++; DIAG.push({ kind: "expire", msg: `${e.name}: ${err.detail || err.message}` });
    }
  }
  if (rows.length) store.set("aemtli.expire.last", JSON.stringify({ at: Date.now(), rows }));
  if (rows.length) toast(`${plural(rows.length, "abgelaufene Sache", "abgelaufene Sachen")} aus dem Vorrat genommen${plan.length > todo.length ? ` (${plan.length - todo.length} morgen)` : ""}`, { action: { label: "Rückgängig", fn: undoCleanup }, duration: 9000 });
  else if (failed && !gone) toast("Aufräumen des Vorrats ist fehlgeschlagen – Details in der Diagnose.", { bad: true });
  computeSuggestions(true).then(() => { if (state.tab === "shopping") renderShopping(); });
}
async function undoCleanup() {
  const last = store.json("aemtli.expire.last", null); if (!last || !last.rows) return;
  hideToast();
  let ok = 0, fail = 0;
  for (const r of last.rows) { try { await api(`/api/stock/transactions/${encodeURIComponent(r.tx)}/undo`, { method: "POST", body: {} }); ok++; } catch (_) { fail++; } }
  KEEP.add(last.rows.map((r) => r.stock_id));
  store.del("aemtli.expire.last");
  toast(fail ? `Rückgängig nur teilweise (${ok} von ${last.rows.length}). In Grocy prüfen.` : `${plural(ok, "Sache", "Sachen")} wieder im Vorrat. Bleibt dort, bis du das Datum in Grocy anpasst.`, { bad: !!fail, duration: 7000 });
  if (state.tab === "settings") renderSettings();
}
function openCleanupConsentSheet(plan) {
  const li = plan.slice(0, 12).map((e) => `<li><span class="st warn">${I.alert}</span><span class="b"><div>${esc(e.name)}</div><div class="m">${esc(amountLabel(e.amount, e.quStock))} · ${e.dueType === 2 ? "Verbrauchsdatum" : "MHD"} vor ${esc(plural(e.over, "Tag", "Tagen"))} (${esc(fmtDate(e.bbd))})</div></span></li>`).join("");
  openSheet(`
    <h2 id="sheet-title">${esc(plural(plan.length, "abgelaufene Sache", "abgelaufene Sachen"))} im Vorrat</h2>
    <p class="sub">Ämtli kann so etwas künftig täglich still erledigen: MHD 7 Tage nach Ablauf, Verbrauchsdatum am Tag danach. Die Buchung erscheint in Grocy unter deinem Namen; Rückgängig geht jederzeit.</p>
    <ul class="plist">${li}${plan.length > 12 ? `<li><span class="st wait">·</span><span class="b"><div class="m">… und ${plan.length - 12} weitere</div></span></li>` : ""}</ul>
    <div class="btnrow">
      <button class="btn btn-primary full" id="cl-go">Aus dem Vorrat nehmen & künftig automatisch</button>
      <button class="btn btn-ghost full" id="cl-once">Nur jetzt aufräumen</button>
      <button class="linkbtn" id="cl-no" style="justify-content:center">Nicht automatisch aufräumen</button>
    </div>`);
  const today = isoDate(new Date());
  $("#cl-go").addEventListener("click", async () => { CFG.expireAuto = true; store.set("aemtli.expire.lastRun", today); closeSheet(); await runCleanup(plan); });
  $("#cl-once").addEventListener("click", async () => { store.set("aemtli.expire.lastRun", today); closeSheet(); await runCleanup(plan); });
  $("#cl-no").addEventListener("click", () => { CFG.expireAuto = false; closeSheet(); toast("Aufräumen bleibt aus. In den Einstellungen änderbar."); });
}

/* ---- Pflege-Sheet: Haltbarkeiten für Altprodukte ohne Default ---- */
function openMaintainSheet() {
  const lastBuy = new Map();
  for (const s of (state.sugg && state.sugg.items) || []) lastBuy.set(s.pid, 1);
  const prods = [...state.products.values()].filter((p) => p.active && !p.noOwnStock && p.parentId == null && p.bbdDays === 0).sort((a, b) => (lastBuy.has(b.id) - lastBuy.has(a.id)) || a.name.localeCompare(b.name, "de"));
  if (!prods.length) { toast("Alle Produkte haben eine Haltbarkeit."); return; }
  const li = prods.map((p) => { const h = heuristic(p.name); const d = h ? h.days : -1; return `<li data-pid="${p.id}"><span class="st wait">·</span><span class="b"><div>${esc(p.name)}</div>${shelfChipsHTML("mt-" + p.id, d)}</span></li>`; }).join("");
  openSheet(`
    <h2 id="sheet-title">Haltbarkeiten pflegen</h2>
    <p class="sub">${esc(plural(prods.length, "Produkt hat", "Produkte haben"))} noch keine Haltbarkeit. Vorgeschlagen aus dem Namen – anpassen und speichern.</p>
    <div class="pbar" hidden id="mt-bar"><span id="mt-barfill" style="width:0%"></span></div>
    <ul class="plist">${li}</ul>
    <div class="btnrow"><button class="btn btn-primary full" id="mt-save">Alle speichern</button></div>`);
  prods.forEach((p) => wireChips("mt-" + p.id));
  $("#mt-save").addEventListener("click", async () => {
    const btn = $("#mt-save"); btn.disabled = true; sheetLocked = true;
    const bar = $("#mt-bar"); bar.hidden = false;
    let ok = 0, fail = 0, stop = false;
    for (let i = 0; i < prods.length; i++) {
      const p = prods[i]; const v = chipValue("mt-" + p.id); const days = v == null ? null : num(v);
      const li = $(`li[data-pid="${p.id}"] .st`);
      if (days != null && !stop) {
        try { await api(`/api/objects/products/${p.id}`, { method: "PUT", body: { default_best_before_days: days } }); p.bbdDays = days; ok++; if (li) { li.className = "st ok"; li.textContent = "✓"; } }
        catch (e) { fail++; if (li) { li.className = "st bad"; li.textContent = "!"; } if (e.forbidden) { stop = true; toast(describeError(e), { bad: true, duration: 7000 }); } }
      }
      $("#mt-barfill").style.width = `${Math.round(((i + 1) / prods.length) * 100)}%`;
    }
    sheetLocked = false; closeSheet();
    if (ok) toast(`${plural(ok, "Haltbarkeit", "Haltbarkeiten")} gespeichert${fail ? `, ${fail} nicht` : ""}`, { bad: !!fail });
    try { await loadMasters(true); } catch (_) {}
    if (state.tab === "settings") renderSettings();
  });
}

/* ---- Nach jedem erfolgreichen Laden der Einkaufsliste ---- */
function afterShoppingLoaded() {
  NOTE_SKIP.prune(new Set(state.shopping.map((s) => s.id)));
  computeSuggestions().then(() => { if (state.tab === "shopping" && !sheetOpen) renderShopping(); });
  setTimeout(() => { if (!sheetOpen) maybeCleanup(); }, 3000);
}

/* ====================================================================== */
/*  Shared render bits, Sheets, Router                                     */
/* ====================================================================== */
function emptyHTML(icon, title, sub) {
  return `<div class="empty"><span class="ic" aria-hidden="true">${icon}</span><div class="t">${esc(title)}</div><div class="s">${esc(sub)}</div></div>`;
}
function skeletonHTML(title) {
  let s = "";
  for (let i = 0; i < 4; i++) s += `<div class="skeleton"><div class="sk-dot sk-anim"></div><div style="flex:1"><div class="sk-line sk-anim" style="width:${50 + (i * 13) % 35}%"></div><div class="sk-line sk-anim" style="width:30%;margin-top:7px;height:9px"></div></div></div>`;
  return `<div class="phead"><h1 class="h1">${esc(title)}</h1><p class="sub">lädt …</p></div><section class="card" aria-busy="true">${s}</section>`;
}
function rememberFocus() {
  const f = document.activeElement;
  if (!f || !view.contains(f)) return null;
  if (f.dataset && f.dataset.act) return { act: f.dataset.act, id: f.dataset.id };
  if (f.id) return { id: "#" + f.id };
  return null;
}
function restoreFocus(key) {
  if (!key) return;
  const el = key.act ? view.querySelector(`[data-act="${key.act}"][data-id="${key.id}"]`) : $(key.id);
  if (el && !el.disabled) { try { el.focus({ preventScroll: true }); } catch (_) {} }
}
function updateBadges() {
  const open = state.shopping.filter((s) => !s.done).length;
  const overdue = state.chores.filter((c) => c.due.status === "expired").length;
  const setBadge = (id, n, label) => {
    const b = $("#" + id); if (!b) return;
    if (n > 0) { b.textContent = n; b.setAttribute("aria-label", `${n} ${label}`); b.hidden = false; } else b.hidden = true;
  };
  setBadge("badge-shopping", open, "zu kaufen");
  setBadge("badge-chores", overdue, "überfällig");
}
function setActiveTab(tab) {
  $$(".tab").forEach((t) => { const on = t.dataset.tab === tab; t.classList.toggle("active", on); if (on) t.setAttribute("aria-current", "page"); else t.removeAttribute("aria-current"); });
}
function showAuthBanner(err) {
  if (err && err.haAuth) setBanner("auth", { tone: "bad", html: "<b>Home-Assistant-Anmeldung abgelaufen.</b>", action: { label: "Neu laden", fn: () => location.reload() } });
  else setBanner("auth", { tone: "bad", html: "<b>Dein Grocy-Schlüssel gilt nicht mehr.</b> Vielleicht wurde er in Grocy gelöscht.", action: { label: "Schlüssel ändern", fn: () => go("settings") } });
}

/* ---- Sheet ---- */
let sheetOpen = false, sheetLocked = false;
function openSheet(html, { locked = false } = {}) {
  const s = $("#sheet"), b = $("#backdrop");
  s.innerHTML = `<div class="grabber" aria-hidden="true"></div>` + html;
  s.classList.add("show"); b.classList.add("show");
  sheetLocked = locked;
  const wasOpen = sheetOpen;
  if (!sheetOpen) { sheetOpen = true; try { history.pushState({ sheet: true }, ""); } catch (_) {} }
  // Nur beim Öffnen fokussieren – ein Re-Render (z. B. Chip gewählt) soll die Tastatur nicht hochholen.
  if (!wasOpen) { const first = s.querySelector("button, select, [tabindex]"); if (first) { try { first.focus({ preventScroll: true }); } catch (_) {} } }
}
function closeSheet() {
  if (!sheetOpen) return;
  if (sheetLocked) return;
  stopScan();
  const s = $("#sheet"), b = $("#backdrop");
  s.classList.remove("show"); b.classList.remove("show"); s.innerHTML = "";
  sheetOpen = false;
  if (history.state && history.state.sheet) { try { history.back(); } catch (_) {} }
}
// Zurück-Geste/-Taste schließt das Sheet. Landet die History dabei auf einem Sheet-Eintrag
// (Sheet wurde direkt nach dem Schließen neu geöffnet, z. B. Wizard → Vorprüfung), bleibt es offen.
window.addEventListener("popstate", (ev) => {
  if (!sheetOpen || sheetLocked) return;
  if (ev.state && ev.state.sheet) return;
  stopScan();
  const s = $("#sheet"), b = $("#backdrop"); s.classList.remove("show"); b.classList.remove("show"); s.innerHTML = ""; sheetOpen = false;
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && sheetOpen) closeSheet(); });

/* ---- Router ---- */
async function go(tab) {
  if (!CFG.configured && tab !== "settings") { renderOnboarding(); return; }
  app.classList.remove("no-tabs");
  hideSuggestions();
  if (tab === "settings") { renderSettings(); return; }
  state.tab = tab; setActiveTab(tab);
  const title = tab === "chores" ? "Aufgaben" : "Einkauf";
  const hasData = tab === "shopping" ? state.shopping.length : state.chores.length;
  // Cache-first: sofort etwas zeigen, dann still aktualisieren.
  if (!hasData && (tab === "shopping" ? shoppingFromSnapshot() : choresFromSnapshot())) { tab === "shopping" ? renderShopping() : renderChores(); }
  else if (!hasData) { view.innerHTML = skeletonHTML(title); renderCta(); }
  else { tab === "shopping" ? renderShopping() : renderChores(); }
  view.setAttribute("aria-busy", "true");
  try {
    if (tab === "shopping") { await loadShopping(); renderShopping(); repairJournal(); afterShoppingLoaded(); }
    else { await loadChores(); state.fromCache = false; renderChores(); }
    setBanner("auth", null); setBanner("proxy", null);
    updateBadges();
  } catch (err) {
    if (state.tab !== tab) return;
    if (err.reload) { go(tab); return; }
    if (isAuthErr(err)) showAuthBanner(err);
    else if (navigator.onLine === false) reflectOnline();
    else showConnBanner(err, () => go(tab));
    const hasSnapshot = tab === "shopping" ? state.shopping.length : state.chores.length;
    if (hasSnapshot) { toast(describeError(err), { bad: true }); }
    else {
      view.innerHTML = `<div class="phead"><h1 class="h1">${esc(title)}</h1></div>
        <section class="card">${emptyHTML(I.warn, isAuthErr(err) ? "Schlüssel wird nicht akzeptiert" : "Grocy antwortet nicht", describeError(err))}
          <details class="help" style="margin:0 16px 12px"><summary>Details</summary><pre class="diag">${esc(`HTTP ${err.status || 0} ${err.detail || ""} ${err.bodyHint || ""}`.trim())}</pre></details>
        </section>
        <div class="btnrow"><button class="btn btn-ghost" id="err-reload">Neu laden</button><button class="btn btn-primary" id="err-settings">Einstellungen</button></div>`;
      $("#err-reload").addEventListener("click", () => go(tab));
      $("#err-settings").addEventListener("click", () => go("settings"));
      renderCta();
    }
  } finally { view.setAttribute("aria-busy", "false"); }
}
async function refresh({ quiet = false } = {}) {
  if (state.running || !CFG.configured || state.tab === "settings" || state.tab === "onboarding") return;
  if (state.busy.size) return;
  const btn = $("#btn-refresh"); if (btn) btn.classList.add("spin");
  const tab = state.tab;
  try {
    if (tab === "shopping") { await loadShopping(); renderShopping(); repairJournal(); afterShoppingLoaded(); }
    else if (tab === "chores") { await loadChores(); state.fromCache = false; renderChores(); }
    updateBadges(); setBanner("auth", null); setBanner("proxy", null); reflectOnline();
  } catch (err) {
    if (isAuthErr(err)) showAuthBanner(err);
    else if (navigator.onLine === false) reflectOnline();
    else showConnBanner(err, () => refresh());
    if (!quiet && !bannerState.auth && !bannerState.proxy) toast(describeError(err), { bad: true });
  } finally { if (btn) btn.classList.remove("spin"); }
}
/* Dauerhafter Hinweis, wenn Grocy/Ämtli nicht antwortet (online, aber kein Erfolg). */
function showConnBanner(err, retry) {
  const grocyGone = err.proxyDown || err.status === 502 || err.status === 503 || err.status === 504 || err.status === 0;
  if (!grocyGone) return;
  const html = err.status === 0 && !err.timeout && ADDON
    ? "<b>Ämtli ist nicht erreichbar.</b> WLAN oder VPN prüfen."
    : "<b>Grocy antwortet nicht.</b> " + (ADDON ? "Läuft das Grocy-Add-on?" : "Adresse und Netzwerk prüfen.");
  setBanner("proxy", { tone: "bad", html, action: { label: "Nochmal", fn: retry } });
}

/* ---------------------------------------------------------------- Events */
const safe = (fn) => (...a) => { try { const r = fn(...a); if (r && typeof r.catch === "function") r.catch(onUncaught); } catch (e) { onUncaught(e); } };
function onViewClick(e) {
  const t = e.target.closest("[data-act]");
  if (!t) return;
  if (t.getAttribute("aria-disabled") === "true" || t.disabled) return;
  const act = t.dataset.act, id = num(t.dataset.id);
  if (act === "toggle") toggleShopping(id);
  else if (act === "adjust") openAdjustSheet(id);
  else if (act === "wizard") openWizard(id);
  else if (act === "remove-only") removeOnly(id);
  else if (act === "recheck") recheck(id);
  else if (act === "undo-last") undoLast();
  else if (act === "putaway-all") putAwayAll();
  else if (act === "sugg-add") suggestionAdd(id);
  else if (act === "sugg-snooze") suggestionSnooze(id);
  else if (act === "chore-done") executeChore(id);
}
function wire() {
  $$(".tab").forEach((tab) => tab.addEventListener("click", safe(() => go(tab.dataset.tab))));
  $("#btn-settings").addEventListener("click", safe(() => go("settings")));
  $("#btn-refresh").addEventListener("click", safe(() => refresh()));
  view.addEventListener("click", safe(onViewClick));
  $("#ctawrap").addEventListener("click", safe(onViewClick));
  $("#toast-act").addEventListener("click", safe(() => { const a = toastAction; hideToast(); if (a) a.fn(); }));
  $("#backdrop").addEventListener("click", closeSheet);
  // Android-Tastatur: fokussiertes Feld im Sheet sichtbar halten.
  $("#sheet").addEventListener("focusin", (e) => { if (e.target.matches("input, select, textarea")) setTimeout(() => { try { e.target.scrollIntoView({ block: "center", behavior: "smooth" }); } catch (_) {} }, 150); });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") stopScan();
    if (document.visibilityState === "visible" && !sheetOpen) refresh({ quiet: true });
  });
  window.addEventListener("offline", reflectOnline);
  window.addEventListener("online", () => { reflectOnline(); refresh({ quiet: true }); });
}
function onUncaught(e) {
  const msg = e && (e.message || (e.reason && e.reason.message)) || String(e);
  DIAG.push({ kind: "js", msg });
  if (!view.children.length || view.textContent.trim() === "") fatal(msg);
  else toast("Etwas ist schiefgelaufen. Falls es bleibt: Seite neu laden.", { bad: true });
}
function fatal(msg) {
  app.classList.remove("no-tabs");
  view.innerHTML = `<div class="phead"><h1 class="h1">Ämtli</h1></div><section class="card">${emptyHTML(I.warn, "Etwas ist schiefgelaufen", msg || "")}</section>
    <div class="btnrow"><button class="btn btn-primary" id="fatal-reload">Neu laden</button><button class="btn btn-ghost" id="fatal-diag">Diagnose kopieren</button></div>`;
  $("#fatal-reload").addEventListener("click", () => location.reload());
  $("#fatal-diag").addEventListener("click", async () => { try { await navigator.clipboard.writeText(DIAG.text()); toast("Diagnose kopiert"); } catch (_) {} });
}
window.addEventListener("error", (ev) => { DIAG.push({ kind: "js", msg: `${ev.message} @${(ev.filename || "").split("/").pop()}:${ev.lineno}` }); if (!view.children.length) fatal(ev.message); });
window.addEventListener("unhandledrejection", (ev) => onUncaught(ev.reason || ev));

/* ---------------------------------------------------------------- Boot */
function registerSW() {
  // Service Worker nur auf stabiler Origin (fester Port/Serve) – nicht unter Ingress.
  if (!("serviceWorker" in navigator) || UNDER_INGRESS) { state.swState = UNDER_INGRESS ? "aus (Ingress)" : "nicht verfügbar"; return; }
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").then((reg) => {
      state.swState = "aktiv";
      reg.addEventListener("updatefound", () => {
        const nw = reg.installing; if (!nw) return;
        nw.addEventListener("statechange", () => {
          if (nw.state === "installed" && navigator.serviceWorker.controller)
            toast("Neue Version von Ämtli verfügbar", { action: { label: "Neu laden", fn: () => location.reload() }, duration: 12000 });
        });
      });
    }).catch((e) => { state.swState = "Fehler: " + String(e); DIAG.push({ kind: "sw", msg: String(e) }); });
  });
}
function boot() {
  applyTheme();
  wire();
  const wanted = new URLSearchParams(location.search).get("tab");
  const start = (wanted === "chores" || wanted === "shopping") ? wanted : "shopping";
  if (!CFG.configured) renderOnboarding();
  else {
    go(start);
    // Nutzer/Version still nachladen (für Einstellungen/Diagnose).
    probe(CFG.key, CFG.url).then(applyProbe).catch(() => {});
  }
  reflectOnline();
  registerSW();
}
try { boot(); window.__aemtliBooted = true; } catch (e) { DIAG.push({ kind: "js", msg: "boot: " + String(e && e.message || e) }); fatal(String(e && e.message || e)); }
