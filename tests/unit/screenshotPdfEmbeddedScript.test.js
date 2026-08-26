'use strict';

const fs = require('fs');
const path = require('path');

describe('PDF screenshot embedded renderer', () => {
  test('survives both template-literal and inner-script parsing', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../e2e/screenshots.spec.js'),
      'utf8'
    );
    const template = source.match(/await page\.setContent\(`([\s\S]*?)`\);/);
    expect(template).not.toBeNull();

    const renderTemplate = new Function(
      'expectedLocalAccidents',
      `return \`${template[1]}\`;`
    );
    const html = renderTemplate(12);
    const embedded = html.match(/<script type="module">([\s\S]*?)<\/script>/);
    expect(embedded).not.toBeNull();

    const script = embedded[1];
    expect(script).toContain("replace(/\\s+/g, ' ')");
    expect(script).toContain("text.includes('ANTRAG / BESCHLUSSVORSCHLAG')");
    expect(script).toContain("text.includes('Abbildung 1: Übersichtskarte')");
    expect(script).toContain("text.includes('Abbildung 2: Auswahl-Karte')");
    expect(script).toContain('spreadPageNumbers = [proposalPageNumber, mapPageNumber]');
    expect(script).not.toContain('spreadPageNumbers = [1, 2]');
    expect(script).toContain("pageTexts.join('\\n')");
    expect(() => new Function(`return async function () {${script}}`)).not.toThrow();
  });
});
