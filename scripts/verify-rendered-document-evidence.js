'use strict';

const fs = require('fs');

const evidenceRoot = process.env.DOCUMENT_RENDER_EVIDENCE_DIR || 'out/qa/rendered-document/docx';
const requiredFiles = [
  'source.docx',
  'converted.pdf',
  'conversion-metadata.json',
  'poppler/rendered-document.json',
  'poppler/rendered-document-audit.json',
];

for (const relative of requiredFiles) {
  const file = `${evidenceRoot}/${relative}`;
  if (!fs.existsSync(file) || fs.statSync(file).size === 0) {
    throw new Error(`Required rendered-document evidence is missing or empty: ${file}`);
  }
}

const pageFiles = fs.readdirSync(`${evidenceRoot}/pages`)
  .filter(name => /^page-.*\.png$/i.test(name))
  .map(name => `${evidenceRoot}/pages/${name}`)
  .filter(file => fs.statSync(file).size > 10 * 1024);
if (pageFiles.length === 0) {
  throw new Error('No rendered DOCX page PNG larger than 10 KiB was produced');
}

const metadata = JSON.parse(fs.readFileSync(
  `${evidenceRoot}/conversion-metadata.json`,
  'utf8',
));
const model = JSON.parse(fs.readFileSync(
  `${evidenceRoot}/poppler/rendered-document.json`,
  'utf8',
));
const audit = JSON.parse(fs.readFileSync(
  `${evidenceRoot}/poppler/rendered-document-audit.json`,
  'utf8',
));
const semantic = metadata.semanticEvidence || {};
if (semantic.mapCount !== 4 || semantic.expectedMapCount !== 4) {
  throw new Error(`Expected four final maps, got ${JSON.stringify(semantic)}`);
}
if (semantic.tableRowCount !== 10 || semantic.expectedTableRowCount !== 10 ||
    semantic.tableHints !== 3 || semantic.tableSectionBindings !== 1) {
  throw new Error(
    'Expected three final table contracts, ten rows and one section binding, got ' +
    JSON.stringify(semantic)
  );
}
if (audit.summary?.tableRowCount !== 10 || audit.passed !== true) {
  throw new Error(
    'Final rendered-document audit does not prove ten table rows: ' +
    JSON.stringify(audit.summary)
  );
}

const rows = model.pages.flatMap(page => page.tableRows || []);
const byId = new Map(rows.map(row => [row.rowId, row]));
const expectedRows = {
  'severity.header': ['Kategorie', 'Anzahl', 'Anteil'],
  'severity.fatal': ['1 – Getötete', '1', '4,2%'],
  'severity.serious': ['2 – Schwerverletzte', '6', '25,0%'],
  'severity.light': ['3 – Leichtverletzte', '17', '70,8%'],
  'deviations.header': ['Muster', 'Lokal', 'Lokal%', 'Stadt%', 'Faktor', '95%-KI (lokaler Anteil)'],
  'deviations.rad-car': ['5', '11', '45,8%', '14,6%', '3,13×', '[– – –]'],
  'yearly-accidents.header': ['Jahr', 'Summe', 'Kombinationen'],
  'yearly-accidents.2022': ['2022', '7', 'Radverkehr + PKW=3, Radverkehr=2, PKW=2'],
  'yearly-accidents.2023': ['2023', '8', 'Radverkehr + PKW=4, Radverkehr=2, PKW=2'],
  'yearly-accidents.2024': ['2024', '9', 'Radverkehr + PKW=4, Radverkehr=3, PKW=2'],
};
for (const [rowId, expectedCells] of Object.entries(expectedRows)) {
  const row = byId.get(rowId);
  if (!row || JSON.stringify(row.cells) !== JSON.stringify(expectedCells)) {
    throw new Error(`Missing or changed final row ${rowId}: ${JSON.stringify(row || null)}`);
  }
}

const pageText = new Map(model.pages.map(page => [
  page.number,
  [...(page.words || [])]
    .sort((left, right) => left.yMin - right.yMin || left.xMin - right.xMin)
    .map(word => word.text)
    .join(' ')
    .replace(/\s+/g, ' '),
]));
const requirePagePattern = (pageNumber, expression, label) => {
  const text = pageText.get(pageNumber) || '';
  if (!expression.test(text)) {
    throw new Error(`Final page ${pageNumber} lacks ${label}: ${text}`);
  }
};
for (const [pageNumber, text] of pageText.entries()) {
  if (/\(n\s*=\s*0\)/u.test(text) || /Teilmenge der\s+0\s+Unfälle/u.test(text)) {
    throw new Error(`Final page ${pageNumber} contains a zero-count map contradiction: ${text}`);
  }
}
requirePagePattern(2, /Top-Abweichungen \(Ausschnitt vs\. Stadt\):/u, 'deviation-table subsection heading');
requirePagePattern(2, /Muster\s+Lokal\s+Lokal\s+%\s+Stadt\s+%\s+Faktor\s+95%-KI/u, 'deviation-table header');
requirePagePattern(2, /5\s+11\s+45,8\s*%\s+14,6\s*%\s+3,13×/u, 'deviation-table first row');
requirePagePattern(2, /Punkte entsprechen exakt[^.]*\(n\s*=\s*24\)/u, 'overview-map count n=24');
requirePagePattern(3, /Punkte entsprechen exakt[^.]*\(n\s*=\s*24\)/u, 'selection-map count n=24');
requirePagePattern(4, /Teilmenge der\s+24\s+Unfälle aus Abbildung 2/u, 'detail-map parent count 24');
requirePagePattern(4, /Punkte entsprechen exakt[^.]*\(n\s*=\s*24\)/u, 'detail-map count n=24');
requirePagePattern(5, /Teilmenge der\s+24\s+Unfälle aus Abbildung 2/u, 'cluster-map parent count 24');
requirePagePattern(5, /Punkte entsprechen exakt[^.]*\(n\s*=\s*11\)/u, 'cluster-map count n=11');

console.log(`[document-render] Verified ${pageFiles.length} rendered DOCX page image(s) and semantic evidence.`);
