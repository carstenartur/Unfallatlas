'use strict';

const fs = require('fs');
const path = require('path');

describe('kommunalpolitische Antragstemplates – Evidenzsprache', () => {
  const readTemplate = name => fs.readFileSync(
    path.resolve(__dirname, '../../templates', name),
    'utf8'
  );

  test('kein generischer Antragstitel behauptet unabhängig vom Analyseergebnis einen Unfallschwerpunkt', () => {
    const baseIntro = readTemplate('base_intro.txt');
    const intro = readTemplate('intro.txt');

    expect(baseIntro).not.toMatch(/Auffälliger Unfallschwerpunkt/i);
    expect(intro).not.toMatch(/Auffälliger Unfallschwerpunkt/i);
    expect(baseIntro).toMatch(/Verkehrssicherheitsprüfung.*amtlich dokumentierter Unfälle/i);
    expect(intro).toMatch(/Grundlage amtlich dokumentierter Unfälle/i);
    expect(baseIntro).toMatch(/polizeilichen Meldungen/i);
    expect(baseIntro).toMatch(/einzelner Unfallschwerpunkt.*räumliche Teilprobleme.*streckenbezogenes Sicherheitsdefizit/is);
  });

  test('Beschluss und Begründung trennen dokumentierte Unfalltatsachen von Ursachen- und Maßnahmenprüfung', () => {
    const baseResolution = readTemplate('base_resolution.txt');
    const resolution = readTemplate('beschluss.txt');

    expect(baseResolution).not.toMatch(/Die Auswertung zeigt.*auffällige Abweichung bestimmter Unfallmuster/i);
    expect(baseResolution).toMatch(/amtlich dokumentierten Unfälle mit Personenschaden/i);
    expect(baseResolution).toMatch(/beweist jedoch weder automatisch einen einzelnen Unfallschwerpunkt noch eine bestimmte Unfallursache/i);
    expect(baseResolution).toMatch(/kurzfristig umsetzbare und risikoarme Sicherungsmaßnahmen/i);
    expect(baseResolution).toMatch(/Anträge, Beschlüsse, Anfragen, Verwaltungsantworten, Planungen/i);
    expect(baseResolution).toMatch(/Konflikt-, Geschwindigkeits- und Verkehrsdaten/i);

    expect(resolution).toMatch(/amtlich dokumentierten Unfälle mit Personenschaden/i);
    expect(resolution).toMatch(/ein einzelner Unfallschwerpunkt, mehrere räumliche Teilprobleme oder ein streckenbezogenes Sicherheitsdefizit/i);
    expect(resolution).toMatch(/bestehende Anträge, Beschlüsse, Anfragen, Verwaltungsantworten, Planungen/i);
    expect(resolution).toMatch(/kurzfristig umsetzbare und risikoarme Sicherungsmaßnahmen/i);
    expect(resolution).toMatch(/Konflikt-, Geschwindigkeits- und Verkehrsdaten/i);
  });

  test('absolute Lokal- und Stadtfallzahlen werden nicht ohne geeigneten Nenner als Überrepräsentation verkauft', () => {
    const facts = readTemplate('sachverhalt.txt');

    expect(facts).toMatch(/amtlich dokumentierte Unfälle mit Personenschaden/i);
    expect(facts).toMatch(/absoluten Fallzahlen unterschiedlich großer Räume folgt für sich allein noch keine lokale Überrepräsentation/i);
    expect(facts).toMatch(/geeignete Bezugsgröße und statistische Einordnung/i);
  });

  test('politische Vorbefassung ist eine ausdrückliche Anlage und kein stiller optionaler Nebenpfad', () => {
    const intro = readTemplate('base_intro.txt');
    const baseResolution = readTemplate('base_resolution.txt');
    const resolution = readTemplate('beschluss.txt');

    expect(intro).toMatch(/politische Vorbefassung.*Rechercheprotokoll/i);
    expect(baseResolution).toMatch(/direkten Quellenlinks/i);
    expect(baseResolution).toMatch(/politischer Vorbefassung abgeglichen/i);
    expect(resolution).toMatch(/direkten Quellenlinks/i);
  });
});
