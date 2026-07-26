# Datenstatus

Die technische Build-Ampel und der Zustand der benötigten Fachdaten sind getrennt. Die folgenden Badges werden vom kanonischen Maven-Pages-Build aus dem ausgelieferten `data-manifest.json` und den Quellenmetadaten erzeugt.

[![Unfalldaten](https://carstenartur.github.io/Unfallatlas/status/accidents.svg)](https://carstenartur.github.io/Unfallatlas/data-status/)  
[![Schulen und Kitas](https://carstenartur.github.io/Unfallatlas/status/poi.svg)](https://carstenartur.github.io/Unfallatlas/data-status/)  
[![Straßenkontext](https://carstenartur.github.io/Unfallatlas/status/roads.svg)](https://carstenartur.github.io/Unfallatlas/data-status/)  
[![Steigung](https://carstenartur.github.io/Unfallatlas/status/slope.svg)](https://carstenartur.github.io/Unfallatlas/data-status/)  
[![Verkehr](https://carstenartur.github.io/Unfallatlas/status/traffic.svg)](https://carstenartur.github.io/Unfallatlas/data-status/)

## Bedeutung

- **Grün:** Für alle in `cities.txt` konfigurierten Städte vorhanden und mit auswertbarem Zeitstand.
- **Gelb:** Nur für einen Teil der Städte vorhanden.
- **Grau:** Vollständig vorhanden, aber mindestens ein notwendiger Quellen- oder Abrufzeitpunkt ist nicht dokumentiert.
- **Rot:** Für keine konfigurierte Stadt vorhanden.

Die Badges zeigen absolute, aus den Daten ableitbare Stände. Der Build erfindet keine Aktualität aus Datei-Zeitstempeln. Die [detaillierte Stadtmatrix](https://carstenartur.github.io/Unfallatlas/data-status/) ergänzt auf der ausgelieferten Seite die relative Altersangabe im Browser.
