#!/usr/bin/env python3
"""Prepare private Bonn reading batches from local catalogues and a bounded OParl-Lite cache."""
import argparse
from contextlib import contextmanager
import csv
import hashlib
from http.client import HTTPException
import io
import json
import os
import re
import sqlite3
import sys
import tempfile
import time
import zipfile
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from urllib import error, parse, request

from ris_record_partitions import records

ORIGIN = 'https://www.bonn.sitzung-online.de'
MIRROR = 'https://oparl.bonn.machdenstaat.de/graphql'
FILE_ID = re.compile(re.escape(ORIGIN) + r'/oparl/files/[0-9]+')
PAPER_ID = re.compile(re.escape(ORIGIN) + r'/oparl/papers/[0-9]+')
VERSION = re.compile(r'[0-9a-fA-F]{64}')
MAX_REQUESTS = 10
DAILY_BYTES = 10 * 1024 * 1024
REQUEST_BYTES = 4 * 1024 * 1024


def sha(data):
    return hashlib.sha256(data).hexdigest()


def file_uri(href):
    if not href:
        return None
    u = parse.urlsplit(href)
    if (u.scheme, u.netloc, u.path, u.fragment) != ('https', 'www.bonn.sitzung-online.de', '/public/doc', ''):
        return None
    params = parse.parse_qs(u.query, keep_blank_values=True)
    ids = params.get('DOLFDNR', [])
    if (params.get('DOCTYP') == ['130'] and params.get('OTYP') == ['41']
            and len(ids) == 1 and re.fullmatch(r'[0-9]+', ids[0])):
        return f'{ORIGIN}/oparl/files/{ids[0]}'
    return None


def prepare(manifest_path, export_path):
    manifest = json.loads(manifest_path.read_bytes())
    if manifest['city'] != 'bonn':
        raise ValueError('Expected the published Bonn manifest')
    papers = {}
    seen = set()
    for r in records(manifest['roots']['records'], manifest_path.parent, 'bonn'):
        pid = r['id']
        if pid in seen or not PAPER_ID.fullmatch(pid):
            raise ValueError(f'Invalid or repeated public Paper ID: {pid}')
        seen.add(pid)
        status = r['locationAssessment']['status']
        if status not in ('unresolved', 'unavailable', 'mapped', 'partial'):
            raise ValueError(f'Unknown assessment for {pid}: {status}')
        if status in ('unresolved', 'unavailable'):
            papers[pid] = dict(id=pid, reference=r['number'], title=r['title'], file=None)
    if len(seen) != manifest['recordCount'] or len(seen) - len(papers) != manifest['mappedRecordCount']:
        raise ValueError('Published record counts disagree')
    refs = {}
    methods = {}
    with zipfile.ZipFile(export_path) as z:
        audit = 'allris-bonn/audit_geokodierung_bonn.tsv'
        with io.TextIOWrapper(z.open(audit), encoding='utf-8-sig', newline='') as f:
            for entry in csv.DictReader(f, delimiter='\t'):
                pid, method = entry['quellobjekt'], entry['methode']
                p = papers.get(pid)
                if p and entry['drucksache'] == p['reference'] and method.startswith('volltext_'):
                    methods.setdefault(pid, set()).add(method)
        for name in z.namelist():
            if not re.fullmatch(r'allris-bonn/bonn/(ortsteile|bezirke|ohne-ortsbezug)/[^/]+\.json', name):
                continue
            for entry in json.loads(z.read(name))['papers']:
                pid = entry.get('source_object')
                p = papers.get(pid)
                if not p or entry.get('reference') != p['reference']:
                    continue
                uri = file_uri(entry.get('main_file'))
                if uri:
                    refs.setdefault(pid, set()).add(uri)
    for pid, p in papers.items():
        links = refs.get(pid, set())
        if len(links) == 1:
            p['file'] = next(iter(links))
        p['methods'] = sorted(methods.get(pid, ()))
    ordered = sorted(papers.values(), key=lambda p: (not bool(p['methods']), p['id']))
    with export_path.open('rb') as f:
        export_hash = hashlib.file_digest(f, 'sha256').hexdigest()
    return {'catalogueGeneration': manifest['generation'], 'exportSha256': export_hash, 'papers': ordered}


def open_cache(path):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    # SQLite bases the mode of its journal on that of the existing database.
    fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        os.fchmod(fd, 0o600)
    finally:
        os.close(fd)
    db = sqlite3.connect(path, timeout=60)
    db.execute('CREATE TABLE IF NOT EXISTS files (uri TEXT PRIMARY KEY, version TEXT, paper_ids TEXT, body TEXT)')
    db.execute('CREATE TABLE IF NOT EXISTS requests (started REAL, charged INTEGER)')
    db.execute('CREATE TABLE IF NOT EXISTS backoff (id INTEGER PRIMARY KEY, until REAL)')
    return db


def read_row(db, row):
    result = {**row, 'status': 'no_file_link' if not row['file'] else 'not_cached'}
    entry = db.execute('SELECT version, paper_ids, body FROM files WHERE uri=?', (row['file'],)).fetchone()
    if entry:
        version, ids, body = entry
        if row['id'] not in json.loads(ids):
            result['status'] = 'unconfirmed_paper_or_missing_file'
        elif body:
            result.update(status='text_available', mirrorVersion=version, text=body, textSha256=sha(body.encode()))
        elif version and body is None:
            result['status'] = 'version_pending'
        else:
            result['status'] = 'no_text_for_version'
    return result


def read_response(db, uris, remote, with_text):
    data = remote(uris, with_text)
    changed = []
    with db:
        if not isinstance(data, dict):
            raise ValueError('Invalid mirror data')
        for i, uri in enumerate(uris):
            if f'f{i}' not in data:
                raise ValueError('Mirror omitted a requested file')
            value = data[f'f{i}']
            if value is None:
                db.execute('INSERT OR REPLACE INTO files VALUES (?,NULL,?,NULL)', (uri, '[]'))
                continue
            required = {'uri', 'papers', 'textSha256'}
            if with_text:
                required.add('text')
            if not isinstance(value, dict) or not required.issubset(value):
                raise ValueError('Mirror returned an incomplete file object')
            if value['uri'] != uri or not isinstance(value['papers'], list):
                raise ValueError('Mirror returned a different file or invalid ownership list')
            ids = set()
            for paper in value['papers']:
                pid = paper.get('uri') if isinstance(paper, dict) else None
                if not isinstance(pid, str) or not PAPER_ID.fullmatch(pid):
                    raise ValueError('Invalid paper URI in mirror ownership list')
                ids.add(pid)
            version = value['textSha256']
            body = value.get('text') if with_text else None
            if version is not None and (not isinstance(version, str) or not VERSION.fullmatch(version)):
                raise ValueError('Invalid mirror version')
            if body is not None and (not isinstance(body, str) or not version):
                raise ValueError('Invalid or unversioned text')
            prior = db.execute('SELECT version, body FROM files WHERE uri=?', (uri,)).fetchone()
            if not with_text:
                if version and prior and prior[0] == version and prior[1] is not None:
                    body = prior[1]
                elif version:
                    changed.append(uri)
            elif body is None and version:
                body = ''
            db.execute('INSERT OR REPLACE INTO files VALUES (?,?,?,?)', (uri, version, json.dumps(sorted(ids)), body))
    return changed


def sync(db, rows, remote, refresh=False):
    uris = list(dict.fromkeys(p['file'] for p in rows if p['file']))
    for start in range(0, len(uris), 10):
        group = uris[start:start + 10]
        todo = []
        probe = []
        for uri in group:
            if not FILE_ID.fullmatch(uri):
                raise ValueError('Invalid Bonn file URI')
            prior = db.execute('SELECT version,body FROM files WHERE uri=?', (uri,)).fetchone()
            if prior is None or (prior[0] and prior[1] is None):
                todo.append(uri)
            elif refresh:
                probe.append(uri)
        if probe:
            todo.extend(read_response(db, probe, remote, False))
        if todo:
            read_response(db, todo, remote, True)


class NoRedirect(request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


@contextmanager
def exclusive_fetch(path):
    # Hold a separate SQLite lock across cache checks and network I/O. Budget
    # reservations in the main database can still commit before each request.
    lock = sqlite3.connect(str(path) + '.fetch-lock', timeout=1)
    try:
        lock.execute('BEGIN IMMEDIATE')
        yield
    finally:
        lock.close()


def mirror(db, uris, with_text):
    # Reserve bytes before sending. On cancellation the conservative charge survives.
    last = db.execute('SELECT max(started) FROM requests').fetchone()[0] or 0
    delay = last + 10 - time.time()
    if delay > 0:
        time.sleep(delay)
    with db:
        db.execute('BEGIN IMMEDIATE')
        now = time.time()
        day_start = datetime.fromtimestamp(now, timezone.utc).replace(
            hour=0, minute=0, second=0, microsecond=0).timestamp()
        blocked = db.execute('SELECT until FROM backoff WHERE id=1').fetchone()
        if blocked and blocked[0] > now:
            raise RuntimeError('Mirror cooldown in effect')
        if now < last + 10:
            raise RuntimeError('Mirror minimum interval has not elapsed')
        count, used = db.execute('SELECT count(*),coalesce(sum(charged),0) FROM requests WHERE started>=?',
                                 (day_start,)).fetchone()
        room = min(REQUEST_BYTES, DAILY_BYTES - used)
        if count >= MAX_REQUESTS or room <= 0:
            raise RuntimeError('Daily mirror budget exhausted; read cached texts offline')
        seq = db.execute('INSERT INTO requests VALUES (?,?)', (now, room)).lastrowid
    variables = {f'u{i}': uri for i, uri in enumerate(uris)}
    args = ','.join(f'${name}:String!' for name in variables)
    fields = 'uri papers{uri} textSha256' + (' text' if with_text else '')
    query = ' '.join(f'f{i}:fileByUri(uri:$u{i}){{{fields}}}' for i in range(len(uris)))
    data = json.dumps({'query': f'query({args}){{{query}}}', 'variables': variables}).encode()
    req = request.Request(MIRROR, data, {'Content-Type': 'application/json', 'User-Agent': 'Unfallwerkbank-RIS/1.0'})
    try:
        with request.build_opener(NoRedirect()).open(req, timeout=45) as response:
            raw = response.read(room)
            if len(raw) >= room:
                raise RuntimeError('Mirror response reached the byte budget; use a smaller batch')
        with db:
            db.execute('UPDATE requests SET charged=? WHERE rowid=?', (len(raw), seq))
    except error.HTTPError as exc:
        if exc.code in (403, 429, 503):
            value = exc.headers.get('Retry-After', '')
            until = time.time() + 86400
            if value.isdigit():
                until = max(until, time.time() + int(value))
            elif value:
                try:
                    until = max(until, parsedate_to_datetime(value).timestamp())
                except (TypeError, ValueError, OverflowError):
                    pass
            with db:
                db.execute('INSERT OR REPLACE INTO backoff VALUES (1,?)', (until,))
        raise
    payload = json.loads(raw)
    if not isinstance(payload, dict) or payload.get('errors') or not isinstance(payload.get('data'), dict):
        raise ValueError('GraphQL error; text not accepted')
    return payload['data']


def atomic_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with tempfile.NamedTemporaryFile('w', dir=path.parent, delete=False, encoding='utf-8') as f:
        try:
            json.dump(data, f, ensure_ascii=False)
            f.close()
            os.replace(f.name, path)
        finally:
            Path(f.name).unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    prep = sub.add_parser('prepare', help='build the complete deterministic queue offline')
    for key in ('manifest', 'ratsatlas_zip', 'queue'):
        prep.add_argument(key, type=Path)
    read = sub.add_parser('read', help='export a private offline reading batch')
    for key in ('queue', 'database', 'output'):
        read.add_argument(key, type=Path)
    read.add_argument('--offset', type=int, default=0, help='zero-based position in the pinned queue')
    read.add_argument('--size', type=int, default=100)
    read.add_argument('--fetch', action='store_true', help='fill missing texts from the mirror')
    read.add_argument('--refresh', action='store_true', help='also check cached mirror versions')
    args = parser.parse_args()
    if args.command == 'prepare':
        q = prepare(args.manifest, args.ratsatlas_zip)
        atomic_json(args.queue, q)
        print(f"{len(q['papers'])} papers, {sum(bool(p['methods']) for p in q['papers'])} candidates")
        return
    if not 1 <= args.size <= 1000 or args.offset < 0 or (args.refresh and not args.fetch):
        parser.error('Invalid range or refresh without --fetch')
    q = json.loads(args.queue.read_bytes())
    rows = q['papers'][args.offset:args.offset + args.size]
    db = open_cache(args.database)
    failure = False
    try:
        if args.fetch:
            try:
                with exclusive_fetch(args.database):
                    sync(db, rows, lambda uris, text: mirror(db, uris, text), args.refresh)
            except (OSError, HTTPException, RuntimeError, ValueError, sqlite3.OperationalError) as exc:
                print(f'Mirror fetch stopped: {exc}', file=sys.stderr)
                failure = True
        result = [read_row(db, p) for p in rows]
        atomic_json(args.output, {'catalogueGeneration': q['catalogueGeneration'], 'exportSha256': q['exportSha256'],
                                  'offset': args.offset, 'papers': result})
        print(f"{len(rows)} papers, {sum(p['status'] == 'text_available' for p in result)} with text")
    finally:
        db.close()
    return int(failure)


if __name__ == '__main__':
    sys.exit(main())
