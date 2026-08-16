# Ergänzende Vergleichs-QA: semantische Kartenanalyse und Unfallhintergrundrecherche

**Datum:** 16. August 2026  
**PR:** #620  
**Prüffall:** markierter Bereich rund um Bonn Hauptbahnhof / ZOB / Münsterplatz / Maximilianstraße / Thomas-Mann-Straße  
**Bezug:** `docs/qa/ai-analysis-comparison-2026-08-16.md`

## 1. Korrektur des bisherigen KI-Mehrwertmaßstabs

Die bisherige Vergleichs-QA verlangte zwar eine visuelle Prüfung, verstand darunter aber überwiegend:

- Karte vorhanden und vollständig gerendert;
- Unfallpunkte, Auswahlgrenze und Legende sichtbar;
- Grafik nicht leer, abgeschnitten oder widersprüchlich.

Das ist notwendige Darstellungs-QA, aber noch keine fachliche Bildanalyse. Eine multimodale KI kann – anders als die deterministischen Berechnungen der Unfallwerkbank – mehrere Kartenansichten als Verkehrsszene lesen und nach ortsspezifischen Besonderheiten suchen. Der zusätzliche Auftrag muss deshalb ausdrücklich verlangen:

1. Standardkarte, Hybridkarte, Orthofoto und Analyseansicht bei identischen Filtern und Grenzen zu vergleichen;
2. potenziell relevante Stellen in Übersicht und Detailzoom zu prüfen;
3. sichtbare Infrastrukturmerkmale genau zu lokalisieren;
4. ihre räumliche Beziehung zu Unfallpunkten und Teilclustern zu beschreiben;
5. Beobachtung, Hypothese und extern bestätigten Kontext zu trennen;
6. nicht sicher erkennbare Details als `nicht beurteilbar` zu kennzeichnen, statt sie zu erraten.

## 2. Fachliche Prüfkategorien für die Kartenlektüre

### 2.1 Schienen und Gleise

Zu unterscheiden sind:

- eine neben dem Straßenraum verlaufende Hauptbahntrasse als Barriere beziehungsweise Ursache gebündelter Zu-/Unterführungsbewegungen;
- eine tatsächlich von Radfahrenden befahrbare oder zu querende Rillenschiene;
- der Winkel zwischen plausibler Radfahrlinie und Schiene;
- räumliche Zwänge, Kurven oder Verschwenkungen unmittelbar vor der Schienenquerung.

Eine sichtbare Bahntrasse ist nicht automatisch eine Schienensturzgefahr. Die KI muss zeigen, dass die Schiene tatsächlich in einer befahrbaren oder zu querenden Linie liegt.

### 2.2 Kurven, Verschwenkungen und Abbiegeradien

Zu prüfen sind insbesondere:

- enge Kurven und S-Kurven;
- abrupte Seitenwechsel einer Radverkehrsführung;
- kleine Abbiegeradien von Bus-, Taxi-, Liefer- oder Kfz-Verkehr;
- verdeckte Annäherungen;
- Kombinationen aus Kurve, Schiene, Gefälle, Haltestelle oder Querung.

### 2.3 Kreuzende Bewegungen

Die KI soll nicht nur Linien im Kartenbild benennen, sondern mögliche Bewegungsbeziehungen rekonstruieren:

- Wo kreuzen Kfz, Busse, Fahrräder und Fußverkehr einander?
- Führen Radwege durch Warte-, Ein-/Ausstiegs- oder Querungsbereiche?
- Gibt es Radwegenden, Seitenwechsel, Mischflächen oder Gegenrichtungsführungen?
- Überlagern sich erkennbare Fußgängerwunschlinien mit Busfahrgassen oder Radführungen?
- Werden Radfahrende durch parkende beziehungsweise haltende Fahrzeuge in den Kfz-Verkehr gedrängt?

### 2.4 Oberfläche und kleine bauliche Details

Kopfsteinpflaster, Fugen, Rinnen, kleine Kanten oder der aktuelle Zustand einer Markierung lassen sich aus einem normalen Karten- oder Screenshotmaßstab häufig nicht zuverlässig erkennen. Dafür gilt:

- nur bei hinreichender Bildauflösung benennen;
- Befliegungs-/Aufnahmestand berücksichtigen;
- mit OSM-`surface`, Straßenansicht, aktueller Fotodokumentation, Planunterlagen oder Vor-Ort-Begehung gegenprüfen;
- sonst ausdrücklich `nicht sicher beurteilbar` ausgeben.

## 3. Zusätzliche Erkenntnisse im Bonner Prüffall

Die visuelle Szene ist kein gewöhnlicher Straßenabschnitt, sondern ein komplexes intermodales Bahnhofsumfeld. Die Auswahl umfasst beziehungsweise berührt:

- den Hauptbahnhof mit gebündelten Zu- und Abgangsbewegungen;
- den Zentralen Omnibusbahnhof mit Busfahrgassen und Bussteigkanten;
- Schienen beziehungsweise Gleisbereiche;
- stark frequentierte Fußwege und Querungswunschlinien;
- Radverkehrsverbindungen zwischen Innenstadt, Bahnhof und Südstadt;
- mehrere gekrümmte Zu-/Ausfahrts- und Abbiegebeziehungen.

Daraus entstehen mehrere getrennt zu prüfende Konfliktsysteme. Die KI darf die 37 Rad-Pkw-Unfälle deshalb nicht vorschnell mit einem einzigen sichtbaren Merkmal erklären. Sie kann aber gezielt prüfen, ob Unfallpunkte an Führungswechseln, Schienenquerungen, engen Kurven, Bus-/Taxi-Zufahrten oder überlagerten Fuß-/Radbewegungen liegen.

## 4. Ergebnis einer kurzen externen Unfallhintergrundrecherche

Die Recherche wurde bewusst auf amtliche Polizeimeldungen und unmittelbar ortsbezogene Ereignisse konzentriert. Die Treffer sind **zusätzlicher Kontext**, keine nachträgliche Erweiterung der deterministisch gezählten 37 Rad-Pkw-Unfälle.

| Datum des Ereignisses | Ort und räumliche Passung | Berichteter Mechanismus | Bedeutung für die Kartenhypothese | Quelle |
|---|---|---|---|---|
| 22.09.2021 | Straße „Am Hauptbahnhof“, kurz vor dem Haupteingang – gleicher Ort | Eine Radfahrerin stürzte schwer; nach damaligem Ermittlungsstand könnte ein Reifen in eine Straßenbahnschiene geraten sein. | Die Schienenfrage ist im exakten Bahnhofsumfeld nicht nur eine abstrakte Bildhypothese. Zu prüfen sind aktuelle Schienenlage, Querungswinkel und heutige Radführung. | Polizei Bonn: https://www.presseportal.de/blaulicht/pm/7304/5027892 |
| 25.06.2025 | ZOB, Bussteig D/C1 – gleicher Ort | Ein Bus beschleunigte aus ungeklärter Ursache und fuhr mit einem Vorderrad auf den Bussteig; mutmaßlich drei Frauen wurden leicht verletzt. | Belegt die sicherheitsrelevante Nähe von Busfahrgassen und Aufenthalts-/Warteflächen. Die technische Ursache dieses Einzelfalls darf nicht verallgemeinert werden. | Polizei Bonn: https://www.presseportal.de/blaulicht/pm/7304/6064005 |
| 21.08.2025 | ZOB – gleicher Ort | Ein Fußgänger trat vom Bussteig auf die Fahrbahn und wurde von einem anfahrenden Linienbus erfasst; er starb später an den Verletzungen. | Stützt den Prüfbedarf für Bussteigkanten, Sicht, Fußgängerwunschlinien und beginnende Busbewegungen. Der Fall gehört nicht zum Rad-Pkw-Filter. | Polizei Bonn: https://www.presseportal.de/blaulicht/pm/7304/6102475 |
| 15.07.2025 | Thomas-Mann-Straße/Budapester Straße – unmittelbar angrenzender Knoten | Ein rechts abbiegender Linienbus erfasste eine Fußgängerin an der Fußgängerfurt; sie wurde schwer verletzt. | Zeigt einen konkreten Abbiege-/Querungskonflikt in der angrenzenden Bewegungsachse. Er ist als Nachbarbefund, nicht als Unfall innerhalb jeder Auswahlgeometrie zu kennzeichnen. | Polizei Bonn: https://www.presseportal.de/blaulicht/pm/7304/6077749 |
| 18.10.2025 | Maximilianstraße – gleicher beziehungsweise unmittelbar angrenzender Korridor | Ein Radfahrer erfasste einen 14-jährigen Fußgänger; der Jugendliche wurde verletzt. | Stützt die Prüfung überlagerter Fuß- und Radbewegungen auf der Bahnhof-/Innenstadtachse. Der Fall gehört nicht zum Rad-Pkw-Filter. | Polizei Bonn: https://www.presseportal.de/blaulicht/pm/7304/6142648 |
| 31.08.2020 | Busbahnhof am Hauptbahnhof – gleicher Ort | Bei Kontrollen stellte die Polizei unter anderem in zweiter Reihe parkende Fahrzeuge fest, die Radwege blockieren und Radfahrende zum Einordnen in den fließenden Verkehr zwingen; außerdem wurden unzulässige Fahrten in gesperrte Bereiche geahndet. | Liefert ortsbezogenen Hintergrund zu Radführungsunterbrechungen, Mischflächen und regelwidrigen Bewegungen. Eine Kontrolle ist kein Unfallnachweis, aber ein relevanter Konflikthinweis. | Polizei Bonn: https://www.presseportal.de/blaulicht/pm/7304/4694616 |

## 5. Belastbare Synthese aus Karte, Statistik und Recherche

### 5.1 Schienen als konkret zu prüfende Gefahrenstelle

Der amtliche Bericht von 2021 nennt im exakten Bahnhofsumfeld einen möglichen Sturz durch eine Straßenbahnschiene. Damit darf die KI die aktuelle Hybrid-/Orthofotoansicht gezielt auf folgende Fragen untersuchen:

- Sind die damaligen Schienen noch vorhanden?
- Welche Radfahrlinie ist heute vorgesehen beziehungsweise tatsächlich naheliegend?
- In welchem Winkel wird die Schiene gekreuzt?
- Erzwingen Kurven, Hindernisse oder andere Verkehrsteilnehmer einen flachen Querungswinkel?
- Liegen Unfallpunkte oder dokumentierte Stürze an derselben Stelle?

Das ist mehr als die allgemeine Aussage „Schienen könnten relevant sein“. Es entsteht ein konkreter, quellenbegründeter Prüfauftrag.

### 5.2 ZOB als Bus–Fuß–Rad-Konfliktraum

Die ZOB-Meldungen zeigen mindestens zwei unterschiedliche Mechanismen:

- Konflikt zwischen beginnender Busbewegung und einer Person, die vom Bussteig in die Fahrgasse tritt;
- Fahrzeugbewegung auf beziehungsweise über die Bussteigkante.

Zusammen mit der visuellen Lage von Busfahrgassen, Warteflächen und Bahnhofszugängen rechtfertigt dies eine genaue Prüfung der Flächenzuordnung, Sichtbeziehungen, Querungswunschlinien und Radverkehrsführung. Die Meldungen erklären nicht automatisch die 37 Rad-Pkw-Unfälle; sie zeigen aber, dass eine reine Pkw-Rad-Perspektive das tatsächliche Sicherheitsumfeld zu eng beschreiben würde.

### 5.3 Mehrere Konfliktsysteme statt einer einzigen Ursache

Die Treffer an Maximilianstraße und Thomas-Mann-Straße weisen auf weitere Mechanismen hin:

- Fuß- und Radverkehr auf überlagerten beziehungsweise schwer lesbaren Bewegungsachsen;
- Abbiegekonflikte mit Fußgängerfurten;
- Übergänge zwischen ZOB, Innenstadt, Bahnhof und Südstadt.

Die KI sollte den Korridor daher mindestens segmentieren in:

1. Schienen-/Bahnhofsvorplatzbereich;
2. ZOB und Bussteig-/Fahrgassenbereich;
3. Maximilianstraße und Fuß-/Radachse;
4. Thomas-Mann-Straße/Budapester Straße mit Abbiege- und Querungsbeziehungen;
5. weitere Rad-Pkw-Teilcluster aus dem deterministischen Unfallkollektiv.

## 6. Zwingende Grenzen der Recherche

- Presse- und Polizeimeldungen sind ereignisbezogen und nicht vollständig; fehlende Treffer bedeuten nicht, dass kein Unfall stattfand.
- Ein Bericht darf nur nach räumlichem und sachlichem Abgleich dem Untersuchungsraum zugeordnet werden.
- Ereignisse mit Bus/Fuß oder Rad/Fuß dürfen nicht in die Zahl der 37 Rad-Pkw-Unfälle eingerechnet werden.
- Ein möglicher Mechanismus eines Einzelfalls ist keine Ursache für die gesamte statistische Häufung.
- Aktuelle Infrastruktur kann vom Zustand zum Unfallzeitpunkt und vom Befliegungsstand des Orthofotos abweichen.

## 7. Umgesetzter Produktvertrag

PR #620 erhält zusätzlich:

- `unfallwerkbank.visualSceneAnalysis.v1`
  - mehrere gebundene Kartenansichten;
  - Pflichtprüfung von Schienen, Kurven, Kreuzungen, Haltestellen, Radführungswechseln, Sicht und Oberfläche;
  - Beobachtungsschema mit Lage, Ansicht/Zoom, Unfallbezug, Konfidenz, Gegenhypothese und Verifikation;
  - automatische Ablehnung bei bloßer Karten-Lesbarkeitsprüfung oder geratenen Oberflächenmerkmalen;

- `unfallwerkbank.accidentBackgroundResearch.v1`
  - Primärquellen-Priorität;
  - dokumentierter Suchplan;
  - räumliche Klassen `inside-selection`, `immediate-adjacency`, `citywide-analogue`, `unknown-or-unrelated`;
  - Ereignistabelle und Nulltrefferprotokoll;
  - Verbot, einen Einzelfall als Erklärung des Gesamtmusters auszugeben.

Der nutzerseitige KI-Auftrag wird dadurch von einer textorientierten QA zu einem multimodalen Untersuchungsauftrag erweitert. Ein einreichungsreifer Antrag setzt nun entweder eine dokumentierte semantische Kartenanalyse und Unfallhintergrundrecherche oder eine ausdrückliche, nachvollziehbare Nichtdurchführbarkeit voraus.
