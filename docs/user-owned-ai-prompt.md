# Nutzerseitige KI-Übergabe

Die Unfallwerkbank kann Analyseergebnisse für ein eigenes KI-Konto bereitstellen, zum Beispiel für ChatGPT oder Gemini. Dabei werden zwei ausdrücklich getrennte Wege angeboten:

1. ein **textbasierter Prompt-Export ohne Bilddateien** für schnelle Aufgaben;
2. ein **vollständiges KI-Medienpaket als ZIP** mit Fakten, Bericht, Karten und weiteren Grafiken.

Beide Wege sind bewusst keine automatischen API-Aufrufe. Erst wenn Nutzer:innen Dateien selbst hochladen, kopieren oder einfügen, verlassen Daten die Unfallwerkbank.

## Warum es zwei Exporte gibt

Ein Markdown-Prompt, ein JSON-Faktenpaket und ein Kartenlink können keine PNG- oder SVG-Dateien transportieren. Der bisherige Text-Export war deshalb für eine fachlich vollständige Übergabe ungeeignet, obwohl die Oberfläche ihn missverständlich als vollständiges Promptpaket bezeichnete.

Die Oberfläche kennzeichnet die bisherigen Schaltflächen nun eindeutig als **Text-Prompt ohne Grafiken**. Für Anträge, räumliche Bewertungen und jede Aufgabe, bei der Karten oder Diagramme relevant sind, ist das KI-Medienpaket der vorgesehene Weg.

## Bedienung

Im Exportdialog unter „Zusatzanalysen“ stehen folgende Optionen bereit:

- **Text-Prompt kopieren (ohne Grafiken)**: kopiert Markdown mit Fakten-JSON und Kartenlink in die Zwischenablage.
- **Text-Prompt .md**: lädt denselben textbasierten Prompt herunter.
- **Fakten .json**: lädt nur die strukturierte Faktenbasis herunter.
- **KI-Medienpaket mit Grafiken (.zip)**: erzeugt einen gebundenen Analyse-Snapshot mit allen verfügbaren Karten und Grafiken.
- **ChatGPT öffnen** / **Gemini öffnen**: öffnet lediglich die jeweilige Oberfläche in einem neuen Tab. Es werden keine Daten automatisch übertragen.

## Inhalt des KI-Medienpakets

Das ZIP enthält mindestens:

- `README.md` mit Upload- und Vollständigkeitsanleitung,
- `prompt.md` mit dem fachlichen Arbeitsauftrag und einer verbindlichen Anlagenliste,
- `facts.json` mit der vollständigen strukturierten Faktenbasis aus `UA.computeExportReport(ctx)`,
- `report.md` mit dem deterministischen Berichtstext,
- `report.html` mit dem gerenderten Bericht einschließlich eingebetteter SVG-Elemente,
- `application-state.json` mit Auswahlgrenzen, Kartenansicht und Exportoptionen,
- `map-url.txt` mit dem prüfbaren Werkbank-Link,
- `manifest.json` mit Rolle, Medientyp, Dateigröße, SHA-256 und Bildmetadaten,
- `graphics/01-uebersichtskarte.png`,
- bei vorhandener Auswahl `graphics/02-detailkarte.png`,
- vorhandene Clusterkarten als einzelne PNG-Dateien,
- bei vorhandenen Daten `graphics/mehrjahres-trend.svg`,
- bei vorhandenen Daten `graphics/stunden-heatmap.svg`.

Alle Inhalte stammen aus demselben unmittelbar zuvor berechneten Exportbericht. Der Kartenlink ist nur eine zusätzliche Prüfhilfe und kein Ersatz für die mitgelieferten Bilddateien.

## Fail-closed-Konsistenz

Ein Paket wird nicht als vollständig ausgegeben, wenn ein erforderlicher visueller Nachweis nicht zuverlässig erzeugt werden kann:

- Die Übersichtskarte ist verpflichtend und muss eine gültige PNG-Datei sein.
- Bei einer markierten Auswahl ist auch die Detailkarte verpflichtend.
- Eine Clusterkarte wird nur akzeptiert, wenn ihre sichtbare Punktzahl zur angegebenen Cluster-Fallzahl passt.
- Jede Nutzdatei außer `manifest.json` erhält einen SHA-256-Eintrag. Das Manifest dokumentiert seine eigene Ausnahme ausdrücklich, weil ein finaler Selbsthash rekursiv wäre.
- Prompt, Fakten, Bericht, Anwendungsstatus und Grafiken werden gemeinsam in genau einem ZIP erzeugt.

Damit kann eine KI fehlende Anlagen oder Widersprüche benennen, statt sie unbemerkt durch Annahmen zu ersetzen.

## Verwendung im eigenen KI-Konto

1. ZIP lokal entpacken.
2. `prompt.md`, `facts.json`, `manifest.json` und **alle Dateien aus `graphics/`** gemeinsam hochladen.
3. `prompt.md` als Auftrag verwenden.
4. Prüfen, ob die KI alle im Manifest genannten Pflichtdateien erkannt hat.

Nur das ZIP-Archiv hochzuladen reicht nicht zuverlässig aus, weil nicht jedes KI-Werkzeug Archive selbst entpackt oder die darin enthaltenen Bilddateien einzeln verarbeitet.

## Sicherheits- und Qualitätsregeln im Prompt

Der Auftrag verlangt unter anderem:

- keine gesicherten Unfallursachen allein aus Unfallatlasdaten, OSM-/GIS-Kontext, Orthofotos oder Kartenbildern abzuleiten;
- amtliche Unfallattribute, rechnerisch abgeleitete Hinweise, sichtbare Kontextindizien und Empfehlungen zu trennen;
- jede Grafik zunächst objektiv und unter Nennung ihres Dateinamens zu beschreiben;
- sichtbare Unfallpunkte und Auswahlgrenzen gegen die Zahlen im Faktenpaket zu prüfen;
- Unsicherheiten, geringe Fallzahlen und Widersprüche ausdrücklich zu benennen;
- bei einer fehlenden Pflichtdatei die Bearbeitung zu stoppen und die fehlende Anlage konkret zu nennen.

## Abgrenzung zum serverseitigen KI-Modus

Der Button „Antragsentwurf erstellen“ kann weiterhin den serverseitigen KI-Endpunkt nutzen, sofern dieser konfiguriert ist. Das nutzerseitige KI-Medienpaket funktioniert unabhängig davon und benötigt keinen `GEMINI_API_KEY` im Unfallwerkbank-Backend. Es erzeugt lokal lediglich die Unterlagen, die Nutzer:innen anschließend bewusst in ihrem eigenen Konto verwenden.
