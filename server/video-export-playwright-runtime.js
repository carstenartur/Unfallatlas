'use strict';

const DEFAULT_DOWNLOAD_TIMEOUT_MS = 180_000;
const MIN_DOWNLOAD_TIMEOUT_MS = 30_000;
const MAX_DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const INSTALL_MARKER = Symbol.for('unfallatlas.videoExportPlaywrightRuntime');
const BROWSER_MARKER = Symbol.for('unfallatlas.videoExportPlaywrightBrowser');
const CONTEXT_MARKER = Symbol.for('unfallatlas.videoExportPlaywrightContext');
const PAGE_MARKER = Symbol.for('unfallatlas.videoExportPlaywrightPage');

class VideoExportPlaywrightRuntimeError extends Error {
  constructor(code, message, details) {
    super(message ? `${code}: ${message}` : code);
    this.name = 'VideoExportPlaywrightRuntimeError';
    this.code = code;
    this.details = details || null;
  }
}

function boundedTimeout(value, fallback = DEFAULT_DOWNLOAD_TIMEOUT_MS) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(MIN_DOWNLOAD_TIMEOUT_MS, Math.min(MAX_DOWNLOAD_TIMEOUT_MS, Math.round(parsed)));
}

function configuredDownloadTimeout(env = process.env) {
  return boundedTimeout(env && env.VIDEO_EXPORT_DOWNLOAD_TIMEOUT_MS);
}

async function readVisibleExportState(page, dialogs) {
  let browserState = null;
  try {
    browserState = await page.evaluate(() => {
      const progress = document.querySelector('#exportProgress');
      const button = document.querySelector('#btnExportPDF');
      const modal = document.querySelector('#modalOverlay');
      const ctx = window.UA && typeof window.UA.getRuntimeContext === 'function'
        ? window.UA.getRuntimeContext()
        : null;
      return {
        progressText: String(progress && progress.textContent || '').trim(),
        buttonDisabled: Boolean(button && button.disabled),
        buttonConnected: Boolean(button && button.isConnected),
        modalVisible: Boolean(modal && getComputedStyle(modal).display !== 'none'),
        provenanceReady: Boolean(window.UA && window.UA.exportProvenanceReady),
        provenanceError: String(window.UA && window.UA.exportProvenanceError &&
          (window.UA.exportProvenanceError.message || window.UA.exportProvenanceError) || ''),
        documentProvenanceInstalled: Boolean(window.UA && window.UA.__documentExportProvenanceInstalled),
        documentPrewarmInstalled: Boolean(window.UA && window.UA.__documentExportPrewarmInstalled),
        prewarmSignature: ctx && window.UA && window.UA.documentExportPrewarmRuntime &&
          typeof window.UA.documentExportPrewarmRuntime.stateSignature === 'function'
          ? window.UA.documentExportPrewarmRuntime.stateSignature(ctx)
          : null,
      };
    });
  } catch (error) {
    browserState = { diagnosticError: String(error && error.message || error) };
  }
  return {
    browserState,
    dialogs: [...dialogs],
  };
}

function patchPage(page, options = {}) {
  if (!page || typeof page.waitForEvent !== 'function') {
    throw new VideoExportPlaywrightRuntimeError('invalid_page', 'Playwright page is required');
  }
  if (page[PAGE_MARKER]) return page;

  const timeoutMs = boundedTimeout(options.downloadTimeoutMs);
  const logger = options.logger || console;
  const dialogs = [];
  const originalWaitForEvent = page.waitForEvent.bind(page);

  if (typeof page.on === 'function') {
    page.on('dialog', dialog => {
      const entry = {
        type: String(dialog && typeof dialog.type === 'function' ? dialog.type() : 'unknown'),
        message: String(dialog && typeof dialog.message === 'function' ? dialog.message() : ''),
      };
      dialogs.push(entry);
      Promise.resolve(dialog && typeof dialog.dismiss === 'function' ? dialog.dismiss() : undefined)
        .catch(error => logger.warn?.('[video-export] dialog dismissal failed:', error.message));
    });
  }

  page.waitForEvent = function waitForVideoExportEvent(eventName, eventOptions) {
    if (eventName !== 'download') return originalWaitForEvent(eventName, eventOptions);

    const requestedTimeout = boundedTimeout(eventOptions && eventOptions.timeout, MIN_DOWNLOAD_TIMEOUT_MS);
    const effectiveTimeout = Math.max(timeoutMs, requestedTimeout);
    const nextOptions = {
      ...(eventOptions && typeof eventOptions === 'object' ? eventOptions : {}),
      timeout: effectiveTimeout,
    };

    const downloadPromise = Promise.resolve(originalWaitForEvent(eventName, nextOptions));
    const visibleFailurePromise = typeof page.waitForFunction === 'function'
      ? page.waitForFunction(() => {
          const text = String(document.querySelector('#exportProgress')?.textContent || '').trim();
          return /^Fehler:/i.test(text) ? text : false;
        }, null, { timeout: effectiveTimeout })
        .then(handle => handle && typeof handle.jsonValue === 'function' ? handle.jsonValue() : handle)
        .then(message => {
          throw new VideoExportPlaywrightRuntimeError(
            'visible_pdf_export_failure',
            String(message || 'PDF export failed before download'),
            { dialogs: [...dialogs] }
          );
        })
      : null;

    return new Promise((resolve, reject) => {
      let settled = false;
      const resolveOnce = value => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const rejectOnce = error => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      downloadPromise.then(resolveOnce, async error => {
        const details = await readVisibleExportState(page, dialogs);
        rejectOnce(new VideoExportPlaywrightRuntimeError(
          'pdf_download_timeout',
          String(error && error.message || error),
          {
            timeoutMs: effectiveTimeout,
            ...details,
          }
        ));
      });

      if (visibleFailurePromise) {
        visibleFailurePromise.catch(error => {
          if (error instanceof VideoExportPlaywrightRuntimeError &&
              error.code === 'visible_pdf_export_failure') {
            rejectOnce(error);
          }
          // A timeout of the failure watcher is expected when the download
          // succeeds or when the download waiter produces the primary error.
        });
      }
    });
  };

  Object.defineProperty(page, PAGE_MARKER, {
    value: Object.freeze({ timeoutMs, dialogs }),
    configurable: false,
    enumerable: false,
    writable: false,
  });
  return page;
}

function patchContext(context, options) {
  if (!context || typeof context.newPage !== 'function' || context[CONTEXT_MARKER]) return context;
  const originalNewPage = context.newPage.bind(context);
  context.newPage = async function newVideoExportPage(...args) {
    return patchPage(await originalNewPage(...args), options);
  };
  if (typeof context.pages === 'function') {
    for (const page of context.pages()) patchPage(page, options);
  }
  Object.defineProperty(context, CONTEXT_MARKER, { value: true });
  return context;
}

function patchBrowser(browser, options) {
  if (!browser || browser[BROWSER_MARKER]) return browser;
  if (typeof browser.newContext === 'function') {
    const originalNewContext = browser.newContext.bind(browser);
    browser.newContext = async function newVideoExportContext(...args) {
      return patchContext(await originalNewContext(...args), options);
    };
  }
  if (typeof browser.newPage === 'function') {
    const originalNewPage = browser.newPage.bind(browser);
    browser.newPage = async function newVideoExportPage(...args) {
      return patchPage(await originalNewPage(...args), options);
    };
  }
  if (typeof browser.contexts === 'function') {
    for (const context of browser.contexts()) patchContext(context, options);
  }
  Object.defineProperty(browser, BROWSER_MARKER, { value: true });
  return browser;
}

function installVideoExportPlaywrightRuntime(playwright = require('@playwright/test'), options = {}) {
  const chromium = playwright && playwright.chromium;
  if (!chromium || typeof chromium.launch !== 'function') {
    throw new VideoExportPlaywrightRuntimeError('missing_chromium', 'Playwright chromium launcher is unavailable');
  }
  if (chromium[INSTALL_MARKER]) return chromium[INSTALL_MARKER];

  const runtimeOptions = Object.freeze({
    downloadTimeoutMs: boundedTimeout(
      options.downloadTimeoutMs,
      configuredDownloadTimeout(options.env || process.env)
    ),
    logger: options.logger || console,
  });
  const originalLaunch = chromium.launch.bind(chromium);
  chromium.launch = async function launchWithVideoExportBoundary(...args) {
    return patchBrowser(await originalLaunch(...args), runtimeOptions);
  };

  const runtime = Object.freeze({
    downloadTimeoutMs: runtimeOptions.downloadTimeoutMs,
    patchPage: page => patchPage(page, runtimeOptions),
    patchContext: context => patchContext(context, runtimeOptions),
    patchBrowser: browser => patchBrowser(browser, runtimeOptions),
  });
  Object.defineProperty(chromium, INSTALL_MARKER, { value: runtime });
  return runtime;
}

module.exports = {
  DEFAULT_DOWNLOAD_TIMEOUT_MS,
  MIN_DOWNLOAD_TIMEOUT_MS,
  MAX_DOWNLOAD_TIMEOUT_MS,
  VideoExportPlaywrightRuntimeError,
  boundedTimeout,
  configuredDownloadTimeout,
  patchPage,
  patchContext,
  patchBrowser,
  installVideoExportPlaywrightRuntime,
};
