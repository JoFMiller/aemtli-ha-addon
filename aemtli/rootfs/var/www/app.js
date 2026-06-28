/* =====================================================================
   Ämtli – schlanke PWA für Grocy
   Fokus: Einkaufszettel (eingekauft → einsortiert) + Hausarbeiten (erledigt)

   Zwei Betriebsarten:
   • Add-on-Modus (window.AEMTLI.proxied === true): Grocy wird vom HA-Add-on
     server-seitig unter dem relativen Pfad "grocy" geproxyt. Es genügt der
     persönliche API-Key; die URL ergibt sich aus document.baseURI (funktioniert
     auch unter Ingress). Eine eigene URL kann optional überschrieben werden.
   • Standalone-/Dev-Modus: vollständige Grocy-URL + API-Key in den Einstellungen.
   ===================================================================== */
"use strict";

/* ---------------------------------------------------- Betriebsart (Add-on) */
const ADDON = !!(typeof window !== "undefined" && window.AEMTLI && window.AEMTLI.proxied);
// Über das Add-on proxiet "<aktueller Pfad>/grocy". Relativ zu document.baseURI,
// damit es sowohl am festen Port (Root) als auch unter Ingress passt.
function proxyBase() {
  try { return new URL("grocy", document.baseURI).href.replace(/\/+$/, ""); }
  catch (_) { return "/grocy"; }
}

/* ---------------------------------------------------------------- Config */
const CFG = {
  get url() {
    const stored = (localStorage.getItem("grocy.url") || "").trim().replace(/\/+$/, "");
    if (stored) return stored;
    return ADDON ? proxyBase() : "";
  },
  set url(v)   { localStorage.setItem("grocy.url", (v || "").trim().replace(/\/+$/, "")); },
  get key()    { return (localStorage.getItem("grocy.key") || "").trim(); },
  set key(v)   { localStorage.setItem("grocy.key", (v || "").trim()); },
  get listId() { return Number(localStorage.getItem("grocy.listId") || 1); },
  set listId(v){ localStorage.setItem("grocy.listId", String(Number(v) || 1)); },
  get bookStock() { return localStorage.getItem("grocy.bookStock") !== "0"; }, // default an
  set bookStock(v){ localStorage.setItem("grocy.bookStock", v ? "1" : "0"); },
  // Im Add-on-Modus reicht der Key (URL ist implizit), sonst URL + Key.
  get configured() { return ADDON ? !!this.key : !!(this.url && this.key); },
};

/* ---- persistente Merkliste bereits in den Bestand gebuchter Einkaufszeilen ---
   Verhindert Doppelbuchungen, auch über Reloads hinweg: eine Einkaufszeile, die
   gebucht wurde, deren Löschen aber (noch) scheiterte, bleibt markiert, bis sie
   tatsächlich von der Liste entfernt ist. Pro Einkaufsliste getrennt. */
const BOOKED = {
  _key() { return "grocy.booked." + CFG.listId; },
  _read() { try { return new Set((JSON.parse(localStorage.getItem(this._key()) || "[]") || []).map(Number)); } catch (_) { return new Set(); } },
  _write(s) { localStorage.setItem(this._key(), JSON.stringify([...s])); },
  has(id) { return this._read().has(num(id)); },
  add(id) { const s = this._read(); s.add(num(id)); this._write(s); },
  delete(id) { const s = this._read(); if (s.delete(num(id))) this._write(s); },
  // Nur noch vorhandene Einkaufszeilen behalten (sonst wächst die Liste endlos).
  prune(validIds) {
    const s = this._read(); let changed = false;
    for (const id of [...s]) if (!validIds.has(id)) { s.delete(id); changed = true; }
    if (changed) this._write(s);
  },
};

/* ---------------------------------------------------------------- Icons */
const I = {
  cart:'<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12"/></svg>',
  check:'<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  plus:'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M12 5v14"/></svg>',
  pack:'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg>',
  trash:'<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
  broom:'<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/></svg>',
  leaf:'<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z"/><path d="M2 21c0-3 1.85-5.36 5.08-6"/></svg>',
  warn:'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>',
  undo:'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/></svg>',
};

/* ---------------------------------------------------------------- Utils */
const $  = (sel, root = document) => root.querySelector(sel);
const view = $("#view");

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const fmtNum = (n) => num(n).toLocaleString("de-DE", { maximumFractionDigits: 3 });
const normKey = (s) => String(s == null ? "" : s).trim().normalize("NFC").toLowerCase();

function initials(name) {
  const p = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!p.length) return "?";
  return ((p[0][0] || "") + (p.length > 1 ? p[p.length - 1][0] : "")).toUpperCase();
}

/* Toast ------------------------------------------------------------------ */
let toastTimer = null;
function toast(msg, bad = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.toggle("bad", bad);
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), bad ? 4200 : 2200);
}

/* ---------------------------------------------------------------- API */
class ApiError extends Error {
  constructor(status, detail) {
    super(detail || `HTTP ${status}`);
    this.status = status;
    this.detail = detail;
  }
}

async function api(path, { method = "GET", body } = {}) {
  if (!CFG.configured) throw new ApiError(0, "Nicht konfiguriert");
  let res;
  try {
    res = await fetch(CFG.url + path, {
      method,
      headers: {
        "GROCY-API-KEY": CFG.key,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      mode: "cors",
      cache: "no-store",
    });
  } catch (e) {
    throw new ApiError(0, "Netzwerk-/Verbindungsfehler"); // CORS, offline, falsche URL
  }
  if (!res.ok) {
    let detail = "";
    try { const j = await res.json(); detail = j.error_message || j.message || ""; } catch (_) {}
    throw new ApiError(res.status, detail);
  }
  if (res.status === 204) return null;
  const txt = await res.text();
  return txt ? JSON.parse(txt) : null;
}

/* ---------------------------------------------------------------- State */
const state = {
  tab: "shopping",
  // Stammdaten-Caches
  products: new Map(),   // id -> {id, name, qu_id_purchase}
  units: new Map(),      // id -> {name, name_plural}
  productNames: [],       // [{id, name, key}] für Autovervollständigung/Match
  // Daten
  shopping: [],
  chores: [],
  loaded: { masters: false },
  busy: new Set(),        // ids, die gerade eine Aktion ausführen
};

function setConn(kind, html) {
  const c = $("#conn");
  if (!kind) { c.className = "conn"; c.innerHTML = ""; return; }
  c.className = "conn show " + kind;
  c.innerHTML = html;
}

// Persistentes Offline-Banner, sobald das Gerät offline ist.
function reflectOnline() {
  if (!navigator.onLine)
    setConn("warn", `<span>${I.warn}</span><span><b>Offline</b> – Änderungen sind gerade nicht möglich.</span>`);
}

function describeError(e) {
  if (e instanceof ApiError) {
    if (e.status === 0) return navigator.onLine
      ? "Keine/blockierte Verbindung zu Grocy. URL, Netzwerk oder CORS prüfen."
      : "Du bist offline – Änderungen sind gerade nicht möglich.";
    if (e.status === 401 || e.status === 403) return "API-Key ungültig oder abgelaufen.";
    if (e.status === 404) return "Endpunkt oder Liste nicht gefunden – URL und gewählte Liste prüfen.";
    return `Grocy-Fehler ${e.status}${e.detail ? ": " + e.detail : ""}`;
  }
  return "Unerwarteter Fehler.";
}

/* --------------------------------------------------- Stammdaten laden */
async function loadMasters(force = false) {
  if (state.loaded.masters && !force) return;
  const [products, units] = await Promise.all([
    api("/api/objects/products"),
    api("/api/objects/quantity_units"),
  ]);
  state.products.clear();
  state.productNames = [];
  for (const p of products || []) {
    if (String(p.active) === "0") continue;
    const rec = { id: num(p.id), name: p.name, qu_id_purchase: p.qu_id_purchase != null ? num(p.qu_id_purchase) : null };
    state.products.set(rec.id, rec);
    state.productNames.push({ id: rec.id, name: p.name, key: normKey(p.name) });
  }
  state.units.clear();
  for (const u of units || []) {
    state.units.set(num(u.id), { name: u.name, name_plural: u.name_plural || u.name });
  }
  state.loaded.masters = true;
}

function unitLabel(quId, amount) {
  const u = state.units.get(num(quId));
  if (!u) return "";
  return num(amount) === 1 ? u.name : (u.name_plural || u.name);
}

/* ====================================================================== */
/*  EINKAUF                                                               */
/* ====================================================================== */
// Eine Sortier-Reihenfolge für alle Renders -> kein Drift nach Toggle.
const shoppingCmp = (a, b) => (a.done - b.done) || a.name.localeCompare(b.name, "de");

async function loadShopping() {
  await loadMasters();
  const items = await api(`/api/objects/shopping_list?query%5B%5D=shopping_list_id%3D${CFG.listId}`);
  const lid = CFG.listId;
  state.shopping = (items || [])
    // Defensiv: falls der Server-Filter ignoriert würde, keine Fremdlisten zeigen.
    .filter((it) => it.shopping_list_id == null || num(it.shopping_list_id) === lid)
    .map((it) => {
      const pid = it.product_id != null && it.product_id !== "" ? num(it.product_id) : null;
      const prod = pid != null ? state.products.get(pid) : null;
      const quId = it.qu_id != null && it.qu_id !== "" ? num(it.qu_id)
                 : (prod && prod.qu_id_purchase != null ? prod.qu_id_purchase : null);
      return {
        id: num(it.id),
        productId: pid,
        name: prod ? prod.name : (it.note || "(ohne Namen)"),
        isProduct: pid != null,
        amount: num(it.amount) || 1,
        quId,
        done: String(it.done) === "1",
        stockBooked: false,
        raw: it,
      };
    });
  // Buchungs-Merkliste auf vorhandene Zeilen eindampfen + Flag wiederherstellen.
  const present = new Set(state.shopping.map((s) => s.id));
  BOOKED.prune(present);
  for (const it of state.shopping) it.stockBooked = BOOKED.has(it.id);
  state.shopping.sort(shoppingCmp);
}

function shoppingItemHTML(it) {
  const busy = state.busy.has("s" + it.id);
  const unit = it.quId ? " " + esc(unitLabel(it.quId, it.amount)) : "";
  const amt = `${fmtNum(it.amount)}${unit}`;
  return `
    <button class="row ${it.done ? "done" : ""}" data-act="toggle" data-id="${it.id}" ${busy ? "disabled" : ""}
            role="checkbox" aria-checked="${it.done}" aria-label="${esc(it.name)} – ${it.done ? "eingekauft" : "noch zu kaufen"}">
      <span class="checkbox ${it.done ? "on" : ""}" aria-hidden="true">${it.done ? I.check : ""}</span>
      <span class="body">
        <span class="nm">${esc(it.name)}
          <span class="tag ${it.isProduct ? "prod" : "note"}">${it.isProduct ? "Produkt" : "Notiz"}</span>
        </span>
        <span class="amt">${amt}</span>
      </span>
    </button>`;
}

function doneItemHTML(it) {
  const busy = state.busy.has("s" + it.id);
  return `
    <div class="row done">
      <button class="checkbox on iconmini" style="border:none;background:none;padding:0;width:23px;height:23px" data-act="toggle" data-id="${it.id}"
              aria-label="${esc(it.name)} wieder als offen markieren" title="Wieder offen" ${busy ? "disabled" : ""}>${I.check}</button>
      <span class="body"><span class="nm">${esc(it.name)}</span></span>
      <span class="rowact">
        <button class="minibtn sprout" data-act="putaway" data-id="${it.id}" ${busy ? "disabled" : ""}>${I.pack}<span>Einsortiert</span></button>
      </span>
    </div>`;
}

function renderShopping() {
  state.shopping.sort(shoppingCmp);            // jede Render-Konsistenz garantieren
  const open = state.shopping.filter((s) => !s.done);
  const done = state.shopping.filter((s) => s.done);

  const list = (arr, builder) => arr.map(builder).join("");

  view.innerHTML = `
    <div class="phead">
      <h1 class="h1">Einkauf</h1>
      <p class="sub">${open.length} zu kaufen${done.length ? ` · ${done.length} im Wagen` : ""}</p>
    </div>

    <form class="addbar card" id="add-form" autocomplete="off">
      <span style="color:var(--sage);display:grid;place-items:center">${I.plus}</span>
      <input type="text" id="add-input" list="prod-list" placeholder="Etwas auf die Liste setzen…" aria-label="Artikel hinzufügen" />
      <datalist id="prod-list">${state.productNames.map((p) => `<option value="${esc(p.name)}"></option>`).join("")}</datalist>
      <input type="number" id="add-qty" class="qtybox" value="1" min="0.001" step="any" inputmode="decimal" aria-label="Menge" />
      <button class="btn btn-primary" type="submit" aria-label="Hinzufügen">${I.plus}</button>
    </form>

    <section class="card">
      <div class="card-head">
        <span class="sect">Zu kaufen <span class="pill">${open.length}</span></span>
      </div>
      ${open.length ? list(open, shoppingItemHTML) : emptyHTML(I.leaf, "Liste ist leer", "Schreib oben den nächsten Artikel rein.")}
    </section>

    ${done.length ? `
    <section class="card">
      <div class="card-head">
        <span class="sect">Eingekauft <span class="pill">${done.length}</span></span>
        <button class="linkbtn" data-act="putaway-all">${I.pack} Alles einsortieren</button>
      </div>
      ${list(done, doneItemHTML)}
    </section>` : ""}
  `;

  const form = $("#add-form");
  if (form) form.addEventListener("submit", onAddSubmit);
}

async function onAddSubmit(e) {
  e.preventDefault();
  const input = $("#add-input");
  const qtyEl = $("#add-qty");
  const name = (input.value || "").trim();
  if (!name) return;
  let amount = num(qtyEl.value);
  if (amount <= 0) amount = 1;

  // Produktnamen exakt (getrimmt/NFC/case-insensitiv) matchen → ermöglicht Bestandsbuchung.
  // Nur bei EINDEUTIGEM Treffer als Produkt anlegen; sonst als freie Notiz (kein
  // Raten bei mehrdeutigen Namen -> keine falsche Bestandszuordnung).
  const k = normKey(name);
  const matches = state.productNames.filter((p) => p.key === k);
  const match = matches.length === 1 ? matches[0] : null;

  const body = match
    ? { shopping_list_id: CFG.listId, product_id: match.id, amount }
    : { shopping_list_id: CFG.listId, note: name, amount };

  input.value = ""; qtyEl.value = "1"; input.focus();
  try {
    await api("/api/objects/shopping_list", { method: "POST", body });
    await loadShopping();
    if (state.tab === "shopping") renderShopping();
    updateBadges();
    toast(match ? `„${name}" (Produkt) ergänzt` : `„${name}" ergänzt`);
  } catch (err) {
    toast(describeError(err), true);
  }
}

async function toggleShopping(id) {
  if (state.busy.has("s" + id)) return;            // Doppelklick-Schutz
  const it = state.shopping.find((s) => s.id === id);
  if (!it) return;
  const next = !it.done;
  it.done = next;                  // optimistisch
  state.busy.add("s" + id);
  if (state.tab === "shopping") renderShopping();
  updateBadges();
  try {
    await api(`/api/objects/shopping_list/${id}`, { method: "PUT", body: { done: next ? 1 : 0 } });
  } catch (err) {
    const cur = state.shopping.find((s) => s.id === id);  // ggf. nach Reload neu suchen
    if (cur) cur.done = !next;     // zurückrollen
    toast(describeError(err), true);
  } finally {
    state.busy.delete("s" + id);
    if (state.tab === "shopping") renderShopping();   // nur rendern, wenn Tab noch aktiv
    updateBadges();
  }
}

// Bucht eine Kaufmenge in den Bestand. Manche Produkte verlangen ein MHD →
// nur DANN (Grocy-Validierungsfehler 400) mit Sentinel „läuft nicht ab" erneut
// versuchen. Bei Netzwerk-/Auth-Fehlern NICHT wiederholen (sonst Doppelbuchung).
async function bookPurchase(productId, amount) {
  const amt = Math.max(num(amount) || 1, 0.001);
  try {
    await api(`/api/stock/products/${productId}/add`, {
      method: "POST", body: { amount: amt, transaction_type: "purchase" },
    });
  } catch (e) {
    if (e instanceof ApiError && e.status === 400) {
      await api(`/api/stock/products/${productId}/add`, {
        method: "POST", body: { amount: amt, transaction_type: "purchase", best_before_date: "2999-12-31" },
      });
    } else {
      throw e;
    }
  }
}

// "Einsortieren": Produkt ggf. in den Bestand buchen (purchase) + von der Liste entfernen.
async function putAway(id, { silent = false } = {}) {
  if (state.busy.has("s" + id)) return { ok: false };       // Doppel-Tap-/Bulk-Schutz
  const it = state.shopping.find((s) => s.id === id);
  if (!it) return { ok: false };
  state.busy.add("s" + id);
  if (!silent && state.tab === "shopping") renderShopping();

  let stockWarned = false;
  try {
    if (it.isProduct && it.productId != null && CFG.bookStock && !it.stockBooked && !BOOKED.has(it.id)) {
      try {
        await bookPurchase(it.productId, it.amount);
        it.stockBooked = true;
        BOOKED.add(it.id);         // persistiert -> kein erneutes Buchen nach Reload
      } catch (stockErr) {
        if (stockErr instanceof ApiError && stockErr.status === 0) {
          // Netzwerkfehler: Buchung könnte serverseitig doch durchgelaufen sein →
          // NICHT löschen, sonst geht der Bezug verloren. Klar melden, Abbruch.
          if (!silent) {
            if (state.tab === "shopping") renderShopping();
            toast(`„${it.name}": Bestandsbuchung unklar (Verbindung) – bitte später in Grocy prüfen.`, true);
          }
          return { ok: false, error: stockErr };
        }
        stockWarned = true;        // z.B. Produkt inaktiv → trotzdem von Liste nehmen
      }
    }
    await api(`/api/objects/shopping_list/${id}`, { method: "DELETE" });
    BOOKED.delete(it.id);          // erfolgreich entfernt → Guard aufräumen
    state.shopping = state.shopping.filter((s) => s.id !== id);
    if (!silent) {
      if (state.tab === "shopping") renderShopping();
      updateBadges();
      if (stockWarned) toast(`„${it.name}" von der Liste – Bestand nicht gebucht (in Grocy prüfen)`, true);
      else toast(it.isProduct && CFG.bookStock ? `„${it.name}" eingeräumt & im Bestand` : `„${it.name}" eingeräumt`);
    }
    return { ok: true, stockWarned };
  } catch (err) {
    if (!silent) {
      if (state.tab === "shopping") renderShopping();
      // Buchung war schon erfolgt, nur das Entfernen schlug fehl → eindeutig melden.
      if (it.stockBooked || BOOKED.has(it.id))
        toast(`„${it.name}" ist im Bestand gebucht, aber das Entfernen von der Liste schlug fehl – bitte erneut „Einsortiert" tippen.`, true);
      else
        toast(describeError(err), true);
    }
    return { ok: false, error: err };
  } finally {
    state.busy.delete("s" + id);
  }
}

async function putAwayAll() {
  const done = state.shopping.filter((s) => s.done);
  if (!done.length) return;
  let okCount = 0, warned = 0, failed = 0;
  for (const it of done) {
    if (!state.shopping.find((s) => s.id === it.id)) continue;   // zwischenzeitlich entfernt
    const r = await putAway(it.id, { silent: true });
    if (r.ok) { okCount++; if (r.stockWarned) warned++; } else failed++;
  }
  if (state.tab === "shopping") renderShopping();
  updateBadges();
  if (failed) toast(`${okCount} eingeräumt, ${failed} fehlgeschlagen`, true);
  else if (warned) toast(`${okCount} eingeräumt, ${warned}× Bestand nicht gebucht`, true);
  else toast(`${okCount} eingeräumt`);
}

/* ====================================================================== */
/*  AUFGABEN (Chores)                                                     */
/* ====================================================================== */
function parseGrocyDate(s) {
  if (!s) return null;
  const str = String(s).trim();
  // Reines Datum (YYYY-MM-DD) als LOKALE Mitternacht interpretieren – nicht als
  // UTC (das täte JS bei reinem ISO-Datum und verschiebt den Tag in -TZ).
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
              : new Date(str.replace(" ", "T"));
  return isNaN(d.getTime()) ? null : d;
}
const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };

function dueInfo(s) {
  const d = parseGrocyDate(s);
  if (!d || d.getFullYear() >= 2999)        // 2999-Sentinel oder ungültiges Datum = kein fester Termin
    return { status: "manual", label: "Kein fester Termin", days: Infinity };
  const diff = Math.round((startOfDay(d) - startOfDay(new Date())) / 86400000);
  let label;
  if (diff < 0) label = diff === -1 ? "seit gestern fällig" : `seit ${Math.abs(diff)} Tagen fällig`;
  else if (diff === 0) label = "heute fällig";
  else if (diff === 1) label = "morgen fällig";
  else label = `in ${diff} Tagen fällig`;
  const status = diff < 0 ? "expired" : diff <= 1 ? "soon" : "fresh";
  return { status, label, days: diff };
}

async function loadChores() {
  const data = await api("/api/chores");
  state.chores = (data || []).map((c) => {
    const u = c.next_execution_assigned_user;
    return {
      choreId: num(c.chore_id),
      name: c.chore_name || "(Aufgabe)",
      next: c.next_estimated_execution_time,
      assignedName: u && (u.display_name || u.username) ? (u.display_name || u.username) : null,
      due: dueInfo(c.next_estimated_execution_time),
    };
  });
  // Terminlose Chores (days = Infinity) ans Ende; nie NaN im Comparator.
  const dayKey = (c) => Number.isFinite(c.due.days) ? c.due.days : Number.MAX_SAFE_INTEGER;
  state.chores.sort((a, b) => dayKey(a) - dayKey(b) || a.name.localeCompare(b.name, "de"));
}

function choreColor(status) {
  return status === "expired" ? "var(--chili)" : status === "soon" ? "var(--zest)" : status === "manual" ? "var(--sage)" : "var(--sprout)";
}

function choreRowHTML(c) {
  const busy = state.busy.has("c" + c.choreId);
  const col = choreColor(c.due.status);
  return `
    <div class="row" style="cursor:default">
      <span class="cstat" style="background:${col}"></span>
      <span class="body">
        <span class="nm">${esc(c.name)}</span>
        <span class="chmeta">
          <span class="due" style="color:${col}">${esc(c.due.label)}</span>
          ${c.assignedName ? `<span class="who"><span class="avatar">${esc(initials(c.assignedName))}</span>${esc(c.assignedName)}</span>` : ""}
        </span>
      </span>
      <span class="rowact">
        <button class="minibtn sprout" data-act="chore-done" data-id="${c.choreId}" ${busy ? "disabled" : ""}>${I.check}<span>Erledigt</span></button>
      </span>
    </div>`;
}

function renderChores() {
  const overdue = state.chores.filter((c) => c.due.status === "expired").length;
  view.innerHTML = `
    <div class="phead">
      <h1 class="h1">Aufgaben</h1>
      <p class="sub">${state.chores.length} wiederkehrend${overdue ? ` · ${overdue} überfällig` : ""}</p>
    </div>
    <section class="card">
      <div class="card-head"><span class="sect">${I.broom} Hausarbeiten</span></div>
      ${state.chores.length
        ? state.chores.map(choreRowHTML).join("")
        : emptyHTML(I.broom, "Keine Aufgaben", "In Grocy sind keine Hausarbeiten angelegt.")}
    </section>`;
}

async function executeChore(choreId) {
  if (state.busy.has("c" + choreId)) return;        // Doppelklick-Schutz (verhindert Doppel-Execution)
  const c = state.chores.find((x) => x.choreId === choreId);
  if (!c) return;
  state.busy.add("c" + choreId);
  if (state.tab === "chores") renderChores();
  let executed = false;
  try {
    await api(`/api/chores/${choreId}/execute`, { method: "POST", body: {} });
    executed = true;
    toast(`„${c.name}" erledigt`);
    await loadChores();
  } catch (err) {
    if (executed) {
      // Execute lief, nur das Nachladen scheiterte → Aufgabe optimistisch entschärfen,
      // damit sie nicht weiter überfällig wirkt und nicht doppelt erledigt wird.
      c.due = { status: "manual", label: "gerade erledigt", days: Infinity };
    } else {
      toast(describeError(err), true);
    }
  } finally {
    state.busy.delete("c" + choreId);
    if (state.tab === "chores") renderChores();   // nur rendern, wenn Tab noch aktiv
    updateBadges();
  }
}

/* ====================================================================== */
/*  EINSTELLUNGEN                                                          */
/* ====================================================================== */
function renderSettings() {
  state.tab = "settings";
  setActiveTab(null);

  // Im Add-on-Modus wird Grocy server-seitig geproxyt: nur der persönliche
  // API-Key wird gebraucht. Eine eigene URL ist optional (Erweitert).
  const urlField = ADDON ? `
      <details class="help" style="margin:0">
        <summary>Erweitert: eigene Grocy-Adresse</summary>
        <div class="field" style="border:none;padding:12px 2px 2px">
          <input type="url" id="set-url" placeholder="leer lassen = über das Add-on" value="${esc(localStorage.getItem("grocy.url") || "")}" inputmode="url" autocapitalize="off" spellcheck="false" />
          <span class="hint">Normalerweise leer lassen – das Add-on erreicht Grocy intern. Nur ausfüllen, um direkt eine andere Grocy-Instanz anzusprechen.</span>
        </div>
      </details>` : `
      <div class="field">
        <label for="set-url">Grocy-Adresse</label>
        <input type="url" id="set-url" placeholder="https://grocy.mein-zuhause.de" value="${esc(CFG.url)}" inputmode="url" autocapitalize="off" spellcheck="false" />
        <span class="hint">Die URL, unter der ihr Grocy erreicht – ohne <code>/api</code> am Ende.</span>
      </div>`;

  view.innerHTML = `
    <div class="phead">
      <h1 class="h1">Einstellungen</h1>
      <p class="sub">${ADDON ? "Dein persönlicher Grocy-Zugang" : "Verbindung zu deinem Grocy"}</p>
    </div>
    <section class="card">
      <div class="field">
        <label for="set-key">Dein API-Key</label>
        <input type="password" id="set-key" placeholder="Langer Schlüssel aus Grocy" value="${esc(CFG.key)}" autocapitalize="off" spellcheck="false" />
        <span class="hint">In Grocy unter <b>„Manage API keys"</b> erstellen – am besten ein eigener pro Person. Der Key bleibt nur auf diesem Gerät; bei Verlust in Grocy widerrufen.</span>
      </div>
      <div class="field" style="${ADDON ? "padding-top:0" : ""}">
        ${urlField}
      </div>
      <div class="field">
        <label for="set-list">Einkaufsliste</label>
        <div class="row-inline">
          <select id="set-list"><option value="${CFG.listId}">Liste ${CFG.listId}</option></select>
        </div>
        <span class="hint">Wird nach erfolgreichem Test automatisch befüllt.</span>
      </div>
      <div class="field">
        <label class="row-inline" style="cursor:pointer">
          <input type="checkbox" id="set-book" ${CFG.bookStock ? "checked" : ""} style="width:auto" />
          <span>Beim Einsortieren Produkte in den Grocy-Bestand buchen</span>
        </label>
        <span class="hint">Empfohlen, damit der Bestand stimmt. Wirkt nur bei Einträgen, die mit einem Grocy-Produkt verknüpft sind (nicht bei freien Notizen).</span>
      </div>
    </section>

    <div class="testline">
      <button class="btn btn-primary" id="set-test">Verbindung testen & speichern</button>
      <span id="set-status"></span>
    </div>

    <details class="help">
      <summary>Wie komme ich an den API-Key?</summary>
      <ol>
        <li>In Grocy oben rechts auf das Benutzer-Menü → <b>„Manage API keys"</b> (direkt: <code>DEINE-GROCY-URL/manageapikeys</code>).</li>
        <li>Auf <b>„Add"</b> klicken – Grocy erzeugt einen langen Schlüssel.</li>
        <li>Schlüssel kopieren und hier oben einfügen.</li>
        <li>„Verbindung testen" – fertig. Der Schlüssel bleibt nur auf diesem Gerät.</li>
      </ol>
    </details>

    <details class="help">
      <summary>Als App installieren</summary>
      <ol>
        <li><b>Android/Chrome:</b> Menü (⋮) → „App installieren" / „Zum Startbildschirm".</li>
        <li><b>iPhone/Safari:</b> Teilen-Symbol → „Zum Home-Bildschirm".</li>
        <li>Hinweis: Installieren geht nur über die <b>HTTPS-Adresse</b> (fester Port), nicht über die Home-Assistant-Seitenleiste.</li>
      </ol>
    </details>
  `;

  $("#set-test").addEventListener("click", testConnection);
}

async function testConnection() {
  const urlInput = $("#set-url");
  const url = urlInput ? urlInput.value.trim().replace(/\/+$/, "") : "";
  const key = $("#set-key").value.trim();
  const status = $("#set-status");
  if (!key || (!ADDON && !url)) {
    status.innerHTML = `<span class="err">${ADDON ? "API-Key ausfüllen." : "URL und API-Key ausfüllen."}</span>`;
    return;
  }

  CFG.url = url;             // im Add-on-Modus ggf. leer → Getter nutzt den Proxy-Pfad
  CFG.key = key;
  CFG.bookStock = $("#set-book").checked;
  status.innerHTML = `<span class="muted">Teste…</span>`;
  try {
    const lists = await api("/api/objects/shopping_lists");
    const sel = $("#set-list");
    const arr = (lists || []);
    if (arr.length) {
      sel.disabled = false;
      sel.innerHTML = arr.map((l) => `<option value="${num(l.id)}" ${num(l.id) === CFG.listId ? "selected" : ""}>${esc(l.name || ("Liste " + l.id))}</option>`).join("");
      sel.onchange = () => { CFG.listId = num(sel.value); };
      if (!arr.some((l) => num(l.id) === CFG.listId)) CFG.listId = num(arr[0].id);
      status.innerHTML = `<span class="ok">✓ Verbunden – ${arr.length} Liste(n) gefunden.</span>`;
      state.loaded.masters = false;
      setConn(null);
      toast("Verbindung gespeichert");
      setTimeout(() => { go("shopping"); }, 700);
    } else {
      // Verbunden, aber keine Einkaufsliste → nicht weiterleiten, klar hinweisen.
      sel.innerHTML = `<option>– keine Liste gefunden –</option>`;
      sel.disabled = true;
      status.innerHTML = `<span class="err">✓ Verbunden, aber keine Einkaufsliste gefunden. Lege in Grocy eine Liste an und teste erneut.</span>`;
    }
  } catch (err) {
    status.innerHTML = `<span class="err">✗ ${esc(describeError(err))}</span>`;
  }
}

/* ====================================================================== */
/*  Shared render bits                                                    */
/* ====================================================================== */
function emptyHTML(icon, title, sub) {
  return `<div class="empty"><span class="ic">${icon}</span><div class="t">${esc(title)}</div><div class="s">${esc(sub)}</div></div>`;
}

function skeletonHTML(rows = 4) {
  let s = "";
  for (let i = 0; i < rows; i++) {
    s += `<div class="skeleton"><div class="sk-dot sk-anim"></div><div style="flex:1"><div class="sk-line sk-anim" style="width:${50 + (i * 13) % 35}%"></div><div class="sk-line sk-anim" style="width:30%;margin-top:7px;height:9px"></div></div></div>`;
  }
  return `<div class="phead"><h1 class="h1">${state.tab === "chores" ? "Aufgaben" : "Einkauf"}</h1><p class="sub">lädt…</p></div><section class="card">${s}</section>`;
}

/* ---------------------------------------------------------------- Badges */
function updateBadges() {
  const open = state.shopping.filter((s) => !s.done).length;
  const overdue = state.chores.filter((c) => c.due.status === "expired").length;
  const setBadge = (id, n) => {
    const b = $("#" + id);
    if (!b) return;
    if (n > 0) { b.textContent = n; b.hidden = false; } else { b.hidden = true; }
  };
  setBadge("badge-shopping", open);
  setBadge("badge-chores", overdue);
}

function setActiveTab(tab) {
  document.querySelectorAll(".tab").forEach((t) =>
    t.classList.toggle("active", t.dataset.tab === tab));
}

/* ---------------------------------------------------------------- Router */
async function go(tab) {
  if (!CFG.configured && tab !== "settings") { renderSettings(); return; }
  state.tab = tab;
  setActiveTab(tab);

  if (tab === "settings") { renderSettings(); return; }

  view.innerHTML = skeletonHTML();
  view.setAttribute("aria-busy", "true");
  try {
    if (tab === "shopping") { await loadShopping(); if (state.tab === "shopping") renderShopping(); }
    else if (tab === "chores") { await loadChores(); if (state.tab === "chores") renderChores(); }
    setConn(null);
    updateBadges();
  } catch (err) {
    if (state.tab !== tab) return;       // Tab inzwischen gewechselt → Ergebnis verwerfen
    view.innerHTML = `<div class="phead"><h1 class="h1">${tab === "chores" ? "Aufgaben" : "Einkauf"}</h1></div>` +
      `<section class="card">${emptyHTML(I.warn, "Keine Verbindung", describeError(err))}</section>` +
      `<div style="text-align:center;margin-top:16px"><button class="btn btn-ghost" id="err-reload">Neu laden</button> <button class="btn btn-primary" id="err-settings">Einstellungen</button></div>`;
    const rb = $("#err-reload"); if (rb) rb.addEventListener("click", () => go(tab));
    const b = $("#err-settings"); if (b) b.addEventListener("click", () => go("settings"));
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
      setConn("bad", `<span>${I.warn}</span><span><b>API-Key ungültig.</b></span><button class="linkbtn conn-act" id="conn-set">Einstellungen</button>`);
      const cb = $("#conn-set"); if (cb) cb.addEventListener("click", () => go("settings"));
    } else {
      reflectOnline();
    }
  } finally {
    view.setAttribute("aria-busy", "false");
  }
}

async function refresh() {
  if (state.busy.size) return;            // keine Reloads während laufender Aktionen (Race-Schutz)
  const btn = $("#btn-refresh");
  if (btn) btn.classList.add("spin");
  const tab = state.tab;
  try {
    if (tab === "shopping") { await loadShopping(); if (state.tab === "shopping") renderShopping(); }
    else if (tab === "chores") { await loadChores(); if (state.tab === "chores") renderChores(); }
    updateBadges(); setConn(null);
  } catch (err) {
    toast(describeError(err), true);
    reflectOnline();
  } finally {
    if (btn) btn.classList.remove("spin");
  }
}

/* ---------------------------------------------------------------- Events */
function onViewClick(e) {
  const t = e.target.closest("[data-act]");
  if (!t) return;
  const act = t.dataset.act;
  const id = num(t.dataset.id);
  if (act === "toggle") toggleShopping(id);
  else if (act === "putaway") putAway(id);
  else if (act === "putaway-all") putAwayAll();
  else if (act === "chore-done") executeChore(id);
}

function wire() {
  document.querySelectorAll(".tab").forEach((tab) =>
    tab.addEventListener("click", () => go(tab.dataset.tab)));
  $("#btn-settings").addEventListener("click", () => go("settings"));
  $("#btn-refresh").addEventListener("click", refresh);
  view.addEventListener("click", onViewClick);

  // Beim Zurückkehren in die App / Tab-Fokus leise aktualisieren
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && CFG.configured && state.tab !== "settings") refresh();
  });

  // Offline-/Online-Status sichtbar machen
  window.addEventListener("offline", reflectOnline);
  window.addEventListener("online", () => {
    setConn(null);
    if (CFG.configured && state.tab !== "settings") refresh();
  });
}

/* ---------------------------------------------------------------- Boot */
function boot() {
  wire();
  const wanted = new URLSearchParams(location.search).get("tab");
  const start = (wanted === "chores" || wanted === "shopping") ? wanted : "shopping";
  if (!CFG.configured) { renderSettings(); }
  else { go(start); }
  reflectOnline();

  // Service Worker nur auf stabiler Origin (fester Port) – nicht unter Ingress
  // (rotierender Token-Pfad macht SW/PWA-Install unzuverlässig).
  const underIngress = location.pathname.includes("/api/hassio_ingress/");
  if ("serviceWorker" in navigator && !underIngress) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch(() => {/* PWA optional */});
    });
  }
}
boot();
