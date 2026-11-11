#!/usr/bin/env python3
"""Check the selected Hannover tram areas against the archived DELFI ZHV export."""
import argparse
import csv
import hashlib
import io
import json
from pathlib import Path
from zipfile import ZipFile

REGISTER = Path(__file__).resolve().parents[1] / 'config/ris-locations/hannover-stadtbahn.json'


def verify(archive):
    register = json.loads(REGISTER.read_text(encoding='utf-8'))
    with archive.open('rb') as source:
        if hashlib.file_digest(source, 'sha256').hexdigest() != register['sourceSha256']:
            raise ValueError('Archive differs from the release cited in the register')
    entries = register['entries']
    ids = {entry[key] for entry in entries for key in ('stationId', 'areaId')}
    rows = {}
    with ZipFile(archive) as zipped, zipped.open(register['sourceMember']) as source:
        reader = csv.DictReader(io.TextIOWrapper(source, encoding='utf-8-sig', newline=''), delimiter=';')
        for row in reader:
            dhid = row['DHID']
            if dhid in ids:
                if dhid in rows:
                    raise ValueError(f'Duplicate ZHV identifier {dhid}')
                rows[dhid] = row
    topics = set()
    for entry in entries:
        station, area = rows[entry['stationId']], rows[entry['areaId']]
        coordinates = [float(area[column].replace(',', '.')) for column in ('Longitude', 'Latitude')]
        if (station['Type'] != 'S' or station['MunicipalityCode'] != entry['municipalityCode']
                or station['Municipality'] != entry['municipality'] or station['Name'] != entry['stationName']
                or area['Type'] != 'A' or area['Parent'] != station['DHID'] or area['Name'] != entry['areaName']
                or area['Authority'] != 'HannIT' or area['SEV'] != 'nein' or coordinates != entry['coordinates']):
            raise ValueError(f"Station or tram area disagrees with ZHV: {entry['name']}")
        for name in [entry['name'], *entry.get('aliases', [])]:
            key = (entry['corridor'].casefold(), name.casefold())
            if key in topics:
                raise ValueError(f'Ambiguous corridor and stop name: {key}')
            topics.add(key)
    print(f'Verified {len(entries)} tram areas in {len({e["municipalityCode"] for e in entries})} municipalities')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive', type=Path, help='DELFI ZHV ZIP specified in the register')
    verify(parser.parse_args().archive)
