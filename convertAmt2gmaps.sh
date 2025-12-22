#!/bin/sh
set -eu

###############################################################################
# Unfallatlas -> Google-Maps-CSV + GeoJSON
#
# Standard-Ausgabe:
#   out/output_all_years[_{city}].csv
#   out/output_all_years[_{city}].geojson
#
# Optional:
#   --per-year  => zusätzlich out/outputYYYY.csv + out/outputYYYY.geojson
#
# City-Handling (schnell, CI-tauglich):
# - Kein automatischer Full-Cache-Build mehr.
# - Bei --city: erst lokaler Cache, sonst Online-Lookup (GVZ API ?search=...)
# - Treffer werden optional in out/city_cache.tsv gespeichert (nur verwendete Städte).
###############################################################################

OUTDIR="out"
LIMIT=1999
YEARS="2016 2017 2018 2019 2020 2021 2022 2023 2024"

ULAND="03"
UREGBEZ="2"
UKREIS="41"
UGEMEINDE=""
CITY_DISPLAY="(manuell/default)"

IST_RAD="1"
IST_PKW=""
IST_FUSS=""
IST_KRAD=""

CITY_CACHE="${OUTDIR}/city_cache.tsv"
CITY_MIN_POP=100000
GVZ_API_BASE="https://gvz.tuerantuer.org/api/administrative_divisions/"

usage() {
  cat <<'EOF'
Usage:
  ./convertAmt2gmaps.sh [options]

Optionen:
  --years "2018 2019 ..."     Jahre (Default: 2016..2024)
  --limit N                  Max. Treffer pro Jahr (Default: 1999), 0=unbegrenzt
  --outdir DIR               Ausgabeverzeichnis (Default: out)
  --per-year                 Zusätzlich pro Jahr outputYYYY.csv/.geojson erzeugen

Stadt:
  --city "Hannover"          erzeugt output_all_years_hannover.{csv,geojson}
  Mehrere:
    --city "Hannover,Bonn"
    --city Hannover --city Bonn

Cache:
  --update-city-cache        (langsam!) Full-Cache bauen (>=100k)
  --list-cities              Cache anzeigen
  --search "text"            Cache durchsuchen

Beteiligung:
  --rad 1|0
  --pkw 1|0
  --fuss 1|0
  --krad 1|0
EOF
}

CITY_LIST=""
CITY_SUFFIX=""
DO_UPDATE_CACHE="0"
DO_LIST_CITIES="0"
SEARCH_Q=""
DO_PER_YEAR="0"

while [ "${1:-}" != "" ]; do
  case "$1" in
    --years) YEARS="$2"; shift 2 ;;
    --limit) LIMIT="$2"; shift 2 ;;
    --outdir)
      OUTDIR="$2"
      CITY_CACHE="${2%/}/city_cache.tsv"
      shift 2
      ;;
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

    --update-city-cache) DO_UPDATE_CACHE="1"; shift 1 ;;
    --list-cities) DO_LIST_CITIES="1"; shift 1 ;;
    --search) SEARCH_Q="$2"; shift 2 ;;

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

# sehr simples URL-Encoding für query-params (reicht für Städte)
urlencode() {
  # ersetzt Leerzeichen->%20, Komma->%2C, Anführungszeichen etc. minimal
  printf "%s" "$1" \
    | sed -e 's/%/%25/g' \
          -e 's/ /%20/g' \
          -e 's/,/%2C/g' \
          -e 's/"/%22/g' \
          -e "s/'/%27/g"
}

# (langsam!) Full-Cache bauen – nur auf expliziten Wunsch
update_city_cache() {
  echo "== City-Cache aktualisieren (>=${CITY_MIN_POP}) =="

  tmp="${CITY_CACHE}.tmp"
  : > "$tmp"

  page=1
  while :; do
    url="${GVZ_API_BASE}?format=json&page=${page}"
    json="$(curl -fsSL "$url")" || break

    echo "$json" | awk -v min="${CITY_MIN_POP}" '
      function unesc(s){ gsub(/\\"/,"\"",s); gsub(/\\\\/,"\\",s); return s }
      BEGIN{ RS="\\{" ; FS="," }
      /"division_category":60/ {
        name=""; ags=""; pop=""
        for(i=1;i<=NF;i++){
          if($i ~ /"name":/){
            name=$i
            sub(/^.*"name":"?/,"",name); sub(/"?.*$/,"",name)
            name=unesc(name)
          }
          if($i ~ /"ags":/){
            ags=$i
            sub(/^.*"ags":"?/,"",ags); sub(/"?.*$/,"",ags)
          }
          if($i ~ /"citizens_total":/){
            pop=$i
            sub(/^.*"citizens_total":/,"",pop); sub(/[^0-9].*$/,"",pop)
          }
        }
        if(pop=="" || pop=="null") next
        if(pop+0 < min) next
        if(ags=="") next

        gsub(/[^0-9]/,"",ags)
        if(length(ags)==9) ags=substr(ags,2,8)
        if(length(ags)<8){ while(length(ags)<8) ags="0" ags }
        if(length(ags)!=8) next

        # Name vereinfachen:
        short=name
        # häufige Präfixe entfernen:
        sub(/^Landeshauptstadt[[:space:]]+/,"",short)
        sub(/^Hansestadt[[:space:]]+/,"",short)
        sub(/^Freie[[:space:]]+und[[:space:]]+Hansestadt[[:space:]]+/,"",short)
        sub(/^Stadt[[:space:]]+/,"",short)
        # nach Komma/Strich/klammer abschneiden
        sub(/,.*$/,"",short)
        sub(/[[:space:]]+-.*$/,"",short)
        sub(/[[:space:]]+\\(.*$/,"",short)
        gsub(/^[[:space:]]+|[[:space:]]+$/,"",short)

        printf "%s\t%s\t%s\n", short, ags, pop
      }
    ' >> "$tmp"

    echo "$json" | grep -q '"next":null' && break
    page=$((page+1))
  done

  awk -F'\t' '
    { k=tolower($1)
      if(!(k in best) || $3+0 > pop[k]+0){ best[k]=$0; pop[k]=$3 }
    }
    END{ for(k in best) print best[k] }
  ' "$tmp" | sort > "$CITY_CACHE"
  rm -f "$tmp"

  echo " -> $CITY_CACHE"
}

require_city_cache() {
  if [ ! -f "$CITY_CACHE" ]; then
    echo "ERROR: City-Cache fehlt: $CITY_CACHE" >&2
    echo "       Bitte ausführen: ./convertAmt2gmaps.sh --update-city-cache" >&2
    exit 2
  fi
}

list_cities() {
  require_city_cache
  awk -F'\t' '{printf "%s\t%s\t%s\n",$1,$2,$3}' "$CITY_CACHE"
}

search_cities() {
  require_city_cache
  q="$(norm_key "${1:-}")"
  awk -F'\t' -v q="$q" '
    function norm(s,   t){
      t=tolower(s)
      gsub(/ä/,"ae",t); gsub(/ö/,"oe",t); gsub(/ü/,"ue",t); gsub(/ß/,"ss",t)
      gsub(/[^a-z0-9]/,"_",t)
      gsub(/__*/,"_",t)
      sub(/^_/,"",t); sub(/_$/,"",t)
      return t
    }
    norm($1) ~ q || index($2,q)>0 { printf "%s\t%s\t%s\n",$1,$2,$3 }
  ' "$CITY_CACHE"
}

# Schnell: nur eine Stadt online suchen (statt Full-Cache)
# Gibt genau 1 Zeile aus: "Name<TAB>AGS8<TAB>Pop"
lookup_city_online() {
  city="$1"
  q="$(urlencode "$city")"
  url="${GVZ_API_BASE}?format=json&search=${q}"

  json="$(curl -fsSL "$url" || true)"
  [ -z "$json" ] && return 1

  # Suche nach division_category 60 (Stadt/Gemeinde), min pop, und nimm best match:
  echo "$json" | awk -v min="${CITY_MIN_POP}" -v want="$city" '
    function unesc(s){ gsub(/\\"/,"\"",s); gsub(/\\\\/,"\\",s); return s }
    function lower(s,  t){ t=s; for(i=1;i<=length(t);i++){} return tolower(t) }
    BEGIN{ RS="\\{" ; FS=","; bestScore=-1; bestLine="" }
    /"division_category":60/ {
      name=""; ags=""; pop=""
      for(i=1;i<=NF;i++){
        if($i ~ /"name":/){
          name=$i; sub(/^.*"name":"?/,"",name); sub(/"?.*$/,"",name); name=unesc(name)
        }
        if($i ~ /"ags":/){
          ags=$i; sub(/^.*"ags":"?/,"",ags); sub(/"?.*$/,"",ags)
        }
        if($i ~ /"citizens_total":/){
          pop=$i; sub(/^.*"citizens_total":/,"",pop); sub(/[^0-9].*$/,"",pop)
        }
      }
      if(pop=="" || pop=="null") next
      if(pop+0 < min) next
      if(ags=="") next

      gsub(/[^0-9]/,"",ags)
      if(length(ags)==9) ags=substr(ags,2,8)
      if(length(ags)<8){ while(length(ags)<8) ags="0" ags }
      if(length(ags)!=8) next

      short=name
      sub(/^Landeshauptstadt[[:space:]]+/,"",short)
      sub(/^Hansestadt[[:space:]]+/,"",short)
      sub(/^Freie[[:space:]]+und[[:space:]]+Hansestadt[[:space:]]+/,"",short)
      sub(/^Stadt[[:space:]]+/,"",short)
      sub(/,.*$/,"",short)
      sub(/[[:space:]]+-.*$/,"",short)
      sub(/[[:space:]]+\\(.*$/,"",short)
      gsub(/^[[:space:]]+|[[:space:]]+$/,"",short)

      w=tolower(want); s=tolower(short)

      # scoring: exakt > prefix > contains
      score=0
      if(s==w) score=300
      else if(index(s,w)==1) score=200
      else if(index(s,w)>0) score=100
      else score=0

      # bei gleichem score: höhere pop gewinnt
      if(score>bestScore || (score==bestScore && pop+0>bestPop+0)){
        bestScore=score
        bestPop=pop
        bestLine=short "\t" ags "\t" pop
      }
    }
    END{
      if(bestLine!="") print bestLine
    }
  ' | head -n 1
}

# City -> Region: Cache zuerst, sonst Online-Lookup; Treffer in Cache schreiben.
set_region_from_city() {
  city="$1"
  key="$(norm_key "$city")"

  line=""

  if [ -f "$CITY_CACHE" ]; then
    # exakte Übereinstimmung (case-insensitive) auf Spalte 1
    line="$(awk -F'\t' -v q="$city" 'BEGIN{ql=tolower(q)} tolower($1)==ql {print; exit}' "$CITY_CACHE" || true)"
  fi

  if [ -z "$line" ]; then
    echo "INFO: \"$city\" nicht im Cache -> Online-Lookup..."
    line="$(lookup_city_online "$city" || true)"
  fi

  if [ -z "$line" ]; then
    echo "ERROR: Stadt \"$city\" konnte weder im Cache noch online gefunden werden (>=${CITY_MIN_POP} Einwohner)." >&2
    echo "       Tipp: ./convertAmt2gmaps.sh --update-city-cache && ./convertAmt2gmaps.sh --search \"$city\"" >&2
    exit 2
  fi

  name="$(printf "%s" "$line" | awk -F'\t' '{print $1}')"
  ags="$(printf "%s" "$line" | awk -F'\t' '{print $2}')"
  pop="$(printf "%s" "$line" | awk -F'\t' '{print $3}')"

  ULAND="$(printf "%s" "$ags" | cut -c1-2)"
  UREGBEZ="$(printf "%s" "$ags" | cut -c3-3)"
  UKREIS="$(printf "%s" "$ags" | cut -c4-5)"
  UGEMEINDE="$(printf "%s" "$ags" | cut -c6-8)"

  CITY_DISPLAY="${name} (AGS ${ags}, Pop ${pop})"
  CITY_SUFFIX="$(norm_key "$name")"

  # optional: kleinen Cache pflegen (nur benutzte Städte)
  if [ ! -f "$CITY_CACHE" ]; then
    : > "$CITY_CACHE"
  fi
  # nur append, wenn nicht schon vorhanden (case-insensitive)
  if ! awk -F'\t' -v q="$name" 'BEGIN{ql=tolower(q)} tolower($1)==ql {found=1} END{exit(found?0:1)}' "$CITY_CACHE" >/dev/null 2>&1; then
    printf "%s\t%s\t%s\n" "$name" "$ags" "$pop" >> "$CITY_CACHE"
    sort -u -o "$CITY_CACHE" "$CITY_CACHE" 2>/dev/null || true
  fi

  echo "== City: $CITY_DISPLAY =="
  echo "   -> ULAND=$ULAND UREGBEZ=$UREGBEZ UKREIS=$UKREIS UGEMEINDE=$UGEMEINDE"
  echo "   -> Dateisuffix: $CITY_SUFFIX"
}

###############################################################################
# Jahr verarbeiten -> direkt in Combined-Dateien schreiben
###############################################################################
process_year_append() {
  year="$1"
  zip="${OUTDIR}/${year}.zip"
  url="https://www.opengeodata.nrw.de/produkte/transport_verkehr/unfallatlas/Unfallorte${year}_EPSG25832_CSV.zip"

  echo "== $year =="

  curl -fsSL -o "$zip" "$url"

  datafile="$(unzip -Z1 "$zip" \
    | grep -Ei "Unfallorte${year}.*\.(csv|txt)$" \
    | grep -Evi "(readme|lizenz|license)" \
    | head -n 1 || true)"

  if [ -z "$datafile" ]; then
    echo "WARN: Keine passende Datendatei im Zip gefunden ($zip)" >&2
    return 0
  fi

  outcsv_year="${OUTDIR}/output${year}.csv"
  outgeo_year="${OUTDIR}/output${year}.geojson"

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
      t=s
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
      i_lat = pick("YGCSWGS84","Y_GCSWGS84","","","")

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

      print "\"POINT (" lon " " lat ")\"," name "," id "," kat "," typ1 "," uart "," monat "," stunde "," wtag "," strz "," licht "," v_istrad "," v_ispkw "," v_isfuss "," v_iskrad "\r" >> outcsv

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

run_combined_for_current_region() {
  suffix=""
  if [ -n "${CITY_SUFFIX:-}" ]; then suffix="_${CITY_SUFFIX}"; fi

  COMBINED_CSV="${OUTDIR}/output_all_years${suffix}.csv"
  COMBINED_GEO="${OUTDIR}/output_all_years${suffix}.geojson"

  echo "WKT,Name,OBJECTID,UKATEGORIE,UTYP1,UART,UMONAT,USTUNDE,UWOCHENTAG,STRZUSTAND,ULICHTVERH,ISTRAD,ISTPKW,ISTFUSS,ISTKRAD\r" > "$COMBINED_CSV"
  { echo '{'; echo '  "type": "FeatureCollection",'; echo '  "features": ['; } > "$COMBINED_GEO"

  COMBINED_GEO_FIRST=1
  for y in $YEARS; do process_year_append "$y" || true; done

  { echo; echo '  ]'; echo '}'; } >> "$COMBINED_GEO"

  echo "== fertig =="
  echo "City:   ${CITY_DISPLAY}"
  echo "Combined CSV: $COMBINED_CSV"
  echo "Combined GEO: $COMBINED_GEO"
  echo
}

###############################################################################
# Main
###############################################################################
if [ "$DO_UPDATE_CACHE" = "1" ]; then
  update_city_cache
fi

if [ "$DO_LIST_CITIES" = "1" ]; then
  list_cities
  exit 0
fi

if [ -n "$SEARCH_Q" ]; then
  search_cities "$SEARCH_Q"
  exit 0
fi

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