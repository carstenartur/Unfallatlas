#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const samples = require('./generate-sample-docx');
const {
  toDataUrl
} = require('./deterministic-map-fixture');
async function generateSamplePdf(options = {}) {
  const scenario = samples.resolveScenario(options.scenario);
  const ctx = samples.createContext(scenario),
    report = samples.createReportData(scenario);
  const maps = samples.createScenarioMaps(ctx, scenario);
  const pdfMake = require('./pdfmake-node');
  let captured;
  const root = {
    UA: {},
    location: {
      href: 'https://carstenartur.github.io/Unfallatlas/werkbank_v2.html',
      pathname: '/Unfallatlas/werkbank_v2.html',
      origin: 'https://carstenartur.github.io',
      protocol: 'https:',
      host: 'carstenartur.github.io',
      search: '',
      hash: ''
    },
    pdfMake: {
      createPdf(definition) {
        captured = pdfMake.createPdf(definition);
        captured.download = () => {};
        return captured;
      }
    }
  };
  for (const file of ['ua.utils.js', 'ua.report_v2.js']) new Function('window', fs.readFileSync(path.join(__dirname, '..', 'js', file), 'utf8'))(root);
  root.UA.captureExportMapImage = async (_ctx, opts = {}) => toDataUrl((opts.exportPoints ? maps.overview : maps.selection).png);
  root.UA._captureDetailMap = async () => toDataUrl(maps.detail.png);
  root.UA._captureClusterMaps = async () => [{
    image: toDataUrl(maps.cluster.png),
    bounds: maps.cluster.receipt.bounds,
    total: maps.cluster.receipt.markerCount,
    points: ctx.allPts.slice(0, scenario.clusterCount),
    label: samples.clusterLabel(scenario),
    zoom: scenario.zoom + 1,
    lat: scenario.center.lat,
    lon: scenario.center.lon
  }];
  await root.UA.exportToPDF(ctx, report, {
    ...scenario.exportOptions,
    _skipQAGate: true
  });
  if (!captured) throw new Error('PDF exporter did not create a document');
  const buffer = await captured.getBuffer(),
    outPath = path.resolve(options.outPath || path.join(__dirname, '..', 'out', 'ci-render-gate.pdf'));
  fs.mkdirSync(path.dirname(outPath), {
    recursive: true
  });
  fs.writeFileSync(outPath, buffer);
  fs.writeFileSync(`${outPath}.maps.json`, JSON.stringify(Object.values(maps).map(m => m.receipt), null, 2));
  return {
    outPath,
    bytes: buffer.length,
    maps: Object.values(maps).map(m => m.receipt)
  };
}
if (require.main === module) {
  const i = process.argv.indexOf('--out');
  generateSamplePdf({
    outPath: i >= 0 ? process.argv[i + 1] : undefined
  }).then(r => console.log(`[generate-sample-pdf] ${r.bytes} bytes; four snapshot-bound maps → ${r.outPath}`)).catch(e => {
    console.error(e.stack);
    process.exitCode = 1;
  });
}
module.exports = {
  generateSamplePdf
};
