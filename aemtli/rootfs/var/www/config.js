/* Laufzeit-Konfiguration, vom Add-on ausgeliefert.
   proxied:true => die App nutzt den server-seitigen Grocy-Reverse-Proxy des
   Add-ons (relativer Pfad "grocy"); in den Einstellungen genügt der API-Key.
   Für reines Standalone-/Dev-Hosting auf false setzen (dann URL + Key eingeben). */
window.AEMTLI = { proxied: true };
