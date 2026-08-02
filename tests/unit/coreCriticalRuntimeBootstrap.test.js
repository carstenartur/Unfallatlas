/** @jest-environment jsdom */

'use strict';

const fs = require('fs');
const path = require('path');

const SOURCE = fs.readFileSync(
  path.join(__dirname, '../../js/ua.core.js'),
  'utf8',
);

function installDocumentState(readyState, source) {
  let currentScriptReads = 0;
  Object.defineProperty(document, 'readyState', {
    configurable: true,
    get: () => readyState,
  });
  Object.defineProperty(document, 'currentScript', {
    configurable: true,
    get: () => {
      currentScriptReads += 1;
      return currentScriptReads === 1 ? { src: source } : null;
    },
  });
}

describe('ua.core critical runtime recovery bootstrap', () => {
  beforeEach(() => {
    window.UA = {};
    delete window.__UA_CRITICAL_RUNTIME_ERROR_HANDLER__;
    jest.spyOn(document, 'write').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete window.UA;
    delete window.__UA_CRITICAL_RUNTIME_ERROR_HANDLER__;
    delete document.currentScript;
    delete document.readyState;
  });

  test('injects the recovery guard while the parser is still loading', () => {
    installDocumentState(
      'loading',
      'https://example.test/Unfallatlas/js/ua.core.js?first=1&second=2',
    );

    window.eval(SOURCE);

    expect(document.write).toHaveBeenCalledTimes(1);
    const markup = document.write.mock.calls[0][0];
    expect(markup).toContain('ua.critical-runtime-recovery.js?v=1');
    expect(markup).toContain('&amp;');
    expect(markup).not.toMatch(/src="[^"]*</);
  });

  test('does not call document.write after parser execution has completed', () => {
    installDocumentState(
      'complete',
      'https://example.test/Unfallatlas/js/ua.core.js',
    );

    window.eval(SOURCE);

    expect(document.write).not.toHaveBeenCalled();
  });
});
