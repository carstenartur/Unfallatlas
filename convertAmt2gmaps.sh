#!/bin/sh
set -eu

###############################################################################
# Unfallatlas -> Google-Maps-CSV + GeoJSON
#
# - Robust: Header-basierte Spaltenzuordnung (keine Jahr-Offsets mehr)
# - City-Auswahl: statische CITY_MAP (kein REST/Cache/Python)
# - Jahre: Default 2016..2024, Jahre ohne Daten je Bundesland werden übersprungen
#
# Ausgabe:
#   out/output_all_years[_<city>].csv
#   out/output_all_years[_<city>].geojson
# Optional:
#   --per-year => zusätzlich out/outputYYYY[_<city>].csv/.geojson
###############################################################################

OUTDIR="out"
LIMIT=1999     # 0 = unbegrenzt
YEARS="2016 2017 2018 2019 2020 2021 2022 2023 2024"

# Default Region Hannover (Region Hannover: ULAND=03, UREGBEZ=2, UKREIS=41)
ULAND="03"
UREGBEZ="2"
UKREIS="41"
UGEMEINDE=""
CITY_DISPLAY="(manuell/default)"
CITY_SUFFIX=""

# Beteiligung-Filter (Default: Fahrrad=1 wie früher)
IST_RAD="1"
IST_PKW=""
IST_FUSS=""
IST_KRAD=""

DO_PER_YEAR="0"
CITY_LIST=""

###############################################################################
# City Map (name -> AGS8 = LL R KK GGG)
###############################################################################
CITY_MAP="$(cat <<'EOF'
berlin|11000000
hamburg|02000000
muenchen|09162000
koeln|05315000
frankfurt_am_main|06412000
duesseldorf|05111000
stuttgart|08111000
leipzig|14713000
dortmund|05913000
essen|05113000
bremen|04011000
dresden|14612000
hannover|03241001
nuernberg|09564000
duisburg|05112000
bochum|05911000
wuppertal|05124000
bielefeld|05711000
bonn|05314000
muenster|05515000
karlsruhe|08212000
mannheim|08222000
EOF
)"

###############################################################################
# Datenverfügbarkeit (laut deiner Kommentar-Liste)
# Rückgabe: Mindestjahr je ULAND
###############################################################################
min_year_for_uland() {
  case "$1" in
    01) echo 2016 ;; # SH
    02) echo 2016 ;; # HH
    03) echo 2017 ;; # NI
    04) echo 2016 ;; # HB
    05) echo 2019 ;; # NRW
    06) echo 2016 ;; # HE
    07) echo 2017 ;; # RP
    08) echo 2016 ;; # BW
    09) echo 2016 ;; # BY
    10) echo 2017 ;; # SL
    11) echo 2018 ;; # BE
    12) echo 2017 ;; # BB
    13) echo 2020 ;; # MV
    14) echo 2016 ;; # SN
    15) echo 2017 ;; # ST
    16) echo 2019 ;; # TH
    *)  echo 2016 ;;
  esac
}

usage() {
  cat <<'EOF'
Usage:
  ./convertAmt2gmaps.sh [options]

Optionen:
  --years "2018 2019 ..."     Jahre (Default: 2016..2024)
  --limit N                  Max. Treffer pro Jahr (Default: 1999), 0=unbegrenzt
  --outdir DIR               Ausgabeverzeichnis (Default: out)
  --per-year                 Zusätzlich pro Jahr outputYYYY[_<city>].csv/.geojson erzeugen

Region:
  --uland 03 --uregb 2 --ukreis 41 [--ugemeinde 001]

Stadt:
  --city "hannover"          nutzt CITY_MAP (name|ags8), erzeugt output_all_years_hannover.*
  Mehrere:
    --city "hannover,bonn"
    --city hannover --city bonn

Beteiligung:
  --rad 1|0      Default 1
  --pkw 1|0      leer = ignorieren
  --fuss 1|0     leer = ignorieren
  --krad 1|0     leer = ignorieren
EOF
}

mkdir -p "$OUTDIR"

###############################################################################
# Args
###############################################################################
while [ "${1:-}" != "" ]; do
  case "$1" in
    --years) YEARS="$2"; shift 2 ;;
    --limit) LIMIT="$2"; shift 2 ;;
    --outdir) OUTDIR="$2"; shift 2 ;;
    --per-year) DO_PER_YEAR="1"; shift 1 ;;

    --uland) ULAND="$2"; shift 2 ;;
    --uregb|--uregbbez|--uregbz) UREGBEZ="$2"; shift 2 ;;
    --ukreis) UKREIS="$2"; shift 2 ;;
    --ugemeinde) UGEMEINDE="$2"; shift 2 ;;

    --city)
      if [ -n "${2:-}" ]; then
        CITY_LIST="${CITY_LIST}${CITY_LIST:+,}$2"
        shift 2
      else
        echo "ERROR: --city braucht einen Wert" >&2
        exit 2
      fi
      ;;

    --rad) IST_RAD="$2"; shift 2 ;;
    --pkw) IST_PKW="$2"; shift 2 ;;
    --fuss) IST_FUSS="$2"; shift 2 ;;
    --krad) IST_KRAD="$2"; shift 2 ;;

    -h|--help) usage; exit 0 ;;
    *) echo "Unbekannte Option: $1" >&2; usage; exit 2 ;;
  esac
done

norm_key() {
  printf "%s" "${1:-}" \
    | tr '[:upper:]' '[:lower:]' \
    | sed \
        -e 's/ä/ae/g' -e 's/ö/oe/g' -e 's/ü/ue/g' -e 's/ß/ss/g' \
        -e 's/[^a-z0-9]/_/g' \
        -e 's/__*/_/g' \
        -e 's/^_//' -e 's/_$//'
}

###############################################################################
# CITY_MAP lookup: name -> ags8
###############################################################################
city_to_ags() {
  key="$(norm_key "$1")"
  printf "%s\n" "$CITY_MAP" | awk -F'|' -v q="$key" '
    BEGIN{IGNORECASE=1}
    {
      name=$1; ags=$2
      gsub(/^[[:space:]]+|[[:space:]]+$/,"",name)
      if(name==q){ print ags; exit 0 }
    }
    END{ exit 1 }
  '
}

set_region_from_city() {
  city_raw="$1"
  key="$(norm_key "$city_raw")"

  ags="$(city_to_ags "$city_raw" 2>/dev/null || true)"
  if [ -z "$ags" ]; then
    echo "ERROR: Stadt \"$city_raw\" nicht in CITY_MAP gefunden (key=$key)." >&2
    echo "       Bitte CITY_MAP ergänzen oder Region-Parameter (--uland/--uregb/--ukreis/--ugemeinde) nutzen." >&2
    exit 2
  fi

  ULAND="$(printf "%s" "$ags" | cut -c1-2)"
  UREGBEZ="$(printf "%s" "$ags" | cut -c3-3)"
  UKREIS="$(printf "%s" "$ags" | cut -c4-5)"
  UGEMEINDE="$(printf "%s" "$ags" | cut -c6-8)"

  CITY_DISPLAY="${key} (AGS ${ags})"
  CITY_SUFFIX="$key"

  echo "== City: $CITY_DISPLAY =="
  echo "   -> ULAND=$ULAND UREGBEZ=$UREGBEZ UKREIS=$UKREIS UGEMEINDE=$UGEMEINDE"
  echo "   -> Dateisuffix: $CITY_SUFFIX"
}

###############################################################################
# Year processing (header-basiert)
###############################################################################
process_year_append() {
  year="$1"

  miny="$(min_year_for_uland "$ULAND")"
  if [ "$year" -lt "$miny" ]; then
    echo "== $year == (skip: ULAND=$ULAND hat Daten erst ab $miny)"
    return 0
  fi

  zip="${OUTDIR}/${year}.zip"
  url="https://www.opengeodata.nrw.de/produkte/transport_verkehr/unfallatlas/Unfallorte${year}_EPSG25832_CSV.zip"

  echo "== $year =="

  # download (overwrite ok)
  curl -fsSL -o "$zip" "$url"

  datafile="$(unzip -Z1 "$zip" \
    | grep -Ei "Unfallorte${year}.*\.(csv|txt)$" \
    | grep -Evi "(readme|lizenz|license)" \
    | head -n 1 || true)"

  if [ -z "$datafile" ]; then
    echo "WARN: Keine passende Datendatei im Zip gefunden ($zip)" >&2
    return 0
  fi

  outcsv_y="${OUTDIR}/output${year}${COMBINED_SUFFIX}.csv"
  outgeo_y="${OUTDIR}/output${year}${COMBINED_SUFFIX}.geojson"

  unzip -p "$zip" "$datafile" \
  | awk -F';' -v year="$year" -v limit="$LIMIT" \
        -v uland="$ULAND" -v ureg="$UREGBEZ" -v ukreis="$UKREIS" -v ugem="$UGEMEINDE" \
        -v istrad="$IST_RAD" -v ispkw="$IST_PKW" -v isfuss="$IST_FUSS" -v iskrad="$IST_KRAD" \
        -v outcsv="$COMBINED_CSV" -v outgeo="$COMBINED_GEO" -v firstref="$COMBINED_GEO_FIRST" \
        -v peryear="$DO_PER_YEAR" -v outcsv_y="$outcsv_y" -v outgeo_y="$outgeo_y" '
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
      gsub(/\\/,"\\\\",t); gsub(/"/,"\\\"",t)
      gsub(/\r/,"",t); gsub(/\n/,"\\n",t)
      return t
    }
    function ok_involvement() {
      if (istrad=="" && ispkw=="" && isfuss=="" && iskrad=="") return 1
      if (istrad!="" && i_istrad>0 && $i_istrad==istrad) return 1
      if (ispkw!=""  && i_ispkw>0  && $i_ispkw==ispkw)   return 1
      if (isfuss!="" && i_isfuss>0 && $i_isfuss==isfuss) return 1
      if (iskrad!="" && i_iskrad>0 && $i_iskrad==iskrad) return 1
      return 0
    }
    BEGIN{
      first = firstref + 0
      out = 0

      if (peryear=="1") {
        print "WKT,Name,OBJECTID\r" > outcsv_y
        print "{\n  \"type\": \"FeatureCollection\",\n  \"features\": [" > outgeo_y
        first_y=1
      }
    }
    NR==1{
      for(i=1;i<=NF;i++){ gsub(/\r/,"",$i); idx[$i]=i }

      i_id     = pick("ID","OBJECTID","OBJECTID_1","","")
      i_uland  = pick("ULAND","","","","")
      i_ureg   = pick("UREGBEZ","","","","")
      i_ukreis = pick("UKREIS","","","","")
      i_ugem   = pick("UGEMEINDE","","","","")

      i_istrad = pick("IstRad","ISTRAD","","","")
      i_ispkw  = pick("IstPKW","ISTPKW","","","")
      i_isfuss = pick("IstFuss","ISTFUSS","IstFuß","ISTFUß","")
      i_iskrad = pick("IstKrad","ISTKRAD","","","")

      i_lon = pick("XGCSWGS84","X_GCSWGS84","","","")
      i_lat = pick("YGCSWGS84","Y_GCSWGS84","","","")

      if(i_lon==0 || i_lat==0){
        skip=1
        print "WARN: Jahr " year ": keine WGS84-Spalten gefunden. Skip." > "/dev/stderr"
      } else skip=0
      next
    }
    NR>1{
      if(skip) next
      if(i_uland==0 || i_ureg==0 || i_ukreis==0) next

      if($i_uland != uland) next
      if($i_ureg  != ureg)  next
      if($i_ukreis!= ukreis) next
      if(ugem!="" && i_ugem>0 && $i_ugem != ugem) next

      if(!ok_involvement()) next

      out++
      if(limit>0 && out>limit) exit

      id = (i_id ? $i_id : out)

      lon=$i_lon; lat=$i_lat
      gsub(/\r/,"",lon); gsub(/\r/,"",lat)
      gsub(/,/,".",lon); gsub(/,/,".",lat)

      name="Unfall " id " (" year ")"

      print "\"POINT (" lon " " lat ")\"," name "," id "\r" >> outcsv

      if(first==0) print "," >> outgeo
      first=0
      print "    {\"type\":\"Feature\",\"geometry\":{\"type\":\"Point\",\"coordinates\":[" lon "," lat "]},\"properties\":{\"id\":\"" jesc(id) "\",\"name\":\"" jesc(name) "\",\"year\":" year "}}" >> outgeo

      if(peryear=="1"){
        print "\"POINT (" lon " " lat ")\"," name "," id "\r" >> outcsv_y

        if(!first_y) print "," >> outgeo_y
        first_y=0
        print "    {\"type\":\"Feature\",\"geometry\":{\"type\":\"Point\",\"coordinates\":[" lon "," lat "]},\"properties\":{\"id\":\"" jesc(id) "\",\"name\":\"" jesc(name) "\",\"year\":" year "}}" >> outgeo_y
      }
    }
    END{
      if(peryear=="1" && !skip){
        print "\n  ]\n}" >> outgeo_y
      }
      printf "FIRSTFLAG=%d\n", first > "/dev/stderr"
    }
  ' 2> "${OUTDIR}/.firstflag.tmp"

  if [ -f "${OUTDIR}/.firstflag.tmp" ]; then
    COMBINED_GEO_FIRST="$(awk -F= '/^FIRSTFLAG=/{print $2; exit}' "${OUTDIR}/.firstflag.tmp" || echo "$COMBINED_GEO_FIRST")"
    rm -f "${OUTDIR}/.firstflag.tmp"
  fi

  if [ "$DO_PER_YEAR" = "1" ]; then
    [ -f "$outcsv_y" ] && echo " -> $outcsv_y"
    [ -f "$outgeo_y" ] && echo " -> $outgeo_y"
  fi
}

###############################################################################
# Combined runner (für aktuelle Region/City)
###############################################################################
run_combined_for_current_region() {
  COMBINED_SUFFIX=""
  if [ -n "${CITY_SUFFIX:-}" ]; then
    COMBINED_SUFFIX="_${CITY_SUFFIX}"
  fi

  COMBINED_CSV="${OUTDIR}/output_all_years${COMBINED_SUFFIX}.csv"
  COMBINED_GEO="${OUTDIR}/output_all_years${COMBINED_SUFFIX}.geojson"

  echo "WKT,Name,OBJECTID\r" > "$COMBINED_CSV"
  { echo '{'; echo '  "type": "FeatureCollection",'; echo '  "features": ['; } > "$COMBINED_GEO"
  COMBINED_GEO_FIRST=1

  for y in $YEARS; do
    process_year_append "$y" || true
  done

  { echo; echo '  ]'; echo '}'; } >> "$COMBINED_GEO"

  echo "== fertig =="
  echo "Filter: ULAND=$ULAND UREGBEZ=$UREGBEZ UKREIS=$UKREIS${UGEMEINDE:+ UGEMEINDE=$UGEMEINDE}"
  echo "City:   ${CITY_DISPLAY}"
  echo "Years:  $YEARS"
  echo "Limit:  $LIMIT (0=unbegrenzt)"
  echo "Per-year: $DO_PER_YEAR"
  echo "Combined CSV: $COMBINED_CSV"
  echo "Combined GEO: $COMBINED_GEO"
  echo
}

###############################################################################
# Main
###############################################################################
if [ -n "$CITY_LIST" ]; then
  OLDIFS=$IFS
  IFS=,
  set -- $CITY_LIST
  IFS=$OLDIFS

  for c in "$@"; do
    c="$(printf "%s" "$c" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
    [ -z "$c" ] && continue
    set_region_from_city "$c"
    run_combined_for_current_region
  done
  exit 0
fi

CITY_SUFFIX=""
CITY_DISPLAY="(manuell/default)"
run_combined_for_current_region