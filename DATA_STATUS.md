# Datenstatus und Aktualisierung

Die technische Build-Ampel und der Zustand der benötigten Fachdaten sind getrennt. Die folgenden Badges werden vom kanonischen Maven-Pages-Build aus dem ausgelieferten `data-manifest.json` und den Quellenmetadaten erzeugt.

## Daten in der richtigen Reihenfolge aktualisieren

Die Schritte sind absichtlich nummeriert und entsprechen der Reihenfolge in der GitHub-Actions-Seitenleiste. Der Klick auf **Aktualisieren** öffnet direkt den zuständigen Workflow; dort oben rechts **Run workflow** wählen.

| Schritt | Datenbestand | Status | Aktion | Was passiert danach? |
|---:|---|---|---|---|
| **1** | Unfalldaten | [![Unfalldaten](https://carstenartur.github.io/Unfallatlas/status/accidents.svg)](https://carstenartur.github.io/Unfallatlas/data-status/) | [![Aktualisieren](https://img.shields.io/badge/%E2%96%B6-Aktualisieren-2ea44f?logo=githubactions&logoColor=white)](https://github.com/carstenartur/Unfallatlas/actions/workflows/generate-and-commit.yml) | Erzeugt und validiert die Unfalldaten. Auf `main` startet anschließend Schritt 3 automatisch. |
| **2** | Schulen und Kitas | [![Schulen und Kitas](https://carstenartur.github.io/Unfallatlas/status/poi.svg)](https://carstenartur.github.io/Unfallatlas/data-status/) | [![Aktualisieren](https://img.shields.io/badge/%E2%96%B6-Aktualisieren-2ea44f?logo=githubactions&logoColor=white)](https://github.com/carstenartur/Unfallatlas/actions/workflows/fetchpoi.yml) | Ruft fehlende POIs ab, validiert und komprimiert sie. |
| **3** | Straßenkontext | [![Straßenkontext](https://carstenartur.github.io/Unfallatlas/status/roads.svg)](https://carstenartur.github.io/Unfallatlas/data-status/) | [![Aktualisieren](https://img.shields.io/badge/%E2%96%B6-Aktualisieren-2ea44f?logo=githubactions&logoColor=white)](https://github.com/carstenartur/Unfallatlas/actions/workflows/enrich.yml) | Aktualisiert Straßen, Steigung und Verkehrsproxy gemeinsam und prüft sie im Browser. |
| **3** | Steigung | [![Steigung](https://carstenartur.github.io/Unfallatlas/status/slope.svg)](https://carstenartur.github.io/Unfallatlas/data-status/) | [![Aktualisieren](https://img.shields.io/badge/%E2%96%B6-Aktualisieren-2ea44f?logo=githubactions&logoColor=white)](https://github.com/carstenartur/Unfallatlas/actions/workflows/enrich.yml) | Bestandteil desselben Kontext-Workflows; nicht separat starten. |
| **3** | Verkehr | [![Verkehr](https://carstenartur.github.io/Unfallatlas/status/traffic.svg)](https://carstenartur.github.io/Unfallatlas/data-status/) | [![Aktualisieren](https://img.shields.io/badge/%E2%96%B6-Aktualisieren-2ea44f?logo=githubactions&logoColor=white)](https://github.com/carstenartur/Unfallatlas/actions/workflows/enrich.yml) | Bestandteil desselben Kontext-Workflows; nicht separat starten. |
| **4** | Öffentliche Website | [![Pages](https://github.com/carstenartur/Unfallatlas/actions/workflows/deploy-pages-current-data.yml/badge.svg?branch=main)](https://github.com/carstenartur/Unfallatlas/actions/workflows/deploy-pages-current-data.yml) | [![Veröffentlichen](https://img.shields.io/badge/%E2%96%B6-Ver%C3%B6ffentlichen-0969da?logo=githubactions&logoColor=white)](https://github.com/carstenartur/Unfallatlas/actions/workflows/deploy-pages-current-data.yml) | Läuft nach Daten-Commits auf `main` automatisch; manuell nur zur Wiederholung nötig. |

Für eine vollständige Aktualisierung normalerweise **Schritt 1**, danach **Schritt 2** starten. Schritt 3 folgt nach Schritt 1 automatisch; Schritt 4 folgt automatisch auf die erzeugten Daten-Commits. Ein manueller Start von Schritt 3 oder 4 ist nur für gezielte Wiederholungen oder Fehlerbehebung nötig.

## Bedeutung der Datenbadges

- **Grün:** Für alle in `cities.txt` konfigurierten Städte vorhanden und mit auswertbarem Zeitstand.
- **Gelb:** Nur für einen Teil der Städte vorhanden.
- **Grau:** Vollständig vorhanden, aber mindestens ein notwendiger Quellen- oder Abrufzeitpunkt ist nicht dokumentiert.
- **Rot:** Für keine konfigurierte Stadt vorhanden.

Die Badges zeigen absolute, aus den Daten ableitbare Stände. Der Build erfindet keine Aktualität aus Datei-Zeitstempeln. Die [detaillierte Stadtmatrix](https://carstenartur.github.io/Unfallatlas/data-status/) ergänzt auf der ausgelieferten Seite die relative Altersangabe im Browser.