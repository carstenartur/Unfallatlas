# Szenariospezifische Semantikprüfung der Golden-Dokumentmatrix

Die Golden-Matrix erzeugt fünf reale DOCX-Artefakte und rendert sie mit
LibreOffice nach PDF. Der generische Poppler-Audit prüft Seitenränder,
Leer-/Restseiten, Bildgeometrie, Links und Mindestseitenzahlen. Ein solcher
Audit beweist jedoch noch nicht, dass eine als „Übersichtskarte“ beschriftete
Abbildung tatsächlich neben einem Bild steht oder dass jedes Szenario seine
eigene Fallzahl und Kontextwarnung bewahrt.

`scripts/verify-document-golden-rendered-semantics.js` arbeitet deshalb
**ausschließlich auf dem finalen Poppler-Seitenmodell** und erzeugt nach dem
bestehenden `rendered-matrix.json` eine getrennte `semantic-matrix.json`.

## Szenariovertrag

Für jedes der fünf versionierten Szenarien werden im gerenderten Text geprüft:

- Stadt und benannter Untersuchungsraum,
- exakt die szenariospezifische Unfallzahl,
- verfügbare, unsichere oder fehlende Kontextsemantik,
- bei langen Berichten erster und letzter Prüfabschnitt auf unterschiedlichen
  finalen Seiten.

Die Erwartungen stammen aus `scripts/document-golden-scenarios.js`; die
Semantikmatrix bleibt über den Hash und Fingerprint der gerenderten
Ausgangsmatrix daran gebunden.

## Kartenrollen

Die deklarierten Rollen `overview`, `selection`, `detail` und `cluster` werden
nicht nur als Text gesucht. Jede sichtbare, eindeutig vorkommende
Abbildungsbeschriftung muss auf derselben finalen Seite räumlich einer eigenen,
unmittelbar vorausgehenden Bildbox zugeordnet werden können. Ein Caption-Text
ohne Bild, eine doppelte Rolle oder die Wiederverwendung derselben Bildbox für
zwei Rollen bricht die QA ab.

## Tabellenrollen

Die Rollen `severity`, `year-trend` und – beim langen Szenario – `deviations`
werden über ihre final gerenderten Abschnittsüberschriften belegt. Enthält das
Poppler-Modell bereits rekonstruierte Tabellenzeilen, werden deren Anzahl und
der Modus `rendered-rows-and-headings` in der Evidenz bewahrt. Andernfalls wird
transparent nur `rendered-headings` ausgewiesen; die Matrix behauptet dann
keine nicht vorhandenen Zeilenkoordinaten.

## Unveränderliche Ausgangsevidenz

`rendered-matrix.json`, die gerenderten Seitenbilder, PDF-Dateien und Auditmodelle
werden nicht verändert. Die Semantikprüfung schreibt atomar ein neues Manifest
und referenziert den SHA-256 der Ausgangsmatrix und jedes Auditmodells. Ein
Fehler kann daher keinen bestandenen generischen Audit nachträglich umdeuten.

## Maven- und CI-Vertrag

Das Maven-Profil `document-render` führt lokal reproduzierbar aus:

1. DOCX-Erzeugung,
2. LibreOffice-/Poppler-Rendering,
3. generischen Seitenaudit,
4. Golden-Matrix-Rendering,
5. szenariospezifische Semantikprüfung.

Der GitHub-Workflow `Rendered Document Poppler Audit` installiert lediglich die
notwendigen Systemprogramme und ruft dieses Maven-Profil auf. Es gibt keine
zweite, nur in GitHub vorhandene Semantiklogik.

## Verbleibende Grenze

Die Semantikmatrix setzt `microsoftWordEvidenceVerified` weiterhin auf `false`.
LibreOffice und Poppler können keinen aktuellen Microsoft-Word-Build ersetzen.
Der externe Word-Beleg muss separat mit Dateihash, Word-Build, Betriebssystem,
Seitenzahl, Seitenbildern und Prüfergebnis eingereicht und anschließend durch
den bestehenden Receipt-Validator gebunden werden.
