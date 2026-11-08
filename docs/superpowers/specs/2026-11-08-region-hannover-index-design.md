# Region Hannover im gemeinsamen Ratsdatenindex

## Auftrag und Umfang

Der öffentliche Dokumentenbestand der Region Hannover wird dem vorhandenen
Hannover-Index hinzugefügt. Stadt und Region bleiben über das bestehende
`source`-Feld unterscheidbar; zusätzlich behalten alle Vorgänge amtliche Links
und voneinander unabhängige, stabile IDs. Die Quelle wird lesbar angezeigt.

## Gewählter Anschluss

Der bestehende ALLRIS-Sitzungsclient für Bonn wird als gemeinsamer Baustein
verwendet. Ein eigener Regionsadapter erschließt die tatsächlich veröffentlichte
Vorlagenliste und ihre Detailseiten. Der gemeinsame Refresh, Ortsabgleich,
Version-2-Snapshot und Pages-Build bleiben die Veröffentlichungspipeline.

Ein separates Regionsdateiformat würde Suche und Karte duplizieren. Eine
Unterscheidung allein anhand der URL wäre für Herkunft und spätere Filter
unnötig schwer zu verwenden. Deshalb bleibt die bestehende Quellenkennung
`region-hannover-ris` neben `hannover-sim` erhalten.

## Verträge

- Quelle: `https://ris.hannit.de/public/vo040`; Details ausschließlich aus
  tatsächlich gelisteten öffentlichen Vorlagen, keine erratenen ID-Bereiche.
- ID: `region-hannover-ris:vo:<VOLFDNR>`; Deduplizierung unabhängig von
  Suchbegriff, Seitenposition oder Drucksachennummer.
- Der Sitzungsclient folgt dem veröffentlichten Prüfverfahren und beendet
  abgelehnte Zugriffe. Cookies bleiben im Speicher und beim gleichen Ursprung.
- Vorlagenart, Veröffentlichungsdatum und Beratungsergebnis werden nicht
  miteinander verwechselt. Ein Beschlussvorschlag ist kein Beschluss.
- Listenmetadaten und erfolgreich gelesene Details werden mit tatsächlicher
  Quellenzeit gespeichert. Arbeits- und Zeitgrenzen bleiben nachvollziehbar.
- Bestehende Stadt- und Regionsdaten dürfen durch Teilimporte nicht verloren
  gehen oder ohne erneuten Abruf eine neue Quellenzeit erhalten.
- Das Hannover-Ortsverzeichnis beschreibt die Landeshauptstadt. Gleichnamige
  Straßen anderer Regionskommunen dürfen keine Hannover-Geometrie erhalten.
  Nur ausdrücklich örtlich belegte Absätze dürfen automatisch zugeordnet werden.
- Nicht verortete Vorgänge bleiben im Suchindex; die Karte lädt sie nicht als
  erfundene Punkte. Original-PDFs werden verlinkt, nicht vollständig gespiegelt.
- Generierte Veröffentlichungsdateien bleiben außerhalb von Git. Der bestehende
  Maven-/Pages-Weg veröffentlicht den tatsächlich erzeugten und geprüften Index.

## Abgrenzung zu laufender Arbeit

PR 753 ergänzt Zeitlinien und weitere Quellenmetadaten. Diese Erweiterung führt
kein konkurrierendes Schema ein. Der Regionsadapter kann dessen vorhandene
Feldnamen liefern; der hier maßgebliche Snapshot auf main bewahrt die bestehenden
Basisfelder. Vor einer Zusammenführung ist ein dort noch statischer Status
„Region gesperrt“ mit dem tatsächlichen Abrufstatus abzugleichen.
