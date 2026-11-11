#!/usr/bin/env python3
"""Export the ordered public Köln context geometries for an auditable existing-data run."""
import argparse
import gzip
import json
from pathlib import Path


def read_tile(path):
    with gzip.open(path, "rt", encoding="utf-8") as src:
        return json.load(src)


def export(repo, target):
    base = repo / "out/ctxtiles/koeln"
    index = read_tile(base / "index.json.gz")
    ways, geometries, collapsed = {}, {}, set()
    for tile in index["tiles"]:
        payload = read_tile(base / str(tile["x"]) / f'{tile["y"]}.json.gz')
        for way_id, flat in payload["geometries"].items():
            if len(flat) % 2:
                raise ValueError(f"Odd coordinate count: {way_id}")
            points = list(zip(flat[::2], flat[1::2]))
            if len(set(points)) < 2:
                collapsed.add(way_id)
                continue
            highway = payload["ways"][way_id].get("highway")
            if isinstance(highway, int):
                highway = index["dicts"]["highway"][highway]
            attributes = {"highway": highway}
            geometry = [{"lat": lat, "lon": lon} for lat, lon in points]
            if way_id in ways and (ways[way_id] != attributes or geometries[way_id] != geometry):
                raise ValueError(f"Inconsistent published geometry: {way_id}")
            ways[way_id], geometries[way_id] = attributes, geometry
    if collapsed & ways.keys():
        raise ValueError("A way has both collapsed and positive-length public geometry")
    document = {"ways": ways, "wayGeometries": geometries,
                "source": "OpenStreetMap contributors, ordered generalised public context geometries",
                "publicGeometry": {"format": "ua-encodeGeometry-v1", "method": "none", "toleranceMeters": 0}}
    with target.open("x", encoding="utf-8") as out:
        json.dump(document, out, separators=(",", ":"))
        out.write("\n")
    print(f"{len(ways)} positive-length ways, {len(collapsed)} collapsed ways excluded")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    export(args.root, args.output)
