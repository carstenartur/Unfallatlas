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

#Nummer Amtsgerichtsbezirk (Auszug, als Referenz)
#032305 Hannover
#031103 Braunschweig
#033313 Osnabrück
#021100 Hamburg
#110000 Berlin

# weitere Amtsgerichtsbezirke bitte in
# https://www.destatis.de/DE/Themen/Laender-Regionen/Regionales/Gemeindeverzeichnis/Administrativ/beschreibung-gebietseinheiten.pdf?__blob=publicationFile
# nachschlagen

###############################################################################
# Benutzerfreundlichkeit: CLI + City-Mapping
#
# Beispiele:
#   ./convertAmt2gmaps.sh
#   ./convertAmt2gmaps.sh --city hannover
#   ./convertAmt2gmaps.sh --city braunschweig --years 2022-2024 --limit 2000
#   ./convertAmt2gmaps.sh --list-cities
#   ./convertAmt2gmaps.sh --search han
#
# Hinweis:
#   City-Mapping ist bewusst klein gehalten und kann in CITY_MAP erweitert werden.
###############################################################################

usage() {
  cat <<'EOF'
Usage:
  ./convertAmt2gmaps.sh [options]

Options:
  --city <name>        Stadt/Region (z.B. hannover, braunschweig, hamburg, berlin)
  --years <spec>       Jahre: "2019-2024" oder "2018,2020,2022"
  --limit <n>          Max. Features pro Jahr (Default: 1999)
  --outdir <dir>       Ausgabeordner (Default: out)
  --rad | --pkw | --fuss | --krad | --gkfz | --sonstig
                       Unfallart-Filter (Default: --rad)
  --list-cities        Liste der eingebauten City-Keys anzeigen
  --search <text>      Suche in City-Keys
  -h|--help            Hilfe anzeigen

Default:
  Ohne Optionen wird Hannover (ULAND=03, UREGBEZ=2, UKREIS=41) und Fahrrad (IstRad=1) verwendet.
EOF
}

# City-Key → "ULAND UREGBEZ UKREIS"
# (Keys sind klein/ASCII: ä->ae, ö->oe, ü->ue, ß->ss, Leerzeichen/.- -> _)
CITY_MAP='
hannover=03 2 41
braunschweig=03 1 01
goettingen=03 1 04
osnabrueck=03 3 13
hamburg=02 0 00
berlin=11 0 00
'

norm_key() {
  printf "%s" "${1:-}" \
    | tr '[:upper:]' '[:lower:]' \
    | sed -e 's/[ .-]/_/g' -e 's/ä/ae/g' -e 's/ö/oe/g' -e 's/ü/ue/g' -e 's/ß/ss/g'
}

list_cities() {
  echo "$CITY_MAP" | awk -F'=' 'NF==2{print $1}' | sort
}

search_cities() {
  q="$(norm_key "$1")"
  echo "$CITY_MAP" | awk -F'=' -v q="$q" 'NF==2 && $1 ~ q {print $1}' | sort
}

resolve_city() {
  key="$(norm_key "$1")"
  line="$(echo "$CITY_MAP" | awk -v k="$key" -F'[= ]+' '$1==k{print $2,$3,$4}')"
  if [ -z "${line:-}" ]; then
    echo "ERROR: Unbekannte Stadt '$1' (key: $key)." >&2
    echo "       Nutze --list-cities oder erweitere CITY_MAP." >&2
    exit 2
  fi
  ULAND="$(echo "$line" | awk '{print $1}')"
  UREGBEZ="$(echo "$line" | awk '{print $2}')"
  UKREIS="$(echo "$line" | awk '{print $3}')"
}

parse_years() {
  spec="$1"
  if echo "$spec" | grep -qE '^[0-9]{4}-[0-9]{4}$'; then
    a="${spec%-*}"; b="${spec#*-}"
    YEARS="$(awk -v a="$a" -v b="$b" 'BEGIN{for(i=a;i<=b;i++)printf i (i<b?" ":"") }')"
  else
    YEARS="$(echo "$spec" | tr ',' ' ' | tr -s ' ')"
  fi
}

###############################################################################
# Defaults (wie bisher)
###############################################################################
CITY=""
YEARS="2016 2017 2018 2019 2020 2021 2022 2023 2024"
LIMIT=1999
OUTDIR="out"

# Default: Fahrrad
IST_RAD="1"
IST_PKW="0"
IST_FUSS="0"
IST_KRAD="0"
IST_GKFZ="0"
IST_SONSTIG="0"

###############################################################################
# CLI parsen
###############################################################################
while [ $# -gt 0 ]; do
  case "$1" in
    --city) CITY="${2:-}"; shift 2;;
    --years) parse_years "${2:-}"; shift 2;;
    --limit) LIMIT="${2:-}"; shift 2;;
    --outdir) OUTDIR="${2:-}"; shift 2;;

    --rad)     IST_RAD="1"; IST_PKW="0"; IST_FUSS="0"; IST_KRAD="0"; IST_GKFZ="0"; IST_SONSTIG="0"; shift;;
    --pkw)     IST_RAD="0"; IST_PKW="1"; IST_FUSS="0"; IST_KRAD="0"; IST_GKFZ="0"; IST_SONSTIG="0"; shift;;
    --fuss)    IST_RAD="0"; IST_PKW="0"; IST_FUSS="1"; IST_KRAD="0"; IST_GKFZ="0"; IST_SONSTIG="0"; shift;;
    --krad)    IST_RAD="0"; IST_PKW="0"; IST_FUSS="0"; IST_KRAD="1"; IST_GKFZ="0"; IST_SONSTIG="0"; shift;;
    --gkfz)    IST_RAD="0"; IST_PKW="0"; IST_FUSS="0"; IST_KRAD="0"; IST_GKFZ="1"; IST_SONSTIG="0"; shift;;
    --sonstig) IST_RAD="0"; IST_PKW="0"; IST_FUSS="0"; IST_KRAD="0"; IST_GKFZ="0"; IST_SONSTIG="1"; shift;;

    --list-cities) list_cities; exit 0;;
    --search) search_cities "${2:-}"; exit 0;;

    -h|--help) usage; exit 0;;
    *) echo "ERROR: Unbekannte Option: $1" >&2; usage; exit 2;;
  esac
done

###############################################################################
# Region setzen: City oder Default Hannover
###############################################################################
if [ -n "$CITY" ]; then
  resolve_city "$CITY"
else
  # Default Hannover wie bisher
  ULAND="03"
  UREGBEZ="2"
  UKREIS="41"
fi

mkdir -p "$OUTDIR"

###############################################################################
# Verarbeitung
###############################################################################
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

  unzip -p "$zip" "$datafile" \
  | awk -F';' \
      -v year="$year" -v limit="$LIMIT" \
      -v uland="$ULAND" -v ureg="$UREGBEZ" -v ukreis="$UKREIS" \
      -v istrad="$IST_RAD" -v ispkw="$IST_PKW" -v isfuss="$IST_FUSS" -v iskrad="$IST_KRAD" -v isgkfz="$IST_GKFZ" -v issonst="$IST_SONSTIG" \
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
      print "WKT,Name,OBJECTID\r" > outcsv
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

      # Unfallarten (können je nach Jahr/Export leicht anders heißen, wir versuchen beide Varianten)
      i_rad    = pick("IstRad","ISTRAD","","","")
      i_pkw    = pick("IstPKW","ISTPKW","","","")
      i_fuss   = pick("IstFuss","ISTFUSS","IstFuß","ISTFUß","")
      i_krad   = pick("IstKrad","ISTKRAD","","","")
      i_gkfz   = pick("IstGkfz","ISTGKFZ","","","")
      i_sonst  = pick("IstSonstig","ISTSONSTIG","","","")

      i_licht  = pick("ULICHTVERH","U_LICHTVERH","","","")

      # WGS84 für Google Maps/GeoJSON
      i_lon = pick("XGCSWGS84","X_GCSWGS84","","","")
      i_lat = pick("YGCSWGS84","Y_GCSWGS84","","","")

      i_str = pick("Strasse","STRASSE","StrName","STRNAME","USTRNAME")

      if (i_lon==0 || i_lat==0) {
        print "WARN: Jahr " year ": keine WGS84-Spalten (XGCSWGS84/YGCSWGS84). Überspringe Ausgabe." > "/dev/stderr"
        skip=1
      } else {
        skip=0
      }

      # Wenn User eine Unfallart fordert, aber die Spalte im Datensatz fehlt: warnen (nicht abbrechen)
      if (istrad=="1" && i_rad==0)  print "WARN: Jahr " year ": IstRad-Spalte fehlt." > "/dev/stderr"
      if (ispkw=="1" && i_pkw==0)   print "WARN: Jahr " year ": IstPKW-Spalte fehlt." > "/dev/stderr"
      if (isfuss=="1" && i_fuss==0) print "WARN: Jahr " year ": IstFuss-Spalte fehlt." > "/dev/stderr"
      if (iskrad=="1" && i_krad==0) print "WARN: Jahr " year ": IstKrad-Spalte fehlt." > "/dev/stderr"
      if (isgkfz=="1" && i_gkfz==0) print "WARN: Jahr " year ": IstGkfz-Spalte fehlt." > "/dev/stderr"
      if (issonst=="1" && i_sonst==0) print "WARN: Jahr " year ": IstSonstig-Spalte fehlt." > "/dev/stderr"

      next
    }
    NR>1 {
      if (skip) next
      if (i_uland==0 || i_ureg==0 || i_ukreis==0) next

      if ($i_uland != uland)  next
      if ($i_ureg  != ureg)   next
      if ($i_ukreis!= ukreis) next

      # Unfallart-Filter: genau eine gewählt (CLI erzwingt das), aber wir implementieren OR sauber
      want=0
      if (istrad=="1"  && i_rad  && $i_rad=="1")  want=1
      if (ispkw=="1"   && i_pkw  && $i_pkw=="1")  want=1
      if (isfuss=="1"  && i_fuss && $i_fuss=="1") want=1
      if (iskrad=="1"  && i_krad && $i_krad=="1") want=1
      if (isgkfz=="1"  && i_gkfz && $i_gkfz=="1") want=1
      if (issonst=="1" && i_sonst && $i_sonst=="1") want=1
      if (!want) next

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

      # Label nach Unfallart
      label="Unfall"
      if (istrad=="1") label="Fahrrad"
      else if (ispkw=="1") label="PKW"
      else if (isfuss=="1") label="Fuss"
      else if (iskrad=="1") label="Krad"
      else if (isgkfz=="1") label="Gkfz"
      else if (issonst=="1") label="Sonstig"

      name = label " " id " (" year ")"
      if (licht != "") name = name ", Licht: " licht
      if (str   != "") name = name " Strasse: " str

      print "\"POINT (" lon " " lat ")\"," name "," id "\r" >> outcsv

      if (!first) print "," >> outgeo
      first=0

      print "    {\n" \
            "      \"type\": \"Feature\",\n" \
            "      \"geometry\": { \"type\": \"Point\", \"coordinates\": [" lon ", " lat "] },\n" \
            "      \"properties\": {\n" \
            "        \"id\": \"" jesc(id) "\",\n" \
            "        \"name\": \"" jesc(name) "\",\n" \
            "        \"year\": " year ",\n" \
            "        \"type\": \"" jesc(label) "\",\n" \
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

# Combined CSV
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

    # Features-Array extrahieren und zwischen Dateien korrekt trennen
    awk -v firstref="$first" '
      BEGIN{in=0; first=firstref; printed_any=0}
      /"features"[[:space:]]*:[[:space:]]*\[/{in=1; next}
      in && /^[[:space:]]*\]/{in=0; next}
      in {
        if ($0 ~ /^[[:space:]]*$/) next
        if (first=="0" && printed_any=="0") print ","
        printed_any=1
        print
      }
    ' "$f"

    # Wenn Features vorhanden waren, first=0 setzen
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
echo "Region: ULAND=$ULAND UREGBEZ=$UREGBEZ UKREIS=$UKREIS"
echo "Years:  $YEARS"
echo "Limit:  $LIMIT"
echo "Outdir: $OUTDIR"
echo "Combined CSV: $COMBINED_CSV"
echo "Combined GEO: $COMBINED_GEO"