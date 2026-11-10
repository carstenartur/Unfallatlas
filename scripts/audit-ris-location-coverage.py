#!/usr/bin/env python3
"""Count location assessments in all records of an already published RIS v2 snapshot."""
import argparse
import gzip
import hashlib
import json
import re
from collections import Counter, defaultdict
from pathlib import Path


def records(root, directory, city):
    name = f"{city}.{root['sha256']}.records.json.gz"
    if not re.fullmatch(r'[a-f0-9]{64}', root['sha256']) or root['kind'] != 'records' or root['path'] != name:
        raise ValueError(f"Invalid record reference: {root['path']}")
    data = (directory / name).read_bytes()
    if data.startswith(b'\x1f\x8b'):
        data = gzip.decompress(data)
    if len(data) != root['bytes'] or hashlib.sha256(data).hexdigest() != root['sha256']:
        raise ValueError(f"Record partition does not match its reference: {name}")
    node = json.loads(data)
    if len(node['entries']) != root['count']:
        raise ValueError(f"Invalid partition size: {name}")
    for key, value in node['entries']:
        if node['type'] == 'branch':
            yield from records(value, directory, city)
        elif node['type'] == 'leaf' and value['id'] == key:
            yield value
        else:
            raise ValueError(f"Invalid record node: {name}")


def summarize(manifest_path, sample_size, seed):
    raw = manifest_path.read_bytes()
    manifest = json.loads(raw)
    by_source = defaultdict(lambda: {
        'statuses': Counter(), 'unmappedReasons': Counter(), 'unmappedReasonCombinations': Counter(),
        'unmappedEvidenceSources': Counter(),
    })
    universe = set()
    ranked = []
    for record in records(manifest['roots']['records'], manifest_path.parent, manifest['city']):
        identifier = record['id']
        if identifier in universe:
            raise ValueError(f"Duplicate record: {identifier}")
        universe.add(identifier)
        assessment = record['locationAssessment']
        group = by_source[record['source']]
        status = assessment['status']
        if status not in ('mapped', 'partial', 'unresolved', 'unavailable'):
            raise ValueError(f"Unknown assessment: {identifier} ({status})")
        group['statuses'][status] += 1
        if status in ('mapped', 'partial'):
            continue
        reasons = sorted(set(assessment['reasons']))
        group['unmappedReasons'].update(reasons)
        group['unmappedReasonCombinations'][' + '.join(reasons) or '(none)'] += 1
        group['unmappedEvidenceSources'][' + '.join(sorted(assessment['sources'])) or '(none)'] += 1
        if sample_size:
            rank = hashlib.sha256(f'{seed}\n{identifier}'.encode()).digest()
            ranked.append((rank, identifier, {k: record[k] for k in ('id', 'title', 'source', 'url')},
                           status, reasons))
    totals = Counter()
    for group in by_source.values():
        totals.update(group['statuses'])
    if (len(universe) != manifest['recordCount'] or len(universe) != manifest['locationAssessment']['attempted']
            or totals['mapped'] + totals['partial'] != manifest['mappedRecordCount']
            or any(totals[status] != manifest['locationAssessment'][status]
                   for status in ('mapped', 'partial', 'unresolved', 'unavailable'))):
        raise ValueError("Record totals disagree with the published manifest")
    return {
        'generation': manifest['generation'], 'manifestSha256': hashlib.sha256(raw).hexdigest(),
        'locationRevision': manifest['locationRevision'], 'sourceTime': manifest['generatedAt'],
        'recordCount': len(universe), 'mappedRecordCount': manifest['mappedRecordCount'],
        'unmappedRecordCount': totals['unresolved'] + totals['unavailable'],
        'bySource': by_source, 'sampleSeed': seed,
        'sample': [dict(row, status=status, reasons=reasons)
                   for _, _, row, status, reasons in sorted(ranked)[:sample_size]],
    }


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('manifest', type=Path, help='path to the manifest beside its record partitions')
    parser.add_argument('--sample-size', type=int, default=0)
    parser.add_argument('--seed', default='hannover-unmapped-all-sources-2026-11-10')
    args = parser.parse_args()
    if args.sample_size < 0:
        parser.error('--sample-size must be non-negative')
    print(json.dumps(summarize(args.manifest, args.sample_size, args.seed), indent=2, ensure_ascii=False, sort_keys=True))
