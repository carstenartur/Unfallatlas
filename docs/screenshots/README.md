# Dokumentationsmedien

Dieses Verzeichnis enthält die in README, Nutzungsanleitung und QA verwendeten
statischen Belegbilder der Unfallwerkbank. Die Medien sind keine frei gepflegte
Galerie: Bildinhalt, Abmessungen, Datenzustand, Grundkarte und Verwendungsstellen
werden automatisiert geprüft.

## Verbindliche Regeln

1. Anwendungsscreenshots haben grundsätzlich **1280 × 640 px**.
2. Die gerenderte PDF-Belegseite hat **892 × 1262 px**.
3. Jedes eingecheckte Medium unter `docs/` ist in
   [`docs/media-manifest.json`](../media-manifest.json) deklariert.
4. Zu jedem statischen Beleg existieren Provenienz- und Readiness-Nachweise unter
   [`qa/screenshot-evidence/`](../../qa/screenshot-evidence/).
5. Screenshots in `README.md` und `docs/DOKUMENTATION.md` müssen auf den
   kanonischen, reproduzierbaren Werkbankzustand verlinken. Der Vertrag wird von
   [`scripts/documentation-deeplink-contract.cjs`](../../scripts/documentation-deeplink-contract.cjs)
   geprüft.
6. Ein geöffnetes Menü oder ein Dialog wird nicht durch einen wirkungslosen
   URL-Parameter vorgetäuscht. Die Dokumentation verlinkt die zugrunde liegende
   Analyse und nennt den anschließenden Bedienungsschritt.

## Eingecheckter, geprüfter Bestand

Grundzustände und Bedienoberfläche:

- `01-startansicht.png`
- `02-stadtauswahl.png`
- `03-filter.png`
- `04-cluster-ansicht.png`
- `05-heatmap-ansicht.png`
- `06-legende.png`
- `07-export-modal.png`
- `08-stundenfilter.png`
- `09-bereich-markieren.png`

Praxis- und Exportszenarien:

- `10-auto-fahrrad-und.png`
- `11-fahrrad-alleinunfaelle.png`
- `12-poi-schulen-kitas.png`
- `13-bonn-hbf-radunfaelle.png`
- `14-export-filterkontext.png`
- `15-export-pdf-rendered.png`
- `16-antrag-inhalt.png`

Kartenmodi und Fallback:

- `21-mapmode-standard.png`
- `22-mapmode-orthophoto.png`
- `23-mapmode-hybrid.png`
- `24-mapmode-analysis.png`
- `25-mapmode-orthophoto-fallback.png`

Nicht jedes Bild muss in der Nutzerführung erscheinen. Diagnosebilder für
transiente UI-Zustände oder absichtlich erzwungene Fehlerfälle bleiben als
QA-Belege erhalten, ohne die README zu überladen.

## Erzeugung

Die kanonischen Szenarien stehen in
[`tests/e2e/screenshots.spec.js`](../../tests/e2e/screenshots.spec.js). Vor einer
Übernahme müssen insbesondere folgende Nachweise erfolgreich sein:

- Unfalldaten sind geladen und die gefilterte Menge ist nicht leer.
- Angeforderte Layer sind vollständig gerendert.
- Die sichtbare Grundkarte stammt aus einer real geladenen Kartenquelle.
- Auswahl, Stadt, Filter und Kartenmodus entsprechen dem Szenario.
- Medienbudget, Abmessungen und Referenzen sind gültig.

Relevante Befehle:

```bash
npm run qa:e2e:prepare
npx playwright test tests/e2e/screenshots.spec.js --project=chromium
npm run validate:screenshot-evidence
npm run validate:media
```

## Deep-Link-QA

Der Dokumentationsvertrag unterscheidet zwei Ebenen:

- **Vertrag für alle gezeigten Bilder:** Bildpfad und vollständige Query müssen
  dem deklarierten Szenario entsprechen.
- **Live-Prüfung repräsentativer Fälle:** ausgewählte Cluster-, Bereichs-,
  POI-, Start-, Export- und Heatmaplinks werden zusätzlich in der laufenden
  Anwendung geöffnet und gegen den tatsächlichen Laufzeitzustand geprüft.

Dadurch kann die Dokumentation viele hilfreiche Screenshots zeigen, ohne jeden
doppelten Verweis als eigenen teuren End-to-End-Lauf auszuführen.

## Kontextmedien

Die Generatoren können zusätzliche Kontextkandidaten unter
`.build/doc-media/context/` erzeugen. Dieser Ordner ist bewusst nicht
eingecheckt. Eine Übernahme ist erst zulässig, wenn Filterwirkung, Popupinhalt,
Datenprovenienz, Grundkarte und Deep-Link gemeinsam geprüft wurden.

## Animationen

Das früher eingebettete README-Demo-GIF zeigte nicht mehr die aktuelle
Oberfläche und wurde entfernt. Die Nutzerführung verwendet statische,
deep-verlinkte Screenshots. Der serverseitige Videoexport bleibt eine
eigenständige Produktfunktion; ein künftig erneut eingebettetes Demo müsste aus
einem aktuellen, dokumentierten Szenario erzeugt und wie jedes andere Medium in
Manifest und QA aufgenommen werden.
