'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { readJsonMaybeGz } = require('./read-json-maybe-gz');

const numbers = new Intl.NumberFormat('de-DE');
const count = value => Number.isSafeInteger(value) && value >= 0 ? numbers.format(value) : 'unbekannt';

function readDelivered(root, relative) {
  if (!relative) return null;
  const file = path.resolve(root, relative.replace(/^\/+/, '').replace(/\.gz$/, ''));
  if (!fs.existsSync(file) && !fs.existsSync(file + '.gz')) return null;
  return readJsonMaybeGz(file, {mode: 'raw-ok'});
}

function sourceLinks(source, label = source.publisher || source.datasetTitle) {
  return [
    {label, url: source.datasetUrl},
    {label: label + ' · Originaldaten', url: source.distributionUrl},
    {label: source.licenseId, url: source.licenseUrl},
  ].filter(link => link.url);
}

function retrievalDate(source) {
  const date = source.retrievedAt?.slice(0, 10);
  return date ? ' · Abruf ' + date : '';
}

function roadMeasurements(root, manifest, metadataByCity) {
  const rows = [];
  for (const [slug, city] of Object.entries(manifest?.cities || {})) {
    if (!city.enrichment?.metaPath) continue;
    const meta = metadataByCity?.has(slug)
      ? metadataByCity.get(slug)
      : readDelivered(root, city.enrichment.metaPath);
    const evidence = meta?.sources?.trafficMatched;
    if (!evidence?.source || !meta.traffic?.numericValuesPresent) continue;
    const {source, coverage = {}} = evidence;
    if (!['count', 'model'].includes(source.measurementType)) continue;
    const typed = meta.traffic.featureTypes?.[source.measurementType] ?? meta.traffic.typedFeatures;
    if (!(typed > 0)) continue;
    const places = city.name || ({koeln: 'Köln', hamburg: 'Hamburg'})[slug] || slug;
    const period = source.temporalCoverage || 'Zeitraum unbekannt';
    const context = count(typed) + ' von ' + count(meta.counts?.features) + ' Unfallpunkten';
    let detail;
    if (source.sourceId === 'traffic.count.koeln-kfz-osm-2016-2019') {
      detail = 'Die Stadt Köln rechnete Kfz-Zählungen an Werktagen auf Tageswerte hoch (' + source.unit + '). '
        + count(coverage.publishedObservations) + ' von ' + count(coverage.totalObservations)
        + ' Richtungsbeobachtungen konnten Straßen eindeutig zugeordnet werden. '
        + count(coverage.excludedAmbiguousObservations) + ' waren mehrdeutig, '
        + count(coverage.excludedUnmatchedObservations) + ' blieben ohne Zuordnung.';
    } else if (source.sourceId === 'traffic.count.bast-annual-dtv-2023') {
      detail = 'Der bundesweite BASt-Jahresexport umfasst ' + count(coverage.stationCount)
        + ' Zählstellen. In diesem Stadtbestand sind ' + count(coverage.matchedStations)
        + ' Zählstellen einer Straße zugeordnet. Der Jahresdurchschnitt (' + source.unit
        + ') gilt am Zählquerschnitt. Die Messwerte je Fahrtrichtung werden getrennt ausgewiesen.';
    } else {
      detail = source.datasetTitle + (source.unit ? ' (' + source.unit + ').' : '.');
    }
    const type = source.measurementType === 'model' ? 'Modellwerte' : 'Zählwerte';
    rows.push({
      label: places + ' · ' + type + ' im Unfallkontext',
      coverage: context + ' · ' + period + retrievalDate(source),
      description: detail,
      sources: sourceLinks(source),
      license: source.licenseId || 'In den Quelldaten nicht angegeben',
    });
  }
  return rows;
}

function buildMobilityDataSources(siteRoot, manifest = readDelivered(siteRoot, 'out/data-manifest.json'), metadataByCity) {
  const rows = roadMeasurements(siteRoot, manifest, metadataByCity);
  const station = readDelivered(siteRoot, 'data/mobility/duesseldorf-mannesmannufer-2024.json');
  if (station?.sources?.counts && station.hours) {
    const {counts, station: location, osm} = station.sources;
    const hours = Object.values(station.hours).filter(values => Array.isArray(values) && values.some(Number.isFinite));
    const readings = hours.reduce((sum, values) => sum + values.filter(Number.isFinite).length, 0);
    if (readings > 0) rows.push({
      label: 'Düsseldorf · Radzählstelle Mannesmannufer',
      coverage: count(hours.length) + ' Stunden mit ' + count(readings) + ' Richtungswerten · ' + counts.temporalCoverage + retrievalDate(counts),
      description: 'Gemessene Fahrräder pro Stunde je Fahrtrichtung an einer Zählstelle. Die Karte zeigt die Originalstunden am Stationspunkt. Fehlende Stunden bleiben offen.',
      sources: [
        ...sourceLinks(counts, 'Düsseldorf · Stundenwerte'),
        ...sourceLinks(location, 'Amtlicher Standort'),
        ...sourceLinks(osm, 'OpenStreetMap · Radweg'),
      ],
      license: 'Stundenwerte ' + counts.licenseId + ', Standort ' + location.licenseId + ', Radweg ' + osm.licenseId,
    });
  }
  const costs = readDelivered(siteRoot, 'data/cost_factors_de.json');
  if (costs?.source && Object.keys(costs.perPerson || {}).length) {
    rows.push({
      label: 'Kostensätze für Personenschäden',
      coverage: count(Object.keys(costs.perPerson).length) + ' Kostensätze · Bezugsjahr ' + costs.source.year,
      description: 'Euro pro Person nach Verletzungsschwere. Die Rechnung setzt je Unfall eine Person der höchsten erfassten Schwere an. Weitere Betroffene und Sachschäden bleiben unberücksichtigt.',
      sources: [{label: costs.source.title, url: costs.source.url}],
      license: 'Keine separate Datenlizenz in der Kostentabelle angegeben',
    });
  }
  const catalog = readDelivered(siteRoot, 'data/measures_catalog.json');
  if (catalog?.measures?.length) {
    const sources = catalog.sources.map(source => ({label: source.title, url: source.url}));
    rows.push({
      label: 'Maßnahmenkatalog',
      coverage: count(catalog.measures.length) + ' Maßnahmen · Katalogversion ' + catalog.version,
      description: 'Maßnahmen mit Kosten- und Wirkungsspannen für die Planung. Die Spannen dienen der Orientierung. Für die BASt-Berichte verweist der Katalog auf das Publikationsverzeichnis, eine genaue Fundstelle je Wirkungsspanne fehlt.',
      sources,
      license: 'Keine separate Datenlizenz im Katalog angegeben',
    });
  }
  return rows;
}

module.exports = {buildMobilityDataSources};
