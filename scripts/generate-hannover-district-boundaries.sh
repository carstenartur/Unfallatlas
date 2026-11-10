#!/usr/bin/env bash
set -euo pipefail
output=${1:?Usage: convert.sh /absolute/output.geojson [path/to/downloaded-skh5.zip]}
archive=${2:-}
work_dir=$(mktemp -d)
trap 'rm -rf -- "$work_dir"' EXIT
source_url='https://www.hannover.de/content/download/887881/file/SKH5_Statistische_Gliederung.zip'
source_sha='cdd2f16d6bf62c37d71e728adb38f9b9b95a1f6966cee1e077bda276518c871b'
if [[ -z "$archive" ]]; then
  archive="$work_dir/skh5.zip"
  curl --fail --silent --show-error --location "$source_url" --output "$archive"
fi
printf '%s  %s\n' "$source_sha" "$archive" | sha256sum -c -
unzip -oq "$archive" 'SKH5_Stadtbezirke/*' -d "$work_dir"
ogr2ogr -f GeoJSON -t_srs EPSG:4326 -lco RFC7946=YES -lco COORDINATE_PRECISION=6 \
  -sql 'SELECT STADTBZNAM AS district FROM SKH5_Stadtbezirke WHERE STADTBZNR IS NOT NULL ORDER BY STADTBZNR' \
  "$work_dir/districts.json" "$work_dir/SKH5_Stadtbezirke/SKH5_Stadtbezirke.shp"
python3 - "$work_dir/districts.json" "$output" "$source_url" "$source_sha" <<'PY'
import json
import sys
from pathlib import Path
source_file, output_file, source_url, source_sha = sys.argv[1:]
source = json.loads(Path(source_file).read_text(encoding='utf-8'))
result = {
    'type': 'FeatureCollection',
    'source': {
        'label': '© Landeshauptstadt Hannover (2026), Statistische Gliederung SKH5, CC BY 4.0',
        'url': 'https://www.hannover.de/Leben-in-der-Region-Hannover/Verwaltungen-Kommunen/Die-Verwaltung-der-Landeshauptstadt-Hannover/Dezernate-und-Fachbereiche-der-LHH/Stadtentwicklung-und-Bauen/Fachbereich-Planen-und-Stadtentwicklung/Geoinformation/Open-GeoData/Themenkarten-und-statistische-Gliederung/Statistische-Gliederungen/Statistische-Gliederung-SKH5'
    },
    'metadata': {
        'publisher': 'Landeshauptstadt Hannover',
        'url': source_url,
        'license': 'CC BY 4.0',
        'licenseUrl': 'https://creativecommons.org/licenses/by/4.0/',
        'attribution': '© Landeshauptstadt Hannover (2026), CC BY 4.0',
        'changes': 'Auswahl der 13 benannten Stadtbezirke, Umprojektion nach WGS 84 und Koordinatenrundung auf sechs Dezimalstellen.',
        'sourceSha256': source_sha
    },
    'features': source['features']
}
Path(output_file).write_text(json.dumps(result, ensure_ascii=False, separators=(',', ':')) + '\n', encoding='utf-8')
PY
