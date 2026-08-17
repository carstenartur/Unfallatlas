# Entdeckungsfilter, vollständiges Gebietskollektiv und nummerierte Beweisanlage

## Fachliche Leitregel

Die Filter der Unfallwerkbank sind **Such- und Priorisierungsinstrumente**. Sie sollen vermeidbare Unfallmuster sichtbar machen und helfen, knappe Mittel dort einzusetzen, wo ein hoher Sicherheitsnutzen zu erwarten ist. Sie definieren nicht den Umfang der Tatsachenbasis eines kommunalpolitischen Antrags.

Sobald ein relevanter Untersuchungsbereich festgelegt ist, unterscheidet die Unfallwerkbank drei Ebenen:

1. **Entdeckungskollektiv** – Unfälle, die unter den aktiven Beteiligungs-, Schwere-, Zeit-, Straßen- und Kontextfiltern sichtbar werden. Dieses Kollektiv dient der Mustererkennung und Priorisierung.
2. **Vollständiges Gebietskollektiv** – alle im Unfallatlas veröffentlichten Unfälle mit Personenschaden innerhalb der Auswahlgrenzen. Dieses Kollektiv bildet die vollständige Antrags- und Beweisgrundlage.
3. **Referenzkollektiv** – die für den jeweiligen statistischen Vergleich verwendete Referenzpopulation, insbesondere für den Vergleich lokaler und stadtweiter Anteile von Beteiligungsmustern.

Die Entdeckungsteilmenge muss eine Teilmenge des vollständigen Gebietskollektivs sein. Ein Antrag darf die gefilterte Teilmenge niemals als Gesamtunfallzahl des Gebiets ausgeben oder andere Gebietsunfälle stillschweigend ausblenden.

## Datenvertrag

`unfallwerkbank.evidenceCohorts.v1` enthält:

- Auswahlgrenzen und verfügbaren Berichtszeitraum;
- aktiven Filtersnapshot;
- IDs und Anzahl der Entdeckungsteilmenge;
- IDs, vollständige Zeilen und Anzahl des Gebietskollektivs;
- die Zahl der zusätzlich berücksichtigten Unfälle;
- eine nummerierte Karten-URL;
- die Regel zur besonderen Priorisierung vulnerabler Gruppen.

Jeder Unfall erhält eine snapshotgebundene Kennung `A001`, `A002`, … sowie einen technischen `sourceFingerprint`. Die sichtbare Kennung verbindet:

- Unfallliste;
- nummerierte Übersicht und Detailkarten;
- KI-Kartenbefunde und Pattern-Evaluierungen;
- Maßnahmenbegründungen;
- CSV-/GeoJSON-Anlagen und Quellenprüfung.

Die Nummerierung erfolgt deterministisch nach veröffentlichten Zeit-/Lageattributen und Fingerprint. Vorhandene Quell-IDs bleiben zusätzlich erhalten.

## Vollständige Beweisanlage

Der Exportdialog bietet eine eigene Beweisanlage:

- interaktive nummerierte Karte;
- PDF mit Übersicht, automatisch aufgeteilten Detailkarten und ungekürzter Tabelle;
- CSV mit Kennung, Fingerprint, veröffentlichten Unfallattributen und Deep-Link;
- GeoJSON mit denselben Kennungen und der ursprünglichen Feature-Provenienz.

Die Übersicht darf bei vielen Punkten dicht sein. Die Detailkarten werden deshalb rekursiv in räumlich zusammenhängende Gruppen mit begrenzter Punktzahl aufgeteilt. Jede Tabellenzeile nennt die zugehörige Karte.

## Priorisierung und vulnerable Gruppen

„Most bang for the buck“ wird als transparenter Entscheidungsauftrag verstanden, nicht als verdeckte Rangzahl. Für jeden Maßnahmenkandidaten sind mindestens zu betrachten:

- erwartbarer Sicherheitsnutzen;
- Zahl, Schwere und Wiederholung der adressierten Unfälle;
- Evidenzstärke und Plausibilität des Mechanismus;
- Reichweite auf das vollständige Gebietskollektiv;
- Kosten, Umsetzungszeit und Zielkonflikte;
- mögliche Risikoverlagerung;
- Schutz besonders verletzlicher Menschen.

Schulen und Kindertagesstätten sind kein automatischer Unfallursachennachweis. Ihr Umfeld erhöht jedoch Schutzbedarf und Prüfpriorität für Geschwindigkeit, Querungen, Sicht, Bring-/Holverkehr sowie durchgängige Fuß- und Radverkehrsführungen.

## KI-Vertrag

Die Untersuchungsphase muss ein `unfallwerkbank.evidenceCohortCoverage.v1` ausgeben. Darin bestätigt die KI:

- Gesamtzahl des Gebietskollektivs;
- alle berücksichtigten `A###`-Kennungen;
- vollständige Entdeckungsteilmenge;
- leere Liste ausgelassener Unfälle;
- ausdrückliche Berücksichtigung von Schulen, Kitas und anderen vulnerablen Gruppen.

Die Antragserzeugung bleibt gesperrt, wenn eine Kennung fehlt, ein Unfall ohne begründeten Datenfehler ausgelassen wird oder die gefilterte Entdeckungsteilmenge als vollständige Gebietsevidenz behandelt wird.

Für Maßnahmen muss zusätzlich beschrieben werden:

- welche `A###`-Unfälle unmittelbar adressiert werden;
- welche weiteren Gebietsunfälle ebenfalls profitieren könnten;
- welche Unfälle nicht adressiert werden;
- ob eine Verlagerung oder ein neuer Konflikt möglich ist.

## Grenzen

- Der Unfallatlas enthält veröffentlichte Unfälle mit Personenschaden; reine Sachschäden, Beinaheereignisse und nicht gemeldete Unfälle sind nicht Teil der Anlage.
- `A###` ist eine Dokumentkennung, keine amtliche Unfallnummer.
- Die veröffentlichte Lage darf nicht genauer interpretiert werden, als es die Quelldaten erlauben.
- Ein vollständiger Anhang bestätigt Unfallereignisse und ihre veröffentlichten Attribute, nicht automatisch eine gemeinsame Ursache.
