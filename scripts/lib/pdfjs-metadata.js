'use strict';

// PDF.js 6.3 returns custom document information and MarkInfo as Maps.
// Preserve those entries when an inspection subprocess emits JSON evidence.
function pdfMetadataJsonReplacer(_key, value) {
  return value instanceof Map ? Object.fromEntries(value) : value;
}

function pdfInfoEntry(info, name) {
  const custom = info instanceof Map ? info.get('Custom') : info?.Custom;
  for (const container of [info, custom]) {
    if (!container || typeof container !== 'object') continue;
    const entries = container instanceof Map ? [...container] : Object.entries(container);
    const match = entries.find(([key]) => key.toLowerCase() === name.toLowerCase());
    if (match) return match[1];
  }
  return undefined;
}

module.exports = { pdfMetadataJsonReplacer, pdfInfoEntry };
