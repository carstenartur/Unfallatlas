const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const COMPACT_QUERY = '(max-width: 640px), (max-height: 500px) and (pointer: coarse)';
const desktopPreference = 'ua_panel_collapsed';
const phonePreference = 'ua_panel_collapsed_mobile';
const markup = fs.readFileSync(path.join(ROOT, 'werkbank_v2.html'), 'utf8');

function loadScript(name) {
  (function(window) {
    eval(fs.readFileSync(path.join(ROOT, 'js', name), 'utf8'));
  })(window);
}

let viewportMedia;
function setViewport(width, height, pointer = 'coarse') {
  // jsdom does not evaluate media queries; model the browser's answer and
  // change event for the responsive stylesheet's compact-screen query.
  const matches = width <= 640 || (height <= 500 && pointer === 'coarse');
  if (!viewportMedia) {
    viewportMedia = new EventTarget();
    viewportMedia.media = COMPACT_QUERY;
    viewportMedia.matches = matches;
    viewportMedia.onchange = null;
    viewportMedia.addListener = (listener) => viewportMedia.addEventListener('change', listener);
    viewportMedia.removeListener = (listener) => viewportMedia.removeEventListener('change', listener);
    window.matchMedia = (query) => query === COMPACT_QUERY
      ? viewportMedia
      : { media: query, matches: false, addEventListener() {}, removeEventListener() {} };
    return;
  }
  if (viewportMedia.matches === matches) return;
  viewportMedia.matches = matches;
  const event = new Event('change');
  Object.assign(event, { matches, media: COMPACT_QUERY });
  viewportMedia.dispatchEvent(event);
}

describe('UA panel disclosure before data loading', () => {
  let UA;
  let ctx;
  const originalMatchMedia = window.matchMedia;

  beforeEach(() => {
    document.body.innerHTML = new DOMParser().parseFromString(markup, 'text/html').body.innerHTML;
    window.history.replaceState({}, '', '/werkbank_v2.html');
    localStorage.clear();
    window.UA = {};
    viewportMedia = null;
    setViewport(390, 844);
    loadScript('ua.utils.js');
    loadScript('ua.state.js');
    loadScript('ua.ui.js');
    UA = window.UA;
    ctx = {};
  });

  afterEach(() => {
    jest.restoreAllMocks();
    window.matchMedia = originalMatchMedia;
    document.body.innerHTML = '';
    delete window.UA;
  });

  test('a phone starts compact and can expand before any city data has loaded', () => {
    UA.bindDom(ctx);

    expect(ctx.ui.panelEl.classList.contains('collapsed')).toBe(true);
    expect(ctx.ui.collapseBtn.getAttribute('aria-expanded')).toBe('false');
    expect(ctx.ui.collapseBtn.getAttribute('aria-label')).toBe('Bedienfeld ausklappen');
    expect(ctx.ui.collapseBtn.title).toBe('Bedienfeld ausklappen');
    expect(localStorage.getItem(phonePreference)).toBeNull();

    ctx.ui.collapseBtn.click();

    expect(ctx.ui.panelEl.classList.contains('collapsed')).toBe(false);
    expect(ctx.ui.collapseBtn.getAttribute('aria-expanded')).toBe('true');
    expect(ctx.ui.collapseBtn.title).toBe('Bedienfeld einklappen');
    expect(localStorage.getItem(phonePreference)).toBe('0');
    expect(localStorage.getItem(desktopPreference)).toBeNull();
  });

  test.each([
    ['phone landscape', 844, 390, 'coarse', true],
    ['narrow window', 600, 900, 'fine', true],
    ['desktop', 1440, 900, 'fine', false],
    ['short desktop window', 1280, 480, 'fine', false],
  ])('%s starts with its appropriate panel size without storing the automatic default', (_name, width, height, pointer, collapsed) => {
    setViewport(width, height, pointer);

    UA.bindDom(ctx);

    expect(ctx.ui.panelEl.classList.contains('collapsed')).toBe(collapsed);
    expect(ctx.ui.collapseBtn.getAttribute('aria-expanded')).toBe(String(!collapsed));
    expect(localStorage.getItem(phonePreference)).toBeNull();
    expect(localStorage.getItem(desktopPreference)).toBeNull();
  });

  test('an old desktop expanded preference does not cover the phone map on startup', () => {
    localStorage.setItem(desktopPreference, '0');

    UA.bindDom(ctx);

    expect(ctx.ui.panelEl.classList.contains('collapsed')).toBe(true);
    expect(localStorage.getItem(phonePreference)).toBeNull();
  });

  test.each([
    ['0', false],
    ['1', true],
  ])('restores the explicit phone preference %s', (stored, collapsed) => {
    localStorage.setItem(phonePreference, stored);

    UA.bindDom(ctx);

    expect(ctx.ui.panelEl.classList.contains('collapsed')).toBe(collapsed);
    expect(ctx.ui.collapseBtn.getAttribute('aria-expanded')).toBe(String(!collapsed));
  });

  test('preserves the desktop preference separately from the phone preference', () => {
    setViewport(1440, 900, 'fine');
    localStorage.setItem(desktopPreference, '1');
    localStorage.setItem(phonePreference, '0');

    UA.bindDom(ctx);

    expect(ctx.ui.panelEl.classList.contains('collapsed')).toBe(true);
    ctx.ui.collapseBtn.click();
    expect(ctx.ui.panelEl.classList.contains('collapsed')).toBe(false);
    expect(localStorage.getItem(desktopPreference)).toBe('0');
    expect(localStorage.getItem(phonePreference)).toBe('0');
  });

  test('resizing to a phone applies the compact default without storing it', () => {
    setViewport(1440, 900, 'fine');
    UA.bindDom(ctx);
    ctx.ui.citySel.focus();
    ctx.ui.panelEl.scrollTop = 300;

    setViewport(390, 844);

    expect(ctx.ui.panelEl.classList.contains('collapsed')).toBe(true);
    expect(ctx.ui.collapseBtn.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(ctx.ui.collapseBtn);
    expect(ctx.ui.panelEl.scrollTop).toBe(0);
    expect(localStorage.getItem(phonePreference)).toBeNull();
    expect(localStorage.getItem(desktopPreference)).toBeNull();
  });

  test('layout changes restore separate preferences and save subsequent clicks to the current layout', () => {
    setViewport(1440, 900, 'fine');
    UA.bindDom(ctx);

    setViewport(390, 844);
    ctx.ui.collapseBtn.click();
    expect(localStorage.getItem(phonePreference)).toBe('0');
    expect(localStorage.getItem(desktopPreference)).toBeNull();

    setViewport(1440, 900, 'fine');
    expect(ctx.ui.panelEl.classList.contains('collapsed')).toBe(false);
    ctx.ui.collapseBtn.click();
    expect(localStorage.getItem(desktopPreference)).toBe('1');
    expect(localStorage.getItem(phonePreference)).toBe('0');

    setViewport(390, 844);
    expect(ctx.ui.panelEl.classList.contains('collapsed')).toBe(false);
    setViewport(1440, 900, 'fine');
    expect(ctx.ui.panelEl.classList.contains('collapsed')).toBe(true);
  });

  test('repeated DOM setup and later full UI binding preserve the current state and toggle once', () => {
    UA.bindDom(ctx);
    expect(ctx.ui.panelEl.classList.contains('collapsed')).toBe(true);
    ctx.ui.collapseBtn.click();
    expect(ctx.ui.panelEl.classList.contains('collapsed')).toBe(false);

    UA.bindDom(ctx);
    UA.bindUi(ctx);

    expect(ctx.ui.panelEl.classList.contains('collapsed')).toBe(false);
    ctx.ui.collapseBtn.click();
    expect(ctx.ui.panelEl.classList.contains('collapsed')).toBe(true);
    expect(ctx.ui.collapseBtn.getAttribute('aria-expanded')).toBe('false');

    ctx.ui.legendBtn.click();
    expect(ctx.ui.legendBox.style.display).toBe('block');
    expect(ctx.ui.legendBtn.getAttribute('aria-expanded')).toBe('true');
  });

  test('collapse returns focus from hidden controls and resets the panel scroll position', () => {
    setViewport(1440, 900, 'fine');
    UA.bindDom(ctx);
    ctx.ui.citySel.focus();
    ctx.ui.panelEl.scrollTop = 300;

    ctx.ui.collapseBtn.click();

    expect(ctx.ui.panelEl.classList.contains('collapsed')).toBe(true);
    expect(document.activeElement).toBe(ctx.ui.collapseBtn);
    expect(ctx.ui.panelEl.scrollTop).toBe(0);
  });

  test('the information button reveals its legend even while the phone panel is collapsed', () => {
    UA.bindDom(ctx);

    ctx.ui.legendBtn.click();

    expect(ctx.ui.panelEl.classList.contains('collapsed')).toBe(false);
    expect(ctx.ui.legendBox.style.display).toBe('block');
    expect(ctx.ui.legendBtn.getAttribute('aria-expanded')).toBe('true');
    expect(localStorage.getItem(phonePreference)).toBeNull();
  });

  test('hiding the legend returns focus to its disclosure button', () => {
    setViewport(1440, 900, 'fine');
    UA.bindDom(ctx);
    ctx.ui.legendBtn.click();
    const link = document.createElement('a');
    link.href = '#legend';
    link.textContent = 'Legend link';
    ctx.ui.legendBox.appendChild(link);
    link.focus();

    ctx.ui.legendBtn.click();

    expect(ctx.ui.legendBox.style.display).toBe('none');
    expect(ctx.ui.legendBtn.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(ctx.ui.legendBtn);
  });

  test('blocked local storage does not prevent expanding or collapsing the phone panel', () => {
    jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Storage blocked'); });
    jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage blocked'); });

    UA.bindDom(ctx);
    expect(ctx.ui.panelEl.classList.contains('collapsed')).toBe(true);
    ctx.ui.collapseBtn.click();
    expect(ctx.ui.panelEl.classList.contains('collapsed')).toBe(false);
    ctx.ui.collapseBtn.click();
    expect(ctx.ui.panelEl.classList.contains('collapsed')).toBe(true);
  });

  test('browsers without matchMedia keep an operable expanded default', () => {
    delete window.matchMedia;
    UA.bindDom(ctx);
    expect(ctx.ui.panelEl.classList.contains('collapsed')).toBe(false);

    ctx.ui.collapseBtn.click();

    expect(ctx.ui.panelEl.classList.contains('collapsed')).toBe(true);
    expect(localStorage.getItem(desktopPreference)).toBe('1');
  });
});
