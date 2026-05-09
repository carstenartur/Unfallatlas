# Screenshots — Aufnahme-Hinweise

Dieses Verzeichnis enthält die in `README.md` und `docs/DOKUMENTATION.md`
referenzierten PNG-Screenshots der Unfallwerkbank V2.

## Konvention

| Nummer | Datei | Beschreibung |
|---|---|---|
| 01 | `01-startansicht.png` | Startansicht der Werkbank V2 |
| 02 | `02-stadtauswahl.png` | Stadtauswahl-Dropdown |
| 03 | `03-filter.png` | Filter-Panel (Beteiligung, Schwere, Zeit, …) |
| 04 | `04-cluster-ansicht.png` | Cluster-Ansicht |
| 05 | `05-heatmap-ansicht.png` | Heatmap-Ansicht |
| 06 | `06-legende.png` | Legende |
| 07 | `07-export-modal.png` | Export-Modal |
| 08 | `08-stundenfilter.png` | Stundenfilter |
| 09 | `09-bereich-markieren.png` | Bereich markieren |
| 10 | `10-auto-fahrrad-und.png` | Auto+Fahrrad UND-Modus |
| 11 | `11-fahrrad-alleinunfaelle.png` | Fahrrad-Alleinunfälle |
| 12 | `12-poi-schulen-kitas.png` | POI: Schulen + Kitas |
| 13 | `13-bonn-hbf-radunfaelle.png` | Bonn Hbf Rad+Auto-Unfälle |
| 14 | `14-export-filterkontext.png` | Export mit Filterkontext |
| 15 | `15-export-pdf-rendered.png` | Gerenderter PDF-Export |
| 16 | `16-antrag-inhalt.png` | Antrag-Inhalt |

## TODO – Kontextdaten-Screenshots (PR #260)

Mit der Einführung der Kontextdaten (PR #260, „Kontext (neu)") sind
zwei zusätzliche Screenshots vorgesehen. Sie werden mit der nächsten
UI-Aufnahme nachgereicht (live-Browser-Capture; nicht im Rahmen der
reinen Dokumentations-PR möglich):

| Nummer | Datei | Beschreibung |
|---|---|---|
| 17 | `17-kontext-filter.png` | Filter-Panel mit aufgeklappter Sektion **Kontext (neu)** (Hangneigung, Verkehrsklasse-DTV-Proxy, „nur auf gematchten Straßen") |
| 18 | `18-popup-kontextdaten.png` | Marker-Popup mit Standard-Unfalldetails plus zusätzlichem Block **Kontextdaten** (Topographie, Straßenkontext, Verkehrsexposition mit „proxy"-Badge) |

Beide Screenshots sollen die explizite **Proxy/Schätzung**-Kennzeichnung
sichtbar enthalten — der Verkehrsklassen-Wert ist ein
*projekteigener OSM-`highway`-Proxy*, **keine gemessene
Verkehrsdichte**.

### Aufnahme-Anleitung

1. `werkbank_v2.html` lokal mit einer Stadt öffnen, deren GeoJSON
   bereits angereichert wurde (siehe `out/output_all_years_<slug>.geojson`
   sowie der Capability-Detect in `js/ua.context_layers.js`).
2. Filter-Panel scrollen, bis die Sektion **„Kontext (neu)"** sichtbar
   ist — Screenshot 17 aufnehmen.
3. Auf einen Marker klicken, dessen Popup einen *Kontextdaten*-Block
   zeigt — Screenshot 18 aufnehmen.
4. Beide PNGs als `17-kontext-filter.png` / `18-popup-kontextdaten.png`
   in dieses Verzeichnis legen und die Platzhalter-Hinweise in
   `docs/DOKUMENTATION.md` (Abschnitt „Kontext (neu)") entfernen.
