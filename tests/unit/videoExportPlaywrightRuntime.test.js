'use strict';

const {
  DEFAULT_DOWNLOAD_TIMEOUT_MS,
  MAX_DOWNLOAD_TIMEOUT_MS,
  VideoExportPlaywrightRuntimeError,
  boundedTimeout,
  configuredDownloadTimeout,
  patchPage,
  installVideoExportPlaywrightRuntime,
} = require('../../server/video-export-playwright-runtime');

function pendingPromise() {
  return new Promise(() => {});
}

function fakePage(overrides = {}) {
  const handlers = {};
  const page = {
    on: jest.fn((event, handler) => { handlers[event] = handler; }),
    waitForEvent: jest.fn(async () => 'download'),
    waitForFunction: jest.fn(() => pendingPromise()),
    evaluate: jest.fn(async () => ({ progressText: 'PDF wird erstellt...' })),
    ...overrides,
  };
  page.handlers = handlers;
  return page;
}

describe('video-export Playwright runtime', () => {
  test('bounds the configurable download timeout', () => {
    expect(configuredDownloadTimeout({})).toBe(DEFAULT_DOWNLOAD_TIMEOUT_MS);
    expect(configuredDownloadTimeout({ VIDEO_EXPORT_DOWNLOAD_TIMEOUT_MS: '5000' })).toBe(30_000);
    expect(configuredDownloadTimeout({ VIDEO_EXPORT_DOWNLOAD_TIMEOUT_MS: '240000' })).toBe(240_000);
    expect(configuredDownloadTimeout({ VIDEO_EXPORT_DOWNLOAD_TIMEOUT_MS: '9999999' }))
      .toBe(MAX_DOWNLOAD_TIMEOUT_MS);
    expect(boundedTimeout('invalid', 123_456)).toBe(123_456);
  });

  test('raises only download waiters to the video-export budget', async () => {
    const page = fakePage();
    const originalWaitForEvent = page.waitForEvent;
    patchPage(page, { downloadTimeoutMs: 240_000, logger: { warn: jest.fn() } });

    await expect(page.waitForEvent('download', { timeout: 90_000 })).resolves.toBe('download');
    expect(originalWaitForEvent).toHaveBeenCalledWith('download', { timeout: 240_000 });

    await expect(page.waitForEvent('close', { timeout: 12_000 })).resolves.toBe('download');
    expect(originalWaitForEvent).toHaveBeenLastCalledWith('close', { timeout: 12_000 });
  });

  test('dismisses blocking dialogs and fails immediately on visible export errors', async () => {
    const page = fakePage({
      waitForEvent: jest.fn(() => pendingPromise()),
      waitForFunction: jest.fn(async () => ({
        jsonValue: async () => 'Fehler: Quellenprovenienz ist nicht verfügbar.',
      })),
    });
    const dismiss = jest.fn(async () => undefined);
    patchPage(page, { logger: { warn: jest.fn() } });

    await page.handlers.dialog({
      type: () => 'alert',
      message: () => 'Word-Export fehlgeschlagen',
      dismiss,
    });
    await Promise.resolve();
    expect(dismiss).toHaveBeenCalledTimes(1);

    await expect(page.waitForEvent('download', { timeout: 90_000 })).rejects.toMatchObject({
      name: 'VideoExportPlaywrightRuntimeError',
      code: 'visible_pdf_export_failure',
      details: {
        dialogs: [{ type: 'alert', message: 'Word-Export fehlgeschlagen' }],
      },
    });
  });

  test('adds browser diagnostics when the download waiter times out', async () => {
    const originalError = new Error('Timeout 90000ms exceeded');
    const page = fakePage({
      waitForEvent: jest.fn(async () => { throw originalError; }),
      evaluate: jest.fn(async () => ({
        progressText: 'PDF wird erstellt...',
        buttonDisabled: true,
        documentProvenanceInstalled: true,
        documentPrewarmInstalled: true,
      })),
    });
    patchPage(page, { downloadTimeoutMs: 210_000, logger: { warn: jest.fn() } });

    await expect(page.waitForEvent('download', { timeout: 90_000 })).rejects.toMatchObject({
      name: 'VideoExportPlaywrightRuntimeError',
      code: 'pdf_download_timeout',
      details: {
        timeoutMs: 210_000,
        browserState: {
          progressText: 'PDF wird erstellt...',
          buttonDisabled: true,
          documentProvenanceInstalled: true,
          documentPrewarmInstalled: true,
        },
      },
    });
  });

  test('patches chromium launch, browser contexts and pages exactly once', async () => {
    const page = fakePage();
    const context = {
      newPage: jest.fn(async () => page),
      pages: jest.fn(() => []),
    };
    const browser = {
      newContext: jest.fn(async () => context),
      contexts: jest.fn(() => []),
    };
    const playwright = {
      chromium: {
        launch: jest.fn(async () => browser),
      },
    };

    const first = installVideoExportPlaywrightRuntime(playwright, {
      downloadTimeoutMs: 225_000,
      logger: { warn: jest.fn() },
    });
    const second = installVideoExportPlaywrightRuntime(playwright, {
      downloadTimeoutMs: 500_000,
    });
    expect(second).toBe(first);
    expect(second.downloadTimeoutMs).toBe(225_000);

    const launched = await playwright.chromium.launch({ headless: true });
    const createdContext = await launched.newContext({ viewport: { width: 100, height: 100 } });
    const createdPage = await createdContext.newPage();
    await expect(createdPage.waitForEvent('download', { timeout: 90_000 })).resolves.toBe('download');
    expect(page.waitForFunction).toHaveBeenCalledTimes(1);
  });

  test('rejects invalid pages with a typed error', () => {
    expect(() => patchPage(null)).toThrow(VideoExportPlaywrightRuntimeError);
  });
});
