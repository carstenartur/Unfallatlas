const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');

function source(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function parsedWerkbank() {
  return new DOMParser().parseFromString(source('werkbank_v2.html'), 'text/html');
}

function loadUaModule(relativePath) {
  const mockWindow = {
    UA: {},
    location: { href: 'http://localhost:8000/werkbank_v2.html' },
    history: { replaceState: jest.fn() },
  };
  // The browser modules are IIFEs. Supplying both window and history keeps
  // this source-level contract test independent from jsdom's global URL.
  new Function('window', 'history', source(relativePath))(mockWindow, mockWindow.history);
  return mockWindow.UA;
}

describe('Werkbank accessibility baseline', () => {
  const nativeButtonIds = [
    'legendBtn', 'collapseBtn',
    'modeOr', 'modeAnd', 'modeSolo',
    'mapModeStandard', 'mapModeOrthophoto', 'mapModeHybrid', 'mapModeAnalysis',
    'toggleCluster', 'toggleHeat', 'toggleOnlyHot',
    'btnDraw', 'btnClearDraw', 'btnOpenExport',
    'btnPolCtxOpen', 'btnPrioritiesOpen', 'tourBtnStart', 'tourBtnRecord',
    'tourBtnPrev', 'tourBtnPlayPause', 'tourBtnNext', 'tourBtnStop',
    'btnCopyText', 'btnCopyLink', 'btnCloseModal',
    'recorderBtnPlay', 'recorderBtnDownload', 'recorderBtnClose',
    'polCtxBtnClose', 'polCtxBtnSearch', 'polCtxBtnAdopt',
    'prioBtnClose', 'prioBtnLoad',
    'btnExportWord', 'btnExportPDF', 'btnExportCSV', 'btnExportGeoJSON',
    'btnExportKML', 'btnExportVideo', 'btnAiProposal',
  ];

  test.each(nativeButtonIds)('%s is a non-submitting native button', (id) => {
    const element = parsedWerkbank().getElementById(id);
    expect(element).not.toBeNull();
    expect(element.tagName).toBe('BUTTON');
    expect(element.getAttribute('type')).toBe('button');
  });

  test('status and disclosure semantics are present in the initial markup', () => {
    const doc = parsedWerkbank();
    const status = doc.getElementById('stat');
    expect(status.getAttribute('role')).toBe('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.getAttribute('aria-atomic')).toBe('true');

    const legend = doc.getElementById('legendBtn');
    expect(legend.getAttribute('aria-controls')).toBe('legendBox');
    expect(legend.getAttribute('aria-expanded')).toBe('false');

    const collapse = doc.getElementById('collapseBtn');
    expect(collapse.getAttribute('aria-controls')).toBe('panelBody');
    expect(collapse.getAttribute('aria-expanded')).toBe('true');
  });

  test('the export and recorder dialogs have accessible names', () => {
    const doc = parsedWerkbank();
    const dialog = doc.getElementById('modalOverlay');
    const titleId = dialog.getAttribute('aria-labelledby');
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(titleId).toBe('exportModalTitle');
    expect(doc.getElementById(titleId).textContent).toMatch(/Analyse \/ Export/);

    const recorderDialog = doc.getElementById('recorderModal');
    const recorderTitleId = recorderDialog.getAttribute('aria-labelledby');
    expect(recorderDialog.getAttribute('role')).toBe('dialog');
    expect(recorderTitleId).toBe('recorderModalTitle');
    expect(doc.getElementById(recorderTitleId).textContent).toMatch(/Aufgezeichnete Tour bearbeiten/);
  });

  test('interactive elements receive a visible focus indicator', () => {
    expect(source('css/ua.css')).toMatch(/:focus-visible\s*\{[^}]*outline:/s);
  });

  test.each(['js/ua.core.js', 'js/ua.utils.js'])(
    '%s keeps visual and aria-pressed state synchronized',
    (modulePath) => {
      const UA = loadUaModule(modulePath);
      const button = document.createElement('button');

      UA.setBtnState(button, true);
      expect(button.classList.contains('active')).toBe(true);
      expect(button.getAttribute('aria-pressed')).toBe('true');

      UA.setBtnState(button, false);
      expect(button.classList.contains('active')).toBe(false);
      expect(button.getAttribute('aria-pressed')).toBe('false');

      expect(() => UA.setBtnState(null, true)).not.toThrow();
    }
  );
});
