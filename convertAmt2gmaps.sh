#!/bin/sh
set -eu

###############################################################################
# Unfallatlas -> Google-Maps-CSV + GeoJSON (kombiniert über mehrere Jahre)
#
# Ausgaben:
#   out/output_all_years[_<citysuffix>].csv
#   out/output_all_years[_<citysuffix>].geojson
#
# Optional:
#   --per-year  => zusätzlich out/outputYYYY[_<citysuffix>].csv/.geojson
#
# City-Handling (CI-tauglich):
#   --city <name>      -> nutzt statisches Mapping CITY_MAP
#   --ags  <AGS8>      -> direkte AGS-Angabe (8-stellig), überschreibt City Map
#
# Wichtig: GeoJSON enthält ALLE Properties, die index.html erwartet.
#
# WICHTIGER FIX:
#   Combined-Dateien werden atomisch geschrieben:
#     *.tmp  -> am Ende validieren -> mv nach final
#   Dadurch kann eine Action niemals eine "halbgeschriebene" GeoJSON committen.
###############################################################################

OUTDIR="out"
LIMIT=1999
YEARS="2016 2017 2018 2019 2020 2021 2022 2023 2024"

# Default Region (falls ohne City/AGS gestartet):
# Region Hannover (ULAND=03, UREGBEZ=2, UKREIS=41)
ULAND="03"
UREGBEZ="2"
UKREIS="41"
UGEMEINDE=""
CITY_DISPLAY="(manuell/default)"
CITY_SUFFIX=""

IST_RAD="1"
IST_PKW=""
IST_FUSS=""
IST_KRAD=""

DO_PER_YEAR="0"

###############################################################################
# City Map (Name -> AGS8)
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

usage() {
  cat <<'EOF'
Usage:
  ./convertAmt2gmaps.sh [options]

Optionen:
  --years "2018 2019 ..."     Jahre (Default: 2016..2024)
  --limit N                  Max. Treffer pro Jahr (Default: 1999), 0=unbegrenzt
  --outdir DIR               Ausgabeverzeichnis (Default: out)
  --per-year                 Zusätzlich pro Jahr outputYYYY*.csv/.geojson erzeugen

Region / Stadt:
  --city "Hannover"          nutzt CITY_MAP und erzeugt output_all_years_hannover.*
  Mehrere:
    --city "Hannover,Bonn"
    --city Hannover --city Bonn

  --ags 03241001             direkt AGS8 (überschreibt City Map)

Beteiligung:
  --rad 1|0
  --pkw 1|0
  --fuss 1|0
  --krad 1|0
EOF
}

CITY_LIST=""
AGS_OVERRIDE=""

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

    --ags)
      AGS_OVERRIDE="$2"
      shift 2
      ;;

    --rad) IST_RAD="$2"; shift 2 ;;
    --pkw) IST_PKW="$2"; shift 2 ;;
    --fuss) IST_FUSS="$2"; shift 2 ;;
    --krad) IST_KRAD="$2"; shift 2 ;;

    -h|--help) usage; exit 0 ;;
    *) echo "Unbekannte Option: $1" >&2; usage; exit 2 ;;
  esac
done

mkdir -p "$OUTDIR"

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
# CI-stabileres curl (ohne Formatänderungen)
###############################################################################
fetch_zip() {
  url="$1"
  out="$2"
  # retries + timeouts, damit CI nicht "hängt"
  curl -fsSL \
    --retry 5 --retry-delay 2 --retry-connrefused \
    --connect-timeout 20 --max-time 300 \
    -o "$out" "$url"
}

###############################################################################
# CITY_MAP lookup -> AGS8
###############################################################################
ags_from_citymap() {
  ckey="$(norm_key "$1")"
  printf "%s\n" "$CITY_MAP" \
    | awk -F'|' -v k="$ckey" 'tolower($1)==tolower(k){print $2; exit}'
}

set_region_from_ags8() {
  ags="$1"
  ags="$(printf "%s" "$ags" | tr -cd '0-9')"
  if [ "${#ags}" -ne 8 ]; then
    echo "ERROR: AGS muss 8-stellig sein (z.B. Hannover=03241001)." >&2
    exit 2
  fi

  ULAND="$(printf "%s" "$ags" | cut -c1-2)"
  UREGBEZ="$(printf "%s" "$ags" | cut -c3-3)"
  UKREIS="$(printf "%s" "$ags" | cut -c4-5)"
  UGEMEINDE="$(printf "%s" "$ags" | cut -c6-8)"
}

set_region_from_city() {
  city="$1"

  if [ -n "$AGS_OVERRIDE" ]; then
    set_region_from_ags8 "$AGS_OVERRIDE"
    CITY_DISPLAY="${city} (AGS ${AGS_OVERRIDE})"
    CITY_SUFFIX="$(norm_key "$city")"
    echo "== City: $CITY_DISPLAY =="
    echo "   -> ULAND=$ULAND UREGBEZ=$UREGBEZ UKREIS=$UKREIS UGEMEINDE=$UGEMEINDE"
    echo "   -> Dateisuffix: $CITY_SUFFIX"
    return 0
  fi

  ags="$(ags_from_citymap "$city")"
  if [ -z "$ags" ]; then
    echo "ERROR: Stadt \"$city\" nicht in CITY_MAP." >&2
    echo "       Nutze --ags (z.B. Hannover=03241001, Bonn=05314000) oder ergänze CITY_MAP." >&2
    exit 2
  fi

  set_region_from_ags8 "$ags"

  CITY_DISPLAY="${city} (AGS ${ags})"
  CITY_SUFFIX="$(norm_key "$city")"

  echo "== City: $CITY_DISPLAY =="
  echo "   -> ULAND=$ULAND UREGBEZ=$UREGBEZ UKREIS=$UKREIS UGEMEINDE=$UGEMEINDE"
  echo "   -> Dateisuffix: $CITY_SUFFIX"
}

###############################################################################
# Jahr verarbeiten -> Append in Combined-Dateien
###############################################################################
process_year_append() {
  year="$1"
  zip="${OUTDIR}/${year}.zip"
  url="https://www.opengeodata.nrw.de/produkte/transport_verkehr/unfallatlas/Unfallorte${year}_EPSG25832_CSV.zip"

  echo "== $year =="

  fetch_zip "$url" "$zip"

  datafile="$(unzip -Z1 "$zip" \
    | grep -Ei "Unfallorte${year}.*\.(csv|txt)$" \
    | grep -Evi "(readme|lizenz|license)" \
    | head -n 1 || true)"

  if [ -z "$datafile" ]; then
    echo "WARN: Keine passende Datendatei im Zip gefunden ($zip)" >&2
    return 0
  fi

  outcsv_year="${OUTDIR}/output${year}${CITY_SUFFIX:+_${CITY_SUFFIX}}.csv"
  outgeo_year="${OUTDIR}/output${year}${CITY_SUFFIX:+_${CITY_SUFFIX}}.geojson"

  unzip -p "$zip" "$datafile" \
  | awk -F';' -v year="$year" -v limit="$LIMIT" \
        -v uland="$ULAND" -v ureg="$UREGBEZ" -v ukreis="$UKREIS" -v ugem="$UGEMEINDE" \
        -v istrad="$IST_RAD" -v ispkw="$IST_PKW" -v isfuss="$IST_FUSS" -v iskrad="$IST_KRAD" \
        -v outcsv="$COMBINED_CSV" -v outgeo="$COMBINED_GEO" -v firstref="$COMBINED_GEO_FIRST" \
        -v peryear="$DO_PER_YEAR" -v outcsv_y="$outcsv_year" -v outgeo_y="$outgeo_year" '
    function pick(a,b,c,d,e) {
      if (a!="" && (a in idx)) return idx[a]
      if (b!="" && (b in idx)) return idx[b]
      if (c!="" && (c in idx)) return idx[c]
      if (d!="" && (d in idx)) return idx[d]
      if (e!="" && (e in idx)) return idx[e]
      return 0
    }
    function jesc(s,   t) {
      t = (s=="" ? "" : s)
      gsub(/\\/,"\\\\",t)
      gsub(/"/,"\\\"",t)
      gsub(/\r/,"",t)
      gsub(/\n/,"\\n",t)
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
    BEGIN {
      first = firstref + 0
      out = 0
      if (peryear=="1") {
        print "WKT,Name,OBJECTID,UKATEGORIE,UTYP1,UART,UMONAT,USTUNDE,UWOCHENTAG,STRZUSTAND,ULICHTVERH,ISTRAD,ISTPKW,ISTFUSS,ISTKRAD\r" > outcsv_y
        print "{\n  \"type\": \"FeatureCollection\",\n  \"features\": [" > outgeo_y
        first_y=1
      }
    }
    NR==1 {
      for (i=1; i<=NF; i++) { gsub(/\r/,"",$i); idx[$i]=i }

      i_id     = pick("ID","OBJECTID","OBJECTID_1","","")
      i_uland  = pick("ULAND","","","","")
      i_ureg   = pick("UREGBEZ","","","","")
      i_ukreis = pick("UKREIS","","","","")
      i_ugem   = pick("UGEMEINDE","","","","")

      i_istrad = pick("IstRad","ISTRAD","","","")
      i_ispkw  = pick("IstPKW","ISTPKW","","","")
      i_isfuss = pick("IstFuss","ISTFUSS","IstFuß","ISTFUß","")
      i_iskrad = pick("IstKrad","ISTKRAD","","","")

      i_licht  = pick("ULICHTVERH","U_LICHTVERH","","","")

      i_kat    = pick("UKATEGORIE","","","","")
      i_typ1   = pick("UTYP1","","","","")
      i_uart   = pick("UART","","","","")
      i_monat  = pick("UMONAT","","","","")
      i_stunde = pick("USTUNDE","","","","")
      i_wtag   = pick("UWOCHENTAG","","","","")
      i_strz   = pick("STRZUSTAND","","","","")

      i_lon = pick("XGCSWGS84","X_GCSWGS84","","","")
      i_lat = pick("YGCSWGS84","Y_GCSWGSW84","Y_GCSWGS84","","")

      i_str = pick("Strasse","STRASSE","StrName","STRNAME","USTRNAME")

      if (i_lon==0 || i_lat==0) { skip=1 } else { skip=0 }
      next
    }
    NR>1 {
      if (skip) next
      if (i_uland==0 || i_ureg==0 || i_ukreis==0) next

      if ($i_uland != uland)  next
      if ($i_ureg  != ureg)   next
      if ($i_ukreis!= ukreis) next
      if (ugem != "" && i_ugem>0 && $i_ugem != ugem) next

      if (!ok_involvement()) next

      out++
      if (limit > 0 && out > limit) exit

      id = (i_id ? $i_id : out)

      lon = $i_lon; lat = $i_lat
      gsub(/\r/,"",lon); gsub(/\r/,"",lat)
      gsub(/,/,".",lon); gsub(/,/,".",lat)

      str = (i_str ? $i_str : ""); gsub(/\r/,"",str)
      licht = (i_licht ? $i_licht : ""); gsub(/\r/,"",licht)

      kat    = (i_kat ? $i_kat : "")
      typ1   = (i_typ1 ? $i_typ1 : "")
      uart   = (i_uart ? $i_uart : "")
      monat  = (i_monat ? $i_monat : "")
      stunde = (i_stunde ? $i_stunde : "")
      wtag   = (i_wtag ? $i_wtag : "")
      strz   = (i_strz ? $i_strz : "")

      gsub(/\r/,"",kat); gsub(/\r/,"",typ1); gsub(/\r/,"",uart)
      gsub(/\r/,"",monat); gsub(/\r/,"",stunde); gsub(/\r/,"",wtag); gsub(/\r/,"",strz)

      v_istrad = (i_istrad ? $i_istrad : "")
      v_ispkw  = (i_ispkw  ? $i_ispkw  : "")
      v_isfuss = (i_isfuss ? $i_isfuss : "")
      v_iskrad = (i_iskrad ? $i_iskrad : "")

      gsub(/\r/,"",v_istrad); gsub(/\r/,"",v_ispkw); gsub(/\r/,"",v_isfuss); gsub(/\r/,"",v_iskrad)

      name = "Unfall " id " (" year ")"
      if (kat != "") name = name " Kat:" kat
      if (licht != "") name = name ", Licht: " licht
      if (str   != "") name = name " Strasse: " str

      # CSV (voll)
      print "\"POINT (" lon " " lat ")\"," name "," id "," kat "," typ1 "," uart "," monat "," stunde "," wtag "," strz "," licht "," v_istrad "," v_ispkw "," v_isfuss "," v_iskrad "\r" >> outcsv

      # GeoJSON (voll)
      if (first==0) print "," >> outgeo
      first=0

      print "    {\n" \
            "      \"type\": \"Feature\",\n" \
            "      \"geometry\": { \"type\": \"Point\", \"coordinates\": [" lon ", " lat "] },\n" \
            "      \"properties\": {\n" \
            "        \"id\": \"" jesc(id) "\",\n" \
            "        \"name\": \"" jesc(name) "\",\n" \
            "        \"year\": " year ",\n" \
            "        \"ulichtverh\": \"" jesc(licht) "\",\n" \
            "        \"strasse\": \"" jesc(str) "\",\n" \
            "        \"ukategorie\": \"" jesc(kat) "\",\n" \
            "        \"utyp1\": \"" jesc(typ1) "\",\n" \
            "        \"uart\": \"" jesc(uart) "\",\n" \
            "        \"umonat\": \"" jesc(monat) "\",\n" \
            "        \"ustunde\": \"" jesc(stunde) "\",\n" \
            "        \"uwochentag\": \"" jesc(wtag) "\",\n" \
            "        \"strzustand\": \"" jesc(strz) "\",\n" \
            "        \"istrad\": \"" jesc(v_istrad) "\",\n" \
            "        \"istpkw\": \"" jesc(v_ispkw) "\",\n" \
            "        \"istfuss\": \"" jesc(v_isfuss) "\",\n" \
            "        \"istkrad\": \"" jesc(v_iskrad) "\"\n" \
            "      }\n" \
            "    }" >> outgeo

      if (peryear=="1") {
        print "\"POINT (" lon " " lat ")\"," name "," id "," kat "," typ1 "," uart "," monat "," stunde "," wtag "," strz "," licht "," v_istrad "," v_ispkw "," v_isfuss "," v_iskrad "\r" >> outcsv_y

        if (!first_y) print "," >> outgeo_y
        first_y=0

        print "    {\n" \
              "      \"type\": \"Feature\",\n" \
              "      \"geometry\": { \"type\": \"Point\", \"coordinates\": [" lon ", " lat "] },\n" \
              "      \"properties\": {\n" \
              "        \"id\": \"" jesc(id) "\",\n" \
              "        \"name\": \"" jesc(name) "\",\n" \
              "        \"year\": " year ",\n" \
              "        \"ulichtverh\": \"" jesc(licht) "\",\n" \
              "        \"strasse\": \"" jesc(str) "\",\n" \
              "        \"ukategorie\": \"" jesc(kat) "\",\n" \
              "        \"utyp1\": \"" jesc(typ1) "\",\n" \
              "        \"uart\": \"" jesc(uart) "\",\n" \
              "        \"umonat\": \"" jesc(monat) "\",\n" \
              "        \"ustunde\": \"" jesc(stunde) "\",\n" \
              "        \"uwochentag\": \"" jesc(wtag) "\",\n" \
              "        \"strzustand\": \"" jesc(strz) "\",\n" \
              "        \"istrad\": \"" jesc(v_istrad) "\",\n" \
              "        \"istpkw\": \"" jesc(v_ispkw) "\",\n" \
              "        \"istfuss\": \"" jesc(v_isfuss) "\",\n" \
              "        \"istkrad\": \"" jesc(v_iskrad) "\"\n" \
              "      }\n" \
              "    }" >> outgeo_y
      }
    }
    END {
      if (peryear=="1" && !skip) print "\n  ]\n}" >> outgeo_y
      printf "FIRSTFLAG=%d\n", first > "/dev/stderr"
    }
  ' 2> "${OUTDIR}/.firstflag.tmp"

  if [ -f "${OUTDIR}/.firstflag.tmp" ]; then
    COMBINED_GEO_FIRST="$(awk -F= '/^FIRSTFLAG=/{print $2; exit}' "${OUTDIR}/.firstflag.tmp" || echo "$COMBINED_GEO_FIRST")"
    rm -f "${OUTDIR}/.firstflag.tmp"
  fi
}

###############################################################################
# Atomisches Schreiben für Combined-Dateien:
#   schreibe in *.tmp und mv am Ende nach final.
###############################################################################
run_combined_for_current_region() {
  suffix=""
  if [ -n "${CITY_SUFFIX:-}" ]; then suffix="_${CITY_SUFFIX}"; fi

  COMBINED_CSV_FINAL="${OUTDIR}/output_all_years${suffix}.csv"
  COMBINED_GEO_FINAL="${OUTDIR}/output_all_years${suffix}.geojson"

  COMBINED_CSV_TMP="${COMBINED_CSV_FINAL}.tmp"
  COMBINED_GEO_TMP="${COMBINED_GEO_FINAL}.tmp"

  # Cleanup tmp wenn wir vor mv rausfliegen
  cleanup_tmp() {
    rm -f "$COMBINED_CSV_TMP" "$COMBINED_GEO_TMP" 2>/dev/null || true
  }
  trap cleanup_tmp INT TERM HUP
  # EXIT-trap nur solange wir noch nicht erfolgreich gemoved haben:
  trap cleanup_tmp EXIT

  COMBINED_CSV="$COMBINED_CSV_TMP"
  COMBINED_GEO="$COMBINED_GEO_TMP"

  echo "WKT,Name,OBJECTID,UKATEGORIE,UTYP1,UART,UMONAT,USTUNDE,UWOCHENTAG,STRZUSTAND,ULICHTVERH,ISTRAD,ISTPKW,ISTFUSS,ISTKRAD\r" > "$COMBINED_CSV"
  { echo '{'; echo '  "type": "FeatureCollection",'; echo '  "features": ['; } > "$COMBINED_GEO"

  COMBINED_GEO_FIRST=1
  for y in $YEARS; do
    process_year_append "$y" || true
  done

  { echo; echo '  ]'; echo '}'; } >> "$COMBINED_GEO"

  # Validierung: GeoJSON muss parsebar sein (sonst NICHT mv!)
  if command -v python3 >/dev/null 2>&1; then
    python3 -m json.tool "$COMBINED_GEO" >/dev/null
  else
    # fallback: grobe Plausibilitätsprüfung (nicht perfekt, aber besser als nichts)
    tail -n 2 "$COMBINED_GEO" | grep -q '}' || {
      echo "ERROR: GeoJSON scheint unvollständig (keine abschließende '}' gefunden)." >&2
      exit 2
    }
  fi

  # Atomisch publishen
  mv -f "$COMBINED_CSV" "$COMBINED_CSV_FINAL"
  mv -f "$COMBINED_GEO" "$COMBINED_GEO_FINAL"

  # ab hier: tmp nicht mehr löschen
  trap - EXIT
  trap - INT TERM HUP

  echo "== fertig =="
  echo "City:   ${CITY_DISPLAY}"
  echo "CSV:    $COMBINED_CSV_FINAL"
  echo "GeoJSON: $COMBINED_GEO_FINAL"
  echo
}

###############################################################################
# Main
###############################################################################
if [ -n "$CITY_LIST" ]; then
  OLDIFS=$IFS; IFS=,; set -- $CITY_LIST; IFS=$OLDIFS
  for c in "$@"; do
    c="$(printf "%s" "$c" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
    [ -z "$c" ] && continue
    set_region_from_city "$c"
    run_combined_for_current_region
  done
  exit 0
fi

# ohne --city: manuelle/default Region
CITY_SUFFIX=""
CITY_DISPLAY="(manuell/default)"
run_combined_for_current_region