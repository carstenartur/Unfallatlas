# Region Hannover im gemeinsamen Dokumentenindex

## Geprüfter Import am 8. November 2026

Die tatsächliche öffentliche ALLRIS-Übersicht wurde über den regulären Sitzungsclient,
den veröffentlichten Ladecallback und die angebotene Seitennavigation ausgelesen.
Es wurden keine Vorlagennummern oder Dokument-URLs durchprobiert.

| Prüfung | Tatsächliches Ergebnis |
|---|---:|
| Amtlich angegebene Trefferzahl der Vorlagenübersicht | 14.055 |
| Eindeutige erfasste `VOLFDNR` | 14.055 |
| Erfolgreiche Detailabrufe | 2.000 |
| Vorlagen mit extrahiertem Sachtext | 1.929 |
| Vorlagen mit Beratungsereignissen | 1.848 |
| Belegte Beratungsereignisse | 4.451 |
| Vorlagen mit Original-PDF-Link | 1.746 |
| Fehlgeschlagene Detailabrufe | 0 |
| Noch nicht geprüfte Detailseiten | 12.055 |

Die Freigabedaten reichen vom **25. Februar 2004 bis 6. November 2026**.
`collection.listComplete: true` bezeichnet den abgeschlossenen öffentlichen
Listendurchlauf. `coverage.complete: false` und der Quellenstatus `partial` bleiben
bestehen, da damit weder sämtliche Detailseiten noch ein vollständiges PDF-Archiv
erschlossen sind. Die anfängliche Datumsordnung lieferte überlappende Seiten.
Die abschließende Kontrolle vom **18:55:56 bis 18:57:11 UTC** verwendete deshalb
die vom Portal selbst angebotene aufsteigende Nummernsortierung. In **144 regulären
Listenabrufen** wurden genau **14.055 aktuell unterschiedliche IDs** beobachtet,
unabhängig von historisch gespeicherten Einträgen. Der Collector und ein separater
Laufzähler bestätigten dieselbe vollständige Menge. Die 2.000 vorhandenen
Detailprüfzeiten und sämtliche Detailtext-/Ereignis-/Statuswerte blieben unverändert;
es gab bei dieser Kontrolle keine Detailnetzabrufe.
Drei alte Vorlagen ohne eingetragene Art bleiben als `Sonstige` erhalten.

## Gemeinsamer Snapshot

Der reale Regionsbestand wurde mit dem bereits verifizierten historischen SIM-Cache
über `collectCombinedHannoverCatalogue` und `refreshRisCatalogues` zusammengeführt.
Die städtischen Detailabrufe wurden für diese lokale Reproduktion nicht erneut
angefordert. Vorhandene Belege behalten deshalb ihre ursprünglichen Quellenzeiten.

| Inhalt | Anzahl |
|---|---:|
| Städtische SIM-Dokumente | 54.217 |
| Regionale ALLRIS-Vorlagen | 14.055 |
| Dokumente insgesamt | 68.272 |
| Dokumente mit Kartenbezug insgesamt | 3.896 |
| Davon neu aus dem Regionsbestand | 1 |
| Einmal gespeicherte Geometrien | 1.993 |
| Validierte Indexdateien | 3.038 |
| Komprimierte Indexdateien zusammen | 13.145.753 Bytes |

Alle Dokumente durchlaufen dieselbe Ortsprüfung. Der vorhandene Gazetteer deckt
die Landeshauptstadt ab; für Regionsdokumente wird jede Ortsfundstelle zusätzlich
auf einen unmittelbaren Bezug zu dieser Stadt geprüft. Der einzelne neue Kartenbezug
ist **Ohestraße 6 in Hannover**, belegt in Vorlage `VOLFDNR=1007559`.
Die übrigen Regionsvorlagen bleiben über den Dokumentenindex zugänglich.
Es werden keine Straßen in anderen Regionskommunen mit gleichnamigen städtischen
Straßen gleichgesetzt.

Der anschließende Vergleich der nummernsortierten aktuellen Übersicht mit dem
gemeinsamen Snapshot fand **keine fehlenden IDs und keine Abweichungen bei Titel,
Nummer, Datum, Typ, URL oder Quellenkennung** für die 14.055 Regionsvorlagen.

Die Quellenzeit der regionalen Teilsammlung im initialen gemeinsamen Snapshot ist
`2026-11-08T17:47:15.966Z`. Die spätere vollständige Inventarkontrolle liefert als
konservativen Katalogstand `2026-11-08T17:56:21.253Z`, weiterhin begrenzt durch die
unveränderten echten Detailprüfzeiten.
Der gemeinsame Snapshot behält wegen älterer städtischer Belege konservativ
`2026-11-07T19:59:34.477Z`. Der lokale Aufbau erfolgte ab
`2026-11-08T18:10:31.648Z`; dieser Aufbauzeitpunkt ersetzt keine Quellenprüfung.

## Recherche und Nachweis

Die echte Suche nach **`2073 (V) BDs`** über `createRisSnapshotSearch` liefert
die regionale Kanalradwege-Vorlage `region-hannover-ris:vo:2003037` und den
Änderungsantrag `region-hannover-ris:vo:2003261`, jeweils mit regionaler Herkunft
und amtlichem Link. Die Vorlage bleibt eine Beschlussdrucksache mit Status
`proposal`; ihre belegten Beratungen vom 7. und 19. September 2023 werden getrennt
geführt und nicht als Dokumentdatum ausgegeben.

Der reguläre fortsetzbare Import und die anschließende Dateiprüfung bleiben:

```sh
node scripts/refresh-ris-catalogues.js --city hannover
node scripts/refresh-ris-catalogues.js --validate data/ris
```

Generierte Snapshots, Rohantworten, Cookies und Sitzungscallbacks werden nicht
eingecheckt. Der reguläre Pages-Build veröffentlicht dasselbe begrenzte,
inhaltsadressierte Indexformat.

## Lokale Repository-Prüfung

Der erste vollständige lokale Jest-Lauf bestand mit **363 erfolgreichen Testsuites und 4.211
erfolgreichen Tests**; fünf Suites und elf Tests wurden wie vorgesehen übersprungen.
Die anschließend angepassten Cache-Versionen der drei RIS-Browsermodule wurden
zusätzlich durch die 21 Asset-Versionierungstests geprüft. Die lokale Laufzeit war
Node.js 24.22.1; die verbindliche CI verwendet die im Repository gepinnte Laufzeit.
Die spätere PR-Prüfung ergänzte funktionale Regressionen für tatsächliche
Inventarvollständigkeit, faire Erneuerung alter Details und die Reihenfolge
bestätigter Rücknahmen gegenüber älteren lokalen oder veröffentlichten Snapshots.
Eine 28-Tage-Simulation mit 15 Dokumenten und zwei täglichen Abrufen prüft die
Fortsetzung unter einer höheren Lastquote als 14.055 Dokumente bei 2.000 Abrufen.
Der reguläre Veröffentlichungsweg bietet dazu täglich einen begrenzten Lauf:
montags bis samstags den bestehenden aktuellen Datenaufbau, sonntags die bestehende
vollständige Datenerneuerung. Quellenzeiten werden dadurch nicht künstlich erneuert.
Die gezielte Abschlussprüfung der acht betroffenen Testsuites bestand mit
**283 Tests**, darunter alle **60 Collector-Tests**. Die engen Review-Fälle zu
parallelen Cacheprüfungen, alten Checkpoints und zusätzlichen Navigationsschritten
wurden ebenfalls zuerst reproduziert und anschließend abgesichert.
