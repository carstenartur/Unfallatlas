'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

function git(root, args, input) {
  const result = spawnSync('git', args, { cwd: root, input, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024,
    env: { ...process.env, GIT_NO_LAZY_FETCH: '1' } });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git ${args[0]}: ${result.stderr.trim()}`);
  return result.stdout;
}

function category(name) {
  if (/^unfallatlas-website-.*\.zip$/.test(name)) return 'release-archive';
  if (/^(out\/qa|coverage|test-results|playwright-report|\.build)\//.test(name)) return 'ci-diagnostics';
  if (/^(qa\/|docs\/(?:release-evidence|storage-evidence)\/)/.test(name)) return 'durable-evidence';
  if (/^docs\/.*\.(?:png|gif|jpg|jpeg|webp|svg|mp4|webm|pdf)$/i.test(name)) return 'documentation-media';
  if (/^(raw\/|data\/raw\/|out\/raw\/)/.test(name) || /\.(?:hgt|tiff?|osm\.pbf)$/i.test(name)) return 'raw-input';
  if (name.startsWith('out/')) return 'published-static-data';
  return 'source-and-other';
}

function summary(blobs) {
  const groups = {}; const paths = new Map();
  for (const item of blobs) {
    const name = category(item.path);
    if (!groups[name]) groups[name] = { blobs: 0, bytes: 0 };
    groups[name].blobs++; groups[name].bytes += item.bytes;
    const prior = paths.get(item.path) || { path: item.path, versions: 0, bytes: 0, largestBytes: 0 };
    prior.versions++; prior.bytes += item.bytes; prior.largestBytes = Math.max(prior.largestBytes, item.bytes);
    paths.set(item.path, prior);
  }
  return { blobCount: blobs.length, uncompressedBytes: blobs.reduce((n, b) => n + b.bytes, 0), categories: groups,
    largest: blobs.slice().sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path)).slice(0, 40),
    repeatedPaths: [...paths.values()].filter(p => p.versions > 1).sort((a, b) => b.bytes - a.bytes).slice(0, 30) };
}

function inventory(root, head = 'refs/remotes/origin/main') {
  if (git(root, ['rev-parse', '--is-shallow-repository']).trim() !== 'false') throw new Error('Complete inventory requires non-shallow history');
  const headSha = git(root, ['rev-parse', '--verify', `${head}^{commit}`]).trim();
  const refs = git(root, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/remotes/origin/', 'refs/tags/'])
    .trim().split('\n').filter(Boolean).filter(row => !row.startsWith('refs/remotes/origin/HEAD '));
  if (!refs.some(row => row.startsWith('refs/remotes/origin/main '))) throw new Error('Fetch all origin heads and tags before inventory');
  const revisions = [...new Set(refs.map(row => row.split(' ')[1]))].join('\n') + '\n';
  const objects = git(root, ['rev-list', '--objects', '--missing=print', '--stdin'], revisions);
  if (objects.split('\n').some(row => row.startsWith('?'))) throw new Error('Missing promised objects: fetch without a blob filter before inventory');
  const metadata = git(root, ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize) %(rest)'], objects);
  const history = [];
  for (const row of metadata.split('\n').filter(Boolean)) {
    const m = /^([a-f0-9]+) (\w+) (\d+)(?: ([\s\S]*))?$/.exec(row);
    if (!m) throw new Error('Missing or invalid Git object metadata');
    if (m[2] === 'blob') history.push({ blob: m[1], bytes: Number(m[3]), path: m[4] || '(no path)' });
  }
  const current = git(root, ['ls-tree', '-rlz', headSha]).split('\0').filter(Boolean).map(row => {
    const m = /^\d+ blob ([a-f0-9]+)\s+(\d+)\t([\s\S]*)$/.exec(row);
    return m ? { blob: m[1], bytes: Number(m[2]), path: m[3] } : null;
  }).filter(Boolean);
  return { schemaVersion: 1, generatedAt: new Date().toISOString(), head: headSha,
    method: 'All blobs reachable from fetched origin branch and tag refs; unique object IDs; uncompressed Git blob bytes, not pack/disk/server usage. A shared blob is classified by the first path reported by rev-list. Deleted server refs and unreachable objects are outside this accessible inventory.',
    refs: { count: refs.length, sha256: crypto.createHash('sha256').update(refs.join('\n') + '\n').digest('hex'), values: refs },
    commits: Number(git(root, ['rev-list', '--count', '--stdin'], revisions).trim()),
    current: summary(current), history: summary(history) };
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== '--output') throw new Error('Usage: inventory-repository-storage.js --output PATH');
    const report = inventory(path.resolve(__dirname, '..'));
    const file = path.resolve(args[1]); fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ head: report.head, refs: report.refs.count, commits: report.commits,
      currentBytes: report.current.uncompressedBytes, historyBytes: report.history.uncompressedBytes,
      historicalBlobs: report.history.blobCount, largest: report.history.largest.slice(0, 8) }, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { inventory, category, summary };
