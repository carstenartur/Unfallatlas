#!/usr/bin/env bash
set -euo pipefail

CITY="${1:-}"
if [[ -z "${CITY}" ]]; then
  echo "Usage: $0 \"City Name\""
  exit 1
fi

slug() {
  echo "$1" | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/ä/ae/g; s/ö/oe/g; s/ü/ue/g; s/ß/ss/g' \
    | sed -E 's/[^a-z0-9]+/_/g; s/^_+|_+$//g'
}

CITY_SLUG="$(slug "$CITY")"
OUTDIR="out"
mkdir -p "$OUTDIR"

echo "==> Resolve bbox for: $CITY"
# Nominatim -> bbox: [south, north, west, east]
# We request JSON with boundingbox
NOMI_JSON="$(curl -sG \
  --data-urlencode "q=${CITY}, Germany" \
  --data-urlencode "format=json" \
  --data-urlencode "limit=1" \
  --data-urlencode "bounded=0" \
  "https://nominatim.openstreetmap.org/search")"

# Extract bbox without jq (simple sed/grep approach)
# boundingbox:["50.6","50.8","7.0","7.2"]
BBOX_LINE="$(echo "$NOMI_JSON" | tr -d '\n' | sed -E 's/.*"boundingbox":\[(.*?)\].*/\1/')"
SOUTH="$(echo "$BBOX_LINE" | cut -d, -f1 | tr -d '"')"
NORTH="$(echo "$BBOX_LINE" | cut -d, -f2 | tr -d '"')"
WEST="$(echo  "$BBOX_LINE" | cut -d, -f3 | tr -d '"')"
EAST="$(echo  "$BBOX_LINE" | cut -d, -f4 | tr -d '"')"

if [[ -z "$SOUTH" || -z "$NORTH" || -z "$WEST" || -z "$EAST" ]]; then
  echo "Failed to resolve bbox. Nominatim response:"
  echo "$NOMI_JSON"
  exit 2
fi

echo "==> bbox: S=$SOUTH N=$NORTH W=$WEST E=$EAST"

echo "==> Query Overpass (schools/kindergartens/childcare)"
# Overpass QL: bbox is (south,west,north,east)
read -r -d '' QL <<EOF || true
[out:json][timeout:60];
(
  node["amenity"="school"]($SOUTH,$WEST,$NORTH,$EAST);
  way["amenity"="school"]($SOUTH,$WEST,$NORTH,$EAST);
  relation["amenity"="school"]($SOUTH,$WEST,$NORTH,$EAST);

  node["amenity"="kindergarten"]($SOUTH,$WEST,$NORTH,$EAST);
  way["amenity"="kindergarten"]($SOUTH,$WEST,$NORTH,$EAST);
  relation["amenity"="kindergarten"]($SOUTH,$WEST,$NORTH,$EAST);

  node["amenity"="childcare"]($SOUTH,$WEST,$NORTH,$EAST);
  way["amenity"="childcare"]($SOUTH,$WEST,$NORTH,$EAST);
  relation["amenity"="childcare"]($SOUTH,$WEST,$NORTH,$EAST);
);
out center tags;
EOF

OV_JSON="$(curl -s \
  --data-urlencode "data=$QL" \
  "https://overpass-api.de/api/interpreter")"

# Convert Overpass JSON -> GeoJSON (minimal, jq-less):
# We'll write a simple FeatureCollection with Point features using lat/lon or center.
# This is intentionally minimal so you can consume it easily.

OUTFILE="${OUTDIR}/poi_${CITY_SLUG}.geojson"
echo "==> Write $OUTFILE"

python3 - <<PY
import json, sys

data = json.loads(sys.stdin.read())
features = []
for el in data.get("elements", []):
    tags = el.get("tags") or {}
    amenity = tags.get("amenity")
    if amenity not in ("school", "kindergarten", "childcare"):
        continue

    # node has lat/lon, way/relation uses center
    lat = el.get("lat")
    lon = el.get("lon")
    if lat is None or lon is None:
        c = el.get("center") or {}
        lat = c.get("lat")
        lon = c.get("lon")
    if lat is None or lon is None:
        continue

    osm_type = el.get("type")
    osm_id = el.get("id")
    fid = f"osm:{osm_type}:{osm_id}"
    name = tags.get("name") or ""

    features.append({
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [float(lon), float(lat)]},
        "properties": {
            "id": fid,
            "type": amenity,
            "name": name,
            "source": "OpenStreetMap/Overpass",
        }
    })

out = {"type": "FeatureCollection", "features": features}
print(json.dumps(out, ensure_ascii=False))
PY
PY <<<"$OV_JSON" > "$OUTFILE"

echo "==> Done. POIs: $(python3 -c "import json; print(len(json.load(open('$OUTFILE'))['features']))")"