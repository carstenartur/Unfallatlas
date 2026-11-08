# Teilbare Ratsvorgänge und nachvollziehbarer Beratungsverlauf

## Auftrag

Eine erarbeitete Ansicht der Unfallwerkbank muss über ihre URL reproduzierbar sein. Das gilt für Ratsvorgänge ebenso wie für die übrigen Kartenebenen. Zusätzlich soll der Beratungsverlauf deutlich lesbarer werden, mit der Prozesslinie des Ratsatlas Bonn als gestalterischer Referenz.

## Verbindliches Verhalten

- `mapLayer` enthält künftig auch `ris`; die Reihenfolge bleibt `slope,traffic,ris`. Straßenebenen und RIS behalten getrennte Lader.
- Die URL bewahrt den Flächenfilter, den geöffneten Vorgang, den gewählten Bereich, die sichtbaren Datenseiten und den eingeklappten Zustand. Ein expliziter Link hat Vorrang vor lokal gespeicherten Einstellungen. Bestehende Ansichts-, Filter- und Auswahlparameter bleiben erhalten.
- Ein Vorgang kann ohne Geometrie geöffnet und geteilt werden. Öffnen verändert den geteilten Kartenausschnitt nicht. Die Dokumentansicht ist unabhängig davon, ob die RIS-Kartenebene eingeschaltet ist.
- Eine eigenständige, nicht modale Detailansicht bietet Beratungsverlauf, Zusammenhänge und Orte. Sie ist auf dem Telefon schließbar und einklappbar. Schaltflächen sind mindestens 44 Pixel hoch; keine horizontale Überbreite, eine zentrale Scrollfläche.
- Die vertikale Prozesslinie zeigt Datum, Gremium, Ergebnis, Beleg und Quellenlink. Fehlende Daten, nachgewiesen leere Daten und unvollständige Abrufe bleiben unterscheidbar. Dokumentart bedeutet nicht Verfahrensfortschritt. Es werden keine Phasen oder Beschlüsse erfunden.
- Direkte amtliche Querverweise und lediglich zusammenhängende Vorgänge werden getrennt bezeichnet. Interne Navigation nutzt ausschließlich stabile IDs des aktuellen Stadtkatalogs. Externe Links werden als HTTPS-URLs geprüft.
- Daten werden abschnittsweise und seitenweise geladen. Ein URL-Seitenwert lädt genau diese begrenzte Seite, keine Folge unbeschränkter Abrufe. Ungültige Seiten werden auf eine gültige Ansicht zurückgeführt. Die Anzeige benennt Teilmengen ausdrücklich; die geladenen Beratungen sind zeitlich sortiert, datumslose Einträge separat.
- Alte asynchrone Antworten dürfen nach Stadtwechsel, Dokumentwechsel oder Schließen keine Ansicht erneut öffnen oder überschreiben. Snapshots werden bei allen Detailabrufen beibehalten.

## Gemeinsame Schnittstellen

`ctx.contextOverlays.active.ris` ist die einzige Quelle für den Aktivierungszustand. `ctx.risView` enthält `selectionOnly`, `recordId`, `section`, `collapsed`, `eventsPage`, `relationsPage`, `relatedPage`, `locationsPage`. Standard: false/null/history/false/0/0/0/0. Der Bereich verwendet exakt `history`, `relations` oder `locations`.

URL-Schlüssel: `risSelectionOnly`, `risRecord`, `risView`, `risCollapsed`, `risEventsPage`, `risRelationsPage`, `risRelatedPage`, `risLocationsPage`. Boolesche Optionen verwenden `1`; Standardwerte werden weggelassen. Ohne Vorgang werden Bereich, Einklappzustand und Detailseiten zurückgesetzt, der Flächenfilter bleibt unabhängig.

`UA.RisViewState.normalize(value)`, `fromSearch(search)`, `toQuery(value)` bilden die reine Zustandsgrenze. IDs sind höchstens 2048 Zeichen lang. Seiten sind nichtnegative sichere Ganzzahlen; der Katalog begrenzt die tatsächlich verfügbare Seite.

`UA.RisRecordView.create({record,city,snapshot,view,isActive,onViewChange,onOpenRecord,onShowLocation,onAdopt})` liefert `{element,update(view),destroy()}`. Der Renderer besitzt die Abschnittslader. `onViewChange(patch)` wird vom Controller synchron in den kanonischen Zustand übernommen und anschließend über `update` zurückgespielt. `onShowLocation(record,location,options)` verwendet die bestehende Kartenfunktion. `onOpenRecord(id)` navigiert intern. Der Renderer verändert weder URL noch globale App-Zustände.

`UA.RisDetails.open(ctx,id,{section,trigger}={})`, `refresh(ctx)` und `close(ctx)` besitzen Dokumentauflösung, Ansichtsrahmen, Teilen, Schließen, Einklappen, Fokus und Lebenszyklus. `refresh` erfolgt nach der App-Hydration. Die bisherigen Karten-Popups und Suchkarten öffnen dieselbe Detailansicht. Es werden keine neuen Browser-History-Einträge angelegt.

## Abnahme

Ein frischer Browser mit widersprechender lokaler Speicherung stellt einen geteilten Link samt Karte, Ebene, Flächenauswahl, Vorgang und Bereich wieder her. Ebenso funktioniert ein unverorteter Regionsvorgang. Telefon und Tablet bleiben bedienbar. Die normale Build- und Testkette sowie unabhängige Codeprüfung prüfen die Änderung; die öffentliche Bereitstellung wird anschließend anhand konkreter Links geprüft.
