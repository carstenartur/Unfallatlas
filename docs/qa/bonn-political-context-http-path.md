# Bonn: HTTP- und Browservertrag der politischen Recherche

Stand: 30. August 2026

## Produktpfade

Die vollständige Unfallwerkbank-Serverinstallation verwendet weiterhin ausschließlich:

```text
POST /api/political-context/search
```

Der Server orchestriert OParl, die amtliche Portalsuche und dokumentierte Fallbacks.
Dieser Pfad bleibt die maßgebliche Vollrecherche.

GitHub Pages ist dagegen ein statischer Host und kann den POST-Endpunkt nicht
bereitstellen. Ohne ausdrücklich konfiguriertes Backend wird der bekannte
aussichtslose POST dort gar nicht erst gesendet. Die öffentliche Browser-Version
verwendet **nur für Bonn** die amtliche, CORS-fähige OParl-Paper-Sammlung direkt.
Antwortet ein konfigurierter oder sonstiger Serverpfad mit HTTP 404 oder 405,
greift dieselbe Bonn-Teilsuche ebenfalls fail-safe.

Die browserdirekte Suche ist absichtlich begrenzt:

- neueste OParl-Seiten werden rückwärts durchsucht;
- URLs bleiben auf die amtlichen Bonner OParl-/Ratsinformations-Hosts begrenzt;
- Treffer werden als `partial-results` gekennzeichnet;
- jeder Treffer ist für die automatische KI-Übernahme gesperrt, bis die
  politische Vorbefassung vollständig geprüft wurde;
- eine leere begrenzte Suche wird niemals zu `searched-no-results`, sondern
  bricht mit `POLITICAL_CONTEXT_BROWSER_SEARCH_INCOMPLETE` ab;
- für andere Städte erklärt die Oberfläche bei 404/405, dass ein
  Unfallwerkbank-Server erforderlich ist.

## Regressionsevidenz

Vier unabhängige Verträge decken den früheren False-Green-Pfad ab:

1. `politicalContextHttpRoute.test.js` startet den echten Produktionsserver und
   sendet einen realen POST; 404 und 405 sind harte Fehler.
2. `ua.political-context-browser-fallback.test.js` prüft die
   POST-Vermeidung im statischen Profil, 404/405→Bonn-OParl-Umschaltung,
   Hostgrenzen, Teilsuchesemantik und Nullbefundschutz.
3. `political-context-bonn-pages-fallback.spec.js` führt denselben Ablauf in
   Chromium im öffentlichen Pages-Profil aus und beweist, dass kein POST an den
   statischen Host gesendet wird und die amtliche CORS-Antwort genutzt wird.
4. `bonnOparlBrowserCorsLive.test.js` prüft im geplanten Bonn-Live-Workflow,
   dass die amtliche Sammlung die öffentliche Unfallwerkbank-Origin tatsächlich
   per CORS lesen lässt.

Damit kann ein grüner Provider-Test nicht mehr verdecken, dass der reale
HTTP- oder Browserpfad unbenutzbar ist.
