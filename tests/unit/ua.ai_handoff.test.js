/**
 * Complete user-owned AI handoff: graphics, facts and one bound snapshot.
 *
 * @jest-environment jsdom
 */

describe('UA.aiHandoff', () => {
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=';
  let UA;
  let capturedZipEntries;

  function load(relativePath) {
    const fs = require('fs');
    const path = require('path');
    const code = fs.readFileSync(path.resolve(__dirname, '../../js/', relativePath), 'utf8');
    // eslint-disable-next-line no-new-func
    (new Function('window', 'document', code))(window, document);
  }

  function flush(n = 4) {
    let promise = Promise.resolve();
    for (let index = 0; index < n; index += 1) {
      promise = promise.then(() => new Promise(resolve => setTimeout(resolve, 0)));
    }
    return promise;
  }

  function installRuntime(overrides = {}) {
    capturedZipEntries = null;
    UA.exportProvenanceReady = Promise.resolve();
    UA.artifactProvenance = {
      sha256: jest.fn(async value => {
        const bytes = value instanceof Uint8Array ? value : new TextEncoder().encode(String(value));
        return Array.from(bytes).reduce((sum, byte) => (sum + byte) % 256, 0)
          .toString(16).padStart(2, '0').repeat(32);
      }),
    };
    UA.zip = {
      createStoredZip: jest.fn(entries => {
        capturedZipEntries = entries;
        return new Uint8Array([0x50, 0x4b, 0x05, 0x06]);
      }),
    };
    UA.computeExportReport = jest.fn(async () => ({
      structured: {
        meta: { city: 'Bonn' },
        summary: { totalAccidents: 7 },
        yearlyTrend: {
          years: [2021, 2022, 2023],
          counts: { total: [2, 3, 4] },
          slope: 1,
          intercept: -2019,
          classification: 'steigend',
        },
        heatmap: {
          total: 7,
          matrix: Array.from({ length: 24 }, () => [0, 0]),
          max: 1,
        },
      },
      text: 'Deterministischer Bericht mit allen Tabellen.',
      html: '<main><h1>Bonn</h1><svg aria-label="Trend"></svg></main>',
    }));
    UA.captureExportMapImage = jest.fn(async () => PNG);
    UA._captureDetailMap = jest.fn(async () => PNG);
    UA._captureClusterMaps = jest.fn(async () => [{
      label: 'Cluster A', image: PNG, total: 2, points: [{}, {}], lat: 50.7, lon: 7.1, zoom: 17,
    }]);
    UA.computeClusterMapTargets = jest.fn(() => [{
      label: 'Cluster A', total: 2, points: [{}, {}], lat: 50.7, lon: 7.1, zoom: 17,
    }]);
    UA.trend = { renderTrendSVG: jest.fn(() => '<svg aria-label="Mehrjahres-Trend"></svg>') };
    UA.heatmap = { renderHeatmapSVG: jest.fn(() => '<svg aria-label="Stunden-Heatmap"></svg>') };
    Object.assign(UA, overrides);
  }

  beforeEach(() => {
    document.body.innerHTML = `
      <fieldset id="aiProposalSection">
        <button id="btnAiProposal"></button>
        <div id="aiProposalStatus"></div>
        <div id="aiProposalResult"></div>
      </fieldset>
      <textarea id="exportBoxTa"></textarea>
    `;
    delete window.UA;
    window.UA = {};
    window.history.replaceState(null, '', '/werkbank_v2.html?city=Bonn');
    load('ua.ai_proposal.js');
    UA = window.UA;
    installRuntime();
    load('ua.ai_handoff.js');
  });

  test('relabels the text-only path and adds a complete media-package control', async () => {
    const ctx = { CITY_RAW: 'Bonn', ui: {}, selectionBounds: {} };
    UA.aiProposal.wire(ctx);
    await flush();

    expect(document.getElementById('btnAiHandoffDownload')).toBeTruthy();
    expect(document.getElementById('btnAiPromptCopy').textContent).toMatch(/ohne Grafiken/);
    expect(document.getElementById('aiHandoffCompletenessNote').textContent).toMatch(/keine Bilddateien/);
  });

  test('creates one bound ZIP with maps, SVG graphics, complete facts and hashes', async () => {
    window.fetch = jest.fn();
    const ctx = {
      CITY_RAW: 'Bonn',
      ui: {},
      selectionBounds: {
        getSouthWest: () => ({ lat: 50.70, lng: 7.05 }),
        getNorthEast: () => ({ lat: 50.75, lng: 7.15 }),
      },
      map: {
        getCenter: () => ({ lat: 50.73, lng: 7.10 }),
        getZoom: () => 15,
      },
      exportOptions: {},
    };

    const pkg = await UA.aiHandoff.generatePackage(UA, ctx);

    expect(window.fetch).not.toHaveBeenCalled();
    expect(UA.computeExportReport).toHaveBeenCalledTimes(1);
    expect(pkg.manifest.completeness).toBe('complete');
    expect(pkg.graphics.map(graphic => graphic.name)).toEqual(expect.arrayContaining([
      'graphics/01-uebersichtskarte.png',
      'graphics/02-detailkarte.png',
      'graphics/03-cluster-cluster-a.png',
      'graphics/mehrjahres-trend.svg',
      'graphics/stunden-heatmap.svg',
    ]));
    expect(pkg.prompt).toContain('Verbindliche Anlagen dieses Medienpakets');
    expect(pkg.prompt).toContain('graphics/01-uebersichtskarte.png');
    expect(pkg.manifest.uploadContract.requiredFiles).toContain('manifest.json');
    expect(pkg.manifest.hashScope).toEqual(expect.objectContaining({
      algorithm: 'SHA-256',
      coveredFiles: 'all ZIP payload files except manifest.json',
    }));
    expect(pkg.manifest.hashScope.excluded).toContainEqual(expect.objectContaining({ path: 'manifest.json' }));
    expect(pkg.manifest.files.every(file => /^[a-f0-9]{64}$/.test(file.sha256))).toBe(true);
    expect(capturedZipEntries.map(entry => entry.name)).toEqual(expect.arrayContaining([
      'README.md', 'prompt.md', 'facts.json', 'report.md', 'report.html',
      'application-state.json', 'map-url.txt', 'manifest.json',
      'graphics/01-uebersichtskarte.png',
    ]));
  });

  test('fails closed when an expected cluster graphic was silently omitted', async () => {
    UA.computeClusterMapTargets = jest.fn(() => [
      { label: 'Cluster A', total: 2, lat: 50.7, lon: 7.1 },
      { label: 'Cluster B', total: 2, lat: 50.8, lon: 7.2 },
    ]);

    await expect(UA.aiHandoff.generatePackage(UA, { exportOptions: {} }))
      .rejects.toMatchObject({ code: 'missing_cluster_graphics' });
    expect(UA.zip.createStoredZip).not.toHaveBeenCalled();
  });

  test('fails closed when a cluster image count disagrees with its stated total', async () => {
    UA._captureClusterMaps = jest.fn(async () => [{
      label: 'Widerspruch', image: PNG, total: 3, points: [{}, {}],
    }]);

    await expect(UA.aiHandoff.generatePackage(UA, { exportOptions: {} }))
      .rejects.toMatchObject({ code: 'cluster_count_mismatch' });
    expect(UA.zip.createStoredZip).not.toHaveBeenCalled();
  });

  test('fails closed when the required overview map is not a PNG', async () => {
    UA.captureExportMapImage = jest.fn(async () => 'data:text/plain;base64,ZmFsc2U=');

    await expect(UA.aiHandoff.generatePackage(UA, { exportOptions: {} }))
      .rejects.toMatchObject({ code: 'invalid_png_data_url' });
    expect(UA.zip.createStoredZip).not.toHaveBeenCalled();
  });

  test('also installs after the original wire already created the prompt panel', async () => {
    document.body.innerHTML = `
      <fieldset id="aiProposalSection">
        <button id="btnAiProposal"></button>
        <div id="aiProposalStatus"></div>
        <div id="aiProposalResult"></div>
      </fieldset>
      <textarea id="exportBoxTa"></textarea>
    `;
    delete window.UA.aiHandoff;
    const originalWire = UA.aiProposal.wire._uaOriginalWire || UA.aiProposal.wire;
    UA.aiProposal.wire = originalWire;
    const ctx = { CITY_RAW: 'Bonn', ui: {} };
    UA.aiProposal.wire(ctx);
    UA.getRuntimeContext = () => ctx;

    load('ua.ai_handoff.js');
    await flush();

    expect(document.getElementById('btnAiHandoffDownload')).toBeTruthy();
  });
});
