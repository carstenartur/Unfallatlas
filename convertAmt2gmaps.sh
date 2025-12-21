#!/bin/sh
set -eu

###############################################################################
# Unfallatlas Converter
# - Lädt Unfallatlas-Unfallorte je Jahr (CSV im ZIP)
# - Filtert nach Region (ULAND/UREGBEZ/UKREIS) und Unfallart (IstRad/IstPKW/…)
# - Erzeugt pro Jahr:
#     out/outputYYYY.csv     (Google-Maps CSV mit WKT)
#     out/outputYYYY.geojson (WGS84 GeoJSON)
# - Erzeugt kombiniert:
#     out/output_all_years.csv
#     out/output_all_years.geojson
#
# Neue Benutzerfunktionen:
#   --city "<Name>"      (z.B. "Hannover")
#   --city-id <ID>       (z.B. 032305)
#   --list-cities
#   --search <text>
#   --years 2019-2024  | --years 2018,2020,2022
#   --limit 2000
#   --outdir out
#   --rad | --pkw | --fuss | --krad | --gkfz | --sonstig
#
# WICHTIG ZUR "vollständigen" internen Liste:
# - Unten ist die komplette, im ursprünglichen Script enthaltene Ortsliste als
#   maschinenlesbare CITY_LIST enthalten (ID;NAME).
# - Für die tatsächliche Filterung braucht Unfallatlas aber ULAND/UREGBEZ/UKREIS.
#   Diese Werte sind NICHT in der ursprünglichen Liste enthalten.
# - Daher gibt es zusätzlich CITY_REGION_MAP für Orte/Regionen, für die diese
#   Codes explizit gepflegt sind. Default bleibt Hannover.
# - Du kannst CITY_REGION_MAP beliebig erweitern (einfach weitere Zeilen).
###############################################################################

usage() {
  cat <<'EOF'
Usage:
  ./convertAmt2gmaps.sh [options]

Options:
  --city <name>        Ortsname aus interner Liste (z.B. "Hannover")
  --city-id <id>       Orts-ID aus interner Liste (z.B. 032305)
  --list-cities        Alle Orte (Name + ID) anzeigen
  --search <text>      Suche in Ortsnamen/IDs
  --years <spec>       Jahre: "2019-2024" oder "2018,2020,2022"
  --limit <n>          Max. Features pro Jahr (Default: 1999)
  --outdir <dir>       Ausgabeordner (Default: out)
  --rad | --pkw | --fuss | --krad | --gkfz | --sonstig
                       Unfallart-Filter (Default: --rad)
  -h|--help            Hilfe

Default:
  Ohne --city/--city-id wird Region Hannover genutzt (ULAND=03, UREGBEZ=2, UKREIS=41).
EOF
}

###############################################################################
# Vollständige interne Ortsliste (aus dem ursprünglichen Script)
# Format: ID;NAME
###############################################################################
CITY_LIST=$(cat <<'EOF'
011112;Flensburg
011115;Husum
011118;Niebüll
011119;Schleswig
011312;Elmshorn
011315;Itzehoe
011319;Meldorf
011321;Pinneberg
011512;Bad Segeberg
011514;Eckernförde
011517;Kiel
011519;Neumünster
011522;Plön
011524;Rendsburg
011526;Norderstedt
011711;Ahrensburg
011716;Eutin
011721;Lübeck
011724;Oldenburg
011725;Ratzeburg
011726;Reinbek
011728;Schwarzenbek
021100;Hamburg
031101;Bad Gandersheim
031103;Braunschweig
031104;Goslar
031105;Helmstedt
031108;Salzgitter
031111;Seesen
031115;Wolfenbüttel
031116;Clausthal-Zellerfeld
031117;Wolfsburg
031202;Duderstadt
031203;Einbek
031204;Göttingen
031205;Hann. Münden
031206;Herzberg am Harz
031208;Northeim
031209;Osterode am Harz
032101;Bückeburg
032104;Rinteln
032106;Stadthagen
032303;Burgwedel
032304;Hameln
032305;Hannover
032306;Neustadt am Rübenb.
032307;Springe
032308;Wennigsen (Deister)
032401;Alfeld (Leine)
032403;Burgdorf
032404;Elze
032407;Gifhorn
032408;Hildesheim
032409;Holzminden
032410;Lehrte
032411;Peine
032503;Celle
032504;Dannenberg (Elbe)
032507;Lüneburg
032509;Soltau
032510;Uelzen
032511;Winsen (Luhe)
032601;Bremervörde
032602;Buxtehude
032603;Cuxhaven
032608;Langen
032611;Ottendorf
032612;Stade
032613;Tostedt
032614;Zeven
032701;Achim
032705;Diepholz
032708;Nienburg (Weser)
032709;Osterholz-Scharmbeck
032710;Rotenburg (Wümme)
032711;Stolzenau
032712;Sulingen
032713;Syke
032715;Verden
032716;Walsrode
033101;Aurich
033102;Emden
033104;Leer
033105;Norden
033107;Wittmund
033201;Brake
033202;Cloppenburg
033204;Delmenhorst
033207;Jever
033209;Nordenham
033210;Oldenburg (Oldenb.)
033211;Varel
033212;Vechta
033213;Westerstede
033214;Wildeshausen
033215;Wilhelmshaven
033302;Bersenbrück
033307;Bad Iburg
033308;Lingen
033310;Meppen
033312;Nordhorn
033313;Osnabrück
033314;Papenburg
EOF
)

###############################################################################
# Region-Mapping für Unfallatlas-Filter (ULAND/UREGBEZ/UKREIS)
# Format: KEY;ULAND;UREGBEZ;UKREIS;DISPLAY
#
# KEY ist ein normalisierter Ortsname (siehe norm_key()) oder eine ID.
# Du kannst beliebig weitere Zeilen hinzufügen.
#
# Hinweis:
# - Diese Codes beziehen sich auf Unfallatlas-Felder ULAND/UREGBEZ/UKREIS.
# - Für Hannover nutzen wir bewusst den Kreis "41" (Region Hannover).
###############################################################################
CITY_REGION_MAP=$(cat <<'EOF'
hannover;03;2;41;Hannover (Region Hannover)
032305;03;2;41;Hannover (Region Hannover)
hamburg;02;0;00;Hamburg (Land)
021100;02;0;00;Hamburg (Land)
berlin;11;0;00;Berlin (Land)
EOF
)

###############################################################################
# Helpers
###############################################################################
norm_key() {
  # Normalisiert Namen robust (Umlaute, Punkte, Klammern, Leerzeichen)
  # "Neustadt am Rübenb." -> "neustadt_am_ruebenb"
  printf "%s" "${1:-}" \
    | tr '[:upper:]' '[:lower:]' \
    | sed \
        -e 's/ä/ae/g' -e 's/ö/oe/g' -e 's/ü/ue/g' -e 's/ß/ss/g' \
        -e 's/[^a-z0-9]/_/g' \
        -e 's/__*/_/g' \
        -e 's/^_//' -e 's/_$//'
}

list_cities() {
  echo "$CITY_LIST" \
    | awk -F';' '{printf "%s (%s)\n",$2,$1}' \
    | sort
}

search_cities() {
  q="$(norm_key "${1:-}")"
  # match on normalized name OR raw ID substring
  echo "$CITY_LIST" | awk -F';' -v q="$q" '
    function norm(s,   t){
      t=tolower(s)
      gsub(/ä/,"ae",t); gsub(/ö/,"oe",t); gsub(/ü/,"ue",t); gsub(/ß/,"ss",t)
      gsub(/[^a-z0-9]/,"_",t)
      gsub(/__*/,"_",t)
      sub(/^_/,"",t); sub(/_$/,"",t)
      return t
    }
    {
      id=$1; name=$2
      if (index(id, q)>0 || norm(name) ~ q) printf "%s (%s)\n", name, id
    }
  ' | sort
}

# Liefert "ULAND UREGBEZ UKREIS DISPLAY" aus CITY_REGION_MAP, basierend auf key
resolve_region_by_key() {
  key="$1"
  line="$(echo "$CITY_REGION_MAP" | awk -F';' -v k="$key" '$1==k{print $2" "$3" "$4" "$5}')"
  if [ -z "${line:-}" ]; then
    return 1
  fi
  ULAND="$(echo "$line" | awk '{print $1}')"
  UREGBEZ="$(echo "$line" | awk '{print $2}')"
  UKREIS="$(echo "$line" | awk '{print $3}')"
  CITY_DISPLAY="$(echo "$line" | cut -d' ' -f4-)"
  return 0
}

# Stadtname -> erst in CITY_LIST nach ID suchen, dann Region anhand ID oder Name-Key
resolve_city_name() {
  name="$1"
  k="$(norm_key "$name")"

  # 1) Try direct region mapping by normalized name
  if resolve_region_by_key "$k"; then
    return 0
  fi

  # 2) Find ID in CITY_LIST via normalized name and try region mapping via ID
  id="$(echo "$CITY_LIST" | awk -F';' -v k="$k" '
    function norm(s,   t){
      t=tolower(s)
      gsub(/ä/,"ae",t); gsub(/ö/,"oe",t); gsub(/ü/,"ue",t); gsub(/ß/,"ss",t)
      gsub(/[^a-z0-9]/,"_",t)
      gsub(/__*/,"_",t)
      sub(/^_/,"",t); sub(/_$/,"",t)
      return t
    }
    norm($2)==k { print $1; exit }
  ')"

  if [ -n "${id:-}" ] && resolve_region_by_key "$id"; then
    return 0
  fi

  # 3) Unknown region codes: still show helpful message
  echo "ERROR: Ort \"$name\" ist in der internen Liste bekannt (key: $k),"
  echo "       aber es existiert kein ULAND/UREGBEZ/UKREIS Mapping in CITY_REGION_MAP."
  echo "       Bitte ergänze CITY_REGION_MAP um eine Zeile, z.B.:"
  echo "         $k;03;2;41;$name"
  echo "       (Codes entsprechen Unfallatlas-Spalten ULAND/UREGBEZ/UKREIS.)"
  exit 2
}

# Stadt-ID -> Region anhand ID-Key
resolve_city_id() {
  id="$1"
  if resolve_region_by_key "$id"; then
    return 0
  fi

  # show name if present
  nm="$(echo "$CITY_LIST" | awk -F';' -v id="$id" '$1==id{print $2; exit}')"
  if [ -n "${nm:-}" ]; then
    echo "ERROR: City-ID $id ($nm) ist bekannt, aber ohne Region-Mapping (ULAND/UREGBEZ/UKREIS)."
  else
    echo "ERROR: Unbekannte City-ID: $id"
  fi
  echo "       Ergänze CITY_REGION_MAP um eine Zeile wie:"
  echo "         $id;03;2;41;${nm:-<Name>}"
  exit 2
}

parse_years() {
  spec="$1"
  if echo "$spec" | grep -qE '^[0-9]{4}-[0-9]{4}$'; then
    a="${spec%-*}"; b="${spec#*-}"
    YEARS="$(awk -v a="$a" -v b="$b" 'BEGIN{for(i=a;i<=b;i++)printf i (i<b?" ":"")}')"
  else
    YEARS="$(echo "$spec" | tr ',' ' ' | tr -s ' ')"
  fi
}

###############################################################################
# Defaults (wie dein ursprüngliches Script)
###############################################################################
CITY_NAME=""
CITY_ID=""

# Default Region Hannover (032305) => ULAND=03, UREGBEZ=2, UKREIS=41
ULAND="03"
UREGBEZ="2"
UKREIS="41"
CITY_DISPLAY="Hannover (Default: Region Hannover)"

# Default Unfallart: Fahrrad
IST_RAD="1"
IST_PKW="0"
IST_FUSS="0"
IST_KRAD="0"
IST_GKFZ="0"
IST_SONSTIG="0"

LIMIT=1999
OUTDIR="out"
YEARS="2016 2017 2018 2019 2020 2021 2022 2023 2024"

###############################################################################
# CLI
###############################################################################
while [ $# -gt 0 ]; do
  case "$1" in
    --city) CITY_NAME="${2:-}"; shift 2;;
    --city-id) CITY_ID="${2:-}"; shift 2;;
    --list-cities) list_cities; exit 0;;
    --search) search_cities "${2:-}"; exit 0;;
    --years) parse_years "${2:-}"; shift 2;;
    --limit) LIMIT="${2:-}"; shift 2;;
    --outdir) OUTDIR="${2:-}"; shift 2;;

    --rad)     IST_RAD="1"; IST_PKW="0"; IST_FUSS="0"; IST_KRAD="0"; IST_GKFZ="0"; IST_SONSTIG="0"; shift;;
    --pkw)     IST_RAD="0"; IST_PKW="1"; IST_FUSS="0"; IST_KRAD="0"; IST_GKFZ="0"; IST_SONSTIG="0"; shift;;
    --fuss)    IST_RAD="0"; IST_PKW="0"; IST_FUSS="1"; IST_KRAD="0"; IST_GKFZ="0"; IST_SONSTIG="0"; shift;;
    --krad)    IST_RAD="0"; IST_PKW="0"; IST_FUSS="0"; IST_KRAD="1"; IST_GKFZ="0"; IST_SONSTIG="0"; shift;;
    --gkfz)    IST_RAD="0"; IST_PKW="0"; IST_FUSS="0"; IST_KRAD="0"; IST_GKFZ="1"; IST_SONSTIG="0"; shift;;
    --sonstig) IST_RAD="0"; IST_PKW="0"; IST_FUSS="0"; IST_KRAD="0"; IST_GKFZ="0"; IST_SONSTIG="1"; shift;;

    -h|--help) usage; exit 0;;
    *) echo "ERROR: Unbekannte Option: $1" >&2; usage; exit 2;;
  esac
done

# City wählen (Name oder ID; Name gewinnt, wenn beides gesetzt)
if [ -n "$CITY_NAME" ]; then
  resolve_city_name "$CITY_NAME"
elif [ -n "$CITY_ID" ]; then
  resolve_city_id "$CITY_ID"
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
      next
    }
    NR>1 {
      if (skip) next
      if (i_uland==0 || i_ureg==0 || i_ukreis==0) next

      if ($i_uland != uland)  next
      if ($i_ureg  != ureg)   next
      if ($i_ukreis!= ukreis) next

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

# Combined GeoJSON
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
echo "Region: ULAND=$ULAND UREGBEZ=$UREGBEZ UKREIS=$UKREIS  ($CITY_DISPLAY)"
echo "Years:  $YEARS"
echo "Limit:  $LIMIT"
echo "Outdir: $OUTDIR"
echo "Combined CSV:  $COMBINED_CSV"
echo "Combined GEO:  $COMBINED_GEO"