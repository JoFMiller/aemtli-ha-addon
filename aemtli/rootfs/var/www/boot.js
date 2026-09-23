/* Läuft vor dem ersten Paint (im <head>, extern wegen Content-Security-Policy).
   1) Theme-Wahl aus localStorage auf <html data-theme> legen – ohne Flackern.
   2) Trailing-Slash-Schutz: Ämtli verlinkt alles relativ ("app.js", "grocy/…").
      Wird die App unter einem Pfad OHNE Schluss-Slash geöffnet (z. B. …/aemtli),
      lösen relative URLs eine Ebene zu hoch auf. Dann einmalig auf …/aemtli/ umleiten.
   3) Start-Wächter: Hat app.js nach dem Laden nichts gerendert, zeigt die Seite selbst,
      was schiefging (Skript nicht ausgeführt, Fehler, CSP) – ohne Entwicklerwerkzeuge. */
(function () {
  try {
    var t = localStorage.getItem("aemtli.theme");
    if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
  } catch (_) { /* Speicher gesperrt – Systemeinstellung gilt */ }

  var p = location.pathname;
  if (p && !/\/$/.test(p) && !/\.[a-z0-9]{1,5}$/i.test(p)) {
    location.replace(p + "/" + location.search + location.hash);
    return;
  }

  var errs = [];
  window.__aemtliBootErrors = errs;
  window.addEventListener("error", function (ev) {
    var f = String(ev.filename || "").split("/").pop();
    errs.push((ev.message || "Fehler") + (f ? " @" + f + ":" + ev.lineno : ""));
  });
  document.addEventListener("securitypolicyviolation", function (ev) {
    errs.push("CSP blockiert " + ev.violatedDirective + ": " + (ev.blockedURI || "?"));
  });

  function line(parent, text, strong) {
    var el = document.createElement(strong ? "div" : "p");
    el.textContent = text;
    el.style.cssText = strong ? "font-weight:700;font-size:1.0625rem;margin:0 0 6px" : "margin:4px 0;font-size:.9375rem;word-break:break-word";
    parent.appendChild(el);
  }
  function check() {
    if (window.__aemtliBooted) return;
    var v = document.getElementById("view");
    if (!v || v.querySelector(".card, .onb, .phead")) return;     // App hat gerendert
    var box = document.createElement("section");
    box.className = "card";
    box.style.cssText = "margin:14px;padding:16px";
    line(box, "Ämtli konnte nicht starten", true);
    line(box, window.AEMTLI ? "config.js geladen (Version " + (window.AEMTLI.version || "?") + ")" : "config.js wurde nicht geladen");
    line(box, window.__aemtliLoaded ? "app.js geladen, aber der Start brach ab" : "app.js wurde nicht ausgeführt");
    if (errs.length) line(box, "Fehler: " + errs.join(" | "));
    line(box, "Browser: " + navigator.userAgent);
    line(box, "Bitte diesen Text abfotografieren oder kopieren und schicken.");
    var btn = document.createElement("button");
    btn.className = "btn btn-primary";
    btn.textContent = "Neu laden";
    btn.style.marginTop = "10px";
    btn.addEventListener("click", function () { location.reload(); });
    box.appendChild(btn);
    v.innerHTML = "";
    v.appendChild(box);
  }
  window.addEventListener("load", function () { setTimeout(check, 2500); });
  setTimeout(check, 6000);                                          // falls "load" nie feuert
})();
