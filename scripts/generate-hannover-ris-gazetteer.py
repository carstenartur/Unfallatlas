#!/usr/bin/env python3
"""Regenerate Hannover location references or rail context from open LGLN geodata."""

import argparse
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import date
import gzip
import json
from pathlib import Path
import re
import sys
from tempfile import NamedTemporaryFile
from time import sleep
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET


SOURCE = "https://opendata.lgln.niedersachsen.de/doorman/noauth/atkisbdlm_wfs_nas"
METADATA = "https://numis.niedersachsen.de/trefferanzeige?docuuid=121cf327-48f5-4ecd-b3db-aabd023eb3df"
ADDRESS_SOURCE = "https://www.inspire.niedersachsen.de/doorman/noauth/alkis-dls-ad"
ADDRESS_METADATA = "https://numis.niedersachsen.de/trefferanzeige?docuuid=931577a7-6b51-42fc-8409-3431f50abb4c"
LICENSE_URL = "https://creativecommons.org/licenses/by/4.0/"
WFS = "http://www.opengis.net/wfs/2.0"
ADV = "http://www.adv-online.de/namespaces/adv/gid/7.1"
AD = "http://inspire.ec.europa.eu/schemas/ad/4.0"
GML = "http://www.opengis.net/gml/3.2"
XLINK = "http://www.w3.org/1999/xlink"
CRS = "urn:ogc:def:crs:EPSG::4326"
NATIVE_CRS = "urn:ogc:def:crs:EPSG::25832"
# WFS EPSG:4326 uses latitude, longitude. The box includes a buffer around
# the municipality; the street-key join, not the box, determines membership.
BBOX = f"52.295,9.56,52.465,9.95,{CRS}"
# Partition address queries in the service's native UTM coordinates (metres,
# easting then northing). Geographic boxes can leave gaps after reprojection.
ADDRESS_BOUNDS = (535_000, 5_790_000, 570_000, 5_820_000)
KEY_PREFIX = "03241001"
# The WFS gateway rejects newline characters inside the FILTER query value.
STREET_FILTER = (
    f'<fes:Filter xmlns:fes="http://www.opengis.net/fes/2.0" xmlns:adv="{ADV}">'
    '<fes:PropertyIsLike wildCard="*" singleChar="?" escapeChar="!">'
    '<fes:ValueReference>adv:strassenschluessel</fes:ValueReference>'
    f'<fes:Literal>{KEY_PREFIX}*</fes:Literal></fes:PropertyIsLike></fes:Filter>'
)
# The INSPIRE WFS compares this reference by local ID, then serializes it
# as a full URL in the response. Request Hannover alone (no regional box).
ADDRESS_UNIT = f"AdminUnitName_{KEY_PREFIX}"
ADDRESS_STREET = "ThoroughfareName_"
ADDRESS_UNIT_PREDICATE = (
    '<fes:PropertyIsEqualTo><fes:ValueReference>ad:component/@xlink:href</fes:ValueReference>'
    f'<fes:Literal>{ADDRESS_UNIT}</fes:Literal></fes:PropertyIsEqualTo>'
)
ADDRESS_TILE_LIMIT = 5000
MAX_RESPONSE_BYTES = 16 * 1024 * 1024
MAX_ARTIFACT_BYTES = 2_000_000
OUTPUT = Path(__file__).resolve().parents[1] / "config/ris-locations/hannover-atkis.json.gz"
OID = "urn:adv:oid:"
# The RIS calls this road Wunstorfer Straße, but ATKIS changes the name to
# Wunstorfer Landstraße before the bridge. These four connected axis objects
# form the approach from that name transition to the canal crossing.
APPROACH_AXIS_IDS = ("DENIAT01000013vv", "DENIAT0100015i3z", "DENIAT0100001UlC", "DENIAT0100001KN4")
WUNSTORFER_STRASSE = "0324100103098"
WUNSTORFER_LANDSTRASSE = "0324100103097"
BRIDGE_ID = "DENIAT010000bUGL"
CANAL_AXIS_ID = "DENIAT0100018hYd"


def request_features(layer, **options):
    source, prefix = (ADDRESS_SOURCE, "ad") if layer == "Address" else (SOURCE, "adv")
    query = urlencode({"service": "WFS", "version": "2.0.0", "request": "GetFeature",
                       "typeNames": f"{prefix}:{layer}", **options})
    request = Request(f"{source}?{query}", headers={"User-Agent": "Unfallwerkbank RIS gazetteer generator"})
    for attempt in range(3):
        try:
            with urlopen(request, timeout=45) as response:
                raw = response.read(MAX_RESPONSE_BYTES + 1)
            break
        except HTTPError as error:
            if error.code not in (429, 500, 502, 503, 504) or attempt == 2:
                raise
        except (URLError, TimeoutError):
            if attempt == 2:
                raise
        sleep(2 ** (attempt + 1))

    if len(raw) > MAX_RESPONSE_BYTES:
        raise ValueError(f"{layer}: response exceeds size limit")
    root = ET.fromstring(raw)
    if root.tag != f"{{{WFS}}}FeatureCollection":
        message = root.findtext(".//{*}ExceptionText") or root.tag
        raise ValueError(f"{layer}: {message.strip()}")
    return root


def feature_id(feature):
    identifier = feature.findtext(f"{{{GML}}}identifier")
    if not identifier:
        raise ValueError(f"{feature.tag}: missing gml:identifier")
    return identifier


def members(root, layer):
    namespace = AD if layer == "Address" else ADV
    elements = [member.find(f"{{{namespace}}}{layer}") for member in root.findall(f"{{{WFS}}}member")]
    if any(element is None for element in elements) or int(root.attrib["numberReturned"]) != len(elements):
        raise ValueError(f"{layer}: incomplete or unexpected feature response")
    return elements


def page_features(layer, limits, *, property_names=None, **options):
    hits = request_features(layer, resultType="hits", **options)
    expected = int(hits.attrib["numberMatched"])
    if not limits[0] <= expected <= limits[1]:
        raise ValueError(f"{layer}: unexpected number of matching features: {expected}")
    ids = set()
    if property_names:
        options["propertyName"] = property_names

    # Reject short extracts and repeated pages before replacing the reference.
    for _ in range(50):
        if len(ids) == expected:
            return
        requested = min(2500, expected - len(ids))
        root = request_features(layer, sortBy="gml:identifier", startIndex=len(ids), count=requested, **options)
        page = members(root, layer)
        if not 0 < len(page) <= requested:
            raise ValueError(f"{layer}: unexpected page length at {len(ids)}: {len(page)}")
        for feature in page:
            identifier = feature_id(feature)
            if identifier in ids:
                raise ValueError(f"{layer}: repeated feature {identifier}")
            ids.add(identifier)
            yield feature
        print(f"{layer}: {len(ids)}/{expected}", file=sys.stderr, flush=True)
    if len(ids) != expected:
        raise ValueError(f"{layer}: page limit reached with {len(ids)}/{expected} features")


def links(feature, property_name, namespace=ADV):
    return {element.get(f"{{{XLINK}}}href") for element in feature.findall(f"{{{namespace}}}{property_name}")}


def curves(feature, precision=6):
    position = feature.find(f"{{{ADV}}}position")
    if position is None:
        raise ValueError(f"{feature_id(feature)}: missing position")
    lines = []
    line = []
    lists = position.findall(f".//{{{GML}}}posList")
    linear_lists = [coordinates for element in position.iter()
                    if element.tag in (f"{{{GML}}}LineString", f"{{{GML}}}LineStringSegment")
                    for coordinates in element.findall(f"{{{GML}}}posList")]
    if not lists or lists != linear_lists:
        raise ValueError(f"{feature_id(feature)}: unsupported curve geometry")
    for coordinates in linear_lists:
        values = [float(value) for value in coordinates.text.split()]
        if len(values) < 4 or len(values) % 2:
            raise ValueError(f"{feature_id(feature)}: invalid coordinate dimensions")
        points = []
        for lat, lon in zip(values[::2], values[1::2]):
            if not (52.25 < lat < 52.55 and 9.5 < lon < 10):
                raise ValueError(f"{feature_id(feature)}: coordinates outside expected EPSG:4326 area")
            point = (round(lon, precision), round(lat, precision))
            if not points or points[-1] != point:
                points.append(point)
        if len(points) < 2:
            continue
        if line and line[-1] == points[0]:
            line.extend(points[1:])
        else:
            if line:
                lines.append(tuple(line))
            line = points
    if line:
        lines.append(tuple(line))
    if not lines:
        raise ValueError(f"{feature_id(feature)}: no usable line")
    return lines


def street_entries():
    keys_by_id = {}
    names_by_key = {}
    for street in page_features("AX_Strasse", (3000, 10_000), FILTER=STREET_FILTER):
        identifier = feature_id(street)
        key = street.findtext(f"{{{ADV}}}strassenschluessel")
        name = (street.findtext(f"{{{ADV}}}name") or "").strip()
        if not key or not re.fullmatch(KEY_PREFIX + r"[0-9]{5}", key):
            raise ValueError(f"{identifier}: unexpected street key: {key}")
        if not name:
            continue
        if key in names_by_key and names_by_key[key] != name:
            raise ValueError(f"{key}: conflicting street names: {names_by_key[key]} / {name}")
        keys_by_id[identifier] = key
        names_by_key[key] = name

    lines_by_key = defaultdict(set)
    approach_axes = {}
    for axis in page_features("AX_Strassenachse", (15_000, 45_000), bbox=BBOX, srsName=CRS,
                              property_names="gml:identifier,adv:position,adv:istTeilVon"):
        keys = {keys_by_id[reference] for reference in links(axis, "istTeilVon") if reference in keys_by_id}
        if keys:
            lines = curves(axis)
            identifier = feature_id(axis).removeprefix(OID)
            if identifier in APPROACH_AXIS_IDS:
                if keys != {WUNSTORFER_LANDSTRASSE} or len(lines) != 1:
                    raise ValueError(f"{identifier}: expected a single Wunstorfer Landstraße approach line")
                approach_axes[identifier] = lines[0]
            for key in keys:
                lines_by_key[key].update(min(line, line[::-1]) for line in lines)

    print(f"Street keys with an axis: {len(lines_by_key)}/{len(names_by_key)}", file=sys.stderr)
    if len(lines_by_key) < 2500:
        raise ValueError("Too few Hannover street keys with geometry")
    entries = []
    for key in sorted(lines_by_key, key=lambda key: (names_by_key[key], key)):
        lines = sorted(lines_by_key[key])
        geometry = {"type": "LineString", "coordinates": lines[0]} if len(lines) == 1 else {
            "type": "MultiLineString", "coordinates": lines,
        }
        entries.append({"name": names_by_key[key], "kind": "street", "streetKey": key, "geometry": geometry})
    wunstorfer = {point for line in lines_by_key[WUNSTORFER_STRASSE] for point in line}
    return entries, approach_axes, wunstorfer


def get_feature(layer, identifier):
    features = members(request_features(layer, resourceId=identifier, srsName=CRS, count=2), layer)
    if len(features) != 1 or feature_id(features[0]) != OID + identifier:
        raise ValueError(f"{layer}: expected feature {identifier}")
    return features[0]


def crossing(a, b, c, d):
    def cross(u, v):
        return u[0] * v[1] - u[1] * v[0]

    r = (b[0] - a[0], b[1] - a[1])
    s = (d[0] - c[0], d[1] - c[1])
    offset = (c[0] - a[0], c[1] - a[1])
    divisor = cross(r, s)
    if divisor:
        t, u = cross(offset, s) / divisor, cross(offset, r) / divisor
        if 0 <= t <= 1 and 0 <= u <= 1:
            return tuple(round(x + t * dx, 6) for x, dx in zip(a, r))
    return None


def bridge_entry(approach_axes, wunstorfer):
    bridge = get_feature("AX_BauwerkImVerkehrsbereich", BRIDGE_ID)
    canal = get_feature("AX_Gewaesserstationierungsachse", CANAL_AXIS_ID)
    name = "Stichkanal Hannover-Linden"
    if bridge.findtext(f"{{{ADV}}}bauwerksfunktion") != "1800" or canal.findtext(f"{{{ADV}}}name") != name:
        raise ValueError("Cannot verify bridge KL 247 and the named canal")

    approach = [approach_axes[identifier] for identifier in APPROACH_AXIS_IDS]
    bridge_curves = curves(bridge, precision=12)
    if len(bridge_curves) != 1:
        raise ValueError("Expected a single line for bridge KL 247")
    bridge_line = bridge_curves[0]
    rounded_bridge = tuple(tuple(round(value, 6) for value in point) for point in bridge_line)
    if rounded_bridge not in (approach[-1], approach[-1][::-1]):
        raise ValueError("Bridge KL 247 must follow the verified road axis")

    start = {approach[0][0], approach[0][-1]} & wunstorfer
    if len(start) != 1:
        raise ValueError("Expected one approach connection to Wunstorfer Straße")
    section = [start.pop()]
    for line in approach[:-1]:
        if section[-1] == line[-1]:
            line = line[::-1]
        if section[-1] != line[0]:
            raise ValueError("Disconnected Wunstorfer Landstraße approach")
        section.extend(line[1:])
    if section[-1] == rounded_bridge[-1]:
        bridge_line, rounded_bridge = bridge_line[::-1], rounded_bridge[::-1]
    if section[-1] != rounded_bridge[0]:
        raise ValueError("Disconnected bridge KL 247")

    water_segments = [(a, b) for line in curves(canal, precision=12) for a, b in zip(line, line[1:])]
    hits = [(index, point) for index, (a, b) in enumerate(zip(bridge_line, bridge_line[1:]))
            for c, d in water_segments if (point := crossing(a, b, c, d)) is not None]
    if len({point for _, point in hits}) != 1:
        raise ValueError("Expected one crossing between bridge KL 247 and the canal axis")
    index, anchor = min(hits)
    section.extend(rounded_bridge[1:index + 1])
    if section[-1] != anchor:
        section.append(anchor)

    return {
        "name": f"Kanalbrücke über den {name}",
        "kind": "place",
        "geometry": {"type": "Point", "coordinates": anchor},
        "sectionLink": {
            "street": "Wunstorfer Straße",
            "geometry": {"type": "LineString", "coordinates": section},
        },
        "evidence": {
            "nameSource": "https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/15-0330-2026",
            "bridgeIdentification": "https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/15-0765-2026S1",
            "bridgeDesignation": "KL 247",
            "bridgeFeatureId": BRIDGE_ID,
            "canalAxisId": CANAL_AXIS_ID,
            "approachAxisIds": APPROACH_AXIS_IDS,
        },
    }


def address_filter(bounds=None):
    predicate = ADDRESS_UNIT_PREDICATE
    if bounds is not None:
        west, south, east, north = bounds
        predicate = (
            f'<fes:And>{predicate}<fes:BBOX><gml:Envelope srsName="{NATIVE_CRS}">'
            f'<gml:lowerCorner>{west} {south}</gml:lowerCorner><gml:upperCorner>{east} {north}</gml:upperCorner>'
            '</gml:Envelope></fes:BBOX></fes:And>'
        )
    return (
        f'<fes:Filter xmlns:fes="http://www.opengis.net/fes/2.0" xmlns:ad="{AD}" '
        f'xmlns:gml="{GML}" xmlns:xlink="{XLINK}">{predicate}</fes:Filter>'
    )


def split_bounds(bounds):
    west, south, east, north = bounds
    if east - west > north - south:
        mid = (west + east) // 2
        return [(west, south, mid, north), (mid, south, east, north)]
    mid = (south + north) // 2
    return [(west, south, east, mid), (west, mid, east, north)]


def address_features():
    def tile_hits(bounds):
        root = request_features("Address", resultType="hits", FILTER=address_filter(bounds), srsName=CRS)
        return int(root.attrib["numberMatched"])

    def download(tile):
        bounds, count = tile
        root = request_features("Address", FILTER=address_filter(bounds), srsName=CRS, count=count)
        features = members(root, "Address")
        if len(features) != count:
            raise ValueError(f"Address: expected {count} features in {bounds}, got {len(features)}")
        return features

    expected = tile_hits(None)
    if not 60_000 <= expected <= 110_000:
        raise ValueError(f"Address: unexpected number of matching Hannover features: {expected}")
    print(f"Address: sizing tiles for {expected} Hannover features", file=sys.stderr, flush=True)
    # INSPIRE ignores startIndex. Bisect the city box until each municipality
    # filtered tile fits into one bounded response, then check total coverage.
    pending = split_bounds(ADDRESS_BOUNDS)
    expected_pending = expected
    queries = 0
    tiles = []
    ids = set()
    with ThreadPoolExecutor(max_workers=2) as pool:
        while pending:
            queries += len(pending)
            if queries > 100:
                raise ValueError("Address: spatial query limit reached")
            subtiles = []
            total = 0
            next_expected = 0
            for bounds, hits in zip(pending, pool.map(tile_hits, pending)):
                total += hits
                if hits > ADDRESS_TILE_LIMIT:
                    subtiles.extend(split_bounds(bounds))
                    next_expected += hits
                elif hits:
                    tiles.append((bounds, hits))
            if total < expected_pending:
                raise ValueError(f"Address: tile queries cover only {total}/{expected_pending} expected features")
            pending = subtiles
            expected_pending = next_expected

        print(f"Address: downloading {len(tiles)} Hannover tiles", file=sys.stderr, flush=True)
        for offset in range(0, len(tiles), 2):
            for features in pool.map(download, tiles[offset:offset + 2]):
                for feature in features:
                    identifier = feature_id(feature)
                    if identifier not in ids:  # A tile boundary can include the same address twice.
                        ids.add(identifier)
                        yield feature
                print(f"Address: {len(ids)}/{expected}", file=sys.stderr, flush=True)
    if len(ids) != expected:
        raise ValueError(f"Address: incomplete Hannover extract, got {len(ids)}/{expected}")


def address_record(feature, street_keys):
    refs = {href.rsplit("/", 1)[-1] for href in links(feature, "component", AD) if href}
    if ADDRESS_UNIT not in refs:
        raise ValueError(f"{feature_id(feature)}: not a Hannover address")
    keys = {ref.removeprefix(ADDRESS_STREET) for ref in refs if ref.startswith(ADDRESS_STREET)}
    if len(keys) != 1 or not keys <= street_keys:
        return None

    numbers = set()
    suffixes = set()
    for locator in feature.findall(f".//{{{AD}}}LocatorDesignator"):
        type_link = locator.find(f"{{{AD}}}type")
        kind = type_link.get(f"{{{XLINK}}}href", "").rsplit("/", 1)[-1] if type_link is not None else ""
        value = locator.findtext(f"{{{AD}}}designator", "").strip().lower()
        if kind == "addressNumber":
            match = re.fullmatch(r"([0-9]{1,4})\s*([a-z]{0,2})", value)
            if not match or not int(match[1]):
                return None
            numbers.add(int(match[1]))
            if match[2]:
                suffixes.add(match[2])
        elif kind == "addressNumberExtension":
            if not re.fullmatch(r"[a-z]{1,2}", value):
                return None
            suffixes.add(value)
    if len(numbers) != 1 or len(suffixes) > 1:
        return None
    number = f"{numbers.pop()}{next(iter(suffixes), '')}"

    positions = set()
    for position in feature.findall(f"{{{AD}}}position/{{{AD}}}GeographicPosition"):
        if position.findtext(f"{{{AD}}}default") not in ("true", "1"):
            continue
        point = position.find(f"{{{AD}}}geometry/{{{GML}}}Point")
        if point is None:
            continue
        if point.get("srsName", "").lower() not in (CRS.lower(), "http://www.opengis.net/def/crs/epsg/0/4326"):
            raise ValueError(f"{feature_id(feature)}: expected EPSG:4326 address point")
        lat, lon = map(float, point.findtext(f"{{{GML}}}pos", "").split())
        if not (52.25 < lat < 52.55 and 9.5 < lon < 10):
            raise ValueError(f"{feature_id(feature)}: coordinates outside expected EPSG:4326 area")
        positions.add((lon, lat))
    return keys.pop(), number, positions.pop() if len(positions) == 1 else None


def address_index(street_keys):
    by_key = defaultdict(dict)
    # Omit propertyName: the WFS projection keeps only the first component
    # and drops the second component with the official street key.
    for address in address_features():
        record = address_record(address, street_keys)
        if record is not None:
            key, number, point = record
            values = by_key[key]
            if values.setdefault(number, point) != point:
                values[number] = None

    result = {}
    for key, values in sorted(by_key.items()):
        points = {number: tuple(round(value, 6) for value in point)
                  for number, point in sorted(values.items()) if point is not None}
        if points:
            result[key] = points
    count = sum(map(len, result.values()))
    print(f"Hannover house coordinates: {count:,} on {len(result):,} street keys", file=sys.stderr, flush=True)
    if count < 60_000:
        raise ValueError("Too few Hannover house coordinates")
    return result


def write_dataset(path, dataset, *, compressed=True):
    raw = json.dumps(dataset, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
    temporary = None
    try:
        with NamedTemporaryFile(dir=path.parent, prefix=f".{path.name}.", delete=False) as output:
            temporary = Path(output.name)
            if compressed:
                with gzip.GzipFile(filename="", mode="wb", fileobj=output, mtime=0, compresslevel=9) as archive:
                    archive.write(raw)
            else:
                output.write(raw + b"\n")
        if temporary.stat().st_size > MAX_ARTIFACT_BYTES:
            raise ValueError(f"Gazetteer exceeds the {MAX_ARTIFACT_BYTES:,}-byte gzip limit")
        temporary.chmod(0o644)
        temporary.replace(path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def tram_context():
    lines = []
    for feature in page_features("AX_Bahnstrecke", (100, 4000), bbox=BBOX, srsName=CRS):
        if feature.findtext(f"{{{ADV}}}bahnkategorie") in {"1200", "1201"}:
            lines.extend(curves(feature))
    if not lines:
        raise ValueError("No Hannover Stadtbahn or Straßenbahn geometries in the ATKIS response")
    return {
        "schemaVersion": 1,
        "city": "hannover",
        "source": {
            "label": "LGLN, ATKIS Basis-DLM, Stadt- und Straßenbahn (CC BY 4.0), bearbeitet",
            "url": METADATA,
            "licenseUrl": LICENSE_URL,
            "retrievedAt": date.today().isoformat(),
        },
        "lines": lines,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=OUTPUT, help="destination gzip JSON (default: %(default)s)")
    parser.add_argument("--tram-context-output", type=Path, help="write the Stadtbahn and Straßenbahn lines instead")
    args = parser.parse_args()
    if args.tram_context_output:
        dataset = tram_context()
        write_dataset(args.tram_context_output, dataset, compressed=False)
        print(f"Wrote {len(dataset['lines'])} lines to {args.tram_context_output}")
        return

    entries, approach_axes, wunstorfer = street_entries()
    addresses = address_index({entry["streetKey"] for entry in entries})
    entries.append(bridge_entry(approach_axes, wunstorfer))
    credit = f"LGLN ({date.today().year})"
    dataset = {
        "city": "hannover",
        "attribution": f"{credit}, ATKIS Basis-DLM (CC BY 4.0), bearbeitet",
        "license": "CC-BY-4.0",
        "licenseUrl": LICENSE_URL,
        "sourceUrl": SOURCE,
        "sourceMetadataUrl": METADATA,
        "addressAttribution": f"{credit}, INSPIRE Hauskoordinaten aus ALKIS (CC BY 4.0), bearbeitet",
        "addressSourceUrl": ADDRESS_SOURCE,
        "addressSourceMetadataUrl": ADDRESS_METADATA,
        "municipalityKey": KEY_PREFIX,
        "entries": entries,
        "addresses": addresses,
    }
    write_dataset(args.output, dataset)
    print(f"Wrote {len(entries)} entries to {args.output} ({args.output.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
