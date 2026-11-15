"""Read hash-verified record partitions of an already published RIS snapshot."""
import gzip
import hashlib
import json
import re


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
