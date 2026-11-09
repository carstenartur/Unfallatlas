# Ratsdokumente als zusammenhängender Kartenarbeitsbereich

## Auftrag und Referenz

Carsten verlangt eine deutlich bessere GUI, konkret am Ratsatlas Bonn und dessen offenem Quellcode orientiert. Die bisherigen Detail-Tabs allein erfüllen das nicht. Die Ergänzung vom 9. November macht Stadt, Region und Land zu gleichwertigen, verknüpfbaren Quellenebenen; Deutschland und EU sollen ergänzbar bleiben.

Referenz: https://github.com/daimpad/ratsatlas-bonn, insbesondere `site/app.js` (Panelsteuerung, Trefferliste, Auswahl und Prozesslinie), `site/style.css` (Kartenarbeitsbereich und mobile Panels) und `site/prozesse.js` (belegte Abläufe). Die Umsetzung bleibt im vorhandenen JavaScript-/Leaflet-System. Die vorhandene MIT-Lizenznotiz bleibt erhalten.

## Entscheidung

Die bestehende Recherche wird zur nichtmodalen Seitenleiste. Trefferliste und gemeinsame Vorgangsansicht bleiben nebeneinander verfügbar; mobil wechselt man mit einer klaren Zurück-Aktion zwischen beiden. Die Karte bleibt bedienbar und beide Ansichten lassen sich einklappen. Die vorhandenen Detail-, Quellen-, Export- und Kartenlader werden weiterverwendet. Eine zweite Anwendung, ein neues Framework oder eine zweite Detailimplementierung würden Zustand und Nachweise duplizieren und sind deshalb nicht vorgesehen.

## Verbindliches Verhalten

- Kompakte Trefferkarten zeigen Titel, Art, Nummer, Datum, Quelle und Quellenebene. Die primäre Aktion öffnet den Vorgang. Exportauswahl bleibt eine getrennte Aktion. Detail-/Beziehungs-Pagination erfolgt allein im vorhandenen gemeinsamen Renderer.
- Suche und Ebenenfilter gelten für den durchsuchten Bestand, vor Trefferbegrenzung und Pagination. Stadt bleibt der geografische Katalogkontext; Region und Land werden nicht als andere Städte behandelt.
- Quellenebenen sind `city`, `region`, `state`, `federal`, `eu`. Bestehende drei Ebenen behalten ihre Bedeutung. Neue Ebenen erfordern keinen neuen Detailrenderer; sie erzeugen keinen neuen Datenanbieter.
- Der Beratungsverlauf zeigt Datum, Gremium und amtliches Ergebnis in einer kompakten Prozesslinie. Belegtexte sind direkt am Ereignis aufklappbar. Fehlend, nicht erfasst und unvollständig bleiben unterscheidbar. Dokumentart oder Quellenebene ist kein Verfahrensstatus.
- Zusammenhänge zeigen den Ausgangsvorgang, typisierte amtliche Verweise und Quellenebenen der Ziele, soweit bekannt. Verknüpfungen werden niemals aus ähnlich klingenden Titeln oder einer gemeinsamen Kartenlage erfunden.
- Bestehende URL-Schlüssel bleiben kompatibel. Ergänzt werden `risList`, `risListCollapsed`, `risQuery`, `risLevels`, `risSearchPage`, `risSearchSnapshot`. Eine geteilte Suchseite lädt genau eine begrenzte Seite, keinen unbeschränkten Seitenverlauf. Ein Link hat Vorrang vor lokaler Speicherung.
- Ein Dokument ohne Geometrie bleibt recherchierbar, lesbar und teilbar. Dokumentöffnung verschiebt die Karte nicht automatisch. Die Aktion „Auf Karte zeigen“ verwendet ausschließlich vorhandene, geprüfte Geometrien.
- Stadt-/Dokumentwechsel, Schließen und Filterwechsel entwerten verspätete Antworten. Quellenstand und Cursor dürfen nicht vermischt werden. Keine Änderung an Importbeständen, Hausnummernprüfung oder Unfallanalyse.
- Mindestziel: 44px hohe Bedienelemente, keine horizontale Überbreite bei 390px, Desktopliste und Details ohne Überdeckung, Tastaturbedienung und nachvollziehbarer Fokus.

## Abnahme

Gezielte Regressionstests für Zustandsweitergabe, echte gefilterte Suche, Quellenebenen und Lebenszyklus; Browserprüfung von Suche → Dokument → Zusammenhang über mehrere Ebenen → Karte → geteiltem Link. Mobil und Desktop werden anhand echter Screenshots geprüft. Vor Merge laufen die relevanten Tests und ein unabhängiger Review. Neue Anbieter oder unbewiesene Bezüge werden nicht als implementiert ausgegeben.
