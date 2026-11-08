# Optionaler Düsseldorfer Radzählungs-Provider

`scripts/providers/duesseldorf_bicycle_hourly_provider.js` liest die vollständige
amtliche **Mannesmannufer-IN/OUT-Distribution 2024** aus kontrollierten lokalen
Originaldateien. Sie ist eine zusätzliche kommunale Zählquelle neben Köln,
kein stadtweiter Vollbestand und keine Produktionsaktivierung.

## Quellenauswahl und getrennte Lizenzen

Hannover wurde zuerst geprüft: Die Landeshauptstadt beschreibt öffentliche
[CSV-Radzählungen bei der VMZ](https://presse.hannover-stadt.de/pmDetail.cfm?pmid=24895).
Ein distributionsbezogener offener Lizenznachweis ließ sich in der begrenzten
Prüfung jedoch nicht belegen. Das [VMZ-Impressum](https://www.vmz-niedersachsen.de/impressum/)
behält Rechte vor und verlangt für die Wiederverwendung eigener Inhalte eine
Zustimmung. Das ist kein Beweis, dass alle Hannoveraner Verkehrsdaten geschlossen
sind; öffentliche Sichtbarkeit wird hier lediglich nicht als Lizenz behandelt.
Der separate Bike-Citizens-Datensatz ist eine Hochrechnung/GPS-Nutzung und ersetzt
keine weitere geprüfte amtliche Zählquelle. Ein Berlin-Importer ist nicht Teil
dieses Piloten.

Die tatsächlich beschaffbare Alternative stammt vom **Amt für Verkehrsmanagement
der Landeshauptstadt Düsseldorf**. Die originalen amtlichen Turtle-Metadaten
binden jede der verwendeten Distributionen ausdrücklich an ihre eigene Lizenz:

| Distribution | Lizenz | Rolle |
|---|---|---|
| [Mannesmannufer IN OUT 2024, CSV](https://opendata.duesseldorf.de/sites/default/files/Mannesmannufer_IN_OUT_2024_0.csv) | DL-DE-BY-2.0; Namensnennung **Landeshauptstadt Düsseldorf** | Stundenwerte beider originaler Richtungen |
| [Standorte, CSV](https://opendata.duesseldorf.de/sites/default/files/Z%C3%A4hlstellen_2.csv) | DL-DE-Zero-2.0 | Genau benannte amtliche Stationskoordinate |
| [Standorte WGS84, GeoJSON](https://opendata.duesseldorf.de/sites/default/files/Z%C3%A4hlstellen_1.geojson) | DL-DE-Zero-2.0 | Unabhängige Bestätigung von EPSG:4326 und allen 19 CSV-Koordinaten |

Die Lizenz eines anderen Formats wird nicht übertragen: Beispielsweise enthält
der Standortkatalog auch eine separat als geschlossen bezeichnete JSON-Ressource.
Der Provider verwendet diese nicht. Primärnachweise:
[Zählungsmetadaten](https://www.govdata.de/ckan/dataset/wetterabhangige-jahresubersicht-der-dauerzahlstellen-radverkehr-2024.ttl)
und [Standortmetadaten](https://www.govdata.de/ckan/dataset/standorte-der-dauerzahlstellen-radverkehr-in-dusseldorf.ttl).

## Originalbytes und Semantik

Die drei Dateien wurden am 8. November 2026 mit gewöhnlichen öffentlichen
HTTPS-Anfragen ohne Anmeldung oder Challenge-Lösung beschafft:

| Original | Bytes | SHA-256 |
|---|---:|---|
| Zählungs-CSV, UTF8 mit BOM | 408.091 | `06f2f90fb145b224077f69f777aff345007ca7612f916b58ba9a764f6e1576f7` |
| Standort-CSV, UTF8 | 1.692 | `e436955bd45fc322d62cd96b9cbdcc353d5ea9256a950785fcee8d8cfaed32db` |
| WGS84-GeoJSON | 3.960 | `575a0958400030f50967be6948bb582532286e456b3c0a4729a00b604fdbdd84` |

Die MD5-Werte der Zählungs-CSV und des GeoJSON stimmen zusätzlich mit den
amtlich veröffentlichten Checksummen überein. SHA-256 dient der Providerbindung.

Die Quelle bezeichnet ihre Werte ausdrücklich als **stündlich erfasste
Fahrradzählungen**. Die Spalten heißen original:

- `Mannesmann Ufer Stadteinwaerts (Ri. Sueden)`
- `Mannesmann Ufer Stadtauswaerts (Ri. Norden)`

Diese amtlichen Texte bleiben erhalten; die Richtungen werden nicht aus einer
eigenen Vorstellung von „stadteinwärts“ abgeleitet. Die Einheit lautet
`Fahrräder/Stunde`. Es entstehen weder Tageswerte noch DTV, Richtungssummen,
Expositionsraten oder interpolierte Messungen.

Die Zeitlabels haben das Format `TT-MM-2024 HH:00:00`. **Zeitzone und genaue
Intervallgrenzen sind nicht angegeben.** Der Provider erhält das Quellzeitlabel
im Zeitraum und fügt kein UTC-Suffix oder einen erfundenen Intervallendpunkt an.
Interne UTC-Kalenderarithmetik dient ausschließlich dem Vergleich der Labels;
sie ist keine Behauptung physikalischer Zeitabstände.

Das vollständige Original enthält **8.783 eindeutige Zeitlabels** vom 1. Januar
bis 31. Dezember 2024. Das Label **31. März 2024, 02:00 fehlt**; am 27. Oktober
steht 02:00 nur einmal. Die Lücke bleibt erhalten. Der Provider rekonstruiert
keine Sommerzeitregel und erzeugt keine zusätzliche Stunde. Aus jedem vorhandenen
Label entstehen zwei getrennte Richtungsbeobachtungen: **17.566 insgesamt**,
darunter **1.223 echte Nullwerte**. Im geprüften Original sind keine leeren
Zählzellen vorhanden. Der Parser behandelt ein leeres Zählfeld dennoch als
fehlende Beobachtung und niemals als null oder Richtungsersatz. Die amtlichen
Metadaten erklären fehlende Angaben mit dem Ausfall einer Zählstelle; daraus
wird keine Ursache der beobachteten Kalenderlücke abgeleitet.

## Stationsbezug und Provenienz

Der geprüfte Bezug ist ausdrücklich auf die Originalzeile
`mannesmann ufer-totem 01` der amtlichen Standortdatei begrenzt. Der Punkt
`[6.76712, 51.22015]` stimmt exakt mit der separat ausdrücklich als
**WGS84/EPSG:4326** bezeichneten amtlichen GeoJSON-Distribution überein; auch alle
18 anderen CSV-/GeoJSON-Koordinatenpaare stimmen exakt überein.

Dies ist **keine OSM-/Straßenzuordnung** und kein Beleg einer bestimmten
Lagegenauigkeit. Die Standortdistribution wurde zuletzt am 31. März 2022 geändert;
der Abruf 2026 macht sie nicht zu neu erhobener Geometrie für 2024. Quellen-Hash,
separate Standortlizenz und eigener Abrufzeitpunkt bleiben in den bestehenden
SourceManifest-Qualitätshinweisen erhalten. Der Quellenabruf der Zählungen und
das historische Messjahr bleiben getrennt.

Ein unabhängiger Python-Standard-CSV-/Datetime-Reader hat sämtliche 17.566 IDs,
Werte, Richtungen, Quellzeitlabels und Koordinaten aus den vollständigen
Originaldateien bestimmt. Das tatsächliche Ergebnis des Produktionsladers und
der gemeinsamen Registry wurde damit exakt verglichen. Kleine, unveränderte
Originalzeilen inklusive Kalenderlückenrändern und Nullwerten, vollständige kleine
Standortdateien, Original-Lizenzmetadaten und Hash-/Zeit-
Nachweise liegen unter `tests/fixtures/traffic/duesseldorf/`.
CSV-Originalbytes und Lizenzmetadaten sind verlustfrei als deterministisches Gzip
gespeichert. Dadurch bleiben Original-BOM und CRLF erhalten; die Originalhashes
gelten für die entpackten Bytes. Es gibt keine Zeilenenden-Normalisierung.

## Optionale Verwendung

```js
const traffic = require('./js/ua.traffic_provider');
const source = require('./scripts/providers/duesseldorf_bicycle_hourly_provider');
const registry = traffic.createRegistry();
registry.register(source.createDuesseldorfBicycleHourlyProvider({
  allowedRoot: '/controlled/import/root',
  csvPath: 'Mannesmannufer_IN_OUT_2024_0.csv',
  stationsPath: 'Zaehlstellen_2.csv',
  expectedDistributionSha256: '06f2f90fb145b224077f69f777aff345007ca7612f916b58ba9a764f6e1576f7',
  expectedBytes: 408091,
  expectedStationsSha256: 'e436955bd45fc322d62cd96b9cbdcc353d5ea9256a950785fcee8d8cfaed32db',
  expectedStationsBytes: 1692,
  retrievedAt: '<tatsächlicher ISO-Abrufzeitpunkt der Zählungs-CSV>',
  stationsRetrievedAt: '<tatsächlicher ISO-Abrufzeitpunkt der Standort-CSV>',
}));
const observations = await registry.collect({
  city: 'Düsseldorf', mode: 'bicycle', failOnProviderError: true,
});
```

Beide Originaldateien benötigen die geprüften Hashes und Bytezahlen. Der
vollständige Lader akzeptiert den kleinen Testausschnitt nicht als Distribution.
Unbekannte Spalten, ungültige Werte/Koordinaten, doppelte oder ungültige Zeitlabels,
Pfadflucht, Symlinks und fehlende echte Abrufuhren führen zum Fehler. Es erfolgen
keine Liveabfragen. Ein falscher Ort oder fehlender/falscher Modus aktiviert den
Provider nicht. Standardkonfiguration, Renderer und Word-Eingaben bleiben unverändert.

Der Quellenpilot ersetzt nicht die noch erforderliche fachliche Straßenanwendung,
Auswahl eines passenden Zeitraums/Richtungswerts, Qualitäts-/Coverage-Abnahme und
reale Export-/Golden-Prüfung. Die verschiedenen Messgrößen aus Köln, Düsseldorf
und überregionalen Quellen dürfen nicht ohne belegte Methodik als gemeinsame
Tagesbelastung verglichen werden.
