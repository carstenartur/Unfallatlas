'use strict';

const fs = require('fs');
const path = require('path');

describe('Werkbank export-progress browser contract', () => {
  test('recognises every displayed Fehler status without waiting for the timeout', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../e2e/werkbank.spec.js'),
      'utf8'
    );
    const expectedGuard = "return text === 'Fertig.' || /^Fehler\\b/i.test(text);";

    expect(source).toContain(expectedGuard);

    const errorStatus = /^Fehler\b/i;
    expect(errorStatus.test('Fehler. Bericht konnte nicht erzeugt werden.')).toBe(true);
    expect(errorStatus.test('Fehler: Bericht konnte nicht erzeugt werden.')).toBe(true);
    expect(errorStatus.test('fehler beim Export')).toBe(true);
    expect(errorStatus.test('Fehlerlos abgeschlossen')).toBe(false);
  });
});
