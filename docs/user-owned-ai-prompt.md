# Nutzerseitiger KI-Prompt-Export

Die Unfallwerkbank kann im Exportdialog ein Promptpaket erzeugen, das Nutzer:innen in ein eigenes KI-Konto übernehmen können, z. B. ChatGPT oder Gemini.

## Ziel

Der Modus ist bewusst kein API-Aufruf. Die Anwendung erzeugt nur lokale Artefakte:

- einen vollständigen Markdown-Prompt,
- ein strukturiertes Faktenpaket als JSON,
- einen Kartenlink zur Nachprüfung des aktuellen Werkbank-Ausschnitts.

Erst wenn Nutzer:innen den Prompt selbst kopieren, hochladen oder einfügen, verlassen die Daten die Unfallwerkbank. Dadurch entstehen keine KI-API-Kosten für den Betreiber der Unfallwerkbank.

## Bedienung

Im Exportdialog unter „Zusatzanalysen“ gibt es zusätzlich zum serverseitigen KI-Antragsentwurf folgende Optionen:

- **Prompt für ChatGPT/Gemini kopieren**: erzeugt einen vollständigen Prompt und kopiert ihn in die Zwischenablage.
- **Prompt .md**: lädt denselben Prompt als Markdown-Datei herunter.
- **Fakten .json**: lädt das strukturierte Faktenpaket herunter.
- **ChatGPT öffnen** / **Gemini öffnen**: öffnet nur die jeweilige Oberfläche in einem neuen Tab. Der Prompt wird nicht automatisch übertragen.

## Inhalt des Promptpakets

Das Paket enthält:

- den Kartenlink mit `export=1`,
- die strukturierte Faktenbasis aus `UA.computeExportReport(ctx)`,
- den deterministischen Berichtstext,
- klare Regeln zur vorsichtigen Sprache:
  - keine gesicherten Unfallursachen behaupten,
  - amtliche Unfallattribute, GIS-Hinweise und visuelle Kontextindizien trennen,
  - Unsicherheiten und geringe Fallzahlen transparent benennen,
  - Kartenlink nur als Prüfhilfe verwenden.

## Abgrenzung zum serverseitigen KI-Modus

Der bestehende Button „Antragsentwurf erstellen“ kann weiterhin den serverseitigen KI-Endpunkt nutzen, sofern dieser konfiguriert ist. Der nutzerseitige Prompt-Export funktioniert unabhängig davon und benötigt keinen `GEMINI_API_KEY` im Unfallwerkbank-Backend.
