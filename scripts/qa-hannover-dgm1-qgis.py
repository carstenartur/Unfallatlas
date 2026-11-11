#!/usr/bin/env python3
"""Independently check Hannover reference profiles with PyQGIS against the original XYZ archives."""
import argparse
import hashlib
import io
import json
import math
import os
from pathlib import Path
import tempfile
import zipfile

import numpy as np
from osgeo import gdal, osr
from qgis.core import (Qgis, QgsApplication, QgsCoordinateReferenceSystem, QgsCoordinateTransform,
                       QgsGeometry, QgsPointXY, QgsProject, QgsRasterLayer)
from scipy.stats import theilslopes


def original_layers(archives, catalog, wanted, temporary):
    layers = {}
    crs = osr.SpatialReference()
    crs.ImportFromEPSG(25832)
    for item in catalog['archives']:
        archive = archives / Path(item['url']).name
        with archive.open('rb') as source:
            if hashlib.file_digest(source, 'sha256').hexdigest() != item['sha256']:
                raise ValueError(f'Original archive digest mismatch: {archive}')
        with zipfile.ZipFile(archive) as source:
            for member in source.infolist():
                with source.open(member) as xyz:
                    x, y, _ = map(float, xyz.readline().split())
                key = (math.floor(x), math.floor(y))
                if key not in wanted:
                    continue
                if key in layers:
                    raise ValueError(f'Duplicate original tile at {key}')
                rows = np.loadtxt(io.BytesIO(source.read(member)))
                if len(rows) != 250000:
                    raise ValueError(f'Incomplete original tile: {member.filename}')
                # Read XYZ coordinates explicitly. The test does not assume the producer's packing order.
                raster = np.full((500, 500), np.nan)
                raster[499 - (rows[:, 1] - y).astype(int), (rows[:, 0] - x).astype(int)] = rows[:, 2]
                if not np.all(np.isfinite(raster)):
                    raise ValueError(f'Missing original XYZ cells in {member.filename}')
                name = Path(temporary) / f'{key[0]}-{key[1]}.tif'
                data = gdal.GetDriverByName('GTiff').Create(str(name), 500, 500, 1, gdal.GDT_Float64)
                data.SetGeoTransform((key[0], 1, 0, key[1] + 500, 0, -1))
                data.SetProjection(crs.ExportToWkt())
                data.GetRasterBand(1).WriteArray(raster)
                data = None
                layer = QgsRasterLayer(str(name), member.filename)
                if not layer.isValid():
                    raise ValueError(f'QGIS could not open {name}')
                layers[key] = layer
    if wanted != set(layers):
        raise ValueError(f'Missing original tiles: {wanted - set(layers)}')
    return layers


def cell_key(x, y):
    return 500 * math.floor(x / 500), 500 * math.floor(y / 500)


def neighbours(point):
    # Original XYZ heights represent heights at half-metre cell centres.
    west, south = math.floor(point.x() - 0.5) + 0.5, math.floor(point.y() - 0.5) + 0.5
    dx, dy = point.x() - west, point.y() - south
    return [(west, south, (1-dx)*(1-dy)), (west+1, south, dx*(1-dy)),
            (west, south+1, (1-dx)*dy), (west+1, south+1, dx*dy)]


def plans(cases):
    transform = QgsCoordinateTransform(QgsCoordinateReferenceSystem('EPSG:4326'),
                                       QgsCoordinateReferenceSystem('EPSG:25832'), QgsProject.instance())
    def project(point):
        return transform.transform(QgsPointXY(point['lon'], point['lat']))
    for case in cases:
        line = QgsGeometry.fromPolylineXY([project(point) for point in case['geometry']])
        centre = line.lineLocatePoint(QgsGeometry.fromPointXY(project(case['anchor']))) if 'anchor' in case else line.length() / 2
        for window in (20, 50):
            start, end = max(0, centre-window), min(line.length(), centre+window)
            distances = list(np.arange(start, end+1e-6, 1.0))
            if end - distances[-1] > 0.25:
                distances.append(end)
            yield case, window, distances, [line.interpolate(float(d)).asPoint() for d in distances]


def run(archives, root, samples_file=None):
    references = json.loads((root / 'tests/fixtures/hannover-dgm1-real/reference-cases.json').read_text())
    catalog = json.loads((root / 'config/hannover-dgm1-city-archives.json').read_text())
    bridge_file = root / 'tests/fixtures/hannover-dgm1-real/westschnellweg-transition.json'
    approach = json.loads(bridge_file.read_text())['approach']
    cases = references['cases'] + [{'wayId': approach['id'], 'originalTags': approach['tags'],
                                    'geometry': approach['geometry'], 'transition': True}]
    sample_plans = list(plans(cases))
    cells = {cell_key(x, y) for _, _, _, points in sample_plans for point in points for x, y, _ in neighbours(point)}
    with tempfile.TemporaryDirectory() as temporary:
        layers = original_layers(archives, catalog, cells, temporary)
        result = []
        sampled = []
        for case, window, distances, points in sample_plans:
            heights = []
            for point in points:
                height = 0
                for x, y, weight in neighbours(point):
                    z, ok = layers[cell_key(x, y)].dataProvider().sample(QgsPointXY(x, y), 1)
                    if not ok or not math.isfinite(z):
                        raise ValueError('QGIS could not sample the original DGM1 cell')
                    height += weight * z
                heights.append(height)
            if samples_file and window == 50:
                sampled.append({'wayId': case['wayId'], 'profile': [
                    [round(float(d), 3), round(h, 4)] for d, h in zip(distances, heights)]})
            fit = theilslopes(heights, distances, method='joint')
            residual = np.median(np.abs(heights - (fit.slope*np.array(distances) + fit.intercept)))
            result.append({'wayId': case['wayId'], 'windowM': window, 'samples': len(heights),
                           'lengthM': round(distances[-1]-distances[0], 2),
                           'terrainProfilePercent': round(fit.slope*100, 3), 'residualMadM': round(residual, 4),
                           'bridge': case['originalTags'].get('bridge') == 'yes',
                           'bridgeTransition': case.get('transition', False)})
        layers.clear()
        if samples_file:
            samples_file.write_text(json.dumps({
                'surveyYear': catalog['surveyYear'], 'verticalDatum': catalog['verticalDatum'],
                'generator': f'PyQGIS {Qgis.QGIS_VERSION}', 'windowM': 50,
                'columns': ['distanceAlongOsmWayM', 'interpolatedDgm1TerrainHeightM'],
                'attribution': catalog['attribution'], 'geometryAttribution': '© OpenStreetMap contributors, ODbL 1.0',
                'profiles': sampled}, ensure_ascii=False, separators=(',', ':')) + '\n')
        print(json.dumps({'qgis': Qgis.QGIS_VERSION, 'originalTiles': len(cells), 'profiles': result}, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archives', type=Path, required=True)
    parser.add_argument('--samples', type=Path, help='Write the checked ±50 m terrain profiles as JSON')
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    os.environ.setdefault('QT_QPA_PLATFORM', 'offscreen')
    gdal.UseExceptions()
    osr.UseExceptions()
    app = QgsApplication([], False)
    app.initQgis()
    try:
        run(args.archives, args.root, args.samples)
    finally:
        app.exitQgis()
