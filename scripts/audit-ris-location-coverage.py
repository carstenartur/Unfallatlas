#!/usr/bin/env python3
"""Count location assessments in all records of an already published RIS v2 snapshot."""
import argparse
import gzip
import hashlib
import heapq
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


def draw_round(manifests, size, seed, prior_rounds=()):
    """Rank the combined unlocated population and exclude records already reviewed."""
    if size < 1:
        raise ValueError('A sampling round needs at least one record')
    excluded = set()
    for path in prior_rounds:
        for row in json.loads(path.read_bytes())['sample']:
            excluded.add((row['city'], row['id']))
    populations = {}

    def candidates():
        for path in manifests:
            raw = path.read_bytes()
            manifest = json.loads(raw)
            city = manifest['city']
            if city in populations:
                raise ValueError(f'Duplicate city: {city}')
            seen = set()
            unmapped = 0
            for row in records(manifest['roots']['records'], path.parent, city):
                identifier = row['id']
                if identifier in seen:
                    raise ValueError(f'Duplicate record: {city} {identifier}')
                seen.add(identifier)
                status = row['locationAssessment']['status']
                if status in ('mapped', 'partial'):
                    continue
                if status not in ('unresolved', 'unavailable'):
                    raise ValueError(f'Unknown assessment: {identifier} ({status})')
                unmapped += 1
                if (city, identifier) in excluded:
                    continue
                digest = hashlib.sha256(f'{seed}\n{city}\n{identifier}'.encode()).digest()
                yield digest, city, identifier, {k: row[k] for k in ('id', 'title', 'source', 'url')}
            if len(seen) != manifest['recordCount'] or len(seen) - unmapped != manifest['mappedRecordCount']:
                raise ValueError(f'Record totals disagree with {path}')
            populations[city] = {'manifestSha256': hashlib.sha256(raw).hexdigest(),
                                 'generation': manifest['generation'], 'recordCount': len(seen), 'unmapped': unmapped}

    drawn = heapq.nsmallest(size, candidates(), key=lambda item: item[:3])
    if len(drawn) < size:
        raise ValueError(f'Only {len(drawn)} eligible records for a sample of {size}')
    return {'sampleSeed': seed, 'populations': populations,
            'sample': [dict(row, city=city) for _, city, _, row in drawn]}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('manifest', type=Path, help='path to the manifest beside its record partitions')
    parser.add_argument('--sample-size', type=int, default=0)
    parser.add_argument('--seed', default='hannover-unmapped-all-sources-2026-11-10')
    parser.add_argument('--include-manifest', type=Path, action='append', default=[],
                        help='draw one joint sample across the supplied city manifests')
    parser.add_argument('--exclude-round', type=Path, action='append', default=[],
                        help='skip all IDs in a previous joint sample JSON')
    args = parser.parse_args()
    if args.sample_size < 0:
        parser.error('--sample-size must be non-negative')
    if args.include_manifest or args.exclude_round:
        report = draw_round([args.manifest, *args.include_manifest], args.sample_size, args.seed, args.exclude_round)
    else:
        report = summarize(args.manifest, args.sample_size, args.seed)
    print(json.dumps(report, indent=2, ensure_ascii=False, sort_keys=True))
