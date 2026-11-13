'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { readJsonMaybeGz } = require('./read-json-maybe-gz');
const { getMapLayerRegistry } = require('../../js/ua.map_layer_registry');

const OSM_COPYRIGHT = 'https://www.openstreetmap.org/copyright';
const OSM_LICENSE = '© OpenStreetMap-Mitwirkende, ODbL 1.0';
const OSM_SOURCES = [
  { label: 'OpenStreetMap und Lizenz', url: OSM_COPYRIGHT },
  { label: 'Overpass API', url: 'https://overpass-api.de/' },
];
const ACCIDENT_ARCHIVE = 'https://www.opengeodata.nrw.de/produkte/transport_verkehr/unfallatlas/';

function readSourceFile(siteRoot, relativePath) {
  if (!relativePath) return null;
  const file = path.resolve(siteRoot, relativePath.replace(/^\/+/, ''));
  if (!fs.existsSync(file)) return null;
  return file.endsWith('.gz')
    ? readJsonMaybeGz(file, { mode: 'gzip-only' })
    : JSON.parse(fs.readFileSync(file, 'utf8'));
}

function cityCoverage(number, total) {
  return `${number} von ${total} Städten`;
}

function featureCoverage(members, total, family, label) {
  const coverage = cityCoverage(members.length, total);
  if (!members.every(city => Number.isSafeInteger(city[family].features))) return coverage;
  const features = members.reduce((sum, city) => sum + city[family].features, 0);
  return `${features.toLocaleString('de-DE')} ${label} · ${coverage}`;
}

function terrainRows(cities) {
  const groups = new Map();
  const profiles = [];
  for (const city of cities) {
    const { dem, roadSlope } = city.meta?.sources || {};
    if (city.slope?.present && dem?.source) {
      const api = /open[- ]?meteo/i.test(dem.source);
      const skadi = dem.sourceId === 'global.srtm30' || /SRTM Local Tiles/i.test(dem.source);
      const group = api ? 'GLO-90' : skadi ? 'Skadi' : dem.source;
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(city);
    }
    const usableRows = city.meta?.roadSlope?.runtimeWayRowsWithUsableGradient;
    if (roadSlope?.datasetUrl && Number(usableRows) > 0) {
      const times = [
        roadSlope.acquisitionPeriod,
        roadSlope.publicationDate && `veröffentlicht am ${roadSlope.publicationDate}`,
        roadSlope.retrievedAt && `abgerufen am ${roadSlope.retrievedAt.slice(0, 10)}`,
      ].filter(Boolean).join(', ');
      const windows = (roadSlope.windowsMeters || []).join(' und ');
      profiles.push({
        label: `Straßenlängsneigung · ${roadSlope.source || roadSlope.sourceId}`,
        coverage: `${city.name} · ${Number(usableRows).toLocaleString('de-DE')} nutzbare Wegeinträge`,
        description: [roadSlope.publisher, times, windows && `Aus Höhenwerten entlang der Straße berechnete Profile über ${windows} m`].filter(Boolean).join('. ') + '.',
        sources: [{ label: roadSlope.source || 'Geländemodell', url: roadSlope.datasetUrl },
          ...(roadSlope.licenseUrl ? [{ label: 'Lizenz', url: roadSlope.licenseUrl }] : [])],
        license: roadSlope.requiredAttribution || roadSlope.licenseName || 'Lizenz unbekannt',
      });
    }
  }
  const rows = [];
  for (const [group, members] of groups) {
    const coverage = cityCoverage(members.length, cities.length);
    const resolution = [...new Set(members.map(city => city.meta.sources.dem.resolutionM).filter(Number.isFinite))];
    const description = 'Aus den Rasterhöhen abgeleitete Geländeneigung im Umfeld der Straße.' +
      (resolution.length ? ` Die dokumentierte Rasterweite beträgt ${resolution.join(' / ')} m.` : '');
    if (group === 'Skadi') {
      rows.push({ label: 'Geländehöhe und Neigung · Terrain Tiles (Skadi)', coverage, description,
        sources: [{ label: 'Terrain Tiles auf AWS', url: 'https://registry.opendata.aws/terrain-tiles/' },
          { label: 'Ursprungsdaten und Lizenzen', url: 'https://github.com/tilezen/joerd/blob/master/docs/attribution.md' }],
        license: 'Mapzen / Tilezen, Nutzungsbedingungen je Ursprungsdatensatz' });
    } else if (group === 'GLO-90') {
      rows.push({ label: 'Geländehöhe und Neigung · Open-Meteo', coverage,
        description: 'Open-Meteo liefert Höhen aus dem Copernicus DEM 2021 GLO-90. ' + description,
        sources: [{ label: 'Open-Meteo Elevation API', url: 'https://open-meteo.com/en/docs/elevation-api' },
          { label: 'Copernicus DEM', url: 'https://doi.org/10.5270/ESA-c5d3d65' }],
        license: 'Copernicus DEM und Open-Meteo, siehe Quellenbedingungen' });
    } else {
      const source = members[0].meta.sources.dem;
      rows.push({ label: `Geländehöhe und Neigung · ${group}`, coverage, description,
        sources: source.datasetUrl ? [{ label: group, url: source.datasetUrl }] : [],
        license: source.requiredAttribution || source.licenseName || 'Lizenz unbekannt' });
    }
  }
  return rows.concat(profiles);
}

function mapRows(siteRoot) {
  const page = path.join(siteRoot, 'werkbank_v2.html');
  if (!fs.existsSync(page) || !fs.existsSync(path.join(siteRoot, 'js', 'ua.map_layer_registry.js'))) return [];
  const html = fs.readFileSync(page, 'utf8');
  if (!html.includes('js/ua.map_layer_registry.js')) return [];
  const hasCartoKey = /<meta\s+name="unfallwerkbank-carto-basemaps-key"\s+content="[^"\s]+"/.test(html);
  return getMapLayerRegistry().filter(layer => layer.id !== 'hybrid-labels' || hasCartoKey).map(layer => {
    if (layer.id === 'standard-osm') {
      return { label: layer.displayName, coverage: 'Interaktive Standardkarte',
        description: 'Kartenkacheln von OpenStreetMap. Die Karte wird beim Öffnen des Ausschnitts vom Kacheldienst geladen.',
        sources: [{ label: 'OpenStreetMap und Lizenz', url: OSM_COPYRIGHT },
          { label: 'Kacheldienst', url: 'https://operations.osmfoundation.org/policies/tiles/' }], license: OSM_LICENSE };
    }
    if (layer.id === 'hybrid-labels') {
      return { label: layer.displayName, coverage: 'Interaktive Hybridkarte',
        description: 'CARTO liefert Straßen- und Ortsnamen auf Grundlage von OpenStreetMap.',
        sources: [{ label: 'CARTO Basemaps', url: 'https://carto.com/basemaps/' },
          { label: 'CARTO-Nutzungsbedingungen', url: 'https://carto.com/legal/basemap-terms/' },
          { label: 'OpenStreetMap und Lizenz', url: OSM_COPYRIGHT }],
        license: '© OpenStreetMap-Mitwirkende, © CARTO' };
    }
    const sources = [{ label: layer.provider, url: layer.metadataUrl || layer.url }];
    if (layer.licenseUrl) sources.push({ label: 'Lizenz', url: layer.licenseUrl });
    if (layer.id === 'bkg-orthophoto') {
      sources.push({ label: 'BKG-Nutzungsbedingungen und Quellenvermerk', url: 'https://sg.geodatenzentrum.de/web_public/gdz/lizenz/deu/nutzungsbedingungen_dop.pdf' });
    }
    if (layer.id === 'esri-world-imagery') {
      sources.push({ label: 'Esri-Nutzungsbedingungen', url: 'https://www.esri.com/en-us/legal/terms/full-master-agreement' });
    }
    return { label: layer.displayName, coverage: layer.coverageNote || layer.scope,
      description: `Externer Kartendienst für die Orthofoto- und Hybridansicht. ${layer.updateInfo || ''}. ` +
        (layer.officialForExport ? 'Die Anzeige hängt von Standort, Verfügbarkeit und Dienstzugang ab.' : 'Die Werkbank verwendet diese Bilder ausschließlich in der interaktiven Vorschau.'),
      sources, license: layer.license };
  });
}

function buildBaseDataSources(siteRoot, cities, manifest, metadataByCity) {
  const entries = (manifest || readSourceFile(siteRoot, 'out/data-manifest.json'))?.cities || {};
  const rows = [];
  const accidentCities = cities.filter(city => city.accidents?.present);
  if (accidentCities.length) {
    const release = readSourceFile(siteRoot, 'data/accident-data-release.json');
    const source = release?.source || {};
    const years = accidentCities.flatMap(city => city.accidents.years || []).filter(Number.isInteger);
    const period = years.length ? ` Die ausgelieferten Daten umfassen die Berichtsjahre ${Math.min(...years)}–${Math.max(...years)}. Die Stadtmatrix zeigt die Zeitspanne jeder Stadt.` : '';
    rows.push({ label: 'Unfallatlas · Unfälle mit Personenschaden', coverage: featureCoverage(accidentCities, cities.length, 'accidents', 'Unfälle'),
      description: 'Die Statistischen Ämter des Bundes und der Länder veröffentlichen polizeilich erfasste Unfälle mit Personenschaden.' + period +
        (release?.officialReleaseDate ? ` Als amtliches Veröffentlichungsdatum ist ${release.officialReleaseDate} dokumentiert.` : ''),
      sources: [{ label: 'Jahresarchive und Datenbeschreibung', url: source.officialIndexUrl || ACCIDENT_ARCHIVE },
        { label: 'Amtlicher Unfallatlas', url: source.officialStatusUrl || 'https://unfallatlas.statistikportal.de/' },
        { label: 'Lizenz', url: source.licenseUrl || 'https://www.govdata.de/dl-de/by-2-0' }],
      license: `${source.publisher || 'Statistische Ämter des Bundes und der Länder'}, ${source.licenseId || 'DL-DE-BY-2.0'}` });
  }
  const withMetadata = cities.map(city => ({
    ...city,
    meta: metadataByCity?.has(city.slug)
      ? metadataByCity.get(city.slug)
      : readSourceFile(siteRoot, entries[city.slug]?.enrichment?.metaPath),
  }));
  const groups = [
    { label: 'Schulen und Kitas', matches: city => city.poi?.present, featureFamily: 'poi',
      description: 'Über Overpass abgefragte OpenStreetMap-Einträge für Schulen, Kindergärten und Kinderbetreuung. Flächen werden durch ihren Mittelpunkt dargestellt. Ein Objekt kann in mehreren Stadtausschnitten enthalten sein.' },
    { label: 'Straßennetz und Straßenmerkmale', countKey: 'fullWays', countLabel: 'Wegeinträge', matches: city => city.roads?.present && /openstreetmap|\bosm\b/i.test(city.roads.source || ''),
      description: 'Über Overpass bezogene OSM-Weggeometrien und kartierte Merkmale, darunter Straßenklasse, zulässiges Tempo, Fahrstreifen, Oberfläche und Radinfrastruktur. Unfälle werden räumlich zugeordnet. Die Wegeinträge werden je Stadt gezählt.' },
    { label: 'Verkehr · qualitative Klassen aus OpenStreetMap', countKey: 'withTrafficProxy', countLabel: 'Unfallpunkte mit Verkehrsproxy', matches: city => city.traffic?.present && /osm.*proxy|proxy.*osm/i.test(city.traffic.source || ''),
      description: 'Die Werkbank gruppiert OSM-Straßenklassen nach ihrem erwarteten Verkehrsaufkommen. Das Ergebnis ist eine qualitative Einordnung ohne Zählwert oder DTV.' },
  ];
  for (const group of groups) {
    const members = withMetadata.filter(group.matches);
    if (!members.length) continue;
    let coverage = group.featureFamily
      ? featureCoverage(members, cities.length, group.featureFamily, 'POI-Einträge')
      : cityCoverage(members.length, cities.length);
    if (group.countKey && members.every(city => Number.isSafeInteger(city.meta?.counts?.[group.countKey]))) {
      const records = members.reduce((sum, city) => sum + city.meta.counts[group.countKey], 0);
      coverage = `${records.toLocaleString('de-DE')} ${group.countLabel} · ${coverage}`;
    }
    rows.push({ label: group.label, coverage,
      description: group.description, sources: OSM_SOURCES, license: OSM_LICENSE });
  }
  return rows.concat(terrainRows(withMetadata), mapRows(siteRoot));
}

module.exports = { buildBaseDataSources };
