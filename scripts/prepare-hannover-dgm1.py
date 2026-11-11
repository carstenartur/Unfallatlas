#!/usr/bin/env python3
"""Build a seekable 1 m raster from the five reviewed municipal Hannover XYZ archives."""
import argparse
import hashlib
import json
import os
import pathlib
import shutil
import tempfile
import urllib.request
import zipfile

try:
    import numpy as np
except ImportError:
    np = None

import array
import math
import sys

CATALOG = pathlib.Path(__file__).resolve().parents[1] / "config/hannover-dgm1-city-archives.json"
SIDE = 500
# All pinned originals use this exact fixed-width XYZ layout, x-major with y increasing.
ROW = np.dtype([("x", "S12"), ("y", "S13"), ("z", "S10"), ("newline", "S2")]) if np is not None else None


def digest(path):
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def archive_path(directory, item):
    path = directory / pathlib.PurePosixPath(item["url"]).name
    if not path.is_file():
        with tempfile.NamedTemporaryFile(dir=directory, delete=False) as target:
            tmp = pathlib.Path(target.name)
        try:
            with urllib.request.urlopen(item["url"], timeout=120) as response, tmp.open("wb") as out:
                shutil.copyfileobj(response, out, 1024 * 1024)
            if tmp.stat().st_size != item["bytes"] or digest(tmp) != item["sha256"]:
                raise ValueError(f"Source size or SHA-256 mismatch: {item['url']}")
            os.replace(tmp, path)
            return path
        finally:
            tmp.unlink(missing_ok=True)
    if path.stat().st_size != item["bytes"] or digest(path) != item["sha256"]:
        raise ValueError(f"Source size or SHA-256 mismatch: {path}")
    return path


def pack_tile(raw):
    if len(raw) != SIDE * SIDE * 37:
        raise ValueError("Unexpected XYZ member size")
    if np is None:
        east, north = int(float(raw[:12])), int(float(raw[12:25]))
        if east % SIDE or north % SIDE:
            raise ValueError("Misaligned tile origin")
        heights = array.array("f")
        for i, offset in enumerate(range(0, len(raw), 37)):
            x, y, z = (float(raw[offset+a:offset+b]) for a, b in ((0,12),(12,25),(25,35)))
            if (x != east + i//SIDE + 0.5 or y != north + i%SIDE + 0.5 or
                    raw[offset+35:offset+37] != b"\r\n" or not math.isfinite(z)):
                raise ValueError("Invalid XYZ grid, order or height")
            heights.append(z)
        if sys.byteorder == "big":
            heights.byteswap()
        return east, north, heights.tobytes()
    rows = np.frombuffer(raw, dtype=ROW).reshape(SIDE, SIDE)
    x = rows["x"].astype(np.float64)
    y = rows["y"].astype(np.float64)
    z = rows["z"].astype("<f4")
    east, north = int(x[0, 0]), int(y[0, 0])
    axis = np.arange(SIDE, dtype=np.float64) + 0.5
    if (east % SIDE or north % SIDE or not np.all(rows["newline"] == b"\r\n")
            or not np.all(x == (east + axis[:, None])) or not np.all(y == (north + axis))
            or not np.all(np.isfinite(z))):
        raise ValueError("Invalid XYZ grid, order or height")
    return east, north, z.tobytes(order="C")


def build(source_dir, output):
    catalog = json.loads(CATALOG.read_text())
    source_dir.mkdir(parents=True, exist_ok=True)
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=output) as temp:
        temp = pathlib.Path(temp)
        packed = temp / "heights.f32"
        tiles = []
        cells = set()
        with packed.open("wb") as target:
            for item in catalog["archives"]:
                with zipfile.ZipFile(archive_path(source_dir, item)) as source:
                    members = sorted(source.infolist(), key=lambda entry: entry.filename)
                    if len(members) != item["xyzEntries"]:
                        raise ValueError("Archive member count mismatch")
                    for entry in members:
                        # ZipFile.read also verifies the CRC. Never extract member paths.
                        east, north, heights = pack_tile(source.read(entry))
                        if (east, north) in cells:
                            raise ValueError("Overlapping source tiles")
                        cells.add((east, north))
                        tiles.append([east, north])
                        target.write(heights)
        data_hash = digest(packed)
        if data_hash != catalog["packedRasterSha256"]:
            raise ValueError("Converted city raster differs from reference")
        data_name = f"heights-{data_hash}.f32"
        manifest = {"schemaVersion": 2, "sourceId": "hannover.dgm1",
                    "retrievedAt": max(item["retrievedAt"] for item in catalog["archives"]),
                    "archiveSha256": [item["sha256"] for item in catalog["archives"]],
                    "distribution": {"path": data_name, "sha256": data_hash, "bytes": packed.stat().st_size},
                    "grid": {"crs": "EPSG:25832", "resolutionMeters": 1, "tileSide": SIDE,
                             "layout": "x-major-float32le", "tiles": tiles}}
        manifest_file = temp / "manifest.json"
        manifest_file.write_text(json.dumps(manifest, separators=(",", ":")) + "\n")
        if digest(manifest_file) != catalog["packedManifestSha256"]:
            raise ValueError("Converted city manifest differs from reference")
        # Readers holding the previous manifest can still finish with its immutable raster.
        os.replace(packed, output / data_name)
        os.replace(manifest_file, output / "manifest.json")
    print(digest(output / "manifest.json"))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archives", type=pathlib.Path, required=True)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    args = parser.parse_args()
    build(args.archives, args.output)
