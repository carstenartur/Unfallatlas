'use strict';

const fs = require('fs');
const path = require('path');

function decodeRequestPath(urlPath) {
  const raw = String(urlPath || '/').split('?')[0];
  if (raw.includes('\0') || raw.includes('\\')) return null;
  let decoded;
  try { decoded = decodeURIComponent(raw); }
  catch (_) { return null; }
  const relative = decoded.replace(/^\/+/, '') || 'index.html';
  if (relative.split('/').some(segment => segment === '.' || segment === '..')) return null;
  return relative;
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return !relative || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveLexicalPath(siteRoot, urlPath) {
  const relative = decodeRequestPath(urlPath);
  if (!relative) return null;
  const root = path.resolve(siteRoot);
  const target = path.resolve(root, relative);
  return isInside(root, target) && target !== root ? target : null;
}

function isExistingPathConfined(siteRoot, target) {
  const root = path.resolve(siteRoot);
  const candidate = path.resolve(target);
  if (!isInside(root, candidate) || !fs.existsSync(candidate)) return false;
  if (!fs.existsSync(root)) return false;

  let cursor = root;
  if (fs.lstatSync(cursor).isSymbolicLink()) return false;
  for (const segment of path.relative(root, candidate).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    if (!fs.existsSync(cursor) || fs.lstatSync(cursor).isSymbolicLink()) return false;
  }

  const realRoot = fs.realpathSync(root);
  const realCandidate = fs.realpathSync(candidate);
  return isInside(realRoot, realCandidate);
}

function candidatePaths(siteRoot, urlPath, extensions = []) {
  const base = resolveLexicalPath(siteRoot, urlPath);
  if (!base) return null;
  const candidates = [base];
  for (const extension of extensions) {
    const suffix = String(extension).startsWith('.') ? String(extension) : `.${extension}`;
    candidates.push(`${base}${suffix}`);
  }
  return candidates;
}

function expandIndexCandidate(siteRoot, candidate, index) {
  if (!fs.existsSync(candidate) || !isExistingPathConfined(siteRoot, candidate)) return [];
  const stat = fs.lstatSync(candidate);
  if (!stat.isDirectory()) return [candidate];
  return [candidate, path.join(candidate, index)];
}

function hasUnsafeStaticPath(siteRoot, urlPath, options = {}) {
  const candidates = candidatePaths(siteRoot, urlPath, options.extensions || []);
  if (!candidates) return true;
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    if (!isExistingPathConfined(siteRoot, candidate)) return true;
    const stat = fs.lstatSync(candidate);
    if (stat.isDirectory()) {
      const indexCandidate = path.join(candidate, options.index || 'index.html');
      if (fs.existsSync(indexCandidate) && !isExistingPathConfined(siteRoot, indexCandidate)) return true;
    }
  }
  return false;
}

function resolveStaticFile(siteRoot, urlPath, options = {}) {
  const candidates = candidatePaths(siteRoot, urlPath, options.extensions || []);
  if (!candidates) return null;
  for (const candidate of candidates) {
    for (const resolved of expandIndexCandidate(siteRoot, candidate, options.index || 'index.html')) {
      if (!fs.existsSync(resolved) || !isExistingPathConfined(siteRoot, resolved)) return null;
      if (fs.lstatSync(resolved).isFile()) return resolved;
    }
  }
  return null;
}

function createStaticSiteGuard(siteRoot, options = {}) {
  return function staticSiteGuard(req, res, next) {
    if (hasUnsafeStaticPath(siteRoot, req.url || req.path || '/', options)) {
      return res.status(404).type('text/plain').send('Not found');
    }
    return next();
  };
}

module.exports = {
  createStaticSiteGuard,
  decodeRequestPath,
  hasUnsafeStaticPath,
  isExistingPathConfined,
  resolveLexicalPath,
  resolveStaticFile,
};
