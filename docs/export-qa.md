# Export-QA-Matrix – PDF / DOCX

Diese Matrix dokumentiert, welche Aspekte des Werkbank-Exports
(Word + PDF) automatisiert geprüft sind und welche manuell oder mit
optionalen System-Tools getestet werden. Sie ergänzt `qa-matrix.md` um
die Export-spezifischen QA-Gates aus dem PDF/DOCX-Sanierungsplan
(PR 1 – Pipe-Trend-Leak, PR 2 – Bildlogik & Scope, PR 3 – Render-Gate).

Legende: ✅ automatisiert · ⚠️ teilweise · ❌ offen / manuell

---

## Pre-Flight-Konsistenz-Gates

| Invariante | Beschreibung | Status | Test |
|------------|--------------|--------|------|
| 1 — `accidentDetails.total ≤ totalAccidents` | Tabelle darf nicht mehr Zeilen führen, als die Gesamt-Fallzahl behauptet (mask-0-Punkte werden ausgefiltert). | ✅ | `tests/unit/ua.report_v2.validateExportConsistency.test.js` (`table_exceeds_total`) |
| 2 — Karten-Punkte ≡ Tabellen-Zeilen | `countPointsInBounds(viewportPts, exportBbox)` muss exakt `accidentDetails.total` entsprechen. | ✅ | `validateExportConsistency.test.js` (`table_map_mismatch`) + Bonn-Fixture |
| 3 — Cluster ⊆ Tabelle | Jede Cluster/Gruppen-Zählung in `accidentDetails.groups` darf NIE größer sein als `accidentDetails.total`. Cluster werden nicht auto-summiert. | ✅ | `validateExportConsistency.test.js` (`cluster_exceeds_total`) |

---

## SACHVERHALT-Block-Hygiene

| Anforderung | Beschreibung | Status | Test |
|-------------|--------------|--------|------|
| Kein Pipe-Trend-Leak | Mehrjahres-Trend (`Jahr \| Getötete \| …`) darf nicht als Roh-Pipetext im SACHVERHALT-Absatz landen. | ✅ | `tests/unit/ua.report_v2.pdfQA.test.js` (Header/Datenzeile-Regex) |
| Kein Stunden-Heatmap-Leak | Heatmap-Block-Header darf den SACHVERHALT nicht aufbrechen. | ✅ | gleicher Test |
| Vollständige Stop-Liste | `extractSection` terminiert SACHVERHALT an *allen* nachfolgenden Block-Headern (Methodik, URSACHEN, Volkswirtschaftliche Bedeutung, Empfohlene Maßnahmen, …). | ✅ | `tests/unit/ua.report_v2.extractSection.test.js` |

---

## Bildlogik & Scope-Erklärung

| Anforderung | Beschreibung | Status | Test |
|-------------|--------------|--------|------|
| „Hinweis zur Zählweise"-Box | Direkt nach „Aktive Filter" sichtbar in DOCX und PDF. | ✅ | `pdfQA.test.js` (Hinweis-Header + Erläuterungssatz) |
| Nummerierte Bildunterschriften | Jedes Map-Bild führt eine eigene „Abbildung N: …"-Caption (DOCX + PDF, drei Bildklassen: Übersichts-, Detail-, Cluster-Karte). | ✅ | `pdfQA.test.js` (`Abbildung \d+: `-Regex, monoton steigend) |
| `structured.meta.activeFilterScope` | Bezugsrahmen aller Ausschnittszahlen (Bounds + Filter + Maske). | ✅ | `tests/unit/ua.export_v2.scope.test.js` |
| `structured.meta.patternAnalysisScope` | Bezugsrahmen der Auffälligkeiten (Beteiligungsmaske > 0). | ✅ | `scope.test.js` |
| `structured.meta.baselineScope` | Stadtweite Vergleichspopulation (nur Nicht-Beteiligungsfilter). | ✅ | `scope.test.js` (verifiziert das Fehlen von `includeCar` etc.) |
| `structured.methodikScope` | Drei renderfertige Sätze (Aktiver Filter / Muster-Analyse / Vergleichs-Baseline). | ✅ | `scope.test.js` + `pdfQA.test.js` (Methodik-Block sichtbar) |

---

## Karten-Verifikationssätze

| Anforderung | Beschreibung | Status | Test |
|-------------|--------------|--------|------|
| Übersichtskarte mit „n = X"-Satz | Verwendet `accidentDetails.total` (Fallback `totalAccidents`/`viewportPts.length`). | ✅ | `tests/unit/ua.report_v2.mapConsistency.test.js` |
| Detailkarte mit eigenem `n` | Zählt nur Punkte innerhalb der Selection-Bounds. | ✅ | `mapConsistency.test.js` |
| Cluster-Karten skippen bei Mismatch | Wenn `visibleN !== cm.total`, wird die Cluster-Karte ausgelassen (kein falscher Verifikationssatz). | ✅ | `mapConsistency.test.js` |

---

## Bonn-Regression-Fixture

| Anforderung | Beschreibung | Status | Test |
|-------------|--------------|--------|------|
| Synthetisches Bonn-Sample | 20 Punkte (2019–2023, Bad Godesberg-Bounds), reproduziert die Datenstruktur des Original-QA-Befunds. | ✅ | `tests/fixtures/bonn-regression.json` |
| End-to-End Pipeline-Test | `computeExportReport(ctx)` produziert konsistente Felder; `validateExportConsistency` liefert `ok:true`. | ✅ | `tests/unit/ua.export_v2.bonnRegression.test.js` |

---

## PDF-Render-Gate (Poppler / Ghostscript)

| Anforderung | Beschreibung | Status | Test |
|-------------|--------------|--------|------|
| Per-Page-Render mit Timeout | Jede Seite wird durch `pdftoppm`, `pdfimages` und `gs` ohne Timeout (default 15 s/Seite) gerendert. | ⚠️ optional | `scripts/check-pdf-render.js`, npm: `npm run test:render-gate -- --pdf <path>` |
| Skip-Mode ohne Binaries | Ohne installierte Poppler-/Ghostscript-Tools überspringt das Skript freundlich (Exit 0). | ✅ | `scripts/check-pdf-render.js` (which-Probe) |
| CI-Integration | Workflow-Stage mit installiertem `poppler-utils` + `ghostscript`. | ✅ | `.github/workflows/test.yml` Job `pdf-render-gate` |

### Lokale Nutzung

```bash
# Installation (einmalig):
sudo apt-get install poppler-utils ghostscript     # Debian/Ubuntu
brew install poppler ghostscript                   # macOS

# Render-Gate gegen ein erzeugtes PDF laufen lassen:
npm run test:render-gate -- --pdf out/test.pdf

# Mit kürzerem Timeout pro Seite (z. B. für CI):
npm run test:render-gate -- --pdf out/test.pdf --timeout-per-page 10

# Nur ein Tool (z. B. Ghostscript):
npm run test:render-gate -- --pdf out/test.pdf --tool gs
```

Exit-Codes: `0` = ok oder skip (keine Tools installiert), `1` = PDF
nicht gefunden / Argument ungültig, `2` = mindestens eine Seite hat
in einem Tool gefailt oder timeoutet.

---

## Ausblick

- Mobile-Render-Tests (PDF-Reader auf iOS/Android) sind außerhalb des
  CI-Scopes und werden manuell vor jedem Release stichprobenartig
  geprüft.
- Eine pdfjs-basierte Volltext-Extraktion ist absichtlich nicht Teil
  des Gates — pdfjs-dist v5 ist ESM-only und in Jest+CJS schwer
  einzubinden. Stattdessen wird `docDefinition.content` als
  Wahrheitsquelle der pdfMake-Pipeline geprüft (siehe `pdfQA.test.js`).
