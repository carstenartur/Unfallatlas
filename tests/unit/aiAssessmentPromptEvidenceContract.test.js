'use strict';

const {
  PROMPT_VERSION,
  OFFICIAL_UNFALLATLAS_URL,
  OFFICIAL_DESTATIS_URL,
  SYSTEM_PROMPT_ASSESSMENT,
  SYSTEM_PROMPT_PROPOSAL,
  buildPrompt
} = require('../../server/ai/prompts/exportAssessmentPrompt.v2.js');

function aiInput() {
  return {
    meta: {
      city: 'Bonn',
      areaName: 'Bonn Hauptbahnhof',
      date: '15.08.2026',
      link: 'https://example.test/werkbank_v2.html?city=Bonn&export=1',
      gremium: { name: 'Bezirksvertretung Bonn', type: 'Bezirksvertretung' }
    },
    features: {
      counts: { total: 7, fatal: 0, serious: 2, slight: 5 },
      ksiShare: 2 / 7,
      involvement: {
        bike: 1,
        ped: 0,
        car: 1,
        moto: 0,
        truck: 0,
        sampleSize: 7
      },
      dominantPatterns: [
        { label: 'Rad + Pkw', localCount: 7, relativeDiff: 1.2 }
      ],
      trend: {
        direction: 'stable',
        rangeYears: 7,
        firstYear: 2019,
        lastYear: 2025,
        relativeChange: 0
      },
      spatialDensity: {
        hint: 'tight_cluster',
        spanMeters: 350,
        sampleSize: 7,
        totalAccidents: 7
      },
      tags: ['bike_car'],
      references: [],
      normalizedHints: {},
      conflictPatterns: []
    },
    preselectedMeasures: [{
      id: 'qw_marking_bike_lane',
      category: 'quickWin',
      implementationEffort: 'low',
      costBand: 'low',
      title: 'Markierung und Führung prüfen',
      description: 'Markierung und Führung fachlich überprüfen.',
      reasonForPreselection: 'Rad-Pkw-Muster im Untersuchungsraum'
    }]
  };
}

describe('server-side AI prompt preserves official Unfallatlas evidence', () => {
  test('keeps the existing cache-version contract while adding official sources', () => {
    expect(PROMPT_VERSION).toBe('exportAssessmentPrompt.v2.5');
    expect(OFFICIAL_UNFALLATLAS_URL).toBe('https://www.statistikportal.de/de/karten/unfallatlas');
    expect(OFFICIAL_DESTATIS_URL).toMatch(/destatis\.de/);
  });

  test.each([
    ['assessment', SYSTEM_PROMPT_ASSESSMENT],
    ['proposal-brief', SYSTEM_PROMPT_PROPOSAL]
  ])('%s system prompt distinguishes official facts from causal uncertainty', (mode, systemPrompt) => {
    const { system, user } = buildPrompt(aiInput(), mode);

    expect(system).toBe(systemPrompt);
    expect(system).toMatch(/amtlichen Statistik.*Meldungen der Polizeidienststellen/s);
    expect(system).toMatch(/Unfälle mit Personenschaden.*Sachschadensunfälle/s);
    expect(system).toMatch(/Unsicherheit über die genaue Ursache.*entwertet/s);
    expect(system).toMatch(/amtliche Tatsachen mit hohem Evidenzwert/);

    expect(user).toContain('=== DATENSTATUS UND EVIDENZREGEL ===');
    expect(user).toContain('Unfälle gesamt im Bereich: 7');
    expect(user).toContain('Getötete/Schwerverletzte/Leichtverletzte: 0 / 2 / 5');
    expect(user).toContain('=== QUALITÄTSAUFTRAG VOR TEXTGENERATION ===');
    expect(user).toContain('Behandle die genannten Unfälle als amtlich dokumentierte Tatsachen');
    expect(user).toContain('Verknüpfe jede Maßnahme mit mindestens einem konkreten Befund');
    expect(user).toContain(OFFICIAL_UNFALLATLAS_URL);
    expect(user).toContain(OFFICIAL_DESTATIS_URL);
  });

  test('proposal mode explicitly rejects pretty but fact-free prose', () => {
    const { system, user } = buildPrompt(aiInput(), 'proposal-brief');

    expect(system).toMatch(/Allgemeine Verkehrssicherheitsfloskeln ersetzen diesen Tatsachenkern nicht/);
    expect(system).toMatch(/Gib amtliche Unfallzahlen bestimmt und konkret wieder/);
    expect(user).toContain('Beginne Sachverhalt und Langfassung mit konkreter Unfallzahl');
    expect(user).toContain('keine bloße sprachliche Verschönerung der Kennzahlen');
    expect(user).toContain('evidenzbasierten, antragsfähigen Maßnahmensteckbrief');
  });
});
