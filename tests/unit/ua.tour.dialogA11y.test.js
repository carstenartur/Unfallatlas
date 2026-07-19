/**
 * @jest-environment jsdom
 */

const fs = require('fs');
const path = require('path');

function loadTourModule() {
  window.UA = { qGet: () => '' };
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
});
