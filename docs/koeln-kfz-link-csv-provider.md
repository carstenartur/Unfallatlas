# Kölner Kfz-Link-CSV-Provider

Der Provider `scripts/providers/koeln_kfz_link_csv_provider.js` liest die
richtungsbezogenen Kölner Streckenwerte 2016–2019 aus einer kontrollierten
lokalen Kopie der amtlichen Link-CSV.

## Warum nicht die bisher katalogisierte `node.csv`?

Die Knotendatei enthält nur Knotennummern und Gauß-Krüger-Koordinaten. Die
eigentlichen DTVw-ähnlichen Werte stehen in der Link-Datei:

```text
KFZ_Zaehldaten_2016-2019_link.csv
```

Der Provider verwendet deshalb eine eigene, eindeutige Quellen-ID:

```text
traffic.count.koeln-kfz-links-2016-2019
```

Er deutet die Knotendatei nicht nachträglich als Zählwertquelle um.

## Fachliche Semantik

Die Stadt Köln beschreibt die Werte als Knotenstromzählungen an einem
repräsentativen Werktag. Drei Zeitblöcke werden auf den Tagesverkehr
hochgerechnet. Die Werte sind analog DTVw zu lesen und besitzen die Einheit
`Kfz/24 h`.

Für Hin- und Gegenrichtung werden jeweils eigene Beobachtungen erzeugt. Leere
Jahresfelder bleiben leer; sie werden weder mit null noch mit Nachbarjahren
aufgefüllt.

Die Kölner Streckennummer ist **keine OSM-Way-ID**. Bis ein räumlicher Matcher
implementiert ist, lautet der stabile Bezug beispielsweise:

```text
koeln-segment:2071:forward:16545002->16545007
```

Jede Beobachtung weist in ihren Qualitätshinweisen ausdrücklich darauf hin,
dass dieser Bezug noch nicht auf OpenStreetMap gematcht wurde.

## Vertrauensgrenze

Der Produktionspfad akzeptiert ausschließlich:

- die fest hinterlegte Link-CSV-URL;
- den durch das Open-Data-Portal veröffentlichten SHA-256
  `477da6900ee791b7b3db433e27d6bde778c2f138869198b448fb26827de65488`;
- zusätzlich die beim Import explizit angegebene Bytezahl;
- eine reguläre, symlinkfreie Datei innerhalb eines freigegebenen Importroots;
- gültiges UTF-8;
- das dokumentierte Hin-/Rückrichtungsschema.

Unbekannte, fehlende, doppelte oder mehrdeutige Spalten, abweichende
Zeilenbreiten, ungültige Zählwerte und doppelte Beobachtungs-IDs brechen den
Import ab.

## Lokale Verwendung

```js
const koeln = require("./scripts/providers/koeln_kfz_link_csv_provider");

const provider = koeln.createKoelnKfzLinkCsvProvider({
  allowedRoot: "/srv/unfallwerkbank/traffic/koeln",
  csvPath: "KFZ_Zaehldaten_2016-2019_link.csv",
  expectedDistributionSha256:
    "477da6900ee791b7b3db433e27d6bde778c2f138869198b448fb26827de65488",
  expectedBytes: 123456,
  retrievedAt: "2026-07-28T20:00:00.000Z",
});

const observations = await provider.loadObservations({ city: "Köln" });
```

`expectedBytes` muss durch die tatsächliche Größe der kontrolliert
heruntergeladenen Datei ersetzt werden.

## Abgrenzung

Dieser Slice schließt den deterministischen CSV-Import und die typisierte
Beobachtungserzeugung. Weiter offen in #413 bleiben:

- räumliches Matching der Kölner Segmente auf OSM-Ways;
- Zusammenführung von Knoten- und Link-Geometrien beziehungsweise einer
  geeigneten amtlichen Liniengeometrie;
- Coverage-Berichte gegen das ausgelieferte Straßennetz;
- Auswahl- und Konfliktregeln bei mehreren Zähljahren oder Quellen;
- Integration in Karten, Popups, Dokumentexporte und SourceManifest-Artefakte.
