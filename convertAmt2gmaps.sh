#!/bin/sh
set -eu

# 032305 Hannover

#Bundesland
#01 = Schleswig-Holstein (Daten ab 2016)
#02 = Hamburg (Daten ab 2016)
#03 = Niedersachsen (Daten ab 2017)
#04 = Bremen (Daten ab 2016)
#05 = Nordrhein-Westfalen (Daten ab 2019)
#06 = Hessen (Daten ab 2016)
#07 = Rheinland-Pfalz (Daten ab 2017)
#08 = Baden-Württemberg (Daten ab 2016)
#09 = Bayern (Daten ab 2016)
#10 = Saarland (Daten ab 2017)
#11 = Berlin (Daten ab 2018)
#12 = Brandenburg (Daten ab 2017)
#13 = Mecklenburg-Vorpommern (Daten ab 2020)
#14 = Sachsen (Daten ab 2016)
#15 = Sachsen-Anhalt (Daten ab 2017)
#16 = Thüringen (Daten ab 2019)

#Nummer Amtsgerichtsbezirk
#011112 Flensburg
#011115 Husum
#011118 Niebüll
#011119 Schleswig
#011312 Elmshorn
#011315 Itzehoe
#011319 Meldorf
#011321 Pinneberg
#011512 Bad Segeberg
#011514 Eckernförde
#011517 Kiel
#011519 Neumünster
#011522 Plön
#011524 Rendsburg
#011526 Norderstedt
#011711 Ahrensburg
#011716 Eutin
#011721 Lübeck
#011724 Oldenburg
#011725 Ratzeburg
#011726 Reinbek
#011728 Schwarzenbek
#021100 Hamburg
#031101 Bad Gandersheim
#031103 Braunschweig
#031104 Goslar
#031105 Helmstedt
#031108 Salzgitter
#031111 Seesen
#031115 Wolfenbüttel
#031116 Clausthal-Zellerfeld
#031117 Wolfsburg
#031202 Duderstadt
#031203 Einbek
#031204 Göttingen
#031205 Hann. Münden
#031206 Herzberg am Harz
#031208 Northeim
#031209 Osterode am Harz
#032101 Bückeburg
#032104 Rinteln
#032106 Stadthagen
#032303 Burgwedel
#032304 Hameln
#032305 Hannover
#032306 Neustadt am Rübenb.
#032307 Springe
#032308 Wennigsen (Deister)
#032401 Alfeld (Leine)
#032403 Burgdorf
#032404 Elze
#032407 Gifhorn
#032408 Hildesheim
#032409 Holzminden
#032410 Lehrte
#032411 Peine
#032503 Celle
#032504 Dannenberg (Elbe)
#032507 Lüneburg
#032509 Soltau
#032510 Uelzen
#032511 Winsen (Luhe)
#032601 Bremervörde
#032602 Buxtehude
#032603 Cuxhaven
#032608 Langen
#032611 Ottendorf
#032612 Stade
#032613 Tostedt
#032614 Zeven
#032701 Achim
#032705 Diepholz
#032708 Nienburg (Weser)
#032709 Osterholz-Scharmbeck
#032710 Rotenburg (Wümme)
#032711 Stolzenau
#032712 Sulingen
#032713 Syke
#032715 Verden
#032716 Walsrode
#033101 Aurich
#033102 Emden
#033104 Leer
#033105 Norden
#033107 Wittmund
#033201 Brake
#033202 Cloppenburg
#033204 Delmenhorst
#033207 Jever
#033209 Nordenham
#033210 Oldenburg (Oldenb.)
#033211 Varel
#033212 Vechta
#033213 Westerstede
#033214 Wildeshausen
#033215 Wilhelmshaven
#033302 Bersenbrück
#033307 Bad Iburg
#033308 Lingen
#033310 Meppen
#033312 Nordhorn
#033313 Osnabrück
#033314 Papenburg

# weitere Amtsgerichtsbezirke bitte in
# https://www.destatis.de/DE/Themen/Laender-Regionen/Regionales/Gemeindeverzeichnis/Administrativ/beschreibung-gebietseinheiten.pdf?__blob=publicationFile
# nachschlagen

###############################################################################
# Konfiguration: Region Hannover (032305) => ULAND=03, UREGBEZ=2, UKREIS=41
###############################################################################
ULAND="03"
UREGBEZ="2"
UKREIS="41"
IST_RAD="1"

LIMIT=1999
OUTDIR="out"
mkdir -p "$OUTDIR"

# verfügbare Jahre (Unfallatlas-Downloads auf opengeodata.nrw.de)
YEARS="2016 2017 2018 2019 2020 2021 2022 2023 2024"

process_year() {
  year="$1"
  zip="${year}.zip"
  url="https://www.opengeodata.nrw.de/produkte/transport_verkehr/unfallatlas/Unfallorte${year}_EPSG25832_CSV.zip"

  echo "== $year =="

  curl -fsSL -o "$zip" "$url"

  # Datei im ZIP finden (Layout/Endung variiert je Jahr)
  datafile="$(unzip -Z1 "$zip" \
    | grep -Ei "Unfallorte${year}.*(LinRef|EPSG25832_CSV).*\.([ct]sv|txt)$" \
    | head -n 1 || true)"

  if [ -z "$datafile" ]; then
    echo "WARN: Keine passende Datendatei im Zip gefunden ($zip)" >&2
    return 0
  fi

  outcsv="${OUTDIR}/output${year}.csv"
  outgeo="${OUTDIR}/output${year}.geojson"

  # Ein Durchlauf: CSV + GeoJSON schreiben
  unzip -p "$zip" "$datafile" \
  | awk -F';' -v year="$year" -v limit="$LIMIT" \
        -v uland="$ULAND" -v ureg="$UREGBEZ" -v ukreis="$UKREIS" -v istrad="$IST_RAD" \
        -v outcsv="$outcsv" -v outgeo="$outgeo" '
    function pick(a,b,c,d,e) {
      if (a!="" && (a in idx)) return idx[a]
      if (b!="" && (b in idx)) return idx[b]
      if (c!="" && (c in idx)) return idx[c]
      if (d!="" && (d in idx)) return idx[d]
      if (e!="" && (e in idx)) return idx[e]
      return 0
    }
    function jesc(s,   t) {
      t=s
      gsub(/\\/,"\\\\",t)
      gsub(/"/,"\\\"",t)
      gsub(/\r/,"",t)
      gsub(/\n/,"\\n",t)
      return t
    }
    BEGIN {
      # CSV Header
      print "WKT,Name,OBJECTID\r" > outcsv

      # GeoJSON Start
      print "{\n  \"type\": \"FeatureCollection\",\n  \"features\": [" > outgeo
      first=1
      out=0
    }
    NR==1 {
      for (i=1; i<=NF; i++) { gsub(/\r/,"",$i); idx[$i]=i }

      i_id     = pick("ID","OBJECTID","OBJECTID_1","","")
      i_uland  = pick("ULAND","","","","")
      i_ureg   = pick("UREGBEZ","","","","")
      i_ukreis = pick("UKREIS","","","","")
      i_istrad = pick("IstRad","ISTRAD","","","")
      i_licht  = pick("ULICHTVERH","U_LICHTVERH","","","")

      # Für Google Maps/GeoJSON: WGS84
      i_lon = pick("XGCSWGS84","X_GCSWGS84","","","")
      i_lat = pick("YGCSWGS84","Y_GCSWGS84","","","")

      # Straßenname (kann je nach Jahr/Export anders heißen)
      i_str = pick("Strasse","STRASSE","StrName","STRNAME","USTRNAME")

      # Wenn WGS84 fehlt -> wir erzeugen lieber kein falsches GeoJSON/CSV
      if (i_lon==0 || i_lat==0) {
        print "WARN: Jahr " year ": keine WGS84-Spalten (XGCSWGS84/YGCSWGS84). Überspringe Ausgabe." > "/dev/stderr"
        skip=1
      } else {
        skip=0
      }
      next
    }
    NR>1 {
      if (skip) next
      if (i_uland==0 || i_ureg==0 || i_ukreis==0 || i_istrad==0) next

      if ($i_uland != uland)  next
      if ($i_ureg  != ureg)   next
      if ($i_ukreis!= ukreis) next
      if ($i_istrad!= istrad) next

      out++
      if (out > limit) exit

      id = (i_id ? $i_id : out)
      licht = (i_licht ? $i_licht : "")

      lon = $i_lon
      lat = $i_lat
      gsub(/\r/,"",lon); gsub(/\r/,"",lat)
      gsub(/,/,".",lon); gsub(/,/,".",lat)

      str = (i_str ? $i_str : "")
      gsub(/\r/,"",str)

      name = "Fahrrad " id " (" year ")"
      if (licht != "") name = name ", Licht: " licht
      if (str   != "") name = name " Strasse: " str

      # CSV (Google Maps)
      print "\"POINT (" lon " " lat ")\"," name "," id "\r" >> outcsv

      # GeoJSON Feature
      if (!first) print "," >> outgeo
      first=0

      print "    {\n" \
            "      \"type\": \"Feature\",\n" \
            "      \"geometry\": { \"type\": \"Point\", \"coordinates\": [" lon ", " lat "] },\n" \
            "      \"properties\": {\n" \
            "        \"id\": \"" jesc(id) "\",\n" \
            "        \"name\": \"" jesc(name) "\",\n" \
            "        \"year\": " year ",\n" \
            "        \"licht\": \"" jesc(licht) "\",\n" \
            "        \"strasse\": \"" jesc(str) "\"\n" \
            "      }\n" \
            "    }" >> outgeo
    }
    END {
      if (!skip) print "\n  ]\n}" >> outgeo
    }
  '

  if [ -f "$outcsv" ]; then echo " -> $outcsv"; fi
  if [ -f "$outgeo" ]; then echo " -> $outgeo"; fi
}

for y in $YEARS; do
  process_year "$y" || true
done

# Optional: alles zusammenführen (Header nur einmal) - CSV
COMBINED_CSV="${OUTDIR}/output_all_years.csv"
(
  echo "WKT,Name,OBJECTID\r"
  for y in $YEARS; do
    f="${OUTDIR}/output${y}.csv"
    [ -f "$f" ] && tail -n +2 "$f"
  done
) > "$COMBINED_CSV"

# Combined GeoJSON: Features aus Jahresdateien zusammenführen
COMBINED_GEO="${OUTDIR}/output_all_years.geojson"
{
  echo '{'
  echo '  "type": "FeatureCollection",'
  echo '  "features": ['
  first=1
  for y in $YEARS; do
    f="${OUTDIR}/output${y}.geojson"
    [ -f "$f" ] || continue
    awk -v firstref="$first" '
      BEGIN{in=0; first=firstref}
      /"features"[[:space:]]*:[[:space:]]*\[/{in=1; next}
      in && /^[[:space:]]*\]/{in=0; next}
      in {
        line=$0
        # Skip completely empty lines
        if (line ~ /^[[:space:]]*$/) next

        # Wenn das erste Feature nicht am Anfang steht, sicherstellen dass ein Komma zwischen Dateien steht:
        # Das klappt, weil innerhalb der Datei Features bereits korrekt mit Kommas getrennt sind.
        if (first=="0" && printed_any=="0") {
          print ","
        }
        printed_any="1"
        print line
      }
      END{
        # nothing
      }
    ' "$f"
    # Wenn wir aus dieser Datei Features gedruckt haben, first=0 setzen
    if awk '
      BEGIN{in=0; n=0}
      /"features"[[:space:]]*:[[:space:]]*\[/{in=1; next}
      in && /^[[:space:]]*\]/{in=0; next}
      in { if ($0 !~ /^[[:space:]]*$/) n++ }
      END{ exit (n>0 ? 0 : 1) }
    ' "$f"; then
      first=0
    fi
  done
  echo '  ]'
  echo '}'
} > "$COMBINED_GEO"

echo "== fertig =="
echo "Combined CSV:  $COMBINED_CSV"
echo "Combined GEO:  $COMBINED_GEO"