/**
 * @jest-environment jsdom
 */

const fs = require('fs');
const path = require('path');

function loadTourModule() {
  window.UA = {};
  const utils = fs.readFileSync(path.resolve(__dirname, '../../js/ua.utils.js'), 'utf8');
  // eslint-disable-next-line no-eval
  eval(utils);
  window.UA.qGet = () => '';
  const source = fs.readFileSync(path.resolve(__dirname, '../../js/ua.tour.js'), 'utf8');
  // eslint-disable-next-line no-eval
  eval(source);
  return window.UA;
}

describe('Tour recorder dialog accessibility', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <button type="button" id="tourBtnRecord">Aufzeichnen</button>
      <span id="recBadge" style="display:none"><span id="recStepCount"></span></span>
      <div id="recorderModal" style="display:none">
        <button type="button" id="recorderBtnClose">Schließen</button>
        <button type="button" id="recorderBtnDownload">Herunterladen</button>
        <button type="button" id="recorderBtnPlay">Vorschau</button>
        <div id="recorderStepList"></div>
        <textarea id="recorderJson"></textarea>
      </div>
    `;
  });

  test('moves focus to Close and restores the recorder trigger after Escape', () => {
    const UA = loadTourModule();
    const recordButton = document.getElementById('tourBtnRecord');
    const closeButton = document.getElementById('recorderBtnClose');
    const modal = document.getElementById('recorderModal');

    UA.initTour({ CITY_RAW: 'Hannover', map: null, ui: null });
    recordButton.focus();
    recordButton.click();
    recordButton.click();

    expect(modal.style.display).toBe('flex');
    expect(document.activeElement).toBe(closeButton);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(modal.style.display).toBe('none');
    expect(document.activeElement).toBe(recordButton);
  });

  test('groups recorded steps and keeps focus on the moved step description', () => {
    const UA = loadTourModule();
    const map = {
      getCenter: () => ({ lat: 52.3745, lng: 9.7386 }),
      getZoom: () => 13,
      on: jest.fn(),
      off: jest.fn(),
    };

    UA.initTour({ CITY_RAW: 'Hannover', map, ui: null });
    UA.recorderStart();
    UA.recorderStop();

    const rows = document.querySelectorAll('.recStepRow');
    expect(rows).toHaveLength(2);
    expect(rows[0].getAttribute('role')).toBe('group');
    expect(rows[0].getAttribute('aria-label')).toBe('Schritt 1: setCity');

    rows[0].querySelector('[data-direction="down"]').click();

    const movedDescription = document.querySelector(
      '.recStepRow[data-index="1"] .recStepDesc'
    );
    expect(document.activeElement).toBe(movedDescription);
    expect(movedDescription.getAttribute('aria-label')).toBe(
      'Beschreibung für Schritt 2: setCity'
    );
  });

  test('HTML exposes persistent labels and primary task order', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../werkbank_v2.html'), 'utf8');
    const parsed = new DOMParser().parseFromString(source, 'text/html');
    const actions = parsed.querySelector('.taskActions');

    expect(actions.getAttribute('role')).toBe('group');
    expect(actions.getAttribute('aria-label')).toBe('Ausschnitt und Export');
    expect([...actions.querySelectorAll(':scope > button')].map(button => button.id)).toEqual([
      'btnOpenExport',
      'btnDraw',
      'btnClearDraw',
    ]);
    expect(parsed.querySelector('label[for="recorderJson"]')).not.toBeNull();
    expect(parsed.querySelector('label[for="polCtxSearchInput"]')).not.toBeNull();
  });
});
