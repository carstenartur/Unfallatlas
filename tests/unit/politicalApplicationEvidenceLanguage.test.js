'use strict';

const fs = require('fs');
const path = require('path');

describe('kommunalpolitische Antragstemplates – Evidenzsprache', () => {
  const readTemplate = name => fs.readFileSync(
    path.resolve(__dirname, '../../templates', name),
    'utf8'
  );

  test('der Antragstitel behauptet nicht unabhängig vom Analyseergebnis einen Unfallschwerpunkt', () => {
    const intro = readTemplate('base_intro.txt');

    expect(intro).not.toMatch(/Auffälliger Unfallschwerpunkt/i);
    expect(intro).toMatch(/Verkehrssicherheitsprüfung.*amtlich dokumentierter Unfälle/i);
    expect(intro).toMatch(/polizeilichen Meldungen/i);
    expect(intro).toMatch(/einzelner Unfallschwerpunkt.*räumliche Teilprobleme.*streckenbezogenes Sicherheitsdefizit/is);
  });

  test('Beschluss und Begründung trennen dokumentierte Unfalltatsachen von Ursachen- und Maßnahmenprüfung', () => {
    const resolution = readTemplate('base_resolution.txt');

    expect(resolution).not.toMatch(/Die Auswertung zeigt.*auffällige Abweichung bestimmter Unfallmuster/i);
    expect(resolution).toMatch(/amtlich dokumentierten Unfälle mit Personenschaden/i);
    expect(resolution).toMatch(/beweist jedoch weder automatisch einen einzelnen Unfallschwerpunkt noch eine bestimmte Unfallursache/i);
    expect(resolution).toMatch(/kurzfristig umsetzbare und risikoarme Sicherungsmaßnahmen/i);
    expect(resolution).toMatch(/Anträge, Beschlüsse, Anfragen, Verwaltungsantworten, Planungen/i);
    expect(resolution).toMatch(/Konflikt-, Geschwindigkeits- und Verkehrsdaten/i);
  });

  test('politische Vorbefassung ist eine ausdrückliche Anlage und kein stiller optionaler Nebenpfad', () => {
    const intro = readTemplate('base_intro.txt');
    const resolution = readTemplate('base_resolution.txt');

    expect(intro).toMatch(/politische Vorbefassung.*Rechercheprotokoll/i);
    expect(resolution).toMatch(/direkten Quellenlinks/i);
    expect(resolution).toMatch(/politischer Vorbefassung abgeglichen/i);
  });
});
