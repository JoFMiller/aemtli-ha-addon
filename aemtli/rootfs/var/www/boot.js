/* Läuft vor dem ersten Paint (im <head>, extern wegen Content-Security-Policy).
   1) Theme-Wahl aus localStorage auf <html data-theme> legen – ohne Flackern.
   2) Trailing-Slash-Schutz: Ämtli verlinkt alles relativ ("app.js", "grocy/…").
      Wird die App unter einem Pfad OHNE Schluss-Slash geöffnet (z. B. …/aemtli),
      lösen relative URLs eine Ebene zu hoch auf. Dann einmalig auf …/aemtli/ umleiten. */
(function () {
  try {
    var t = localStorage.getItem("aemtli.theme");
    if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
  } catch (_) { /* Speicher gesperrt – Systemeinstellung gilt */ }

  var p = location.pathname;
  if (p && !/\/$/.test(p) && !/\.[a-z0-9]{1,5}$/i.test(p)) {
    location.replace(p + "/" + location.search + location.hash);
  }
})();
