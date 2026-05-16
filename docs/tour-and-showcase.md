# Tour & Showcase

> Diese Seite ist Teil der Unfallatlas-Doku. Zurück zur [README](../README.md).

## Showcase – automatische Beispiel-Rotation

Die **[Showcase-Seite](https://carstenartur.github.io/Unfallatlas/showcase.html)** lädt die Beispiel-URLs aus der README nacheinander in einem `<iframe>` und wechselt automatisch alle 12 Sekunden. Ideal zum Präsentieren der Werkbank ohne manuelle Eingaben.

→ [showcase.html](../showcase.html) öffnen · Play/Pause, Vor/Zurück, Dot-Navigation, Geschwindigkeit wählbar · Keyboard: ← →

## Geführte Tour in der Werkbank

Die **Werkbank V2** enthält einen eingebauten Tour-Player (`js/ua.tour.js`) der JSON-Sequenzen abspielt:

**Tour starten:**
- Klick auf **▶ Tour starten** im Panel unter „Geführte Tour" – startet die eingebaute Demo-Tour
- Oder URL-Parameter: `?tour=demo` (lädt `tours/demo.json`)
- Oder eigene Tour: `?tour=https://example.com/meine-tour.json`

**Tour-Overlay** zeigt:
- Aktuellen Schritt mit Beschreibung
- Fortschritt (z.B. „3 / 12")
- Play/Pause, Vor/Zurück, Beenden-Buttons

**Eigene Tour aufzeichnen (Recorder):**
1. Klick auf **⏺ Aufzeichnen** im Panel → roter REC-Badge erscheint
2. Normal in der Werkbank navigieren (Kartenausschnitt ändern, Filter setzen, Export öffnen)
3. Erneut auf den Button klicken → **Aufzeichnung stoppen**
4. Im Editor: Beschreibungen anpassen, Pausen editieren, Schritte löschen/sortieren
5. **Als JSON herunterladen** → in `tours/` ablegen und über `?tour=dateiname` aufrufen
6. **Vorschau abspielen** – direkt aus dem Editor heraus

**Tour-JSON-Format** (Beispiel):
```json
{
  "name": "Meine Tour",
  "steps": [
    { "action": "setCity",   "value": "Bonn",   "description": "Bonn laden",      "pause": 3000 },
    { "action": "flyTo",     "lat": 50.73, "lng": 7.10, "zoom": 14, "description": "Übersicht", "pause": 2000 },
    { "action": "setFilter", "filters": { "includeCyclist": true, "includeCar": true, "involvementMode": "and" }, "description": "Rad+Auto", "pause": 3000 },
    { "action": "openExport","description": "Export öffnen", "pause": 5000 },
    { "action": "closeExport","description": "Schließen",    "pause": 1000 }
  ]
}
```

## Verwandte Doku

- [Nutzerdoku](DOKUMENTATION.md#tour-system-player--recorder)
- [README](../README.md)
