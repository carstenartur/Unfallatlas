# DOCX-Golden-Matrix

Die bisherige Endartefakt-QA verwendet bewusst einen stabilen Bonn-Referenzfall.
Dieser Fall bleibt unverändert, reicht aber allein nicht aus, um Ortswechsel,
kleine Fallzahlen, lange Dokumente und fehlende Kontextdaten abzudecken.

`scripts/document-golden-scenarios.js` definiert deshalb fünf versionierte,
deterministische Szenarien:

| Szenario | Zweck |
|---|---|
| `bonn-urban-junction` | unveränderter, bereits gerenderter Referenzfall |
| `hannover-arterial` | zweite Stadt, größerer Ausschnitt, weitere Beteiligungsart |
| `long-multi-section-report` | mindestens acht erwartete Renderseiten, viele Abschnitte und Umbruchbelastung |
| `few-cases` | nur drei Fälle, keine statistische Überdeutung |
| `uncertain-context` | unvollständiger Kontext wird sichtbar als unsicher ausgewiesen |

Jeder Vertrag enthält Stadt, Ausschnitt, Mittelpunkt, Zoom, Fallzahl,
Beteiligungsfilter, Kontextstatus, zusätzliche Absätze, Clustergröße,
Exportoptionen sowie erwartete Karten-, Tabellen- und Seitenverträge.
Unbekannte Felder, ungültige Bounds, ein Mittelpunkt außerhalb des Ausschnitts,
leere Beteiligungsfilter und nicht versionierte Szenarien werden abgewiesen.

## Erzeugung

```bash
node scripts/generate-document-golden-matrix.js
```

Ein einzelnes Szenario kann separat geprüft werden:

```bash
node scripts/generate-sample-docx.js \
  --scenario hannover-arterial \
  --out out/hannover-arterial.docx
```

Die vollständige Matrix wird standardmäßig nach
`out/qa/document-golden-matrix/` geschrieben. Jedes Szenario durchläuft den
echten `UA.exportToWord`-Produktivrenderer und erhält eine eigene DOCX-Datei.
`matrix.json` bindet:

- den SHA-256 des vollständigen Szenariovertrags,
- Dateiname, Größe und SHA-256 jedes DOCX,
- die erwarteten Karten-, Tabellen- und Mindestseitenverträge,
- den tatsächlich erreichten automatischen Evidenzstatus,
- den weiterhin offenen manuellen Microsoft-Word-Status.

Der Gesamtabdruck `matrixFingerprint` ist deterministisch aus Szenariovertrag
und Artefakthashes abgeleitet. Die Ausgabe wird zunächst in einem temporären
Verzeichnis erstellt und erst nach vollständigem Erfolg ersetzt; ein
abgebrochener Lauf hinterlässt keine teilweise neue Matrix.

## Ehrliche Evidenzgrenze

Die Matrix behauptet nach der reinen DOCX-Erzeugung ausschließlich:

- das Produkt hat für jedes Szenario genau ein DOCX erzeugt,
- ZIP/DOCX-Signatur und Mindestgröße sind plausibel,
- das konkrete Artefakt ist hashgebunden.

Die Felder für gerenderte Seitenzahl, Karten- und Tabellensemantik bleiben
zunächst `null`. Der manuelle Word-Status lautet ausdrücklich
`not-performed`. Damit kann ein erzeugtes Dokument weder als erfolgreich in
LibreOffice/Poppler gerendert noch als in Microsoft Word geprüft erscheinen,
solange die jeweiligen nachgelagerten Gates keine passende Evidenz geliefert
haben.

Der bestehende Bonn-Endartefaktpfad und der mit #520 eingeführte
Word-Kompatibilitätsbeleg bleiben unverändert maßgeblich. Ein echter Release
benötigt weiterhin einen aktuellen, fingerprintgebundenen Word-Beleg durch eine
reale Prüfung; die Matrix ersetzt diese manuelle Freigabe nicht.

## Noch offen in #415

Dieser Slice schafft das reproduzierbare Matrixfundament und reale
Produktiv-DOCX-Dateien. Für den vollständigen Abschluss fehlen noch:

- LibreOffice-/Poppler-Renderlauf für alle fünf Matrixartefakte;
- Befüllung und Prüfung der beobachteten Seitenzahlen;
- semantische Karten- und Tabellenrekonstruktion je Szenario;
- zusätzliche Verträge für echte Tabellenfortsetzungen im Langbericht;
- ein aktueller manueller Microsoft-Word-Beleg für den Releasekandidaten.
