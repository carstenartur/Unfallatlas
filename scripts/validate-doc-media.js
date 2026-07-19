#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const MEDIA_EXTENSIONS = new Set(['.png', '.apng', '.gif', '.jpg', '.jpeg', '.webp', '.mp4']);
const ALLOWED_FORMATS = Object.freeze({
  screenshot: new Set(['png', 'jpeg', 'webp']),
  'document-preview': new Set(['png', 'jpeg', 'webp']),
  animation: new Set(['gif', 'webp', 'apng']),
});
const IGNORED_DIRECTORIES = new Set([
  '.git', '.build', '_site', 'coverage', 'node_modules', 'playwright-report', 'test-results',
]);
const IGNORED_DIRECTORY_PREFIXES = Object.freeze(['_site.tmp-']);

function parseArgs(argv) {
  const args = { manifest: 'docs/media-manifest.json', report: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--manifest') args.manifest = argv[++i] || args.manifest;
    else if (argv[i] === '--report') args.report = argv[++i] || null;
    else throw new Error(`[validate-doc-media] Unknown argument: ${argv[i]}`);
  }
  return args;
}

function listFiles(directory, predicate, options = {}) {
  const files = [];
  const walk = current => {
    if (!fs.existsSync(current)) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const ignoredDirectories = options.ignoreDirectories || IGNORED_DIRECTORIES;
      if (entry.isDirectory() && (
        ignoredDirectories.has(entry.name) ||
        (ignoredDirectories === IGNORED_DIRECTORIES && IGNORED_DIRECTORY_PREFIXES.some(prefix => entry.name.startsWith(prefix)))
      )) continue;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile() && (!predicate || predicate(absolute))) files.push(absolute);
    }
  };
  walk(directory);
  return files;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function inspectPng(buffer, file, extension) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(signature)) throw new Error(`invalid PNG signature: ${file}`);
  let offset = 8;
  let ihdr = null;
  let hasIend = false;
  let hasAnimation = false;
  const idat = [];
  while (offset < buffer.length) {
    if (offset + 12 > buffer.length) throw new Error(`truncated PNG chunk header: ${file}`);
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
    const end = offset + 12 + length;
    if (end > buffer.length) throw new Error(`truncated PNG ${type} chunk: ${file}`);
    const typeAndData = buffer.subarray(offset + 4, offset + 8 + length);
    const expectedCrc = buffer.readUInt32BE(offset + 8 + length);
    if (crc32(typeAndData) !== expectedCrc) throw new Error(`invalid PNG ${type} CRC: ${file}`);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      if (ihdr || length !== 13 || offset !== 8) throw new Error(`invalid PNG IHDR: ${file}`);
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        compression: data[10],
        filter: data[11],
        interlace: data[12],
      };
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'acTL') hasAnimation = true;
    else if (type === 'IEND') {
      if (length !== 0) throw new Error(`invalid PNG IEND: ${file}`);
      hasIend = true;
      offset = end;
      break;
    }
    offset = end;
  }
  if (!ihdr || !ihdr.width || !ihdr.height || !hasIend || offset !== buffer.length || idat.length === 0) {
    throw new Error(`incomplete PNG structure: ${file}`);
  }
  if (ihdr.compression !== 0 || ihdr.filter !== 0 || ![0, 1].includes(ihdr.interlace)) {
    throw new Error(`unsupported PNG encoding flags: ${file}`);
  }
  let inflated;
  try { inflated = zlib.inflateSync(Buffer.concat(idat)); }
  catch (error) { throw new Error(`PNG pixel stream cannot be decoded (${file}): ${error.message}`); }
  if (!inflated.length) throw new Error(`empty PNG pixel stream: ${file}`);
  if (ihdr.interlace === 0) {
    const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ihdr.colorType];
    if (!channels || ![1, 2, 4, 8, 16].includes(ihdr.bitDepth)) throw new Error(`unsupported PNG color format: ${file}`);
    const scanline = 1 + Math.ceil((ihdr.width * channels * ihdr.bitDepth) / 8);
    if (inflated.length !== scanline * ihdr.height) throw new Error(`invalid PNG pixel stream length: ${file}`);
  }
  if (extension === '.apng' && !hasAnimation) throw new Error(`APNG animation chunk is missing: ${file}`);
  return { width: ihdr.width, height: ihdr.height, format: hasAnimation ? 'apng' : 'png', animated: hasAnimation };
}

function inspectGif(buffer, file) {
  const signature = buffer.subarray(0, 6).toString('ascii');
  if (!['GIF87a', 'GIF89a'].includes(signature) || buffer.length < 14) throw new Error(`invalid GIF signature: ${file}`);
  const width = buffer.readUInt16LE(6);
  const height = buffer.readUInt16LE(8);
  if (!width || !height) throw new Error(`invalid GIF dimensions: ${file}`);
  const skipSubBlocks = start => {
    let offset = start;
    while (offset < buffer.length) {
      const size = buffer[offset++];
      if (size === 0) return offset;
      if (offset + size > buffer.length) throw new Error(`truncated GIF data block: ${file}`);
      offset += size;
    }
    throw new Error(`unterminated GIF data block: ${file}`);
  };
  let offset = 13;
  const globalColorTable = !!(buffer[10] & 0x80);
  if (globalColorTable) offset += 3 * (2 ** ((buffer[10] & 0x07) + 1));
  let frames = 0;
  let trailer = false;
  while (offset < buffer.length) {
    const introducer = buffer[offset];
    if (introducer === 0x3b) {
      trailer = true;
      offset += 1;
      break;
    }
    if (introducer === 0x21) {
      if (offset + 2 >= buffer.length) throw new Error(`truncated GIF extension: ${file}`);
      offset = skipSubBlocks(offset + 2);
      continue;
    }
    if (introducer === 0x2c) {
      if (offset + 10 > buffer.length) throw new Error(`truncated GIF image descriptor: ${file}`);
      const packed = buffer[offset + 9];
      offset += 10;
      if (packed & 0x80) offset += 3 * (2 ** ((packed & 0x07) + 1));
      if (offset >= buffer.length) throw new Error(`GIF image data is missing: ${file}`);
      const lzwMinimumCodeSize = buffer[offset++];
      if (lzwMinimumCodeSize < 2 || lzwMinimumCodeSize > 8) throw new Error(`invalid GIF LZW code size: ${file}`);
      offset = skipSubBlocks(offset);
      frames += 1;
      continue;
    }
    throw new Error(`invalid GIF block introducer 0x${introducer.toString(16)}: ${file}`);
  }
  if (!trailer || offset !== buffer.length || frames === 0) throw new Error(`incomplete GIF structure: ${file}`);
  return { width, height, format: 'gif', animated: frames > 1 };
}

function inspectJpeg(buffer, file) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8 || buffer.at(-2) !== 0xff || buffer.at(-1) !== 0xd9) {
    throw new Error(`invalid JPEG structure: ${file}`);
  }
  const sofMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset + 4 <= buffer.length - 2) {
    if (buffer[offset] !== 0xff) { offset += 1; continue; }
    while (buffer[offset] === 0xff) offset += 1;
    const marker = buffer[offset++];
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > buffer.length) break;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) throw new Error(`truncated JPEG segment: ${file}`);
    if (sofMarkers.has(marker)) {
      const height = buffer.readUInt16BE(offset + 3);
      const width = buffer.readUInt16BE(offset + 5);
      if (!width || !height) throw new Error(`invalid JPEG dimensions: ${file}`);
      return { width, height, format: 'jpeg', animated: false };
    }
    offset += length;
  }
  throw new Error(`JPEG size frame is missing: ${file}`);
}

function inspectWebp(buffer, file) {
  if (buffer.length < 20 || buffer.subarray(0, 4).toString('ascii') !== 'RIFF' || buffer.subarray(8, 12).toString('ascii') !== 'WEBP') {
    throw new Error(`invalid WebP signature: ${file}`);
  }
  if (buffer.readUInt32LE(4) + 8 !== buffer.length) throw new Error(`invalid WebP RIFF length: ${file}`);
  let offset = 12;
  let dimensions = null;
  let animated = false;
  while (offset + 8 <= buffer.length) {
    const type = buffer.subarray(offset, offset + 4).toString('ascii');
    const length = buffer.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const end = dataStart + length;
    if (end > buffer.length) throw new Error(`truncated WebP ${type} chunk: ${file}`);
    const data = buffer.subarray(dataStart, end);
    if (type === 'VP8X' && length >= 10) {
      dimensions = { width: 1 + data.readUIntLE(4, 3), height: 1 + data.readUIntLE(7, 3) };
      animated = !!(data[0] & 0x02);
    } else if (type === 'VP8 ' && length >= 10 && data[3] === 0x9d && data[4] === 0x01 && data[5] === 0x2a) {
      dimensions = { width: data.readUInt16LE(6) & 0x3fff, height: data.readUInt16LE(8) & 0x3fff };
    } else if (type === 'VP8L' && length >= 5 && data[0] === 0x2f) {
      const bits = data.readUInt32LE(1);
      dimensions = { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
    } else if (type === 'ANIM' || type === 'ANMF') animated = true;
    offset = end + (length % 2);
  }
  if (offset !== buffer.length || !dimensions || !dimensions.width || !dimensions.height) {
    throw new Error(`incomplete WebP structure: ${file}`);
  }
  return { ...dimensions, format: 'webp', animated };
}

function inspectMedia(file) {
  const buffer = fs.readFileSync(file);
  const extension = path.extname(file).toLowerCase();
  let result;
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    result = inspectPng(buffer, file, extension);
  } else if (['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'))) result = inspectGif(buffer, file);
  else if (buffer[0] === 0xff && buffer[1] === 0xd8) result = inspectJpeg(buffer, file);
  else if (buffer.subarray(0, 4).toString('ascii') === 'RIFF') result = inspectWebp(buffer, file);
  else throw new Error(`unsupported or invalid media format: ${file}`);
  const expected = extension === '.jpg' ? 'jpeg' : extension.slice(1);
  if (result.format !== expected) throw new Error(`file extension ${extension} does not match ${result.format} content: ${file}`);
  return result;
}

function dimensions(file) {
  const { width, height } = inspectMedia(file);
  return { width, height };
}

function sameDimensions(actual, expected) {
  return actual && expected && actual.width === Number(expected.width) && actual.height === Number(expected.height);
}

function repositoryMarkdownFiles(repoRoot) {
  return listFiles(repoRoot, file => path.extname(file).toLowerCase() === '.md');
}

function markdownMediaReferences(repoRoot) {
  const references = [];
  const seen = new Set();
  const add = (markdownFile, rawTarget) => {
    const target = String(rawTarget || '').replace(/^<|>$/g, '').split('#')[0].split('?')[0];
    if (!target || /^(?:https?:|data:|mailto:|tel:)/i.test(target)) return;
    if (!MEDIA_EXTENSIONS.has(path.extname(target).toLowerCase())) return;
    const absolute = path.resolve(path.dirname(markdownFile), target);
    const row = {
      source: path.relative(repoRoot, markdownFile).replace(/\\/g, '/'),
      target: path.relative(repoRoot, absolute).replace(/\\/g, '/'),
    };
    const key = `${row.source}\0${row.target}`;
    if (!seen.has(key)) { seen.add(key); references.push(row); }
  };
  for (const markdownFile of repositoryMarkdownFiles(repoRoot)) {
    const source = fs.readFileSync(markdownFile, 'utf8');
    for (const pattern of [
      /!?\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)/g,
      /^\s*\[[^\]]+\]:\s*(\S+)/gm,
    ]) {
      let match;
      while ((match = pattern.exec(source))) add(markdownFile, match[1]);
    }
    const htmlPattern = /<(?:img|source|video)\b[^>]*\b(?:src|poster)\s*=\s*(['"])([^'"]+)\1/gi;
    let htmlMatch;
    while ((htmlMatch = htmlPattern.exec(source))) add(markdownFile, htmlMatch[2]);
  }
  return references.sort((a, b) => `${a.source}\0${a.target}`.localeCompare(`${b.source}\0${b.target}`));
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function ensureInsideRoot(repoRoot, target, label) {
  const relative = path.relative(repoRoot, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`${label} escapes repository root`);
  if (fs.existsSync(target)) {
    const realRelative = path.relative(fs.realpathSync(repoRoot), fs.realpathSync(target));
    if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) throw new Error(`${label} resolves outside repository root`);
  }
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function resolveRevision(repoRoot) {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch (_) { return null; }
}

function failureReport(repoRoot, manifestPath, error, options = {}) {
  let manifestSha256 = null;
  if (options.inspectManifest !== false) {
    try {
      if (fs.existsSync(manifestPath) && fs.statSync(manifestPath).isFile()) manifestSha256 = sha256(manifestPath);
    } catch (_) { /* retain null provenance for an unreadable manifest */ }
  }
  return {
    schemaVersion: 2,
    valid: false,
    revision: resolveRevision(repoRoot),
    manifest: {
      path: path.relative(repoRoot, manifestPath).replace(/\\/g, '/'),
      sha256: manifestSha256,
    },
    build: null,
    assets: [],
    totals: { assets: 0, bytes: 0, budget: null },
    errors: [String(error && error.message ? error.message : error)],
  };
}

function validate(options = {}) {
  const repoRoot = path.resolve(options.root || ROOT);
  const manifestPath = path.resolve(repoRoot, options.manifest || 'docs/media-manifest.json');
  const errors = [];
  try { ensureInsideRoot(repoRoot, manifestPath, 'manifest path'); }
  catch (error) {
    // An escaping path is untrusted. Do not even probe it for existence: a
    // fail-closed validation error must never become an external filesystem
    // oracle or trigger stat/read/hash work outside the repository.
    return failureReport(repoRoot, manifestPath, error, { inspectManifest: false });
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    return failureReport(repoRoot, manifestPath, new Error(`cannot read media manifest: ${error.message}`));
  }
  const defaultMaxBytes = Number(manifest.defaults && manifest.defaults.maxBytes);
  const maxTotalBytes = Number(manifest.defaults && manifest.defaults.maxTotalBytes);
  const exceptionPolicy = manifest.defaults && manifest.defaults.exceptionPolicy;
  const rows = [];
  const entries = new Map();

  if (manifest.schemaVersion !== 1) errors.push('manifest.schemaVersion must equal 1');
  if (!isPositiveInteger(defaultMaxBytes)) errors.push('manifest.defaults.maxBytes must be a positive integer');
  if (!isPositiveInteger(maxTotalBytes)) errors.push('manifest.defaults.maxTotalBytes must be a positive integer');
  if (!Array.isArray(manifest.assets) || manifest.assets.length === 0) errors.push('manifest.assets must be a non-empty array');

  for (const asset of Array.isArray(manifest.assets) ? manifest.assets : []) {
    const violations = [];
    const row = { path: asset && asset.path || null, kind: asset && asset.kind || null, violations };
    if (!asset || !asset.path || entries.has(asset.path)) {
      violations.push(`missing or duplicate asset path: ${asset && asset.path || '(empty)'}`);
      errors.push(...violations);
      row.status = 'error';
      rows.push(row);
      continue;
    }
    entries.set(asset.path, asset);
    const allowedFormats = ALLOWED_FORMATS[asset.kind];
    if (!allowedFormats) violations.push(`${asset.path}: unsupported kind ${asset.kind || '(empty)'}`);
    if (!asset.purpose || typeof asset.purpose !== 'string') violations.push(`${asset.path}: purpose is required`);
    if (!Array.isArray(asset.references) || asset.references.length === 0) violations.push(`${asset.path}: at least one reference is required`);
    if (!asset.target || !isPositiveInteger(asset.target.width) || !isPositiveInteger(asset.target.height)) {
      violations.push(`${asset.path}: target width and height must be positive integers`);
    }
    if (asset.maxBytes !== undefined && !isPositiveInteger(asset.maxBytes)) violations.push(`${asset.path}: maxBytes must be a positive integer`);
    if (asset.acceptedLegacy !== undefined && (!Array.isArray(asset.acceptedLegacy) || asset.acceptedLegacy.some(size => !size || !isPositiveInteger(size.width) || !isPositiveInteger(size.height)))) {
      violations.push(`${asset.path}: acceptedLegacy must contain positive integer dimensions`);
    }

    const absolute = path.resolve(repoRoot, asset.path);
    let assetPathSafe = true;
    try { ensureInsideRoot(repoRoot, absolute, `${asset.path}: asset path`); }
    catch (error) {
      violations.push(error.message);
      assetPathSafe = false;
    }
    if (assetPathSafe && (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile())) {
      violations.push(`${asset.path}: file is missing or not a regular file`);
    }

    for (const reference of Array.isArray(asset.references) ? asset.references : []) {
      const referencePath = path.resolve(repoRoot, reference);
      try { ensureInsideRoot(repoRoot, referencePath, `${asset.path}: reference ${reference}`); }
      catch (error) { violations.push(error.message); continue; }
      if (!fs.existsSync(referencePath) || !fs.statSync(referencePath).isFile()) {
        violations.push(`${asset.path}: declared reference is missing: ${reference}`);
        continue;
      }
      const source = fs.readFileSync(referencePath, 'utf8');
      if (!source.includes(asset.path) && !source.includes(path.basename(asset.path))) {
        violations.push(`${asset.path}: declared reference does not mention asset: ${reference}`);
      }
    }

    let inspected = null;
    let targetMatch = false;
    let legacyMatch = false;
    let bytes = null;
    if (assetPathSafe && fs.existsSync(absolute) && fs.statSync(absolute).isFile()) {
      try {
        inspected = inspectMedia(absolute);
        if (allowedFormats && !allowedFormats.has(inspected.format)) {
          violations.push(`${asset.path}: ${inspected.format} is not allowed for kind ${asset.kind}`);
        }
        if (asset.kind === 'animation' && inspected.animated !== true) {
          violations.push(`${asset.path}: animation asset contains fewer than two frames`);
        }
        targetMatch = sameDimensions(inspected, asset.target);
        legacyMatch = (Array.isArray(asset.acceptedLegacy) ? asset.acceptedLegacy : []).some(expected => sameDimensions(inspected, expected));
        if (!targetMatch && !legacyMatch) {
          violations.push(`${asset.path}: ${inspected.width}x${inspected.height} does not match target ${asset.target && asset.target.width}x${asset.target && asset.target.height} or an accepted legacy size`);
        }
      } catch (error) { violations.push(error.message); }
      bytes = fs.statSync(absolute).size;
    }

    const requestedBudget = asset.maxBytes === undefined ? defaultMaxBytes : Number(asset.maxBytes);
    const budget = asset.kind === 'screenshot' && targetMatch ? defaultMaxBytes : requestedBudget;
    if (!isPositiveInteger(budget)) violations.push(`${asset.path}: effective budget must be a positive integer`);
    else if (bytes !== null && bytes > budget) violations.push(`${asset.path}: ${bytes} bytes exceeds budget ${budget}`);
    const needsException = legacyMatch || (isPositiveInteger(requestedBudget) && requestedBudget > defaultMaxBytes);
    if (needsException) {
      if (typeof asset.exception !== 'string' || asset.exception.trim().length < 20) violations.push(`${asset.path}: legacy or above-default policy requires a substantive exception rationale`);
      const expiresOn = exceptionPolicy && exceptionPolicy.expiresOn;
      const expiry = typeof expiresOn === 'string' ? Date.parse(`${expiresOn}T23:59:59Z`) : NaN;
      if (!exceptionPolicy || !Number.isInteger(exceptionPolicy.trackingIssue) || !Number.isFinite(expiry) || expiry < Date.now()) {
        violations.push(`${asset.path}: exception policy requires a tracking issue and a non-expired expiresOn date`);
      }
    }

    Object.assign(row, {
      bytes,
      budget: isPositiveInteger(budget) ? budget : null,
      sha256: bytes === null ? null : sha256(absolute),
      dimensions: inspected ? { width: inspected.width, height: inspected.height } : null,
      format: inspected && inspected.format,
      animated: inspected && inspected.animated,
      target: asset.target || null,
      status: violations.length ? 'error' : (needsException ? 'legacy-exception' : 'valid'),
    });
    errors.push(...violations);
    rows.push(row);
  }

  const committedMedia = listFiles(path.join(repoRoot, 'docs'), file => MEDIA_EXTENSIONS.has(path.extname(file).toLowerCase()), { ignoreDirectories: new Set() })
    .map(file => path.relative(repoRoot, file).replace(/\\/g, '/'));
  for (const mediaPath of committedMedia) if (!entries.has(mediaPath)) errors.push(`${mediaPath}: committed media is not declared in the manifest`);

  for (const reference of markdownMediaReferences(repoRoot)) {
    const absolute = path.resolve(repoRoot, reference.target);
    try { ensureInsideRoot(repoRoot, absolute, `${reference.source}: media reference ${reference.target}`); }
    catch (error) { errors.push(error.message); continue; }
    if (!fs.existsSync(absolute)) errors.push(`${reference.source}: broken media reference ${reference.target}`);
    else {
      const asset = entries.get(reference.target);
      if (!asset) errors.push(`${reference.source}: referenced media is not declared: ${reference.target}`);
      else if (!(asset.references || []).includes(reference.source)) errors.push(`${reference.target}: manifest does not list Markdown consumer ${reference.source}`);
    }
  }

  const duplicateHashes = new Map();
  for (const row of rows.filter(entry => entry.sha256)) {
    if (!duplicateHashes.has(row.sha256)) duplicateHashes.set(row.sha256, []);
    duplicateHashes.get(row.sha256).push(row.path);
  }
  for (const [hash, paths] of duplicateHashes) {
    if (paths.length > 1) errors.push(`duplicate media bytes (${hash}): ${paths.join(', ')}`);
  }

  const totalBytes = rows.reduce((sum, row) => sum + (Number(row.bytes) || 0), 0);
  if (isPositiveInteger(maxTotalBytes) && totalBytes > maxTotalBytes) errors.push(`documentation media total ${totalBytes} bytes exceeds budget ${maxTotalBytes}`);
  const buildManifestPath = path.join(repoRoot, '_site', 'build-manifest.json');
  let build = null;
  if (fs.existsSync(buildManifestPath)) {
    try {
      const built = JSON.parse(fs.readFileSync(buildManifestPath, 'utf8'));
      build = { sha256: sha256(buildManifestPath), fingerprint: built.fingerprint || null, dataFingerprint: built.data && built.data.fingerprint || null };
    } catch (_) { /* build provenance is optional outside the canonical build workflow */ }
  }
  return {
    schemaVersion: 2,
    valid: errors.length === 0,
    revision: resolveRevision(repoRoot),
    manifest: { path: path.relative(repoRoot, manifestPath).replace(/\\/g, '/'), sha256: sha256(manifestPath) },
    build,
    assets: rows,
    totals: { assets: rows.length, bytes: totalBytes, budget: isPositiveInteger(maxTotalBytes) ? maxTotalBytes : null },
    errors,
  };
}

function main(argv) {
  const args = parseArgs(argv);
  const report = validate(args);
  for (const row of report.assets) {
    const prefix = row.status === 'valid' ? 'OK' : (row.status === 'legacy-exception' ? 'EXCEPTION' : 'ERROR');
    const dimensionsText = row.dimensions ? `${row.dimensions.width}x${row.dimensions.height}` : 'unknown';
    process.stdout.write(`${prefix}\t${row.path}\t${dimensionsText}\t${row.bytes ?? '? '}/${row.budget ?? '?'} bytes\n`);
  }
  process.stdout.write(`[validate-doc-media] ${report.totals.assets} assets, ${report.totals.bytes} bytes\n`);
  if (args.report) {
    const reportPath = path.resolve(ROOT, args.report);
    ensureInsideRoot(ROOT, reportPath, 'report path');
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    const temporaryPath = path.join(
      path.dirname(reportPath),
      `.${path.basename(reportPath)}.${process.pid}.${Date.now()}.tmp`
    );
    try {
      fs.writeFileSync(temporaryPath, `${JSON.stringify(report, null, 2)}\n`);
      fs.renameSync(temporaryPath, reportPath);
    } finally {
      if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    }
  }
  if (!report.valid) {
    for (const error of report.errors) process.stderr.write(`ERROR\t${error}\n`);
    process.exitCode = 1;
  }
  return report;
}

if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (error) {
    process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
    process.exitCode = 1;
  }
}

module.exports = { dimensions, inspectMedia, markdownMediaReferences, parseArgs, validate };
