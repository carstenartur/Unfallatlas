# Pages-Prüfung Bonn Revision 7 und Quellbudget (15. November 2026)

## Veröffentlichungsbeleg und Einschränkung

Der Pages-Lauf [43746634608](https://github.com/carstenartur/Unfallatlas/actions/runs/43746634608) zu Main-Commit `63a49f0c117f992993bc875b067ed776ed4562dc` hat seinen Build und den eigenständigen Deployment-Job erfolgreich abgeschlossen. Das Deployment-Protokoll meldet am 15.11.2026 um **18:43:13 UTC** ausdrücklich `Reported success!` zur Bereitstellung des unveränderlichen Artefakts **14175455534** auf https://carstenartur.github.io/Unfallatlas/ . Ein separater byteweiser Abruf der aktuell ausgelieferten Live-Dateien war in der prüfenden Umgebung **nicht möglich**; der erfolgreiche Deployment-Status ist kein unabhängiger HTTP-Inhaltsabgleich.

Für den Vergleich wurde das vorherige unveränderliche [Pages-Artefakt 14166074058 aus Lauf 43709454440](https://github.com/carstenartur/Unfallatlas/actions/runs/43709454440) und das neue Artefakt 14175455534 lokal dekomprimiert. Alle referenzierten RIS-Records-, Location- und Geometry-Partitionen beider Städte wurden anhand der im jeweiligen Manifest enthaltenen SHA-256 geprüft und ihre Datensätze inhaltlich verglichen. Nicht nur Zähler, sondern die bestehenden Objekt-IDs, Ortsbezüge und vollständigen Geometrien einschließlich ihrer Eigenschaften wurden geprüft.

| Prüfung | Vorher | Nachher | Befund |
| --- | ---: | ---: | --- |
| Bonn, amtliche Vorgangs-IDs | 25.206 | 25.206 | Keine ID verloren |
| Bonn, Vorgänge mit Kartenbezug | 1.839 | 1.856 | **+17**, keine früheren Zuordnungen verloren |
| Bonn, Kartenfeatures laut Produktionsbericht | 1.840 | 1.869 | **+29**, alle bisherigen Features geometrisch und semantisch unverändert |
| Hannover, amtliche Vorgangs-IDs | 109.605 | 109.605 | Keine ID verloren |
| Hannover, Vorgänge mit Kartenbezug | 8.004 | 8.004 | Keine frühere Zuordnung verloren |
| Hannover, räumliche Features | 3.395 | 3.395 | Unverändert |

Die neue Bonner Manifestgeneration lautet `4c71e279a6034af7735715684707c4fe7b256998bb5c3ccc9498b785c1f63753` (Ortsrevision **7**); die alte Generation `ff40877c2189cce18fb4d022cc22ab3a7eabb0a7de71f03602047075d2863280` (Revision **6**). Hannovers Ortsrevision **17** bleibt gegenüber dem vorigen Artefakt unverändert. Das neue Bonner Manifest wurde als Datei zusätzlich mit SHA-256 `c4bd0acf7d5d75e75427f50879c3e342802062cdea0af02eb4e5416b94ddd45d` geprüft.

## Quellserver-Schonung als Release-Sicherheitsgrenze

Der Build-Job [132911264925](https://github.com/carstenartur/Unfallatlas/actions/runs/43746634608/job/132911264925) hat am 15.11.2026 um **18:32:00 UTC** `scripts/refresh-ris-catalogues.js --max-refresh-duration-ms 3900000` **ohne explizites Nullbudget** ausgeführt. Das Protokoll enthält anschließend Hannover-Quellsuche und Cache-Statistiken (u. a. `hits:24, misses:10, writes:0`). Daraus folgt **keine belastbare Anzahl tatsächlicher kommunaler HTTP-Requests**; eine host- und tagesübergreifende Abrufbilanz ist damit aber nicht nachgewiesen. Der Bonner Snapshot wurde als `current` übernommen. Aus dem grünen Build darf eine Einhaltung des öffentlichen Tagesbudgets nicht gefolgert werden.

Die Korrektur in diesem PR setzt für die reguläre Maven-Pages-Veröffentlichung `--work-budget 0` und verweigert bei diesem Wert den Eintritt in einen amtlichen Quellkollektor. Vorhandene veröffentlichte RIS-Partitionen können weiter restauriert, auf neue lokale Ortsregisterregeln geprüft und veröffentlicht werden. Die gesonderte, explizit ausgelöste **manuelle Hannover-Checkpoint-Reparatur** bleibt möglich, weil sie nachweislich aus ihrem exakten lokalen Cache und ohne öffentliche Quellenarbeit liest. Automatische Aktualisierung der kommunalen Quellen wird damit bewusst ausgesetzt, bis ein hostübergreifend persistentes und überprüfbares Request-/Bytebudget einschließlich Sperrpfaden existiert. Frische und Ablaufzeit der vorhandenen Snapshots sind weiterhin getrennt zu beobachten. GitHub Pages ist nicht der kommunale Ursprungsserver, jedoch ebenfalls schonend und mit unveränderlichen Artefakten zu behandeln.

## Kontrollstichprobe

Die feste [Historie R1–R7 mit 140 IDs](2026-11-14-ris-stichproben-ids.json) ist unverändert. Der [Bonner Arbeitsstapel](2026-11-15-bonn-lesestapel.md) dokumentiert **98 gesichtete eindeutige Fälle** und **zehn offene Lesepositionen 91–100**. Es wurde keine neue reguläre 20er-Kontrollrunde gezogen: Das unveränderte erste private Hannover-/Bonn-/Region-Lesepaket mit 51 protokollierten Einträgen ist in dieser Ausführungsumgebung nicht verfügbar. Ohne verlässliche Rekonstruktion seiner bereits fachlich gesichteten IDs würde eine neue Auswahl Doppelprüfungen riskieren. Das Fehlen der ZIP rechtfertigt **keinen** erneuten Abruf von bereits bekannten Originalen. Die R7-Kohorte hatte nachweislich Orts- und Maßnahmenbelege und war keine Nullstichprobe. Die bestehende Arbeitsfortsetzung darf daher nicht deaktiviert werden.
