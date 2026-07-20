'use strict';

const fs = require('fs');
const path = require('path');
const { hasUnsafeStaticPath } = require('./safeStaticPath');

const TOP_LEVEL_DATA_FILE = /^(?:data-manifest\.json|output_all_years(?:_[a-z0-9_]+)?\.geojson(?:\.gz)?|poi_[a-z0-9_]+\.geojson(?:\.gz)?|ways_[a-z0-9_]+\.json(?:\.gz)?|output_all_years_[a-z0-9_]+\.enrichment\.meta\.json(?:\.gz)?)$/;
const TILE_DATA_FILE = /^(?:ctxtiles|accidenttiles)\/[a-z0-9_]+\/(?:index\.json(?:\.gz)?|\d+\/\d+(?:\/\d+)?\.json(?:\.gz)?)$/;

function resolveDataRoot(root, configuredRoot) {
  const repositoryRoot = path.resolve(root);
  const candidate = path.resolve(configuredRoot || path.join(repositoryRoot, 'out'));
  const filesystemRoot = path.parse(candidate).root;
  const relativeToRepository = path.relative(candidate, repositoryRoot);
  const containsRepository = !relativeToRepository ||
    (!relativeToRepository.startsWith('..') && !path.isAbsolute(relativeToRepository));

  if (candidate === filesystemRoot || containsRepository) {
    throw new Error(`[server] Refusing unsafe UNFALLATLAS_DATA_ROOT: ${candidate}`);
  }
  if (fs.existsSync(candidate)) {
    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink()) {
      throw new Error(`[server] UNFALLATLAS_DATA_ROOT must not be a symbolic link: ${candidate}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`[server] UNFALLATLAS_DATA_ROOT is not a directory: ${candidate}`);
    }
  }
  return candidate;
}

function normalizeRequestPath(requestPath) {
  if (typeof requestPath !== 'string' || requestPath.includes('\0') || requestPath.includes('\\')) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch (_) {
    return null;
  }
  const relative = decoded.replace(/^\/+/, '');
  if (!relative || relative.startsWith('.') || relative.split('/').some(segment => !segment || segment === '.' || segment === '..' || segment.startsWith('.'))) {
    return null;
  }
  return relative;
}

function isAllowedDataRequestPath(requestPath) {
  const relative = normalizeRequestPath(requestPath);
  return Boolean(relative && (TOP_LEVEL_DATA_FILE.test(relative) || TILE_DATA_FILE.test(relative)));
}

function createStaticDataOverlay(express, dataRoot) {
  const serveAllowedData = express.static(dataRoot, {
    dotfiles: 'deny',
    fallthrough: true,
    index: false,
    redirect: false,
  });
  return function staticDataOverlay(req, res, next) {
    if (!isAllowedDataRequestPath(req.path || req.url || '')) {
      return res.status(404).type('text/plain').send('Not found');
    }
    if (hasUnsafeStaticPath(dataRoot, req.path || req.url || '/', { index: '__disabled__' })) {
      return res.status(404).type('text/plain').send('Not found');
    }
    return serveAllowedData(req, res, next);
  };
}

module.exports = {
  createStaticDataOverlay,
  isAllowedDataRequestPath,
  normalizeRequestPath,
  resolveDataRoot,
};
