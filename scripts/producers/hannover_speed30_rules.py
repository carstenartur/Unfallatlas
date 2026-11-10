"""Join the BBBike Hannover OSM PBF to context tile way IDs.

Requires pyosmium (pip install osmium). Output data: © OpenStreetMap
contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright).
"""

import argparse
from datetime import datetime
import gzip
import json
from pathlib import Path
import re

import osmium


SOURCE_URL = "https://download.bbbike.org/osm/bbbike/Hannover/Hannover.osm.pbf"
SPEED_RULE = re.compile(r"maxspeed(?::(?:lanes|forward|backward|both_ways))*(?::conditional)?")
SPEED_30 = re.compile(r"30(?:\s*km/h)?", re.IGNORECASE)
CONDITIONAL_30 = re.compile(r"(?:^|[;|])\s*30(?:\s*km/h)?\s*@", re.IGNORECASE)


def contains_30(key, value):
    if key.endswith(":conditional"):
        return CONDITIONAL_30.search(value) is not None
    return any(SPEED_30.fullmatch(speed.strip()) for speed in value.split("|"))


def classify(tags):
    general_30 = bool(SPEED_30.fullmatch(tags.get("maxspeed", "").strip()))
    rules = {key: value for key, value in sorted(tags.items()) if SPEED_RULE.fullmatch(key)}
    restricted_rules = {key: value for key, value in rules.items() if key != "maxspeed"}

    restricted_30 = any(contains_30(key, value) for key, value in restricted_rules.items())
    if restricted_30 or (general_30 and restricted_rules):
        return {"kind": "conditional", "rules": rules}
    if not general_30:
        return None

    evidence = {tags.get("maxspeed:type"), tags.get("source:maxspeed")}
    if "DE:zone30" in evidence or tags.get("zone:maxspeed") == "DE:30":
        return {"kind": "zone"}
    if "sign" in evidence:
        return {"kind": "signed"}
    return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pbf", type=Path, help="Hannover OSM extract from BBBike")
    parser.add_argument("context_index", type=Path, help="Hannover context tile index JSON gzip")
    parser.add_argument("output", type=Path, help="Destination for the sidecar JSON")
    args = parser.parse_args()

    with gzip.open(args.context_index, "rt") as handle:
        context_index = json.load(handle)
    if context_index["citySlug"] != "hannover":
        parser.error("the context index must be for Hannover")
    context_ids = {int(way_id) for way_id in context_index["wayIndex"]}

    with osmium.io.Reader(str(args.pbf)) as reader:
        extract_timestamp = reader.header().get("osmosis_replication_timestamp")
    if not extract_timestamp:
        parser.error("the OSM extract has no osmosis_replication_timestamp")
    try:
        extract_date = datetime.fromisoformat(extract_timestamp.replace("Z", "+00:00")).date().isoformat()
    except ValueError:
        parser.error("the OSM extract has an invalid osmosis_replication_timestamp")

    ways = {}
    for way in osmium.FileProcessor(str(args.pbf), osmium.osm.WAY):
        if way.id not in context_ids:
            continue
        tags = dict(way.tags)
        row = classify(tags)
        if row:
            if tags.get("name"):
                row["name"] = tags["name"]
            ways[way.id] = row

    with args.output.open("w", encoding="utf-8") as handle:
        handle.write(f'{{"extractDate":"{extract_date}","sourceUrl":"{SOURCE_URL}","ways":{{\n')
        rows = (
            f'"{way_id}":' + json.dumps(ways[way_id], ensure_ascii=False, separators=(",", ":"))
            for way_id in sorted(ways)
        )
        handle.write(",\n".join(rows))
        handle.write("\n}}\n")


if __name__ == "__main__":
    main()
