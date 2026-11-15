"""Exercises the offline producer and its fixed mirror contract without any network."""
import gzip
import hashlib
import json
import subprocess
import sys
import tempfile
import time
import unittest
import zipfile
from contextlib import closing
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'scripts'))
import bonn_reading_queue as batch

PAPER = 'https://www.bonn.sitzung-online.de/oparl/papers/12'
FILE = 'https://www.bonn.sitzung-online.de/oparl/files/84'
VERSION = 'a' * 64
ROW = {'id': PAPER, 'reference': '211002', 'file': FILE, 'title': 'Querung'}
TEXT = 'Öffentliche Entscheidung zur Querung.'
RESULT = {'uri': FILE, 'textSha256': VERSION, 'text': TEXT, 'papers': [{'uri': PAPER}]}


def published_manifest(directory):
    entries = []
    for number, status in [(11, 'mapped'), (12, 'unresolved'), (13, 'unavailable'), (10, 'unresolved')]:
        pid = f'{batch.ORIGIN}/oparl/papers/{number}'
        entries.append([pid, {'id': pid, 'number': f'DS-{number}', 'title': f'Vorlage {number}',
                              'locationAssessment': {'status': status}}])
    raw = json.dumps({'type': 'leaf', 'entries': entries}).encode()
    digest = hashlib.sha256(raw).hexdigest()
    name = f'bonn.{digest}.records.json.gz'
    (directory / name).write_bytes(gzip.compress(raw))
    reference = {'kind': 'records', 'sha256': digest, 'path': name, 'bytes': len(raw), 'count': 4}
    manifest = directory / 'manifest.json'
    manifest.write_text(json.dumps({'city': 'bonn', 'generation': 'fixture-generation', 'recordCount': 4,
                                    'mappedRecordCount': 1, 'roots': {'records': reference}}))
    return manifest


def ratsatlas_zip(directory):
    def entry(paper, doc, reference=None):
        return {'source_object': f'{batch.ORIGIN}/oparl/papers/{paper}',
                'reference': reference or f'DS-{paper}',
                'main_file': f'{batch.ORIGIN}/public/doc?DOCTYP=130&DOLFDNR={doc}&OTYP=41'}

    path = directory / 'ratsatlas.zip'
    with zipfile.ZipFile(path, 'w') as archive:
        rows = [('DS-12', 12, 'volltext_strasse'), ('FALSCH', 10, 'volltext_strasse'),
                ('DS-13', 13, 'ortsteil'), ('DS-11', 11, 'volltext_strasse')]
        audit = 'drucksache\tquellobjekt\tmethode\n'
        for reference, paper, method in rows:
            audit += f'{reference}\t{batch.ORIGIN}/oparl/papers/{paper}\t{method}\n'
        archive.writestr('allris-bonn/audit_geokodierung_bonn.tsv', audit)
        archive.writestr('allris-bonn/bonn/bezirke/Bonn.json', json.dumps({
            'papers': [entry(12, 84), entry(13, 100), entry(10, 200, 'FALSCH'), entry(11, 54)],
        }))
        archive.writestr('allris-bonn/bonn/ortsteile/Ortsteil.json', json.dumps({
            'papers': [entry(12, 84), entry(13, 101)],
        }))
    return path


class OfflineReadingTest(unittest.TestCase):
    def test_prepare_joins_both_ids_and_preserves_ambiguous_papers(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            manifest = published_manifest(directory)
            archive = ratsatlas_zip(directory)
            queue = batch.prepare(manifest, archive)
            self.assertEqual(queue['catalogueGeneration'], 'fixture-generation')
            self.assertEqual(queue['exportSha256'], hashlib.sha256(archive.read_bytes()).hexdigest())
            self.assertEqual([(p['reference'], p['file'], p['methods']) for p in queue['papers']], [
                ('DS-12', FILE, ['volltext_strasse']), ('DS-10', None, []), ('DS-13', None, []),
            ])
            self.assertEqual(batch.prepare(manifest, archive), queue)
            partition = next(directory.glob('bonn.*.records.json.gz'))
            partition.write_bytes(gzip.compress(b'{}'))
            with self.assertRaises(ValueError):
                batch.prepare(manifest, archive)

    def test_default_read_slices_the_local_queue_without_network(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            queue = directory / 'queue.json'
            database = directory / 'reading.db'
            output = directory / 'reading.json'
            rows = [{**ROW, 'file': None}, ROW, {**ROW, 'id': PAPER + '0', 'file': FILE + '0'}]
            queue.write_text(json.dumps({'catalogueGeneration': VERSION, 'exportSha256': VERSION, 'papers': rows}))
            with closing(batch.open_cache(database)) as db:
                batch.sync(db, [ROW], Mock(return_value={'f0': RESULT}))
            argv = ['bonn_reading_queue.py', 'read', str(queue), str(database), str(output), '--offset', '1']
            with patch.object(sys, 'argv', argv), patch.object(batch.request, 'build_opener') as opener:
                batch.main()
                opener.assert_not_called()
            result = json.loads(output.read_bytes())
            self.assertEqual(result['offset'], 1)
            self.assertEqual(result['catalogueGeneration'], VERSION)
            self.assertEqual([(p['id'], p['status']) for p in result['papers']], [
                (PAPER, 'text_available'), (PAPER + '0', 'not_cached'),
            ])

    def test_budget_counts_requests_and_received_bytes_across_cache_reopens(self):
        for reservations in ([1] * batch.MAX_REQUESTS, [batch.DAILY_BYTES]):
            with self.subTest(reservations=reservations), tempfile.TemporaryDirectory() as tmp:
                database = Path(tmp) / 'cache.db'
                with closing(batch.open_cache(database)) as db, db:
                    db.executemany('INSERT INTO requests VALUES (?,?)', [(time.time(), n) for n in reservations])
                with closing(batch.open_cache(database)) as db, patch.object(batch.request, 'build_opener') as opener:
                    with self.assertRaises(RuntimeError):
                        batch.mirror(db, [FILE], True)
                    opener.assert_not_called()

    def test_cli_exports_cached_rows_even_when_the_fetch_budget_is_exhausted(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            database = directory / 'cache.db'
            queue = directory / 'queue.json'
            output = directory / 'result.json'
            rows = [ROW, {**ROW, 'id': PAPER + '0', 'file': FILE + '0'}]
            queue.write_text(json.dumps({'catalogueGeneration': VERSION, 'exportSha256': VERSION, 'papers': rows}))
            with closing(batch.open_cache(database)) as db, db:
                batch.sync(db, [ROW], Mock(return_value={'f0': RESULT}))
                db.execute('INSERT INTO requests VALUES (?,?)', (time.time(), batch.DAILY_BYTES))
            # The socket audit hook also makes a regression in the budget check harmless to the server.
            launcher = (
                "import runpy, sys\n"
                "def offline(event, args):\n"
                "    if event.startswith('socket.'): raise AssertionError('unexpected network access')\n"
                "sys.addaudithook(offline)\n"
                "sys.argv = sys.argv[1:]\n"
                "runpy.run_path(sys.argv[0], run_name='__main__')\n"
            )
            result = subprocess.run([sys.executable, '-B', '-c', launcher, str(Path(batch.__file__)),
                                     'read', str(queue), str(database), str(output), '--fetch'],
                                    cwd=Path(batch.__file__).parent, capture_output=True, timeout=5)
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn('unexpected network access', result.stderr.decode())
            self.assertTrue(output.is_file(), result.stderr.decode())
            self.assertEqual([p['status'] for p in json.loads(output.read_bytes())['papers']],
                             ['text_available', 'not_cached'])

    def test_missing_text_is_cached_as_unresolved(self):
        with tempfile.TemporaryDirectory() as tmp, closing(batch.open_cache(Path(tmp) / 'cache.db')) as db:
            remote = Mock(return_value={'f0': {**RESULT, 'text': None}})
            batch.sync(db, [ROW], remote)
            self.assertNotIn('text', batch.read_row(db, ROW))
            batch.sync(db, [ROW], remote)
            self.assertEqual(remote.call_count, 1)

    def test_bind_to_original_and_dedupe_by_version(self):
        with tempfile.TemporaryDirectory() as tmp, closing(batch.open_cache(Path(tmp) / 'cache.db')) as db:
            remote = Mock(return_value={'f0': RESULT})
            batch.sync(db, [ROW, ROW], remote)
            self.assertEqual(remote.call_count, 1)
            batch.sync(db, [ROW], remote)
            self.assertEqual(remote.call_count, 1)
            remote.return_value = {'f0': {k: v for k, v in RESULT.items() if k != 'text'}}
            batch.sync(db, [ROW], remote, refresh=True)
            self.assertEqual(remote.call_count, 2)
            self.assertFalse(remote.call_args.args[1])
            reading = batch.read_row(db, ROW)
            self.assertEqual(reading['text'], TEXT)
            self.assertEqual(reading['status'], 'text_available')
            self.assertEqual(reading['textSha256'], hashlib.sha256(TEXT.encode()).hexdigest())
            self.assertNotIn('text', batch.read_row(db, {**ROW, 'id': PAPER + '3'}))

    def test_changed_and_missing_files_do_not_reuse_an_old_version(self):
        with tempfile.TemporaryDirectory() as tmp, closing(batch.open_cache(Path(tmp) / 'cache.db')) as db:
            batch.sync(db, [ROW], Mock(return_value={'f0': RESULT}))
            new = {**RESULT, 'textSha256': 'b' * 64}
            remote = Mock(side_effect=[{'f0': new}, RuntimeError('interrupted')])
            with self.assertRaises(RuntimeError):
                batch.sync(db, [ROW], remote, refresh=True)
            self.assertNotIn('text', batch.read_row(db, ROW))
            batch.sync(db, [ROW], Mock(return_value={'f0': None}))
            self.assertNotIn('text', batch.read_row(db, ROW))

    def test_only_official_export_links(self):
        href = 'https://www.bonn.sitzung-online.de/public/doc?DOCTYP=130&DOLFDNR=84&OTYP=41'
        self.assertEqual(batch.file_uri(href), FILE)
        for other in (href.replace('130', '9'), href + '&DOLFDNR=12', href.replace('www.bonn', 'other')):
            self.assertIsNone(batch.file_uri(other))


if __name__ == '__main__':
    unittest.main()
