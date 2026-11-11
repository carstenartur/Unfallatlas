#!/usr/bin/env python3
"""Build local label anchors from named OSM ways present in a city's published context index.

Requires pyosmium. Input coordinates come from the same PBF way as its name.
Example: local_road_labels.py Bonn.osm.pbf out/ctxtiles/bonn/index.json.gz \
  https://download.bbbike.org/osm/bbbike/Bonn/Bonn.osm.pbf data/mobility/road-labels/bonn.json.gz
"""
import argparse
from bisect import bisect_right
import gzip
import hashlib
import json
import math
from pathlib import Path

import osmium


ROAD_CLASSES = [
    {'motorway', 'trunk', 'primary'}, {'secondary', 'tertiary'},
    {'unclassified', 'residential', 'living_street', 'pedestrian'},
    {'service', 'cycleway', 'footway', 'path', 'steps'},
]
RANK = {road: i for i, group in enumerate(ROAD_CLASSES) for road in group}


def anchors(points):
    lengths = [0.0]
    for (lat, lon), (lat2, lon2) in zip(points, points[1:]):
        dx = (lon2 - lon) * math.cos(math.radians((lat + lat2) / 2))
        lengths.append(lengths[-1] + math.hypot(dx, lat2 - lat) * 111195)
    total = lengths[-1]
    if total < 15:
        return

    def at(distance):
        i = min(bisect_right(lengths, distance) - 1, len(points) - 2)
        fraction = (distance - lengths[i]) / (lengths[i + 1] - lengths[i])
        return tuple(a + fraction * (b - a) for a, b in zip(points[i], points[i + 1]))

    count = math.ceil(total / 340)
    for n in range(count):
        centre = (n + 0.5) * total / count
        radius = min(total / (2 * count), 50)
        lat, lon = at(centre)
        la, lo = at(centre - radius)
        lb, lo2 = at(centre + radius)
        dx = (lo2 - lo) * math.cos(math.radians(lat))
        # Tight hairpins have no reliable label direction at this anchor.
        if math.hypot(dx, lb - la) * 111195 < radius * 1.7:
            continue
        angle = (math.degrees(math.atan2(la - lb, dx)) + 90) % 180 - 90
        yield [round(lat * 1e5), round(lon * 1e5), round(angle), round(total / count)]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('pbf', type=Path)
    parser.add_argument('index', type=Path)
    parser.add_argument('source_url')
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    with gzip.open(args.index, 'rt') as file:
        index = json.load(file)
    if not index.get('citySlug') or not index.get('wayIndex'):
        parser.error('a city context index with way IDs is required')
    with osmium.io.Reader(str(args.pbf)) as reader:
        timestamp = reader.header().get('osmosis_replication_timestamp')
    if not timestamp:
        parser.error('the input PBF must identify its source timestamp')

    names = {}
    labels = []
    eligible_ids = {int(k) for k in index['wayIndex']}
    for way in osmium.FileProcessor(str(args.pbf)).with_locations():
        if not way.is_way() or way.id not in eligible_ids:
            continue
        tags = way.tags
        name = (tags.get('name') or '').strip()
        rank = RANK.get(tags.get('highway'))
        if not name or rank is None or tags.get('area') == 'yes' or tags.get('tunnel', 'no') != 'no':
            continue
        if not all(node.location.valid() for node in way.nodes):
            continue
        points = []  # Skip consecutive duplicates while retaining loops.
        for node in way.nodes:
            point = (node.lat, node.lon)
            if not points or point != points[-1]:
                points.append(point)
        for anchor in anchors(points):
            label = names.setdefault(name, len(names))
            labels.append([way.id, label, *anchor, rank])
    labels.sort(key=lambda row: (row[-1], -row[-2], row[0]))
    if not labels:
        parser.error('no named street in the extract matched the local network')
    with args.pbf.open('rb') as handle:
        source_hash = hashlib.file_digest(handle, 'sha256').hexdigest()
    data = {'schemaVersion': 1, 'city': index['citySlug'], 'source': {
        'provider': 'OpenStreetMap contributors', 'license': 'ODbL 1.0',
        'licenseUrl': 'https://opendatacommons.org/licenses/odbl/1-0/',
        'url': args.source_url, 'timestamp': timestamp, 'sha256': source_hash,
        'contextExtractDate': index['extractDate']}, 'names': list(names), 'labels': labels}
    raw = json.dumps(data, ensure_ascii=False, separators=(',', ':')).encode()
    args.output.write_bytes(gzip.compress(raw, compresslevel=9, mtime=0))
    print(f"{len(names)} street names, {len(labels)} label anchors, {args.output.stat().st_size} bytes")


if __name__ == '__main__':
    main()
