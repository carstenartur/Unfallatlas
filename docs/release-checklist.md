# Release-Checklist – Unfallwerkbank

Vor jedem Release sollten die folgenden Smoke-Tests in **allen vier
Betriebsarten** erfolgreich durchlaufen werden.  Die Prüfungen sind bewusst
manuell und kurz – sie ergänzen die automatisierte Test-Suite (`npm test`,
`npm run test:e2e`) und stellen sicher, dass jede unterstützte Variante real
funktioniert.

> Übersicht der Betriebsarten: siehe README → *Betriebsarten / Betriebs-Matrix*.

---

## 1. Browser-only (GitHub Pages oder lokal über `file://`)

- [ ] `werkbank_v2.html` öffnet, Karte und Stadtauswahl erscheinen
- [ ] Stadt wechseln (z. B. Bonn → Hannover) funktioniert
- [ ] Filter (Beteiligung, Schwere, Uhrzeit, Wochentag) wirken
- [ ] Cluster, Heatmap und Hotspot-Anzeige aktivierbar
- [ ] Bereichsauswahl per Rechteck funktioniert
- [ ] PDF- und Word-Export wird erzeugt (deterministisch, ohne Server)
- [ ] CSV-, GeoJSON- und KML-Download liefern eine valide Datei
- [ ] Geteilte URL reproduziert den exakt gleichen Zustand
- [ ] Tour-Player startet (`?tour=demo`)
- [ ] **Erwartet nicht verfügbar:** Video-Export-Button, KI-Bewertung,
      Button „Politische Vorgänge recherchieren" (graceful degradation)

## 2. Lokaler Server **ohne** `GEMINI_API_KEY`

```bash
unset GEMINI_API_KEY
npm run start:server
# → http://localhost:8000
```

- [ ] `GET /api/health` antwortet `{ status: "ok" }`
- [ ] `GET /api/ai-assessment-available` liefert `{ available: false }`
- [ ] `GET /api/political-context/supported` liefert nicht-leere
      `cities`-Liste
- [ ] Werkbank lädt, alle Browser-only-Punkte (s. o.) bleiben erfüllt
- [ ] **Politische Recherche** liefert für mindestens eine unterstützte
      Stadt (z. B. Hannover) Treffer; Übernahme in den Export funktioniert
- [ ] **Export ohne KI** liefert vollständigen PDF-/Word-Antrag mit
      Statistik, Karte, POI-Analyse und Beschlussvorschlag
- [ ] `POST /api/ai/export-assessment/v2` antwortet `200 OK` mit
      `source: "fallback"` (deterministischer Output)
- [ ] `POST /api/ai/export-assessment` (v1) antwortet `503` mit Hinweis
      auf fehlenden `GEMINI_API_KEY`

## 3. Lokaler Server **mit** `GEMINI_API_KEY`

```bash
export GEMINI_API_KEY=...     # gültiger Schlüssel
npm run start:server
```

- [ ] `GET /api/ai-assessment-available` liefert `{ available: true }`
- [ ] `POST /api/ai/export-assessment/v2?mode=assessment` liefert
      `source: "ai"` (oder `"cache"` bei Wiederholung) und
      schemakonformes Ergebnis
- [ ] `POST /api/ai/export-assessment/v2?mode=proposal-brief` liefert
      schemakonformen Maßnahmen­steckbrief
- [ ] Wiederholung derselben Anfrage → `source: "cache"`
- [ ] Asynchroner Job: `POST /api/ai/jobs` → `202`, anschließend
      `GET /api/ai/jobs/:id` erreicht `status: "done"` mit Ergebnis
- [ ] Politische Recherche funktioniert wie in Variante 2
- [ ] **Export mit KI**: PDF/Word enthält die übernommenen KI-Bewertungs­
      bausteine zusätzlich zu den deterministischen Tabellen
- [ ] **Export ohne KI** in derselben Session weiterhin möglich
      (Nutzer entscheidet pro Export, ob KI verwendet wird)

## 4. Docker

```bash
docker compose up
# oder:
docker run -p 8000:8000 -e GEMINI_API_KEY=... \
  ghcr.io/carstenartur/unfallatlas
```

- [ ] Container startet, `http://localhost:8000` erreichbar
- [ ] Werkbank lädt (`werkbank_v2.html`), Karte sichtbar
- [ ] Button **„🎬 Als Video exportieren"** ist sichtbar (nur Docker)
- [ ] Video-Export liefert eine `.gif`-Datei zum Download
- [ ] Mit gesetztem `GEMINI_API_KEY`: KI-Bewertung funktioniert (s. o.)
- [ ] Ohne `GEMINI_API_KEY`: KI-Endpunkte verhalten sich wie in Variante 2
- [ ] Politische Recherche funktioniert für die unterstützten Städte
- [ ] Container-Logs enthalten keine API-Keys oder PII
- [ ] Rate-Limit greift bei `>3` Video-Requests/min mit `429`

---

## 5. Querschnitts-Checks

- [ ] `npm test` (Unit + Integration) ist grün
- [ ] `npm run test:e2e` (Playwright) ist grün
- [ ] CHANGELOG / Release-Notes erwähnen alle neuen oder geänderten
      Endpunkte und Env-Variablen
- [ ] Doku ist aktuell:
      [`README.md`](../README.md),
      [`docs/architecture.md`](architecture.md),
      [`docs/server-features.md`](server-features.md),
      [`server/ai/README.md`](../server/ai/README.md),
      [`server/political-context/README.md`](../server/political-context/README.md)
