# BASt-Jahres-DTV und lokaler Straßenbezug

Der lokale Provider `scripts/providers/bast_annual_dtv_provider.js` importiert
den tatsächlich geprüften amtlichen Jahresexport **2023**. Der Stadtgenerator
kann daraus nach ausdrücklicher Konfiguration gemessenen Kfz-Kontext an
geeignete Unfallpunkte anbinden. Die Ausgabe verwendet die gemeinsame
Traffic-SPI und SourceManifest-Validierung.

## Amtliche Quellen und Lizenz

- Herausgeber: **Bundesanstalt für Straßen- und Verkehrswesen (BASt)**.
- [Datensatz und distributionsbezogene Lizenz](https://data.gov.de/suche/daten/automatische-zahlstellen-auf-autobahnen-und-bundesstrassen).
- [Geprüfter CSV-Export 2023](https://www.bast.de/DE/Themen/Digitales/HF_1/Massnahmen/verkehrszaehlung/Daten/2023_1/Jawe2023.csv?view=renderTcDataExportCSV&strTyp=A).
- [Amtliche Spaltenbeschreibung](https://www.bast.de/DE/Themen/Digitales/HF_1/Massnahmen/verkehrszaehlung/pdf-dateien/DZ-Abkuerzungen-Beschreibung.pdf?__blob=publicationFile).
- [Originale GovData-Metadaten](https://www.govdata.de/ckan/dataset/automatische-zahlstellen-auf-autobahnen-und-bundesstrassen.ttl).

Die Metadaten weisen für genau die 2023-CSV-Distribution **CC BY 4.0** aus.
Namensnennung: Bundesanstalt für Straßen- und Verkehrswesen (BASt).
Die Ableitung normalisiert CSV nach typisierten Stationsbeobachtungen;
Namensnennung und Änderungsvermerk gehören zum SourceManifest.

Am 8. November 2026 wurden durch gewöhnliche öffentliche HTTPS-Anfragen ohne
Authentifizierung oder Challenge-Lösung folgende Originalbytes beschafft:

| Original | Bytes | SHA-256 |
|---|---:|---|
| Jahres-CSV, ISO-8859-15 | 1.878.927 | `5108764655cc3d75878a887d4631f787d8216c54bb3fc3b63460c1a7b0fcb550` |
| Spaltenbeschreibung, PDF | 521.039 | `70d7d253106f44b1b03fad8b99f3a89420ff8625d09fe6007b2bcb14771a2216` |
| GovData-Metadaten, Turtle | 29.686 | `19d2bf5a93de0bdffef4aa7bb663f0b544dc805e0facc0a67cd1a2b8df977cb0` |

Der im Nachweis gespeicherte Abrufzeitpunkt ist der Start der jeweiligen
erfolgreichen Anfrage, kein Messdatum und kein künstlich erneuertes Quellenalter.
Die Daten bleiben auf das Messjahr 2023 bezogen. Eine HTML-Übersichtsseite lief
in einen Timeout; CSV, Beschreibung und Metadaten waren tatsächlich erreichbar.
Der Web-Abrufdienst hatte zuvor 503 gemeldet; diese Fehler wurden nicht als Daten
oder als generelle Unerreichbarkeit ausgegeben.

## Fachliche Semantik und Geometrie

Der Export enthält die Stationsgeometrie selbst:
`Koor_WGS84_E` und `Koor_WGS84_N` sind laut amtlicher Beschreibung Länge/Breite
in **EPSG:4326**. Der Adapter kopiert sie in GeoJSON-Reihenfolge `[Länge, Breite]`.
Er erfindet keine Segmentgeometrie, OSM-Way-ID oder Lagegenauigkeit.

`DTV_Kfz_MobisSo_Q` ist der Jahres-DTV für alle Tage und beide Fahrtrichtungen
zusammen. `DTV_Kfz_MobisSo_Ri1` und `Ri2` sind getrennte Richtungswerte.
Alle drei bleiben separate Beobachtungen mit Einheit `Kfz/24 h`; sie werden
**nicht addiert**. Himmelsrichtung und Nah-/Fernziel stammen aus den entsprechenden
amtlichen Richtungsfeldern. Die Himmelsrichtung beschreibt den überwiegenden
Streckenverlauf, keinen gemessenen lokalen Straßenwinkel.

Leere Zählwerte werden ausgelassen, nicht mit null, Nachbarwerten oder einer
Richtungssumme ersetzt. Explizite numerische Null bleibt gültig. Vollständig
gezählte Tage (`vT_MobisSo`) und amtliche Anmerkungen bleiben Qualitätshinweise.
Der Import ist auf die drei genannten Kfz-Jahreswerte beschränkt; Schwerverkehr,
Stundenwerte, andere Tagesgruppen und sonstige 2023-Kennwerte werden nicht als
zusätzliche Verkehrsbeobachtungen umgedeutet.

## Tatsächlicher Originaldaten-Nachweis

Der vollständige Originalexport enthält **2.116 eindeutige Stationskennungen**.
**559 Stationen** besitzen keine der drei Kfz-Jahresangaben. Aus den übrigen
**1.557 Stationen** entstehen **4.671 getrennte Beobachtungen**.

Ein unabhängiger Python-Standard-CSV-Reader hat alle Werte und Koordinaten aus
den Originalbytes gelesen. Sein Ergebnis wurde für sämtliche 4.671 Beobachtungen
exakt mit dem tatsächlichen Provider-/Registry-Ergebnis verglichen. Zusätzlich
wurden die ursprünglichen UTM32-Koordinaten mit `proj4 2.22.0` gegengeprüft:
medianer Unterschied 0,472 m, maximal 0,706 m zu den mitgelieferten WGS84-Werten.
Das ist nur eine Konsistenzprüfung zweier Koordinatendarstellungen mit gerundeten
UTM-Metern und näherungsweise gleich behandelten ETRS89/WGS84-Systemen; daraus
folgt keine Stationsgenauigkeit, Straßenpassung oder Fahrstreifenauflösung.

Die kleine Originaldaten-Fixture unter `tests/fixtures/traffic/bast/` enthält
den unveränderten Header und die vollständigen Originalzeilen 2, 10 und 1236
(Stationen 2218, 1102 und 5253). Sie behält ISO-8859-15 und Originalzeilenenden.
Sie wird verlustfrei als `jawe2023-original-excerpt.csv.gz` gespeichert; die
Originalbytes werden vor dem Parser entpackt, nicht als UTF-8 umgedeutet.
`provenance.json` bindet Original, Ausschnitt, Spaltenbeschreibung, Lizenzmetadaten
und unabhängige Prüfzähler. Die Fixture ist ein ausdrücklich gekennzeichneter
Ausschnitt und wird vom Produktionslader nicht als vollständige Distribution
akzeptiert.
Die unveränderten vollständigen Turtle-Metadaten liegen verlustfrei komprimiert
als `govdata-metadata.ttl.gz` bei; ihr Originalhash gilt für die entpackten Bytes.

Die vollständige amtliche CSV liegt zusätzlich als `jawe2023-original.csv.gz`
für die CI-Regression des echten Produktionsladers vor. Der normale Hash- und
Bytegrößencheck bleibt aktiv. Die Registry erhält nur bei ausdrücklich
gesetztem `country: 'DE'` die 4.671 Beobachtungen; leere Kontexte, reine
Stadtanfragen, `de` und `NL` bleiben ohne Ergebnis. Ein testweise entferntes
Ländergate lässt diese Regression nachweislich scheitern.

## Optionale Verwendung

```js
const bast = require('./scripts/providers/bast_annual_dtv_provider');
const traffic = require('./js/ua.traffic_provider');
const registry = traffic.createRegistry();
registry.register(bast.createBastAnnualDtvProvider({
  allowedRoot: '/controlled/import/root',
  csvPath: 'Jawe2023.csv',
  expectedDistributionSha256: '5108764655cc3d75878a887d4631f787d8216c54bb3fc3b63460c1a7b0fcb550',
  expectedBytes: 1878927,
  retrievedAt: '<tatsächlicher ISO-8601-Abrufzeitpunkt mit Uhrzeit und Zeitzone>',
}));
const observations = await registry.collect({country: 'DE', failOnProviderError: true});
```

Nur `country: 'DE'` fragt diesen optionalen überregionalen Provider ab. Eine
gewöhnliche Stadtanfrage aktiviert ihn nicht. Der stadtbezogene generische
JSON-Snapshot-Katalog wird nicht erweitert oder aufgeweicht. Originalhash,
Bytezahl, Spaltenlayout, Pfadgrenze und symlinkfreie Datei werden streng geprüft;
andere Jahrgänge benötigen eine neue ausdrückliche Prüfung.

## Anwendung im Stadtgenerator

`CONTEXT_BAST_ANNUAL_COUNTS_CITY=Hamburg npm run generate:context-city -- --city Hamburg`
aktiviert den Pfad für eine Stadt aus `cities.txt`. Der gehostete Kontextlauf
liest dieselbe Konfiguration aus der gleichnamigen Repository-Variable. Die
Kölner Konfiguration bleibt unabhängig. Der Generator lädt das amtliche CSV
in sein Staging-Verzeichnis, prüft Bytezahl und SHA-256 und installiert die
erzeugten Dateien erst nach der bestehenden Validierung. Bei aktivierter
Quelle wird ein älterer OSM-Cache ohne Straßennummern und Richtungsattribute
neu erzeugt. Bei HTTP 429 und Serverfehlern der BASt kann ein geplanter Lauf
mit aktiviertem Fallback den letzten validierten Stadtstand behalten.
Fehler bei Lizenz, Dateigröße oder Prüfsumme brechen den Lauf ab.

Für die Verknüpfung wird nur der originale Kfz-Querschnitt `Q` einer
nummerierten Bundesstraße ohne amtlichen Straßenzusatz verwendet. Der amtliche
Stationspunkt muss höchstens 12 m vom OSM-Way mit derselben Straßennummer
liegen. Mehrere Ways derselben Bundesstraße innerhalb von 25 m oder mehrere
Stationen auf demselben Way bleiben mehrdeutig. Der passende Way braucht eine
geeignete Hauptstraßenklasse und entweder `oneway=no` oder ausdrücklich
gekennzeichnete Fahrstreifen in beiden Richtungen mit derselben Gesamtzahl wie
der BASt-Querschnitt. Abweichende Richtungs- oder Zugangstags, Tunnel, Brücken
und Kreisverkehre schließen eine Zuordnung aus.

Der Jahreswert kommt als lokaler Kontext an Kfz-Unfallpunkte aus **2023** auf
demselben eindeutig zugeordneten Way innerhalb von 150 m der Zählstelle. Der
Unfallpunkt muss zusätzlich bis auf 10 m an diesem Way und mehr als 10 m von
jedem anderen Kfz-Way liegen. Rad-, Fuß- und sonstige Beteiligung müssen
ausdrücklich ausgeschlossen sein. Die übrigen Fälle behalten den qualitativen
OSM-Proxy. Die Straßenkarte behält den Proxy auf dem gesamten
Straßennetz, da ein punktueller Querschnitt keine Belastung über die Länge
eines OSM-Ways belegt. Der Unfallkontext bewahrt den amtlichen Stationspunkt,
Querschnitt, Messperiode und vollständigen Quellenbezug. Die Anzeige nennt
die Entfernung vom Unfallpunkt zur Zählstelle. Der Abstand der Zählstelle zum
OSM-Way steht separat in den Qualitätshinweisen. Der Wert beschreibt den
Jahresmittelwert am Zählquerschnitt. Die bestehende Altersgrenze
kennzeichnet historische Werte weiterhin im späteren Bezugsjahr.

Die OSM-Geometrie und Straßentags stammen von **© OpenStreetMap contributors**
unter [ODbL 1.0](https://www.openstreetmap.org/copyright). Die Metadaten
speichern getrennt vom amtlichen CSV den OSM-Eingabehash und die gemeldete
Abdeckung, einschließlich eindeutiger und mehrdeutiger Stationsbezüge und
der Anzahl angewandter Werte.

Der Hamburger Referenzfall verbindet den amtlichen Querschnitt der Station
2201 (Kollaustraße, B 447) mit dem Unfallpunkt 9757 aus 2023. Der originale
Wert beträgt **45.865 Kfz/24 h**. Der [OSM-Way 1561698173](https://www.openstreetmap.org/way/1561698173)
weist drei Fahrstreifen in der einen und vier in der anderen Richtung aus.
Der Unfallpunkt 62075 bei St. Mauritz (B 481) behält den Proxy, weil am Punkt
zusätzlich eine Zufahrt liegt. Die beiden Fixtures enthalten die relevanten
Unfallfelder aus dem veröffentlichten Bestand sowie Straßenattribute und
geordnete Geometrien aus dokumentierten OSM-API-Ausschnitten.

## Verbleibende Grenzen von #413

Die BASt-Richtungswerte `Ri1` und `Ri2` bleiben getrennt im Stationsimport.
Ihre Himmelsrichtungen und Ziele beschreiben die amtliche Route; für die
Anwendung auf einzelne Fahrbahnen fehlt ein entsprechend geprüfter Bezug.
Für den [Düsseldorfer Stundenwert-Piloten](duesseldorf-bicycle-hourly-provider.md)
braucht die zeitliche Anwendung eindeutige Quellzeitlabels und Richtungen.
Modellwerte, BASt-Jahres-DTV, werktäglicher Kölner Verkehr und stündliche
Radwerte sind unterschiedliche Messgrößen. Die fachliche Abnahme und die
Kontrolle einer aktivierten Veröffentlichung bleiben gesonderte Schritte.
