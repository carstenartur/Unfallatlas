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
from xml.etree import ElementTree

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


def plans(cases, step=1):
    transform = QgsCoordinateTransform(QgsCoordinateReferenceSystem('EPSG:4326'),
                                       QgsCoordinateReferenceSystem('EPSG:25832'), QgsProject.instance())
    def project(point):
        return transform.transform(QgsPointXY(point['lon'], point['lat']))
    for case in cases:
        line = QgsGeometry.fromPolylineXY([project(point) for point in case['geometry']])
        centre = line.lineLocatePoint(QgsGeometry.fromPointXY(project(case['anchor']))) if 'anchor' in case else line.length() / 2
        for window in (20, 50):
            start, end = max(0, centre-window), min(line.length(), centre+window)
            distances = list(np.arange(start, end+1e-6, step))
            if end - distances[-1] > 0.25:
                distances.append(end)
            yield case, window, distances, [line.interpolate(float(d)).asPoint() for d in distances]


def reference_cases(root):
    references = json.loads((root / 'tests/fixtures/hannover-dgm1-real/reference-cases.json').read_text())
    bridge_file = root / 'tests/fixtures/hannover-dgm1-real/westschnellweg-transition.json'
    approach = json.loads(bridge_file.read_text())['approach']
    return references['cases'] + [{'wayId': approach['id'], 'originalTags': approach['tags'],
                                   'geometry': approach['geometry'], 'transition': True}]


def read_height(point, layers, tile_size):
    height = 0
    for x, y, weight in neighbours(point):
        key = tile_size * math.floor(x / tile_size), tile_size * math.floor(y / tile_size)
        z, ok = layers[key].dataProvider().sample(QgsPointXY(x, y), 1)
        if not ok or not math.isfinite(z):
            raise ValueError(f'Missing original DGM1 cell at {x}, {y}')
        height += weight * z
    return height


def run(archives, root, samples_file=None, state_tiles=None, comparison=None):
    catalog = json.loads((root / 'config/hannover-dgm1-city-archives.json').read_text())
    cases = reference_cases(root)
    sample_plans = list(plans(cases))
    cells = {cell_key(x, y) for _, _, _, points in sample_plans for point in points for x, y, _ in neighbours(point)}
    with tempfile.TemporaryDirectory() as temporary:
        layers = original_layers(archives, catalog, cells, temporary)
        result = []
        sampled = []
        for case, window, distances, points in sample_plans:
            heights = [read_height(point, layers, 500) for point in points]
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
        if comparison:
            compare_surveys(root, cases, layers, state_tiles, comparison)
        layers.clear()
        if samples_file:
            samples_file.write_text(json.dumps({
                'surveyYear': catalog['surveyYear'], 'verticalDatum': catalog['verticalDatum'],
                'generator': f'PyQGIS {Qgis.QGIS_VERSION}', 'windowM': 50,
                'columns': ['distanceAlongOsmWayM', 'interpolatedDgm1TerrainHeightM'],
                'attribution': catalog['attribution'], 'geometryAttribution': '© OpenStreetMap contributors, ODbL 1.0',
                'profiles': sampled}, ensure_ascii=False, separators=(',', ':')) + '\n')
        print(json.dumps({'qgis': Qgis.QGIS_VERSION, 'originalTiles': len(cells), 'profiles': result}, indent=2))


def file_digest(path):
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def state_reference_layers(directory, catalog):
    layers, tile_ids = {}, {}
    for tile in catalog['tiles']:
        raster = directory / Path(tile['raster']['url']).name
        metadata = directory / Path(tile['metadata']['url']).name
        for name, asset in [(raster, 'raster'), (metadata, 'metadata')]:
            if file_digest(name) != tile[asset]['sha256']:
                raise ValueError(f'LGLN source digest mismatch: {name}')
        xml = ElementTree.parse(metadata)
        checks = {'KACHELNAME': tile['id'], 'AKTUALITAET': catalog['acquisitionDate'],
                  'KOORDINATENREFERENZSYSTEM_HOEHE': catalog['verticalDatum']}
        if any(xml.findtext(field) != expected for field, expected in checks.items()):
            raise ValueError(f'Unexpected LGLN metadata: {metadata}')
        layer = QgsRasterLayer(str(raster), tile['id'])
        if (not layer.isValid() or layer.crs().authid() != catalog['horizontalCrs']
                or (layer.width(), layer.height()) != (1000, 1000)
                or (layer.rasterUnitsPerPixelX(), layer.rasterUnitsPerPixelY()) != (1, 1)):
            raise ValueError(f'Unexpected LGLN raster grid: {raster}')
        key = layer.extent().xMinimum(), layer.extent().yMinimum()
        if key in layers or any(v % 1000 for v in key):
            raise ValueError(f'Duplicate or misaligned LGLN tile: {raster}')
        layers[key], tile_ids[key] = layer, tile['id']
    return layers, tile_ids


def compare_surveys(root, cases, city_layers, directory, output):
    city_catalog = 'config/hannover-dgm1-city-archives.json'
    state_catalog = 'config/hannover-dgm1-lgln-reference-tiles.json'
    geometry_files = ['tests/fixtures/hannover-dgm1-real/reference-cases.json',
                      'tests/fixtures/hannover-dgm1-real/westschnellweg-transition.json']
    city = json.loads((root / city_catalog).read_text())
    state = json.loads((root / state_catalog).read_text())
    state_layers, tile_ids = state_reference_layers(directory, state)
    profiles = {case['wayId']: {'wayId': case['wayId'], 'fits': []} for case in cases}
    for step in (1, 2, 5):
        for case, window, distances, points in plans(cases, step):
            city_z = [read_height(p, city_layers, 500) for p in points]
            state_z = [read_height(p, state_layers, 1000) for p in points]
            profile = profiles[case['wayId']]
            fit = {'windowM': window, 'stepM': step, 'count': len(points)}
            for name, heights in [('city', city_z), ('state', state_z)]:
                line = theilslopes(heights, distances, method='joint')
                residual = np.median(np.abs(heights - (line.slope*np.array(distances) + line.intercept)))
                fit[name + 'Percent'] = round(100 * line.slope, 3)
                fit[name + 'ResidualMadM'] = round(residual, 4)
            profile['fits'].append(fit)
            if window == 50 and step == 1:
                profile['stateTiles'] = sorted({tile_ids[(1000*math.floor(x/1000), 1000*math.floor(y/1000))]
                                                for p in points for x, y, _ in neighbours(p)})
                rows = [[round(float(d), 3), round(z, 4), round(h, 4)]
                        for d, z, h in zip(distances, city_z, state_z)]
                profile['samples'] = rows
                csv = ''.join(f'{d:.3f},{z:.4f},{h:.4f}\n' for d, z, h in rows)
                profile['sampleSha256'] = hashlib.sha256(csv.encode('ascii')).hexdigest()
    for profile in profiles.values():
        profile['fits'].sort(key=lambda fit: (fit['windowM'], fit['stepM']))
    result = {'sources': {'municipalSurveyYear': city['surveyYear'], 'municipalVerticalDatum': city['verticalDatum'],
                          'stateSurveyDate': state['acquisitionDate'], 'stateVerticalDatum': state['verticalDatum'],
                          'fileSha256': {name: file_digest(root / name) for name in [city_catalog, state_catalog, *geometry_files]}},
              'attribution': [city['attribution'], state['attribution'], '© OpenStreetMap contributors, ODbL 1.0'],
              'sampleColumns': ['distanceAlongOsmWayM', 'municipalTerrainHeightM', 'stateTerrainHeightM'],
              'profiles': list(profiles.values())}
    output.write_text(json.dumps(result, ensure_ascii=False, separators=(',', ':')) + '\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archives', type=Path, required=True)
    parser.add_argument('--samples', type=Path, help='Write the checked ±50 m terrain profiles as JSON')
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--state-tiles', type=Path, help='Local directory containing the pinned LGLN TIFF/XML pairs')
    parser.add_argument('--comparison', type=Path, help='Write the paired municipal and LGLN reference profiles')
    args = parser.parse_args()
    if bool(args.state_tiles) != bool(args.comparison):
        parser.error('--state-tiles and --comparison must be supplied together')
    os.environ.setdefault('QT_QPA_PLATFORM', 'offscreen')
    gdal.UseExceptions()
    osr.UseExceptions()
    app = QgsApplication([], False)
    app.initQgis()
    try:
        run(args.archives, args.root, args.samples, args.state_tiles, args.comparison)
    finally:
        app.exitQgis()
