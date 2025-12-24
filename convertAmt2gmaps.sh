#!/bin/sh
set -eu

###############################################################################
# Unfallatlas -> CSV + GeoJSON (kombiniert über mehrere Jahre)
#
# Robust:
#  - pro Jahr erst in temp puffern, nur bei Erfolg "committen"
#  - Combined-GeoJSON wird am Ende aus gültigen Feature-Blöcken gebaut
#  - GeoJSON wird IMMER korrekt geschlossen
###############################################################################

OUTDIR="out"
LIMIT=1999
YEARS="2016 2017 2018 2019 2020 2021 2022 2023 2024"

# Default Region: Region Hannover (ULAND=03, UREGBEZ=2, UKREIS=41)
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
    --city hannover --city bonn

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
      [ -n "${2:-}" ] || { echo "ERROR: --city braucht einen Wert" >&2; exit 2; }
      CITY_LIST="${CITY_LIST}${CITY_LIST:+,}$2"
      shift 2
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

ags_from_citymap() {
  ckey="$(norm_key "$1")"
  printf "%s\n" "$CITY_MAP" | awk -F'|' -v k="$ckey" 'tolower($1)==tolower(k){print $2; exit}'
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
  else
    ags="$(ags_from_citymap "$city")"
    if [ -z "$ags" ]; then
      echo "ERROR: Stadt \"$city\" nicht in CITY_MAP." >&2
      echo "       Nutze --ags (z.B. Hannover=03241001, Bonn=05314000) oder ergänze CITY_MAP." >&2
      exit 2
    fi
    set_region_from_ags8 "$ags"
    CITY_DISPLAY="${city} (AGS ${ags})"
    CITY_SUFFIX="$(norm_key "$city")"
  fi

  echo "== City: $CITY_DISPLAY =="
  echo "   -> ULAND=$ULAND UREGBEZ=$UREGBEZ UKREIS=$UKREIS UGEMEINDE=$UGEMEINDE"
  echo "   -> Dateisuffix: $CITY_SUFFIX"
}

###############################################################################
# Pro Jahr: Features + CSV-Zeilen erzeugen (in temp), nur bei Erfolg übernehmen
###############################################################################
process_year_to_buffers() {
  year="$1"
  zip="${OUTDIR}/${year}.zip"
  url="https://www.opengeodata.nrw.de/produkte/transport_verkehr/unfallatlas/Unfallorte${year}_EPSG25832_CSV.zip"

  if [ -s "$zip" ]; then
    echo "== $year == (cached)"
  else
    echo "== $year == (downloading)"
    if ! curl -fsSL -o "$zip" "$url"; then
      echo "WARN: Download fehlgeschlagen: $url" >&2
      return 0
    fi
  fi

  # Einmal listen statt mehrfach unzip -Z1
  if ! ziplist="$(unzip -Z1 "$zip" 2>/dev/null)"; then
    echo "WARN: Zip kaputt/unlesbar: $zip" >&2
    return 0
  fi

  datafile="$(printf "%s\n" "$ziplist" \
    | grep -Ei "Unfallorte${year}.*\.(csv|txt)$" \
    | grep -Evi "(readme|lizenz|license)" \
    | head -n 1 || true)"

  if [ -z "$datafile" ]; then
    echo "WARN: Keine passende Datendatei im Zip gefunden ($zip)" >&2
    return 0
  fi

  # Year temp buffers
  y_csv_tmp="${TMPDIR}/rows_${year}.csv.tmp"
  y_feat_tmp="${TMPDIR}/feats_${year}.json.tmp"

  : > "$y_csv_tmp"
  : > "$y_feat_tmp"

  # awk schreibt NUR in year-temp (nicht direkt in combined!)
  if ! unzip -p "$zip" "$datafile" \
    | awk -F';' -v year="$year" -v limit="$LIMIT" \
          -v uland="$ULAND" -v ureg="$UREGBEZ" -v ukreis="$UKREIS" -v ugem="$UGEMEINDE" \
          -v istrad="$IST_RAD" -v ispkw="$IST_PKW" -v isfuss="$IST_FUSS" -v iskrad="$IST_KRAD" \
          -v outrows="$y_csv_tmp" -v outfeat="$y_feat_tmp" '
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
        gsub(/\r/,"",t)
        gsub(/[\001-\037]/,"",t)   # Steuerzeichen raus (JSON-Killer)
        gsub(/\\/,"\\\\",t)
        gsub(/"/,"\\\"",t)
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

      BEGIN { out=0; first=1; skip=0 }

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

        if (i_lon==0 || i_lat==0) { skip=1 }
        next
      }

      NR>1 {
        if (skip) next
        if (i_uland==0 || i_ureg==0 || i_ukreis==0) next

        # numerisch vergleichen -> "00" und "0" sind gleich
        if (($i_uland + 0)  != (uland + 0))  next
        if (($i_ureg  + 0)  != (ureg  + 0))  next
        if (($i_ukreis + 0) != (ukreis + 0)) next

        # UGEMEINDE nur prüfen, wenn gesetzt; auch numerisch
        if (ugem != "" && i_ugem > 0 && (($i_ugem + 0) != (ugem + 0))) next

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

        v_istrad = (i_istrad ? $i_istrad : "")
        v_ispkw  = (i_ispkw  ? $i_ispkw  : "")
        v_isfuss = (i_isfuss ? $i_isfuss : "")
        v_iskrad = (i_iskrad ? $i_iskrad : "")

        name = "Unfall " id " (" year ")"
        if (kat != "") name = name " Kat:" kat
        if (licht != "") name = name ", Licht: " licht
        if (str   != "") name = name " Strasse: " str

        # CSV-Zeile (nur rows, Header macht Shell)
        print "\"POINT (" lon " " lat ")\"," name "," id "," kat "," typ1 "," uart "," monat "," stunde "," wtag "," strz "," licht "," v_istrad "," v_ispkw "," v_isfuss "," v_iskrad "\r" >> outrows

        # Feature (ohne FeatureCollection-Wrapper)
        if (!first) print "," >> outfeat
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
              "    }" >> outfeat
      }
    '; then
    echo "WARN: Verarbeitung fehlgeschlagen für Jahr $year (ignoriert, Combined bleibt sauber)." >&2
    rm -f "$y_csv_tmp" "$y_feat_tmp" 2>/dev/null || true
    return 0
  fi

  # Wenn das Jahr erfolgreich ist: in Combined übernehmen
  if [ -s "$y_csv_tmp" ]; then
    cat "$y_csv_tmp" >> "$COMBINED_CSV_TMP"
  fi
  if [ -s "$y_feat_tmp" ]; then
    if [ "$COMBINED_HAS_FEATURES" = "1" ]; then
      printf ",\n" >> "$COMBINED_FEATS_TMP"
    fi
    cat "$y_feat_tmp" >> "$COMBINED_FEATS_TMP"
    COMBINED_HAS_FEATURES="1"
  fi

  # Optional per-year Outputs (gültig geschlossen!)
  if [ "$DO_PER_YEAR" = "1" ]; then
    outcsv_year="${OUTDIR}/output${year}${CITY_SUFFIX:+_${CITY_SUFFIX}}.csv"
    outgeo_year="${OUTDIR}/output${year}${CITY_SUFFIX:+_${CITY_SUFFIX}}.geojson"

    outcsv_year_tmp="${outcsv_year}.tmp"
    outgeo_year_tmp="${outgeo_year}.tmp"

    echo "WKT,Name,OBJECTID,UKATEGORIE,UTYP1,UART,UMONAT,USTUNDE,UWOCHENTAG,STRZUSTAND,ULICHTVERH,ISTRAD,ISTPKW,ISTFUSS,ISTKRAD\r" > "$outcsv_year_tmp"
    cat "$y_csv_tmp" >> "$outcsv_year_tmp"

    {
      echo '{'
      echo '  "type": "FeatureCollection",'
      echo '  "features": ['
      cat "$y_feat_tmp"
      echo
      echo '  ]'
      echo '}'
    } > "$outgeo_year_tmp"

    mv -f "$outcsv_year_tmp" "$outcsv_year"
    mv -f "$outgeo_year_tmp" "$outgeo_year"
  fi

  rm -f "$y_csv_tmp" "$y_feat_tmp" 2>/dev/null || true
}

run_combined_for_current_region() {
  suffix=""
  [ -n "${CITY_SUFFIX:-}" ] && suffix="_${CITY_SUFFIX}"

  COMBINED_CSV="${OUTDIR}/output_all_years${suffix}.csv"
  COMBINED_GEO="${OUTDIR}/output_all_years${suffix}.geojson"

  COMBINED_CSV_TMP="${COMBINED_CSV}.tmp"
  COMBINED_GEO_TMP="${COMBINED_GEO}.tmp"

  TMPDIR="${OUTDIR}/.tmp_build${suffix}_$$"
  mkdir -p "$TMPDIR"

  COMBINED_FEATS_TMP="${TMPDIR}/features.json.tmp"
  : > "$COMBINED_FEATS_TMP"
  COMBINED_HAS_FEATURES="0"

  echo "WKT,Name,OBJECTID,UKATEGORIE,UTYP1,UART,UMONAT,USTUNDE,UWOCHENTAG,STRZUSTAND,ULICHTVERH,ISTRAD,ISTPKW,ISTFUSS,ISTKRAD\r" > "$COMBINED_CSV_TMP"

  for y in $YEARS; do
    process_year_to_buffers "$y" || true
  done

  {
    echo '{'
    echo '  "type": "FeatureCollection",'
    echo '  "features": ['
    cat "$COMBINED_FEATS_TMP"
    echo
    echo '  ]'
    echo '}'
  } > "$COMBINED_GEO_TMP"

  mv -f "$COMBINED_CSV_TMP" "$COMBINED_CSV"
  mv -f "$COMBINED_GEO_TMP" "$COMBINED_GEO"

  rm -rf "$TMPDIR" 2>/dev/null || true

  echo "== fertig =="
  echo "City:   ${CITY_DISPLAY}"
  echo "CSV:    $COMBINED_CSV"
  echo "GeoJSON: $COMBINED_GEO"
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

CITY_SUFFIX=""
CITY_DISPLAY="(manuell/default)"
run_combined_for_current_region