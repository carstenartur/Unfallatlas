# Gerenderte DOCX-Golden-Matrix

Die fünf Szenarien aus `scripts/document-golden-scenarios.js` werden zunächst
mit dem Produktivrenderer als DOCX erzeugt:

```bash
node scripts/generate-document-golden-matrix.js
```

Anschließend verarbeitet
`scripts/render-document-golden-matrix.js` **jedes** dieser Dokumente über die
bereits verwendete LibreOffice-/Poppler-Endartefaktstrecke:

```bash
node scripts/render-document-golden-matrix.js
```

## Geprüfter Umfang

Der zweite Schritt prüft fail-closed:

- DOCX-Dateigröße und SHA-256 gegen `matrix.json`;
- Konvertierung ohne LibreOffice-Reparaturwarnung;
- plausibles finales PDF;
- vollständige Poppler-Endseitenanalyse ohne Auditbefund;
- identische Seitenzahl in Poppler-Modell und PNG-Rendering;
- mindestens die im Szenariovertrag angegebene Seitenzahl;
- Hash und Größe von PDF, Metadaten, Auditmodell, Auditbericht und jeder
  gerenderten PNG-Seite;
- atomare Veröffentlichung: Schlägt ein Szenario fehl, entsteht kein
  `rendered-matrix.json` und kein teilweise bestandenes `rendered/`-Verzeichnis.

Das Ergebnis liegt unter:

```text
out/qa/document-golden-matrix/
├── matrix.json
├── rendered-matrix.json
└── rendered/
    ├── bonn-urban-junction/
    ├── few-cases/
    ├── hannover-arterial/
    ├── long-multi-section-report/
    └── uncertain-context/
```

## Wahrheitsgrenze

`rendered-matrix.json` unterscheidet ausdrücklich zwischen bereits geprüften
und noch offenen Aussagen:

- `renderedPageCountsVerified: true`
- `genericFinalPageAuditVerified: true`
- `renderedMapSemanticsVerified: false`
- `renderedTableSemanticsVerified: false`
- `microsoftWordEvidenceVerified: false`

Der Matrixlauf beweist daher reale Endseiten und Mindestseitenzahlen, aber noch
nicht, dass für **jedes** Szenario alle Karten- und Tabellenrollen semantisch
rekonstruiert wurden. Ebenso ersetzt LibreOffice keine manuelle Prüfung in
Microsoft Word. Die bereits vorhandene hashgebundene Word-Receipt-Pipeline
bleibt für reale Releases erforderlich.

## Verbleibender Umfang in #415

Nach diesem Slice bleiben insbesondere:

- szenariospezifische Karten-Hints und exakte Prüfung aller erwarteten
  Kartenrollen;
- szenariospezifische Tabellenverträge einschließlich Langtabellen und
  Fortsetzungsseiten;
- visuelle Regions-Golden-Regressionen für die fünf Fälle;
- eine aktuelle, fingerprint-passende Microsoft-Word-Abnahme des konkreten
  Releasekandidaten.
