'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const city = require('../../docs/qa/hannover-dgm1-samples.json');
const comparison = require('../../docs/qa/hannover-dgm1-survey-comparison.json');
const sources = require('../../config/hannover-dgm1-lgln-reference-tiles.json');

const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function median(values) {
  values.sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
}

function theilSen(rows, heightIndex) {
  const slopes = [];
  for (let end = 1; end < rows.length; end += 1) {
    for (let start = 0; start < end; start += 1) {
      slopes.push((rows[end][heightIndex] - rows[start][heightIndex]) / (rows[end][0] - rows[start][0]));
    }
  }
  return 100 * median(slopes);
}

test('each comparison preserves identical stations, source height systems, pinned samples and both independent slopes', () => {
  expect(comparison.sources.municipalVerticalDatum).toBeNull();
  expect(sources.verticalDatum).toBe('DE_DHHN2016_NH');
  expect(sources.tileReferenceDate).toBe('2016-04-18');
  expect(comparison.sources.stateTileReferenceDate).toBe(sources.tileReferenceDate);
  expect(sources).not.toHaveProperty('acquisitionDate');
  expect(comparison.sources).not.toHaveProperty('stateSurveyDate');
  expect(comparison.profiles.map(p => p.wayId)).toEqual(city.profiles.map(p => p.wayId));
  for (const [index, profile] of comparison.profiles.entries()) {
    const rows = profile.samples;
    expect(rows.map(row => row.slice(0, 2))).toEqual(city.profiles[index].profile);
    const csv = rows.map(([d, cityZ, stateZ]) => `${d.toFixed(3)},${cityZ.toFixed(4)},${stateZ.toFixed(4)}\n`).join('');
    expect(profile.sampleSha256).toBe(digest(Buffer.from(csv)));
    expect(profile.stateTiles.length).toBeGreaterThan(0);
    for (const id of profile.stateTiles) expect(sources.tiles.find(t => t.id === id)).toBeDefined();
    const fit = profile.fits.find(f => f.windowM === 50 && f.stepM === 1);
    expect(Math.abs(fit.cityPercent - theilSen(rows, 1))).toBeLessThan(0.015);
    expect(Math.abs(fit.statePercent - theilSen(rows, 2))).toBeLessThan(0.015);
    expect(profile.fits.map(f => [f.windowM, f.stepM])).toEqual([[20, 1], [20, 2], [20, 5], [50, 1], [50, 2], [50, 5]]);
  }
  for (const name of ['config/hannover-dgm1-city-archives.json', 'config/hannover-dgm1-lgln-reference-tiles.json']) {
    expect(comparison.sources.fileSha256[name]).toBe(digest(fs.readFileSync(path.join(__dirname, '../..', name))));
  }
});
