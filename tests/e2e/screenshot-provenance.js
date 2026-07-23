const BADGE_MODULE_PATH = 'js/ua.media_provenance_badge.js';
const SCREENSHOT_BADGE_ID = 'ua-screenshot-source-provenance';

function validateSnapshot(snapshot) {
  if (!snapshot || !snapshot.manifest ||
      !/^[a-f0-9]{64}$/i.test(String(snapshot.sourceManifestSha256 || ''))) {
    throw new Error('Screenshot provenance requires a valid SourceManifest snapshot');
  }
  const sources = Array.isArray(snapshot.manifest.sources) ? snapshot.manifest.sources : [];
  const source = sources.find(item => item && item.role === 'accidents') || sources[0];
  if (!source || !String(source.publisher || '').trim() ||
      !String(source.datasetTitle || '').trim() ||
      !String(source.datasetUrl || '').trim() ||
      !String(source.licenseUrl || '').trim() ||
      !String(source.licenseId || source.licenseName || '').trim()) {
    throw new Error('Screenshot SourceManifest has no publication-ready accident source');
  }
  return snapshot;
}

export async function captureSourceManifestSnapshot(page, options = {}) {
  const timeout = Math.max(1000, Number(options.timeout) || 180000);
  await page.waitForFunction(() => Boolean(window.UA && window.UA.exportProvenanceReady), null, {
    timeout,
  });
  const snapshot = await page.evaluate(async () => {
    const UA = window.UA;
    await UA.exportProvenanceReady;
    if (UA.exportProvenanceError) throw UA.exportProvenanceError;
    if (!UA.documentExportProvenanceRuntime ||
        typeof UA.documentExportProvenanceRuntime.createSnapshot !== 'function') {
      throw new Error('Document SourceManifest runtime is unavailable for screenshot capture');
    }
    const ctx = typeof UA.getRuntimeContext === 'function' ? UA.getRuntimeContext() : null;
    if (!ctx) throw new Error('Runtime context is unavailable for screenshot capture');
    return UA.documentExportProvenanceRuntime.createSnapshot(ctx);
  });
  return validateSnapshot(snapshot);
}

async function ensureBadgeRuntime(page) {
  const available = await page.evaluate(() => Boolean(
    window.UA && window.UA.mediaProvenanceBadge &&
    typeof window.UA.mediaProvenanceBadge.install === 'function'
  )).catch(() => false);
  if (available) return;
  const [{ default: path }] = await Promise.all([import('path')]);
  await page.addScriptTag({ path: path.resolve(process.cwd(), BADGE_MODULE_PATH) });
  const installed = await page.evaluate(() => Boolean(
    window.UA && window.UA.mediaProvenanceBadge &&
    typeof window.UA.mediaProvenanceBadge.install === 'function'
  ));
  if (!installed) throw new Error('Shared media provenance badge runtime could not be installed');
}

export async function installScreenshotProvenance(page, sourceSnapshot, options = {}) {
  validateSnapshot(sourceSnapshot);
  await ensureBadgeRuntime(page);
  const mode = options.selector ? 'target' : (options.fullPage === true ? 'document' : 'viewport');
  const visibleBadge = await page.evaluate(({ snapshot, badgeOptions }) => {
    return window.UA.mediaProvenanceBadge.install(snapshot, badgeOptions);
  }, {
    snapshot: sourceSnapshot,
    badgeOptions: {
      id: SCREENSHOT_BADGE_ID,
      mode,
      targetSelector: options.selector || null,
      inset: options.inset == null ? 8 : Number(options.inset),
    },
  });
  if (!visibleBadge || visibleBadge.text == null ||
      visibleBadge.sourceManifestSha256 !== sourceSnapshot.sourceManifestSha256 ||
      !visibleBadge.image || !visibleBadge.image.rect) {
    throw new Error('Visible screenshot source badge is not bound to its SourceManifest');
  }
  return visibleBadge;
}

export async function removeScreenshotProvenance(page) {
  return page.evaluate((id) => Boolean(
    window.UA && window.UA.mediaProvenanceBadge &&
    window.UA.mediaProvenanceBadge.remove(id)
  ), SCREENSHOT_BADGE_ID).catch(() => false);
}

export async function captureScreenshotWithProvenance(page, options) {
  if (!options || !options.path) throw new Error('Screenshot capture requires an output path');
  const sourceSnapshot = validateSnapshot(options.sourceSnapshot);
  const visibleBadge = await installScreenshotProvenance(page, sourceSnapshot, options);
  try {
    if (options.selector) {
      const target = page.locator(options.selector);
      await target.waitFor({ state: 'visible', timeout: Math.max(1000, Number(options.timeout) || 30000) });
      const clip = await target.boundingBox();
      if (!clip || !(clip.width > 0) || !(clip.height > 0)) {
        throw new Error(`Screenshot target has no visible capture box: ${options.selector}`);
      }
      await page.screenshot({ path: options.path, clip });
    } else {
      await page.screenshot({ path: options.path, fullPage: options.fullPage === true });
    }
    return { sourceSnapshot, visibleBadge };
  } finally {
    await removeScreenshotProvenance(page);
  }
}

export const screenshotProvenanceContract = Object.freeze({
  BADGE_MODULE_PATH,
  SCREENSHOT_BADGE_ID,
  validateSnapshot,
});
