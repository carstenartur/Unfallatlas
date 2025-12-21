#!/bin/sh
set -eu

###############################################################################
# Unfallatlas -> Google-Maps-CSV + GeoJSON
###############################################################################

OUTDIR="out"
LIMIT=1999
YEARS="2016 2017 2018 2019 2020 2021 2022 2023 2024"

# Default: Region Hannover
ULAND="03"
UREGBEZ="2"
UKREIS="41"
UGEMEINDE=""
CITY_DISPLAY="Hannover (Default)"

# Beteiligung (Filter)
IST_RAD="1"
IST_PKW=""
IST_FUSS=""
IST_KRAD=""

mkdir -p "$OUTDIR"

###############################################################################
# Jahr verarbeiten
###############################################################################
process_year() {
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

  outcsv="${OUTDIR}/output${year}.csv"
  outgeo="${OUTDIR}/output${year}.geojson"

  unzip -p "$zip" "$datafile" \
  | awk -F';' -v year="$year" -v limit="$LIMIT" \
        -v uland="$ULAND" -v ureg="$UREGBEZ" -v ukreis="$UKREIS" -v ugem="$UGEMEINDE" \
        -v istrad="$IST_RAD" -v ispkw="$IST_PKW" -v isfuss="$IST_FUSS" -v iskrad="$IST_KRAD" \
        -v outcsv="$outcsv" -v outgeo="$outgeo" '

    function pick(a,b,c,d,e){
      if(a!="" && (a in idx)) return idx[a]
      if(b!="" && (b in idx)) return idx[b]
      if(c!="" && (c in idx)) return idx[c]
      if(d!="" && (d in idx)) return idx[d]
      if(e!="" && (e in idx)) return idx[e]
      return 0
    }
    function esc(s){
      gsub(/\\/,"\\\\",s); gsub(/"/,"\\\"",s)
      gsub(/\r/,"",s); gsub(/\n/,"\\n",s)
      return s
    }
    function ok_involvement(){
      if(istrad=="" && ispkw=="" && isfuss=="" && iskrad=="") return 1
      if(istrad!="" && i_istrad>0 && $i_istrad==istrad) return 1
      if(ispkw!=""  && i_ispkw>0  && $i_ispkw==ispkw)   return 1
      if(isfuss!="" && i_isfuss>0 && $i_isfuss==isfuss) return 1
      if(iskrad!="" && i_iskrad>0 && $i_iskrad==iskrad) return 1
      return 0
    }

    BEGIN{
      print "WKT,Name,OBJECTID,UKATEGORIE,ULICHTVERH,ISTRAD,ISTPKW,ISTFUSS,ISTKRAD\r" > outcsv
      print "{\n  \"type\": \"FeatureCollection\",\n  \"features\": [" > outgeo
      first=1; out=0
    }

    NR==1{
      for(i=1;i<=NF;i++){ gsub(/\r/,"",$i); idx[$i]=i }

      i_id=pick("ID","OBJECTID","OBJECTID_1","","")
      i_uland=pick("ULAND","","","","")
      i_ureg=pick("UREGBEZ","","","","")
      i_ukreis=pick("UKREIS","","","","")
      i_ugem=pick("UGEMEINDE","","","","")

      i_istrad=pick("IstRad","ISTRAD","","","")
      i_ispkw=pick("IstPKW","ISTPKW","","","")
      i_isfuss=pick("IstFuss","ISTFUSS","IstFuß","ISTFUß","")
      i_iskrad=pick("IstKrad","ISTKRAD","","","")

      i_kat=pick("UKATEGORIE","","","","")
      i_licht=pick("ULICHTVERH","","","","")

      i_lon=pick("XGCSWGS84","","","","")
      i_lat=pick("YGCSWGS84","","","","")

      if(i_lon==0 || i_lat==0){ skip=1 } else skip=0
      next
    }

    NR>1{
      if(skip) next
      if($i_uland!=uland || $i_ureg!=ureg || $i_ukreis!=ukreis) next
      if(ugem!="" && i_ugem>0 && $i_ugem!=ugem) next
      if(!ok_involvement()) next

      out++; if(out>limit) exit

      lon=$i_lon; lat=$i_lat
      gsub(/,/,".",lon); gsub(/,/,".",lat)

      kat=(i_kat?$i_kat:"")
      licht=(i_licht?$i_licht:"")

      v_istrad=(i_istrad?$i_istrad:"")
      v_ispkw=(i_ispkw?$i_ispkw:"")
      v_isfuss=(i_isfuss?$i_isfuss:"")
      v_iskrad=(i_iskrad?$i_iskrad:"")

      name="Unfall " $i_id " (" year ") Kat:" kat

      print "\"POINT (" lon " " lat ")\"," name "," $i_id "," kat "," licht "," \
            v_istrad "," v_ispkw "," v_isfuss "," v_iskrad "\r" >> outcsv

      if(!first) print "," >> outgeo
      first=0

      print "    {\n" \
            "      \"type\": \"Feature\",\n" \
            "      \"geometry\": { \"type\": \"Point\", \"coordinates\": [" lon ", " lat "] },\n" \
            "      \"properties\": {\n" \
            "        \"id\": \"" esc($i_id) "\",\n" \
            "        \"year\": " year ",\n" \
            "        \"ukategorie\": \"" esc(kat) "\",\n" \
            "        \"ulichtverh\": \"" esc(licht) "\",\n" \
            "        \"istrad\": \"" esc(v_istrad) "\",\n" \
            "        \"istpkw\": \"" esc(v_ispkw) "\",\n" \
            "        \"istfuss\": \"" esc(v_isfuss) "\",\n" \
            "        \"istkrad\": \"" esc(v_iskrad) "\"\n" \
            "      }\n" \
            "    }" >> outgeo
    }

    END{
      if(!skip) print "\n  ]\n}" >> outgeo
    }
  '

  echo " -> $outcsv"
  echo " -> $outgeo"
}

###############################################################################
# Run
###############################################################################
for y in $YEARS; do
  process_year "$y" || true
done

###############################################################################
# Combine GeoJSON (mawk-safe)
###############################################################################
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
      BEGIN{inside=0; printed=0}
      /"features"[[:space:]]*:\s*\[/{inside=1; next}
      inside && /^[[:space:]]*\]/{inside=0; next}
      inside{
        if($0~/^[[:space:]]*$/) next
        if(firstref=="0" && printed==0) print ","
        printed=1
        print
      }
    ' "$f"
    first=0
  done
  echo '  ]'
  echo '}'
} > "$COMBINED_GEO"

echo "== fertig =="
echo "City: $CITY_DISPLAY"
echo "Outdir: $OUTDIR"
echo "Combined GEO: $COMBINED_GEO"