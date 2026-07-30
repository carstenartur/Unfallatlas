# Kölner Kfz-Geometriearchiv 2016–2019

Für die bereits typisierten richtungsbezogenen Kölner Verkehrszählwerte reicht
die Link-CSV allein nicht aus: `FROMNODENO` und `TONODENO` sind amtliche
Knotenkennungen, aber noch keine geografische Linie und insbesondere keine
OpenStreetMap-Way-ID.

Das Kölner Open-Data-Angebot veröffentlicht für denselben Stand ein separates
Archiv mit Knotenpunkten und Linien:

```text
https://offenedaten-koeln.de/sites/default/files/
KFZ%20Zaehldaten%202016-2019_0.zip
```

Der vom Portal veröffentlichte SHA-256 lautet:

```text
5672f1b61777ccbd5a1db6555dddf7c61a009eb161b13d4c7cbe530de9299238
```

Die Ressource steht wie der Datensatz unter der Datenlizenz Deutschland – Zero
– Version 2.0. Die Portalbeschreibung nennt Shape-Format und UTM/WGS84-Bezug.

## Zweck dieses Slices

`scripts/providers/koeln_kfz_geometry_archive_provider.js` schafft zunächst nur
eine reproduzierbare Archiv- und Containergrenze. Er:

- akzeptiert ausschließlich eine lokale Datei innerhalb eines freigegebenen,
  symlinkfreien Importroots;
- verlangt den fest hinterlegten amtlichen Distributions-Hash sowie die beim
  Import explizit angegebene Bytezahl;
- inventarisiert das ZIP ohne externe Entpacker;
- validiert vollständige Shapefile-Sätze;
- erzeugt ein hashgebundenes, atomar schreibbares Inventarmanifest.

Er interpretiert in diesem Slice noch keine DBF-Zeile, transformiert keine
Koordinate und verbindet noch keinen Zählwert mit einer Linie.

## ZIP-Sicherheitsgrenze

Der gemeinsame Reader `scripts/lib/strict-zip.js` unterstützt bewusst nur einen
engen Archivvertrag:

- genau ein Datenträger, kein ZIP64;
- keine Verschlüsselung, maskierten Metadaten oder Bit-3-Daten-Descriptoren;
- nur gespeicherte oder raw-deflate-komprimierte Einträge;
- keine absoluten Pfade, `..`, leeren Pfadsegmente oder Laufwerkspräfixe;
- keine exakten oder nur in Groß-/Kleinschreibung abweichenden Duplikate;
- keine Unix-Symlinks;
- identische lokale und zentrale Dateinamen, Flags und Methoden;
- identische lokale und zentrale CRC-32-, komprimierte und unkomprimierte
  Größenangaben;
- CRC-32- und Größenprüfung der tatsächlich dekomprimierten Bytes;
- konfigurierbare Grenzen für Archivgröße, Einträge, Einzeldateien,
  Gesamtausgabe und Expansionsverhältnis;
- keine sich überlappenden lokalen Eintragsbereiche.

Daten-Descriptoren sind ausdrücklich ausgeschlossen, weil sie Null- oder
Platzhalterwerte im lokalen Header und zusätzliche Trailerdaten erlauben. Der
Evidenzreader verlangt stattdessen vollständige, in beiden Verzeichnissen
übereinstimmende Headerangaben vor dem Lesen der Nutzdaten.

Unbekannte Dateitypen im Kölner Geometriearchiv werden abgewiesen. Zugelassen
sind nur Shapefile-Komponenten und eng verwandte Metadatenformate.

## Shapefile-Inventar

Ein nutzbarer Shape-Satz benötigt mindestens:

```text
*.shp
*.shx
*.dbf
*.prj
```

Zusätzliche `.cpg`, `.qpj`, `.sbn` und `.sbx` dürfen zum selben Basispfad
gehören. Der Provider prüft:

- Shapefile-Code 9994 und Version 1000;
- Dateilänge aus dem Shapefile-Header;
- unterstützten Shape-Typ;
- endliche, geordnete XY-Bounding-Box;
- identische Shape-Typen und Bounding-Boxen in SHP und SHX;
- konsistenten DBF-Header, Datensatzanzahl, Datensatzlänge und eindeutige
  Feldnamen;
- UTM-Zone 32 Nord im PRJ-Text und – sofern vorhanden – EPSG:25832 oder
  EPSG:32632.

Das Archiv muss mindestens einen Punkt- und einen Polylinien-Satz enthalten.
Die Dateinamen werden nicht hart verdrahtet; spätere Parser wählen ihre Rolle
anhand des geprüften Shape-Typs und anschließend anhand realer DBF-Felder.

## Lokale Verwendung

```bash
node scripts/providers/koeln_kfz_geometry_archive_provider.js \
  --root /srv/unfallwerkbank/traffic/koeln \
  --archive 'KFZ Zaehldaten 2016-2019_0.zip' \
  --sha256 5672f1b61777ccbd5a1db6555dddf7c61a009eb161b13d4c7cbe530de9299238 \
  --bytes <tatsächliche-dateigröße> \
  --retrieved-at 2026-07-30T17:00:00Z \
  --manifest out/koeln-kfz-geometry-archive.json
```

`--bytes` muss aus der kontrolliert heruntergeladenen lokalen Datei stammen.
Ein anderer Hash wird selbst dann abgewiesen, wenn das Archiv technisch gültig
ist.

## Manifest-Wahrheitsgrenze

Das erzeugte Manifest setzt ausschließlich folgende Aussagen auf `true`:

- Archivbytes geprüft;
- ZIP-Einträge geprüft;
- Shapefile-Container geprüft.

Folgende Aussagen bleiben ausdrücklich `false`:

- DBF-Zeilen interpretiert;
- Koordinaten transformiert;
- Linkwerte mit Geometrien verbunden;
- auf OSM gematcht.

## Nächste Schritte in #413

Auf dieser Grenze kann der nächste Parser ohne erneutes Archivrisiko aufbauen:

1. reale DBF-Feldnamen der Punkt- und Linien-Sätze als Goldvertrag festlegen;
2. SHP-/SHX-Datensätze und DBF-Zeilen positionsgleich lesen;
3. CRS pro Shape-Satz eindeutig nach WGS84 transformieren;
4. Link-CSV-Segmente über `NO`, `FROMNODENO` und `TONODENO` mit den amtlichen
   Linien und Knoten verbinden;
5. unverbundene, doppelte oder widersprüchliche IDs als Coverage-/Konfliktbericht
   ausgeben;
6. erst danach ein richtungsbewusstes OSM-Matching mit Distanz und Konfidenz
   durchführen.
