#!/bin/sh
set -eu

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

Region:
  --uland 03 --uregb 2 --ukreis 41 [--ugemeinde 001]

Stadt:
  --city "Hannover"          (Cache -> Online) erzeugt output_all_years_hannover.{csv,geojson}
  Mehrere:
    --city "Hannover,Bonn"
    --city Hannover --city Bonn

CI-sicher (Bypass City-Lookup):
  --ags 03241001             setzt Region direkt aus AGS (LLRKKGGG)
  Mehrere:
    --ags 03241001 --ags 05314000

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
AGS_LIST=""
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

    --ags)
      if [ -n "${2:-}" ]; then
        AGS_LIST="${AGS_LIST}${AGS_LIST:+,}$2"
        shift 2
      else
        echo "ERROR: --ags braucht einen Wert (z.B. 03241001)" >&2
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

urlencode() {
  # minimal, reicht für query params (Leerzeichen, %, ", ', ,)
  printf "%s" "$1" \
    | sed -e 's/%/%25/g' \
          -e 's/ /%20/g' \
          -e 's/,/%2C/g' \
          -e 's/"/%22/g' \
          -e "s/'/%27/g"
}

###############################################################################
# Curl helper: retry + timeout (CI-freundlich)
###############################################################################
curl_json() {
  url="$1"
  # 3 Retries, connect timeout 10s, total 25s
  curl -fsSL --retry 3 --retry-delay 1 --connect-timeout 10 --max-time 25 "$url"
}

###############################################################################
# Python: pick best city from GVZ JSON
###############################################################################
pick_city_from_json_py() {
  want="$1"
  minpop="$2"
  python3 - "$want" "$minpop" <<'PY'
import sys, json, re

want_raw = sys.argv[1].strip()
want = want_raw.lower()
minpop = int(sys.argv[2])

def clean_name(name: str) -> str:
  s = name or ""
  s = re.sub(r'^Landeshauptstadt\s+', '', s, flags=re.I)
  s = re.sub(r'^Hansestadt\s+', '', s, flags=re.I)
  s = re.sub(r'^Freie\s+und\s+Hansestadt\s+', '', s, flags=re.I)
  s = re.sub(r'^Stadt\s+', '', s, flags=re.I)
  s = re.split(r',|\s+-|\s+\(', s, 1)[0]
  return s.strip()

def ags8(val) -> str:
  s = re.sub(r'[^0-9]', '', str(val or ""))
  if len(s) == 9:
    s = s[1:]
  s = s.zfill(8)
  return s if len(s) == 8 else ""

def score(name: str) -> int:
  n = name.lower()
  if n == want: return 300
  if n.startswith(want): return 200
  if want and want in n: return 100
  return 0

raw = sys.stdin.read().strip()
if not raw:
  sys.exit(0)

try:
  data = json.loads(raw)
except Exception:
  sys.exit(0)

results = data.get("results")
# Fallback: manche APIs liefern direkt ein Array
if results is None and isinstance(data, list):
  results = data
if results is None:
  results = []

best = None
fallback = None  # ohne Namensscore: nimm max pop, falls search schon einschränkt

for r in results:
  # division_category kann int oder string sein
  try:
    if int(r.get("division_category", -1)) != 60:
      continue
  except Exception:
    continue

  pop = r.get("citizens_total")
  if pop in (None, "", "null"):
    continue
  try:
    popi = int(pop)
  except Exception:
    continue
  if popi < minpop:
    continue

  name = clean_name(r.get("name", ""))
  a = ags8(r.get("ags"))
  if not name or not a:
    continue

  sc = score(name)
  cand = (sc, popi, name, a)

  if sc > 0:
    if best is None or cand > best:
      best = cand
  else:
    # fallback nur nach pop
    cand2 = (popi, name, a)
    if fallback is None or cand2 > fallback:
      fallback = cand2

if best:
  sc, popi, name, a = best
  sys.stdout.write(f"{name}\t{a}\t{popi}\n")
elif fallback:
  popi, name, a = fallback
  sys.stdout.write(f"{name}\t{a}\t{popi}\n")
PY
}

###############################################################################
# Full-Cache (nur auf Wunsch) – robust mit format=json
###############################################################################
update_city_cache() {
  echo "== City-Cache aktualisieren (>=${CITY_MIN_POP}) =="

  tmp="${CITY_CACHE}.tmp"
  : > "$tmp"

  page=1
  while :; do
    jsonfile="$(mktemp)"
    url="${GVZ_API_BASE}?format=json&page=${page}"

    if ! curl_json "$url" > "$jsonfile"; then
      rm -f "$jsonfile"
      break
    fi

    python3 - "$CITY_MIN_POP" < "$jsonfile" >> "$tmp" <<'PY'
import sys, json, re
minpop = int(sys.argv[1])

def clean_name(name: str) -> str:
  s = name or ""
  s = re.sub(r'^Landeshauptstadt\s+', '', s, flags=re.I)
  s = re.sub(r'^Hansestadt\s+', '', s, flags=re.I)
  s = re.sub(r'^Freie\s+und\s+Hansestadt\s+', '', s, flags=re.I)
  s = re.sub(r'^Stadt\s+', '', s, flags=re.I)
  s = re.split(r',|\s+-|\s+\(', s, 1)[0]
  return s.strip()

def ags8(val) -> str:
  s = re.sub(r'[^0-9]', '', str(val or ""))
  if len(s) == 9:
    s = s[1:]
  s = s.zfill(8)
  return s if len(s) == 8 else ""

raw = sys.stdin.read().strip()
if not raw:
  sys.exit(0)
data = json.loads(raw)
for r in data.get("results", []):
  try:
    if int(r.get("division_category", -1)) != 60:
      continue
  except Exception:
    continue
  pop = r.get("citizens_total")
  if pop in (None, "", "null"):
    continue
  try:
    popi = int(pop)
  except Exception:
    continue
  if popi < minpop:
    continue
  name = clean_name(r.get("name", ""))
  a = ags8(r.get("ags"))
  if name and a:
    print(f"{name}\t{a}\t{popi}")
PY

    if grep -q '"next":[[:space:]]*null' "$jsonfile"; then
      rm -f "$jsonfile"
      break
    fi

    rm -f "$jsonfile"
    page=$((page+1))
  done

  python3 - < "$tmp" > "$CITY_CACHE" <<'PY'
import sys
best={}
for line in sys.stdin:
  line=line.rstrip("\n")
  if not line: continue
  name, ags, pop = line.split("\t")
  k=name.lower()
  popi=int(pop)
  if k not in best or popi > best[k][2]:
    best[k]=(name, ags, popi)
for k in sorted(best.keys()):
  name, ags, popi = best[k]
  print(f"{name}\t{ags}\t{popi}")
PY

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

###############################################################################
# Online lookup: IMMER format=json; filter in Python (nicht per query-param)
###############################################################################
lookup_city_online() {
  city="$1"
  q="$(urlencode "$city")"

  # absichtlich ohne division_category param (kann je nach Backend anders heißen)
  url="${GVZ_API_BASE}?format=json&search=${q}&page_size=100"

  jsonfile="$(mktemp)"
  if ! curl_json "$url" > "$jsonfile"; then
    rm -f "$jsonfile"
    return 1
  fi

  pick_city_from_json_py "$city" "$CITY_MIN_POP" < "$jsonfile"
  rm -f "$jsonfile"
}

###############################################################################
# City -> Region (Cache -> Online), mit robusterem Cache-Match (norm_key)
###############################################################################
set_region_from_city() {
  city="$1"
  line=""

  if [ -f "$CITY_CACHE" ]; then
    # match über norm_key statt nur tolower-exakt
    key="$(norm_key "$city")"
    line="$(awk -F'\t' -v q="$key" '
      function norm(s,   t){
        t=tolower(s)
        gsub(/ä/,"ae",t); gsub(/ö/,"oe",t); gsub(/ü/,"ue",t); gsub(/ß/,"ss",t)
        gsub(/[^a-z0-9]/,"_",t)
        gsub(/__*/,"_",t)
        sub(/^_/,"",t); sub(/_$/,"",t)
        return t
      }
      norm($1)==q {print; exit}
    ' "$CITY_CACHE" || true)"
  fi

  if [ -z "$line" ]; then
    echo "INFO: \"$city\" nicht im Cache -> Online-Lookup..."
    line="$(lookup_city_online "$city" || true)"
  fi

  if [ -z "$line" ]; then
    echo "ERROR: Stadt \"$city\" konnte weder im Cache noch online gefunden werden (>=${CITY_MIN_POP} Einwohner)." >&2
    echo "       CI-Fallback: nutze --ags (z.B. Hannover=03241001, Bonn=05314000)." >&2
    exit 2
  fi

  name="$(printf "%s" "$line" | awk -F'\t' '{print $1}')"
  ags="$(printf "%s" "$line" | awk -F'\t' '{print $2}')"
  pop="$(printf "%s" "$line" | awk -F'\t' '{print $3}')"

  set_region_from_ags "$ags" "$name" "$pop"

  # Mini-Cache pflegen
  if [ ! -f "$CITY_CACHE" ]; then : > "$CITY_CACHE"; fi
  if ! awk -F'\t' -v q="$name" 'BEGIN{ql=tolower(q)} tolower($1)==ql {found=1} END{exit(found?0:1)}' \
      "$CITY_CACHE" >/dev/null 2>&1; then
    printf "%s\t%s\t%s\n" "$name" "$ags" "$pop" >> "$CITY_CACHE"
    sort -u -o "$CITY_CACHE" "$CITY_CACHE" 2>/dev/null || true
  fi
}

###############################################################################
# AGS -> Region (LL R KK GGG)
###############################################################################
set_region_from_ags() {
  ags="$1"
  name="${2:-AGS}"
  pop="${3:-}"

  # nur Ziffern
  ags="$(printf "%s" "$ags" | sed 's/[^0-9]//g')"
  if [ "${#ags}" -ne 8 ]; then
    echo "ERROR: AGS muss 8-stellig sein, bekommen: '$ags'" >&2
    exit 2
  fi

  ULAND="$(printf "%s" "$ags" | cut -c1-2)"
  UREGBEZ="$(printf "%s" "$ags" | cut -c3-3)"
  UKREIS="$(printf "%s" "$ags" | cut -c4-5)"
  UGEMEINDE="$(printf "%s" "$ags" | cut -c6-8)"

  if [ -n "$pop" ]; then
    CITY_DISPLAY="${name} (AGS ${ags}, Pop ${pop})"
  else
    CITY_DISPLAY="${name} (AGS ${ags})"
  fi
  CITY_SUFFIX="$(norm_key "$name")"

  echo "== City/AGS: $CITY_DISPLAY =="
  echo "   -> ULAND=$ULAND UREGBEZ=$UREGBEZ UKREIS=$UKREIS UGEMEINDE=$UGEMEINDE"
  echo "   -> Dateisuffix: $CITY_SUFFIX"
}

###############################################################################
# Unfallatlas Verarbeitung (wie dein aktueller Minimal-Output)
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

  unzip -p "$zip" "$datafile" \
  | awk -F';' -v year="$year" -v limit="$LIMIT" \
        -v uland="$ULAND" -v ureg="$UREGBEZ" -v ukreis="$UKREIS" -v ugem="$UGEMEINDE" \
        -v istrad="$IST_RAD" -v ispkw="$IST_PKW" -v isfuss="$IST_FUSS" -v iskrad="$IST_KRAD" \
        -v outcsv="$COMBINED_CSV" -v outgeo="$COMBINED_GEO" -v firstref="$COMBINED_GEO_FIRST" '
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
    BEGIN { first = firstref + 0; out = 0 }
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

      i_lon = pick("XGCSWGS84","X_GCSWGS84","","","")
      i_lat = pick("YGCSWGS84","Y_GCSWGS84","Y_GCSWGSW84","","")

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

      print "\"POINT (" lon " " lat ")\",Unfall " id " (" year ")," id "\r" >> outcsv
      if (first==0) print "," >> outgeo
      first=0
      print "    {\"type\":\"Feature\",\"geometry\":{\"type\":\"Point\",\"coordinates\":[" lon "," lat "]},\"properties\":{\"id\":\"" jesc(id) "\",\"year\":" year "}}" >> outgeo
    }
    END { printf "FIRSTFLAG=%d\n", first > "/dev/stderr" }
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

  echo "WKT,Name,OBJECTID\r" > "$COMBINED_CSV"
  { echo '{'; echo '  "type": "FeatureCollection",'; echo '  "features": ['; } > "$COMBINED_GEO"

  COMBINED_GEO_FIRST=1
  for y in $YEARS; do process_year_append "$y" || true; done

  { echo; echo '  ]'; echo '}'; } >> "$COMBINED_GEO"

  echo "== fertig =="
  echo "City:   ${CITY_DISPLAY}"
  echo "Filter: ULAND=$ULAND UREGBEZ=$UREGBEZ UKREIS=$UKREIS${UGEMEINDE:+ UGEMEINDE=$UGEMEINDE}"
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

# --- AGS hat Vorrang, weil CI-sicher ---
if [ -n "$AGS_LIST" ]; then
  OLDIFS=$IFS; IFS=,; set -- $AGS_LIST; IFS=$OLDIFS
  for a in "$@"; do
    a="$(printf "%s" "$a" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
    [ -z "$a" ] && continue
    set_region_from_ags "$a" "$a" ""
    run_combined_for_current_region
  done
  exit 0
fi

# --- City ---
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