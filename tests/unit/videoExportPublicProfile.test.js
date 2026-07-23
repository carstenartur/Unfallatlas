'use strict';

const fs = require('fs');
const path = require('path');

const videoSource = fs.readFileSync(
  path.resolve(__dirname, '../../js/ua.video-export.js'),
  'utf8',
);
const publicPreviewSource = fs.readFileSync(
  path.resolve(__dirname, '../../js/ua.public-preview.js'),
  'utf8',
);

function evaluate(source) {
  // eslint-disable-next-line no-new-func
  new Function(source)();
}

function loadingDocument() {
  Object.defineProperty(document, 'readyState', {
    configurable: true,
    value: 'loading',
  });
}

describe('video export public distribution boundary', () => {
  beforeEach(() => {
    document.body.innerHTML = [
      '<div id="panelBody"></div>',
      '<fieldset id="videoExportContainer" style="display:none">',
      '  <button id="btnExportVideo"></button>',
      '  <div id="videoExportProgress"></div>',
      '</fieldset>',
    ].join('');
    loadingDocument();
    window.UA = {};
    global.fetch = jest.fn();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete global.fetch;
  });

  test('public preview declares video unavailable and performs no backend probe', async () => {
    evaluate(publicPreviewSource);
    evaluate(videoSource);

    expect(window.UA.PUBLIC_DISTRIBUTION_PROFILE).toMatchObject({
      id: 'public-preview-core-v1',
      completeVendorInventory: true,
    });
    expect(window.UA.PUBLIC_DISTRIBUTION_PROFILE.disabledCapabilities)
      .toContain('video-export');
    expect(window.UA.videoExportClient.backendProbeDisabled()).toBe(true);

    await window.UA.videoExportClient.init();

    expect(global.fetch).not.toHaveBeenCalled();
    expect(document.getElementById('videoExportContainer').style.display).toBe('none');
  });

  test('a server distribution still probes the canonical availability endpoint', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ available: false }),
    });
    evaluate(videoSource);

    expect(window.UA.videoExportClient.backendProbeDisabled()).toBe(false);
    await window.UA.videoExportClient.init();

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith('/api/video-export-available', expect.objectContaining({
      method: 'GET',
      headers: { Accept: 'application/json' },
    }));
    expect(document.getElementById('videoExportContainer').style.display).toBe('none');
  });

  test('an available server enables the video action', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ available: true }),
    });
    evaluate(videoSource);

    await window.UA.videoExportClient.init();

    expect(document.getElementById('videoExportContainer').style.display).toBe('');
  });

  test('an unrelated disabled capability does not suppress server discovery', async () => {
    window.UA.PUBLIC_DISTRIBUTION_PROFILE = {
      id: 'custom-profile',
      disabledCapabilities: ['pdf-export'],
    };
    global.fetch.mockResolvedValue({
      ok: false,
      json: async () => ({}),
    });
    evaluate(videoSource);

    await window.UA.videoExportClient.init();

    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
