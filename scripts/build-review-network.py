#!/usr/bin/env python3
"""Build a city review network from local OSM XML and GeoJSON using Python 3.9+ on POSIX.

The network uses selected street classes and explicitly mapped crossings. Segment
geometry is clipped to the city boundary and split at branching nodes and 250 m.
OSM shared node references, not intersecting lines, determine road connectivity.
"""

import argparse
from array import array
from bisect import bisect_left
from collections import Counter, defaultdict
from datetime import date
import fcntl
import gzip
import hashlib
import io
import json
import math
import os
from pathlib import Path
import re
from tempfile import TemporaryDirectory
from xml.etree import ElementTree


SCHEMA_VERSION = 1
MAX_PART_BYTES = 160 * 1024
ROWS_PER_PART = 4000
MAX_SEGMENT_METERS = 250
OSM_LICENSE = 'https://opendatacommons.org/licenses/odbl/1-0/'
STREETS = {
    'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential',
    'living_street', 'service', 'pedestrian', 'busway',
    'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link',
}
RESTRICTED_SERVICE = {'driveway', 'parking_aisle', 'drive-through', 'emergency_access'}
CROSSING_TYPES = {'yes', 'marked', 'unmarked', 'uncontrolled', 'traffic_signals', 'zebra',
                  'toucan', 'pelican', 'puffin', 'table', 'island', 'informal'}
WALK_AND_CYCLE_WAYS = {'footway', 'cycleway', 'path', 'pedestrian'}
EPSILON = 1e-11
CELL_DEGREES = 0.0025


def packed_json(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode('utf-8')


def file_sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def bounds(points):
    longitudes, latitudes = zip(*points)
    return min(longitudes), min(latitudes), max(longitudes), max(latitudes)


def contains(box, point):
    west, south, east, north = box
    lon, lat = point
    return west - EPSILON <= lon <= east + EPSILON and south - EPSILON <= lat <= north + EPSILON


def overlap(a, b):
    return max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])


def cell(value):
    return math.floor(value / CELL_DEGREES)


def cells(box):
    west, south, east, north = box
    if west <= east and south <= north:
        for x in range(cell(west), cell(east) + 1):
            for y in range(cell(south), cell(north) + 1):
                yield x, y


def interpolate(a, b, fraction):
    if fraction <= 0:
        return a
    if fraction >= 1:
        return b
    return a[0] + (b[0] - a[0]) * fraction, a[1] + (b[1] - a[1]) * fraction


def intersection_positions(a, b, c, d):
    """Positions on AB at its intersection with CD, including collinear overlap."""
    dx, dy = b[0] - a[0], b[1] - a[1]
    ex, ey = d[0] - c[0], d[1] - c[1]
    ox, oy = c[0] - a[0], c[1] - a[1]
    denominator = dx * ey - dy * ex
    if abs(denominator) > EPSILON * math.hypot(dx, dy) * math.hypot(ex, ey):
        t = (ox * ey - oy * ex) / denominator
        u = (ox * dy - oy * dx) / denominator
        if -EPSILON <= t <= 1 + EPSILON and -EPSILON <= u <= 1 + EPSILON:
            yield min(1, max(0, t))
    elif abs(ox * dy - oy * dx) <= EPSILON * math.hypot(dx, dy):
        axis = 0 if abs(dx) >= abs(dy) else 1
        for point in (c, d):
            t = (point[axis] - a[axis]) / (b[axis] - a[axis])
            if 0 < t < 1:
                yield t


class Ring:
    def __init__(self, coordinates):
        points = [tuple(point[:2]) for point in coordinates]
        if len(points) < 4 or points[0] != points[-1]:
            raise ValueError('Boundary rings must be closed and contain at least four positions')
        self.bounds = bounds(points)
        self.edges = [(a, b) for a, b in zip(points, points[1:]) if a != b]
        self.bands = defaultdict(list)
        for a, b in self.edges:
            for y in range(cell(min(a[1], b[1])), cell(max(a[1], b[1])) + 1):
                self.bands[y].append((a, b))

    def position(self, point):
        """Return 0 outside the ring, 1 in its interior, or 2 on its edge."""
        if not contains(self.bounds, point):
            return 0
        lon, lat = point
        inside = False
        for a, b in self.bands.get(cell(lat), ()):
            dx, dy = b[0] - a[0], b[1] - a[1]
            if (min(a[0], b[0]) - EPSILON <= lon <= max(a[0], b[0]) + EPSILON
                    and min(a[1], b[1]) - EPSILON <= lat <= max(a[1], b[1]) + EPSILON
                    and abs(dx * (lat - a[1]) - dy * (lon - a[0])) <= EPSILON * math.hypot(dx, dy)):
                return 2
            if (a[1] > lat) != (b[1] > lat) and lon < a[0] + (lat - a[1]) * dx / dy:
                inside = not inside
        return int(inside)


def boundary_polygons(item):
    kind = item.get('type')
    if kind == 'FeatureCollection':
        for feature in item['features']:
            yield from boundary_polygons(feature)
    elif kind == 'Feature':
        yield from boundary_polygons(item['geometry'])
    elif kind == 'Polygon':
        yield item['coordinates']
    elif kind == 'MultiPolygon':
        yield from item['coordinates']
    else:
        raise ValueError('Boundary must consist of GeoJSON Polygon or MultiPolygon geometry')


class Boundary:
    def __init__(self, geojson):
        self.polygons = [[Ring(ring) for ring in polygon] for polygon in boundary_polygons(geojson)]
        if not self.polygons or any(not polygon for polygon in self.polygons):
            raise ValueError('Boundary must contain at least one polygon with an exterior ring')
        self.bounds = bounds(point for rings in self.polygons
                             for point in (rings[0].bounds[:2], rings[0].bounds[2:]))
        self.edge_cells = defaultdict(list)
        self.interior_cells = {}
        for rings in self.polygons:
            for ring in rings:
                for edge in ring.edges:
                    for index in cells(bounds(edge)):
                        self.edge_cells[index].append(edge)

    def covers(self, point):
        if not contains(self.bounds, point):
            return False
        index = cell(point[0]), cell(point[1])
        if index in self.interior_cells:
            return self.interior_cells[index]
        inside = any(outer.position(point) and all(hole.position(point) != 1 for hole in holes)
                     for outer, *holes in self.polygons)
        if index not in self.edge_cells:
            self.interior_cells[index] = inside
        return inside

    def clip_edge(self, start, end):
        if start == end:
            return
        region = overlap(bounds((start, end)), self.bounds)
        if region[0] > region[2] or region[1] > region[3]:
            return
        edges = {edge for index in cells(region) for edge in self.edge_cells.get(index, ())}
        cuts = {0, 1}
        for edge in edges:
            cuts.update(intersection_positions(start, end, *edge))
        ordered = sorted(cuts)
        entered = None
        last = None
        for a, b in zip(ordered, ordered[1:]):
            if b - a <= EPSILON:
                continue
            if self.covers(interpolate(start, end, (a + b) / 2)):
                if entered is None:
                    entered = a
                last = b
            elif entered is not None:
                yield interpolate(start, end, entered), interpolate(start, end, last)
                entered = None
        if entered is not None:
            yield interpolate(start, end, entered), interpolate(start, end, last)

    def clip_line(self, points):
        fragment = []
        for start, end in zip(points, points[1:]):
            for a, b in self.clip_edge(start, end):
                if fragment and fragment[-1] != a:
                    yield fragment
                    fragment = []
                if not fragment:
                    fragment.append(a)
                fragment.append(b)
        if fragment:
            yield fragment


class Nodes:
    """Compact positions for sorted OSM snapshots, with support for unordered XML."""
    def __init__(self):
        self.ids = array('Q')
        self.longitudes = array('d')
        self.latitudes = array('d')
        self.unordered = {}

    def add(self, node_id, lon, lat):
        if self.ids and node_id <= self.ids[-1]:
            self.unordered[node_id] = lon, lat
        else:
            self.ids.append(node_id)
            self.longitudes.append(lon)
            self.latitudes.append(lat)

    def get(self, node_id):
        if node_id in self.unordered:
            return self.unordered[node_id]
        index = bisect_left(self.ids, node_id)
        if index < len(self.ids) and self.ids[index] == node_id:
            return self.longitudes[index], self.latitudes[index]
        return None


def node_is_crossing(tags):
    return tags.get('crossing') != 'no' and (tags.get('highway') == 'crossing'
                                             or tags.get('crossing') in CROSSING_TYPES)


def way_is_crossing(tags):
    highway = tags.get('highway')
    if tags.get('area') == 'yes' or tags.get('crossing') == 'no':
        return False
    if highway == 'crossing':
        return True
    return highway in WALK_AND_CYCLE_WAYS and (
        tags.get('crossing') in CROSSING_TYPES
        or any(tags.get(key) == 'crossing' for key in ('footway', 'cycleway', 'path'))
    )


def way_is_street(tags):
    return (tags.get('highway') in STREETS and tags.get('area') != 'yes'
            and tags.get('access') not in ('no', 'private')
            and tags.get('service') not in RESTRICTED_SERVICE)


def clean_label(text):
    return ' '.join(text.split())[:160]


def crossing_features(tags):
    markings = tags.get('crossing:markings')
    crossing = tags.get('crossing')
    features = []
    if markings == 'no' or (not markings and crossing == 'unmarked'):
        features.append('unmarked')
    elif markings in ('yes', 'zebra', 'lines', 'ladder') or (not markings and crossing == 'marked'):
        features.append('marked')
    if tags.get('lit') in ('yes', 'no'):
        features.append('lit' if tags['lit'] == 'yes' else 'unlit')
    if tags.get('crossing:signals') == 'no':
        features.append('unsignalled')
    elif tags.get('crossing:signals') == 'yes' or (not tags.get('crossing:signals') and crossing == 'traffic_signals'):
        features.append('signals')
    if tags.get('crossing:island') == 'no':
        features.append('noisland')
    elif tags.get('crossing:island') == 'yes' or (not tags.get('crossing:island') and crossing == 'island'):
        features.append('island')
    return features


def read_osm(path):
    nodes = Nodes()
    crossing_nodes = set()
    features_by_element = {}
    roads = {}
    crossing_ways = {}
    open_osm = gzip.open if path.suffix == '.gz' else open
    with open_osm(path, 'rb') as handle:
        events = ElementTree.iterparse(handle, events=('start', 'end'))
        _, root = next(events)
        if root.tag != 'osm':
            raise ValueError('Expected an OSM XML snapshot with an <osm> root')
        for event, element in events:
            if event != 'end' or element.tag not in ('node', 'way', 'relation', 'bounds'):
                continue
            if element.get('visible') != 'false':
                if element.tag == 'node':
                    node_id = int(element.attrib['id'])
                    if node_id > 0:
                        nodes.add(node_id, float(element.attrib['lon']), float(element.attrib['lat']))
                        if len(element):
                            tags = {tag.get('k'): tag.get('v') for tag in element}
                            if node_is_crossing(tags):
                                crossing_nodes.add(node_id)
                                features = crossing_features(tags)
                                if features:
                                    features_by_element[f'c:n:{node_id}'] = features
                elif element.tag == 'way':
                    tags = {tag.get('k'): tag.get('v') for tag in element if tag.tag == 'tag'}
                    is_crossing = way_is_crossing(tags)
                    is_street = not is_crossing and way_is_street(tags)
                    if is_street or is_crossing:
                        way_id = int(element.attrib['id'])
                        refs = [int(ref.attrib['ref']) for ref in element if ref.tag == 'nd']
                        if 0 < way_id < 2**53 and len(refs) >= 2:
                            if is_street:
                                roads[way_id] = refs, clean_label(tags.get('name') or tags.get('ref') or '')
                            else:
                                crossing_ways[way_id] = refs
                                features = crossing_features(tags)
                                if features:
                                    features_by_element[f'c:w:{way_id}'] = features
            root.clear()
    return nodes, roads, crossing_nodes, crossing_ways, features_by_element


def known_runs(refs, nodes):
    run = []
    for ref in refs:
        if run and ref == run[-1][0]:
            continue
        point = nodes.get(ref)
        if point is None:
            if len(run) >= 2:
                yield run
            run = []
        else:
            run.append((ref, point))
    if len(run) >= 2:
        yield run


def road_topology(roads, nodes, boundary):
    runs = {}
    way_ids = defaultdict(set)
    arms = defaultdict(set)
    for way_id, (refs, _) in roads.items():
        for run in known_runs(refs, nodes):
            west, south, east, north = overlap(bounds(point for _, point in run), boundary.bounds)
            if west > east or south > north:
                continue
            runs.setdefault(way_id, []).append(run)
            for index, (node_id, point) in enumerate(run):
                if not boundary.covers(point):
                    continue
                way_ids[node_id].add(way_id)
                if index > 0:
                    arms[node_id].add(run[index - 1][0])
                if index + 1 < len(run):
                    arms[node_id].add(run[index + 1][0])
    junctions = {node_id for node_id, neighbors in arms.items() if len(neighbors) >= 3}
    return runs, way_ids, junctions


def distance(a, b):
    lat_a, lat_b = math.radians(a[1]), math.radians(b[1])
    lon_delta = math.radians(b[0] - a[0])
    arc = math.sin((lat_b - lat_a) / 2)**2 + math.cos(lat_a) * math.cos(lat_b) * math.sin(lon_delta / 2)**2
    return 2 * 6371008.8 * math.asin(min(1, math.sqrt(arc)))


def local_segments(line):
    piece = [line[0]]
    length = 0.0
    for end in line[1:]:
        start = piece[-1]
        edge_length = distance(start, end)
        while length + edge_length > MAX_SEGMENT_METERS:
            cut = interpolate(start, end, (MAX_SEGMENT_METERS - length) / edge_length)
            if cut != start:
                piece.append(cut)
            yield piece
            piece = [cut]
            length = 0.0
            start = cut
            edge_length = distance(start, end)
        piece.append(end)
        length += edge_length
    if len(piece) >= 2:
        yield piece


def midpoint(line):
    lengths = [distance(a, b) for a, b in zip(line, line[1:])]
    remaining = sum(lengths) / 2
    for a, b, length in zip(line, line[1:], lengths):
        if 0 < length and remaining <= length:
            return interpolate(a, b, remaining / length)
        remaining -= length
    return line[-1]


def flat_coordinates(points):
    flat = []
    last = None
    for lon, lat in points:
        pair = round(lat, 7), round(lon, 7)
        if pair != last:
            flat.extend(pair)
            last = pair
    return flat


def named_roads(way_ids, roads, fallback):
    names = sorted({roads[way_id][1] for way_id in way_ids if roads[way_id][1]})
    return clean_label(' / '.join(names)) or fallback


def segment_sites(runs, roads, junctions, boundary):
    for way_id, way_runs in runs.items():
        spans = {}
        for run in way_runs:
            start = 0
            for end in range(1, len(run)):
                if end == len(run) - 1 or run[end][0] in junctions:
                    span = run[start:end + 1]
                    refs = tuple(ref for ref, _ in span)
                    if refs > refs[::-1]:
                        refs, span = refs[::-1], span[::-1]
                    spans[refs] = [point for _, point in span]
                    start = end
        occurrences = Counter()
        label = roads[way_id][1] or f'OSM-Weg {way_id}'
        for refs, points in sorted(spans.items()):
            ends = refs[0], refs[-1]
            occurrences[ends] += 1
            span_id = f's:{way_id}:{ends[0]}:{ends[1]}:{occurrences[ends]}'
            for fragment_no, fragment in enumerate(boundary.clip_line(points), 1):
                for piece_no, piece in enumerate(local_segments(fragment), 1):
                    coordinates = flat_coordinates(piece)
                    if len(coordinates) >= 4:
                        yield [f'{span_id}:{fragment_no}:{piece_no}', 'segment', label, [str(way_id)], coordinates]


def crossing_sites(crossing_nodes, crossing_ways, nodes, road_nodes, roads, boundary, features_by_element):
    way_features = defaultdict(set)
    point_ways = {ref: set() for ref in crossing_nodes if boundary.covers(nodes.get(ref))}
    for way_id, refs in crossing_ways.items():
        anchors = {ref for ref in refs if ref in road_nodes or ref in point_ways}
        if anchors:
            # A way crossing several road nodes does not identify which crossing carries its tags.
            if len(anchors) == 1:
                way_features[next(iter(anchors))].update(features_by_element.get(f'c:w:{way_id}', []))
            for ref in anchors:
                point_ways.setdefault(ref, set()).add(way_id)
            continue
        refs = min(refs, refs[::-1])
        fragment_no = 0
        for run in known_runs(refs, nodes):
            for fragment in boundary.clip_line([point for _, point in run]):
                fragment_no += 1
                yield [f'c:w:{way_id}:{fragment_no}', 'crossing', 'Querung', [str(way_id)],
                       flat_coordinates([midpoint(fragment)])]
    for node_id, crossing_ids in point_ways.items():
        site_id = f'c:n:{node_id}'
        if way_features.get(node_id):
            tags = way_features[node_id].union(features_by_element.get(site_id, []))
            merged = []
            for alternatives in [('unmarked', 'marked'), ('lit', 'unlit'),
                                 ('signals', 'unsignalled'), ('island', 'noisland')]:
                agreed = tags.intersection(alternatives)
                if len(agreed) == 1:
                    merged.extend(agreed)
            features_by_element[site_id] = merged
        street_ids = road_nodes.get(node_id, set())
        label = named_roads(street_ids, roads, 'Querung')
        yield [f'c:n:{node_id}', 'crossing', label, [str(i) for i in sorted(street_ids | crossing_ids)],
               flat_coordinates([nodes.get(node_id)])]


def network_sites(osm, boundary):
    nodes, roads, crossing_nodes, crossing_ways, features_by_element = read_osm(osm)
    runs, road_nodes, junctions = road_topology(roads, nodes, boundary)
    sites = list(segment_sites(runs, roads, junctions, boundary))
    for node_id in junctions:
        way_ids = road_nodes[node_id]
        sites.append([f'j:{node_id}', 'junction', named_roads(way_ids, roads, 'Knotenpunkt'),
                      [str(i) for i in sorted(way_ids)], flat_coordinates([nodes.get(node_id)])])
    sites.extend(crossing_sites(crossing_nodes, crossing_ways, nodes, road_nodes, roads, boundary, features_by_element))
    sites.sort(key=lambda row: row[0])
    features = {}
    for site_id, kind, *_ in sites:
        if kind == 'crossing':
            key = site_id.rsplit(':', 1)[0] if site_id.startswith('c:w:') else site_id
            if features_by_element.get(key):
                features[site_id] = features_by_element[key]
    return sites, features


def part_payloads(rows, revision):
    header = packed_json({'schemaVersion': SCHEMA_VERSION, 'revision': revision})[:-1] + b',"sites":['
    buffer = io.BytesIO()
    # GzipFile keeps the platform byte, filename and mtime independent of the build machine.
    with gzip.GzipFile(filename='', mode='wb', fileobj=buffer, mtime=0) as handle:
        handle.write(header + b','.join(rows) + b']}\n')
    compressed = buffer.getvalue()
    if len(compressed) <= MAX_PART_BYTES:
        yield compressed
    elif len(rows) >= 2:
        middle = len(rows) // 2
        yield from part_payloads(rows[:middle], revision)
        yield from part_payloads(rows[middle:], revision)
    else:
        raise ValueError('A single review site exceeds the gzip part limit')


def replace_outputs(stage, files):
    # Save the old revision before changing any public path. The temporary
    # directory is on the same filesystem, so each backup can be a hard link.
    replacements = []
    for number, (source, target) in enumerate(files):
        backup = stage / f'previous-{number}'
        try:
            os.link(target, backup, follow_symlinks=False)
        except FileNotFoundError:
            backup = None
        replacements.append((source, target, backup))

    attempted = 0
    try:
        for attempted, (source, target, _) in enumerate(replacements, 1):
            source.replace(target)
    except (OSError, KeyboardInterrupt):
        for _, target, backup in reversed(replacements[:attempted]):
            if backup is None:
                target.unlink(missing_ok=True)
            else:
                backup.replace(target)
        raise


def publish_network(output, stage, index):
    catalog_file = output / 'catalog.json'
    # A directory lock serializes concurrent builds without adding a published lock file.
    descriptor = os.open(output, os.O_RDONLY)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        catalog = json.loads(catalog_file.read_bytes()) if catalog_file.exists() else {
            'schemaVersion': SCHEMA_VERSION, 'cities': {},
        }
        if catalog['schemaVersion'] != SCHEMA_VERSION or not isinstance(catalog['cities'], dict):
            raise ValueError('Existing review network catalog has an unsupported schema')
        catalog['cities'][index['city']] = index['revision']
        catalog['cities'] = dict(sorted(catalog['cities'].items()))
        (stage / 'catalog.json').write_bytes(packed_json(catalog) + b'\n')
        destination = output / index['city']
        destination.mkdir(exist_ok=True)
        filenames = [f'{part}.json.gz' for part in index['parts']] + ['index.json']
        if index.get('crossingContext'):
            filenames.append('crossings.json.gz')
        files = [(stage / filename, destination / filename) for filename in filenames]
        replace_outputs(stage, files + [(stage / 'catalog.json', catalog_file)])
        for old in destination.glob('*.json.gz'):
            part_number = old.name.removesuffix('.json.gz')
            if re.fullmatch(r'[1-9][0-9]*', part_number) and int(part_number) > len(index['parts']):
                old.unlink()
    finally:
        os.close(descriptor)


def write_network(output, city, source, boundary_source, sites, features):
    counts = dict.fromkeys(('segment', 'junction', 'crossing'), 0)
    counts.update(Counter(site[1] for site in sites))
    if not counts['segment']:
        raise ValueError('No road segments intersect the supplied city boundary')
    rows = [packed_json(site) for site in sites]
    digest = hashlib.sha256(packed_json([SCHEMA_VERSION, ROWS_PER_PART, MAX_PART_BYTES,
                                         city, source, boundary_source]))
    for row in rows:
        digest.update(row + b'\n')
    revision = 'r' + digest.hexdigest()[:24]
    output.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(dir=output, prefix='.review-network-') as stage:
        stage = Path(stage)
        parts = []
        for start in range(0, len(rows), ROWS_PER_PART):
            for payload in part_payloads(rows[start:start + ROWS_PER_PART], revision):
                parts.append(len(parts) + 1)
                (stage / f'{parts[-1]}.json.gz').write_bytes(payload)
        index = {'schemaVersion': SCHEMA_VERSION, 'city': city, 'revision': revision,
                 'source': source, 'boundarySource': boundary_source, 'parts': parts, 'counts': counts}
        if features:
            index['crossingContext'] = True
            payload = packed_json({'revision': revision, 'features': features})
            (stage / 'crossings.json.gz').write_bytes(gzip.compress(payload, mtime=0))
        (stage / 'index.json').write_bytes(packed_json(index) + b'\n')
        publish_network(output, stage, index)
    return index


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--city', required=True, help='Unfallwerkbank city key, for example frankfurt_am_main')
    parser.add_argument('--osm', type=Path, required=True, help='Local OSM XML snapshot (.osm or .osm.gz)')
    parser.add_argument('--boundary', type=Path, required=True, help='City or district boundary GeoJSON')
    parser.add_argument('--output', type=Path, default=Path(__file__).resolve().parents[1] / 'data/mobility/review-network')
    parser.add_argument('--source-label', default='© OpenStreetMap contributors (ODbL 1.0)')
    parser.add_argument('--source-url', required=True, help='OSM extract download URL')
    parser.add_argument('--source-license-url', default=OSM_LICENSE)
    parser.add_argument('--source-date', required=True, help='Date of the OSM extract (YYYY-MM-DD)')
    parser.add_argument('--source-sha256', help='Expected SHA-256 of the original OSM file')
    parser.add_argument('--boundary-label', help='Override GeoJSON source label')
    parser.add_argument('--boundary-url', help='Override GeoJSON source URL')
    parser.add_argument('--boundary-license-url', help='Override GeoJSON source or metadata license URL')
    args = parser.parse_args()
    if not re.fullmatch(r'[a-z0-9]+(?:_[a-z0-9]+)*', args.city):
        parser.error('--city must contain lowercase letters, digits, or separating underscores')
    try:
        source_date = date.fromisoformat(args.source_date).isoformat()
        source_digest = file_sha256(args.osm)
        if args.source_sha256 and args.source_sha256.lower() != source_digest:
            parser.error('OSM file does not match --source-sha256')
        source = {'label': args.source_label, 'url': args.source_url, 'licenseUrl': args.source_license_url,
                  'date': source_date, 'sha256': source_digest}
        boundary_bytes = args.boundary.read_bytes()
        geojson = json.loads(boundary_bytes)
        provenance = geojson.get('source', {})
        metadata = geojson.get('metadata', {})
        boundary_source = {'label': args.boundary_label or provenance.get('label') or metadata.get('attribution'),
                           'url': args.boundary_url or provenance.get('url') or metadata.get('url'),
                           'licenseUrl': args.boundary_license_url or provenance.get('licenseUrl') or metadata.get('licenseUrl'),
                           'sha256': hashlib.sha256(boundary_bytes).hexdigest()}
        if not all(boundary_source.values()):
            parser.error('Boundary source label, URL and license URL are required in GeoJSON or via flags')
        sites, features = network_sites(args.osm, Boundary(geojson))
        index = write_network(args.output, args.city, source, boundary_source, sites, features)
    except (OSError, ValueError, KeyError, ElementTree.ParseError) as error:
        parser.error(str(error))
    print(packed_json(index).decode('utf-8'))


if __name__ == '__main__':
    main()
