#!/usr/bin/env python3
"""Project the audited Hannover Ratsatlas additions into a local, reproducible register."""
import argparse
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile

PIN = '437733d455bdfede122b93aa0c89accd3704dd80'
AUDIT = 'docs/qa/2026-11-21-weitere-kartenorte/data-audit.json'
OUTPUT = Path(__file__).resolve().parents[1] / 'config/ris-locations/hannover-ratsatlas.json.gz'


def require(condition, message):
    if not condition:
        raise ValueError(message)


def read_payload(directory, filename, checksum):
    raw = gzip.decompress((directory / filename).read_bytes())
    require(hashlib.sha256(raw).hexdigest() == checksum, f'Ratsatlas checksum mismatch: {filename}')
    return json.loads(raw)


def build(checkout, revision, audit_path):
    commit = subprocess.check_output(['git', '-C', checkout, 'rev-parse', '--verify', f'{revision}^{{commit}}'], text=True).strip()
    audit = json.loads(subprocess.check_output(['git', '-C', checkout, 'show', f'{commit}:{audit_path}']))
    checksums = audit['derivedSha256']
    directory = checkout / 'site/data/enriched'
    additions = read_payload(directory, 'additions.json.gz', checksums['additions'])
    index = read_payload(directory, 'search-index.json.gz', checksums['searchIndex'])
    features = read_payload(directory, 'map.geojson.gz', checksums['map'])
    require(all(data['generation'] == audit['sourceGeneration'] for data in (additions, index, features)), 'Mixed generations')
    ids = set(additions['records'])
    require(len(ids) == audit['totals']['addedRecordCount'] and not ids.intersection(row['id'] for row in audit['removedRecords']),
            'Invalid record count or withdrawn locations in register')
    rows = {row['id']: row for row in index['records'] if row['id'] in ids}
    geometry = {f['properties']['geometryId']: f for f in features['features']}
    shapes, records = {}, {}
    for identifier in sorted(ids):
        row = rows[identifier]
        require(row['source'] == 'hannover-sim' and row['level'] == 'city' and row['sourceId'] == identifier
                and identifier.startswith('hannover-sim:') and row['mapped'], f'Invalid source record: {identifier}')
        locations = []
        for loc in additions['records'][identifier]['locations']:
            key = loc['geometryId']
            feature = geometry[key]
            require(key.startswith('atlas:') and identifier in feature['properties']['recordIds']
                    and loc['mapped'] and loc['label'] == feature['properties']['label'], f'Invalid geometry link: {identifier}')
            shapes[key] = feature['geometry']
            locations.append({field: loc[field] for field in ('geometryId', 'kind', 'label', 'accuracy', 'method',
                                                               'sourceUrl', 'attribution', 'evidence', 'areaId') if field in loc})
        require(locations and len({loc['geometryId'] for loc in locations}) == len(locations), f'Duplicate or missing location: {identifier}')
        records[identifier] = dict(title=row['title'], locations=locations)
    require(len(shapes) == audit['totals']['addedGeometryCount'], 'Geometry count mismatch')
    return dict(revision=commit, sourceGeneration=audit['sourceGeneration'], sourceManifestSha256=audit['sourceManifestSha256'],
                derivedSha256={key: checksums[key] for key in ('additions', 'map', 'searchIndex')}, geometries=shapes, records=records)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('checkout', type=Path)
    parser.add_argument('--revision', default=PIN, help='Upstream commit with the matching data audit')
    parser.add_argument('--audit', default=AUDIT, help='Path of the committed data audit at that revision')
    parser.add_argument('--output', type=Path, default=OUTPUT)
    args = parser.parse_args()
    register = build(args.checkout, args.revision, args.audit)
    encoded = io.BytesIO()
    with gzip.GzipFile(fileobj=encoded, mode='wb', mtime=0) as compressed:
        compressed.write(json.dumps(register, ensure_ascii=False, separators=(',', ':'), sort_keys=True).encode())
    with tempfile.NamedTemporaryFile(dir=args.output.parent, delete=False) as temporary:
        temporary.write(encoded.getvalue())
        os.fchmod(temporary.fileno(), 0o644)
    os.replace(temporary.name, args.output)
    print(f"{len(register['records'])} records, {len(register['geometries'])} geometries, {len(encoded.getvalue())} bytes")
