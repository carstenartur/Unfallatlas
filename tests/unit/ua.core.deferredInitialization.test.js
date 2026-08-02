'use strict';

const fs = require('fs');
const path = require('path');

describe('UA core deferred initialization contracts', () => {
  let UA;

  beforeEach(() => {
    document.body.innerHTML = `
      <button id="btnPolCtxOpen" type="button"></button>
      <button id="btnPrioritiesOpen" type="button"></button>
      <button id="btnExportWord" type="button"></button>
    `;
    window.UA = {};
    const source = fs.readFileSync(path.resolve(__dirname, '../../js/ua.core.js'), 'utf8');
    eval(source);
    UA = window.UA;
  });

  afterEach(() => {
    document.body.innerHTML = '';
    delete window.UA;
    jest.restoreAllMocks();
  });

  test('feature module assignments are wrapped exactly once', () => {
    const init = jest.fn();
    const ctx = { city: 'Bonn' };
    UA.Priorities.init = init;

    UA.Priorities.init(ctx);
    UA.Priorities.init(ctx);

    expect(init).toHaveBeenCalledTimes(1);
    expect(init).toHaveBeenCalledWith(ctx);
  });

  test('report UI binding waits for provenance and remains idempotent', async () => {
    let resolveReady;
    const ready = new Promise((resolve) => { resolveReady = resolve; });
    const init = jest.fn();
    const ctx = { city: 'Bonn' };
    UA.exportProvenanceReady = ready;
    UA.initReportExportUI = init;

    const first = UA.initReportExportUI(ctx);
    const second = UA.initReportExportUI(ctx);
    expect(init).not.toHaveBeenCalled();

    resolveReady();
    await Promise.all([first, second]);

    expect(init).toHaveBeenCalledTimes(1);
    expect(init).toHaveBeenCalledWith(ctx);
  });
});
