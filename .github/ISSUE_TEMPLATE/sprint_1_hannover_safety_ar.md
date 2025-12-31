---
### Sprint 1 Zielsetzung
Wir konzentrieren uns auf die Daten-Fusion für Hannover.

#### Ziel
Erstelle ein Skript, das:
- Beispieldaten aus dem Unfallatlas (GeoJSON) lädt.
- Eine Kachel des 3D-Stadtmodells Hannover (CityGML/OBJ) lädt.
- Die Logik prüft, welche Unfälle innerhalb der Grenzen der geladenen 3D-Kachel liegen.

### Anforderungen
1. **Modulare Struktur:**
   - *Data-Ingestion*: Lade die Daten aus GeoJSON und CityGML/OBJ.
   - *Geo-Transformer*: Entwickle die Koordinaten-Logik zur Bestimmung, ob ein Punkt innerhalb der Kachel liegt (Bounding Box).
   - *3D-Generator*: Dieses Modul wird in späteren Sprints erweitert, um 3D-Ausgaben (USDZ/GLB) zu erstellen.
2. **Automatisierte Tests:**
   - Schreibe automatisierte Tests für:
     - Die Umrechnung von GPS-Daten zu lokalen Kachelkoordinaten.
     - Die Bounding-Box-Logik zum Filtern von Unfällen innerhalb der Kachel-Grenzen.
3. **Iterativ erweiterbar:** Stelle sicher, dass der Code modular ist und spätere Anpassungen (z. B. Android-Unterstützung) einfach umgesetzt werden können.

### Testfälle
- **Unit-Test für GPS-zu-Koordinaten-Mapping:** Verifiziere, dass ein Punkt exakt auf die lokalen 3D-Koordinaten einer Stadtkachel gemappt wird.
- **Bounding-Box-Test:** Bestätige, dass alle Unfälle korrekt als "innerhalb" oder "außerhalb" der Kachel-Grenzen erkannt werden.

---