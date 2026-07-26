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
  -A "Unfallatlas/1.0 (https://github.com/carstenartur/Unfallatlas)" \
  --data-urlencode "q=${CITY}, Germany" \
  --data-urlencode "format=json" \
  --data-urlencode "limit=1" \
  --data-urlencode "bounded=0" \
  "https://nominatim.openstreetmap.org/search")"

# Extract bbox without jq (simple sed/grep approach)
# boundingbox:["50.6","50.8","7.0","7.2"]
BBOX_LINE="$(echo "$NOMI_JSON" | tr -d '\n' | sed -E 's/.*"boundingbox":\[([^]]+)\].*/\1/')"
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

# Function for Overpass API call with retry logic
fetch_overpass() {
  local query="$1"
  local max_retries=5
  local retry_delay=5

  for ((i=1; i<=max_retries; i++)); do
    echo "==> Overpass API request (attempt $i/$max_retries)" >&2

    local response
    response="$(curl -s \
      -A "Unfallatlas/1.0 (https://github.com/carstenartur/Unfallatlas)" \
      --data-urlencode "data=$query" \
      "https://overpass-api.de/api/interpreter")"

    # Check if response is valid JSON with "elements" array (robust validation)
    if echo "$response" | python3 -c "import json, sys; data = json.loads(sys.stdin.read()); sys.exit(0 if 'elements' in data else 1)" 2>/dev/null; then
      echo "$response"
      return 0
    fi

    # Rate limiting or error - wait and retry
    if [[ $i -lt $max_retries ]]; then
      echo "==> Rate limited or error (invalid JSON or missing 'elements'), waiting ${retry_delay}s before retry..." >&2
      # Show first part of response for debugging
      echo "==> Response preview: $(echo "$response" | head -c 200)..." >&2
      sleep "$retry_delay"
      # Exponential backoff: double the wait time (cap at 120s to prevent overflow)
      retry_delay=$((retry_delay * 2))
      if [[ $retry_delay -gt 120 ]]; then
        retry_delay=120
      fi
    else
      # Last attempt failed - show response for debugging
      echo "ERROR: Last response received:" >&2
      echo "$response" | head -n 10 >&2
    fi
  done

  echo "ERROR: Overpass API failed after $max_retries attempts" >&2
  return 1
}

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

OV_JSON="$(fetch_overpass "$QL")" || {
  echo "ERROR: Failed to fetch data from Overpass API (see details above)"
  exit 2
}

# Convert Overpass JSON -> GeoJSON (minimal, jq-less):
# Point features use lat/lon or the centre of ways/relations. The top-level
# metadata is the authoritative source for data-age badges and export provenance.
OUTFILE="${OUTDIR}/poi_${CITY_SLUG}.geojson"
RETRIEVED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
export CITY SOUTH NORTH WEST EAST RETRIEVED_AT

echo "==> Write $OUTFILE"

echo "$OV_JSON" | python3 -c "
import json, os, sys

try:
    data = json.loads(sys.stdin.read())
except json.JSONDecodeError as e:
    print(f'ERROR: Failed to parse Overpass JSON: {e}', file=sys.stderr)
    sys.exit(2)

features = []
for el in data.get('elements', []):
    tags = el.get('tags') or {}
    amenity = tags.get('amenity')
    if amenity not in ('school', 'kindergarten', 'childcare'):
        continue

    # node has lat/lon, way/relation uses center
    lat = el.get('lat')
    lon = el.get('lon')
    if lat is None or lon is None:
        c = el.get('center') or {}
        lat = c.get('lat')
        lon = c.get('lon')
    if lat is None or lon is None:
        continue

    osm_type = el.get('type')
    osm_id = el.get('id')
    fid = f'osm:{osm_type}:{osm_id}'
    name = tags.get('name') or ''

    features.append({
        'type': 'Feature',
        'geometry': {'type': 'Point', 'coordinates': [float(lon), float(lat)]},
        'properties': {
            'id': fid,
            'type': amenity,
            'name': name,
            'source': 'OpenStreetMap/Overpass',
        }
    })

out = {
    'type': 'FeatureCollection',
    'properties': {
        'schemaVersion': 1,
        'city': os.environ['CITY'],
        'retrievedAt': os.environ['RETRIEVED_AT'],
        'bbox': [
            float(os.environ['SOUTH']),
            float(os.environ['WEST']),
            float(os.environ['NORTH']),
            float(os.environ['EAST']),
        ],
        'source': {
            'id': 'openstreetmap-overpass',
            'publisher': 'OpenStreetMap contributors',
            'datasetTitle': 'OpenStreetMap schools, kindergartens and childcare facilities',
            'datasetUrl': 'https://www.openstreetmap.org/',
            'distributionUrl': 'https://overpass-api.de/api/interpreter',
            'licenseId': 'ODbL-1.0',
            'licenseName': 'Open Data Commons Open Database License 1.0',
            'licenseUrl': 'https://opendatacommons.org/licenses/odbl/1-0/',
            'requiredAttribution': '© OpenStreetMap contributors',
        },
    },
    'features': features,
}
print(json.dumps(out, ensure_ascii=False))
" > "$OUTFILE"

echo "==> Done. POIs: $(python3 -c "import json; print(len(json.load(open('$OUTFILE'))['features']))")"

# Wait between cities to avoid rate limiting
echo "==> Waiting 3s before next request..."
sleep 3
