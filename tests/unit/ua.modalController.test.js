/**
 * @jest-environment jsdom
 */

const fs = require('fs');
const path = require('path');

function loadUtils() {
  window.UA = {};
  const source = fs.readFileSync(path.resolve(__dirname, '../../js/ua.utils.js'), 'utf8');
  // eslint-disable-next-line no-eval
  eval(source);
  return window.UA;
}

describe('UA modal controller', () => {
  beforeEach(() => {
    document.documentElement.className = '';
    document.body.innerHTML = `
      <main id="background"><button id="trigger" type="button">Öffnen</button></main>
      <div id="dialog" role="dialog" aria-modal="true" aria-hidden="true" style="display:none">
        <button id="first" type="button">Erste Aktion</button>
        <input id="field" />
        <button id="last" type="button">Schließen</button>
      </div>
    `;
  });

  test('inerts the background, traps Tab and restores focus after Escape', () => {
    const UA = loadUtils();
    const overlay = document.getElementById('dialog');
    const background = document.getElementById('background');
    const trigger = document.getElementById('trigger');
    const first = document.getElementById('first');
    const last = document.getElementById('last');
    const controller = UA.createModalController(overlay, { initialFocus: '#first' });

    trigger.focus();
    controller.open();

    expect(overlay.style.display).toBe('flex');
    expect(overlay.getAttribute('aria-hidden')).toBeNull();
    expect(document.activeElement).toBe(first);
    expect(background.inert).toBe(true);
    expect(background.getAttribute('aria-hidden')).toBe('true');

    last.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(first);

    first.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Tab', shiftKey: true, bubbles: true, cancelable: true,
    }));
    expect(document.activeElement).toBe(last);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(overlay.style.display).toBe('none');
    expect(overlay.getAttribute('aria-hidden')).toBe('true');
    expect(background.inert).toBe(false);
    expect(background.getAttribute('aria-hidden')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  test('closes only when the backdrop itself is activated', () => {
    const UA = loadUtils();
    const overlay = document.getElementById('dialog');
    const first = document.getElementById('first');
    const controller = UA.createModalController(overlay);
    controller.open();

    first.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(controller.isOpen()).toBe(true);

    overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(controller.isOpen()).toBe(false);
  });

  test('double open is idempotent and restores the original background state', () => {
    const UA = loadUtils();
    const overlay = document.getElementById('dialog');
    const background = document.getElementById('background');
    const controller = UA.createModalController(overlay);
    controller.open();
    controller.open();
    controller.close();
    expect(background.inert).toBe(false);
    expect(background.getAttribute('aria-hidden')).toBeNull();
  });

  test('uses a visible fallback when the configured return target becomes unusable', () => {
    const UA = loadUtils();
    const overlay = document.getElementById('dialog');
    const trigger = document.getElementById('trigger');
    const fallback = document.createElement('button');
    fallback.id = 'fallback';
    document.getElementById('background').appendChild(fallback);
    const controller = UA.createModalController(overlay, {
      returnFocus: trigger,
      fallbackFocus: fallback,
    });
    trigger.focus();
    controller.open();
    trigger.disabled = true;
    controller.close();
    expect(document.activeElement).toBe(fallback);
  });

  test('export integration delegates focus handling only to the shared controller', () => {
    const appSource = fs.readFileSync(path.resolve(__dirname, '../../js/ua.app_v2.js'), 'utf8');
    expect(appSource).toContain('UA.createModalController(ui.modalOverlay');
    expect(appSource).not.toContain('focusWithoutScrolling');
  });
});
