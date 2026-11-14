'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { readJsonMaybeGz } = require('./read-json-maybe-gz');
const { levels, sourceLabel } = require('../../js/ua.ris-sources');
const { ROOTS } = require('../../js/ua.ris-partitions');

const OSM = '© OpenStreetMap-Mitwirkende, ODbL 1.0';
const OSM_RIGHTS = 'https://www.openstreetmap.org/copyright';
const CC_BY = 'https://creativecommons.org/licenses/by/4.0/';
const BONN_TERMS = 'https://opendata.bonn.de/dataset/ratsinformationssystem-oparl-api';
const SIM = 'https://e-government.hannover-stadt.de/lhhsimwebre.nsf';
const REGION = 'https://ris.hannit.de/public/vo040';
const SCHOOL_PLANS = 'https://www.hannover.de/Leben-in-der-Region-Hannover/Soziales/Kinder-Jugendliche/Grundschulzeit/Schulwegpl%C3%A4ne';
const SKH5 = 'https://www.hannover.de/content/download/887881/file/SKH5_Statistische_Gliederung.zip';
const ATKIS = 'https://numis.niedersachsen.de/trefferanzeige?docuuid=121cf327-48f5-4ecd-b3db-aabd023eb3df';
const NOT_SHIPPED = 'In dieser Ausgabe nicht enthalten';
const DOCUMENT_RIGHTS = 'Für die Originaldokumente und Anlagen sind die Rechte bei der jeweiligen Quelle zu prüfen.';

const number = value => value.toLocaleString('de-DE');
const link = (label, url) => ({ label, url });

function load(root, name) {
  const file = path.join(root, name);
  if (!fs.existsSync(file) && !fs.existsSync(file + '.gz')) return null;
  return readJsonMaybeGz(file, { mode: 'raw-ok' });
}

function sourceStatusLinks(manifest) {
  const feedLabels = {
    'landtag-rss-drucksachen': 'Landtag · Drucksachen (RSS)', 'landtag-rss-steno': 'Landtag · Plenarprotokolle (RSS)',
    'landtag-catalogue': 'Landtag · Dokumentensuche', 'landtag-archive': 'Landtag · Archivsuche'
  };
  const names = { available: 'verfügbar', partial: 'Teilbestand', failed: 'Abruf fehlgeschlagen', blocked: 'Abruf gesperrt' };
  return (manifest.sourceStatuses || []).map(status => {
    const label = feedLabels[status.source] || sourceLabel(status);
    return link(`${label} · ${names[status.status] || status.status}, ${number(status.recordCount)} Vorgänge`, status.url);
  });
}

function council(root, city) {
  const bonn = city === 'bonn';
  const label = bonn ? 'Ratsdokumente Bonn' : 'Rats- und Parlamentsdokumente Hannover · Stadt, Region und Land';
  const sources = bonn
    ? [link('Bundesstadt Bonn · OParl und Nutzungsbedingungen', BONN_TERMS)]
    : [link('Landeshauptstadt Hannover · Sitzungsmanagement', SIM), link('Region Hannover · ALLRIS', REGION)];
  let license = bonn
    ? 'CC0 für OParl-Textinformationen zu Ratsterminen und öffentlichen Vorlagen. Angehängte und externe Dokumente sind davon ausgenommen.'
    : DOCUMENT_RIGHTS;
  const directory = path.join(root, 'data/ris');
  const manifest = load(directory, city + '.json');
  if (!manifest) return { label, coverage: NOT_SHIPPED, description: 'Für diese Stadt liegt kein Ratsdatenkatalog in der Ausgabe.', sources, license };
  const v2 = manifest.schemaVersion === 2;
  const count = v2 ? manifest.recordCount : manifest.records?.count;
  const roots = v2 ? ROOTS.map(kind => manifest.roots?.[kind]) : [manifest.records, manifest.map];
  const hasAssets = roots.length > 0 && roots.every(ref => typeof ref?.path === 'string' && path.basename(ref.path) === ref.path && fs.existsSync(path.join(directory, ref.path)));
  if (manifest.city !== city || ![1, 2].includes(manifest.schemaVersion) || !Number.isSafeInteger(count) || !hasAssets) {
    return { label, coverage: 'Katalog unvollständig', description: 'Manifest oder zugehörige Einstiegsdateien fehlen oder sind ungültig.', sources, license };
  }

  const notes = [];
  if (manifest.coverage?.from && manifest.coverage?.to) notes.push(`Katalogzeitraum ${manifest.coverage.from} bis ${manifest.coverage.to}.`);
  const verified = manifest.provenance?.sourceVerifiedAt || manifest.generatedAt;
  if (verified) notes.push(`Quellenstand ${verified.slice(0, 10)}.`);
  if (manifest.provenance?.builtAt) notes.push(`Katalog erzeugt am ${manifest.provenance.builtAt.slice(0, 10)}.`);
  if (manifest.coverage?.complete === false) notes.push('Der Import deckt die amtlichen Bestände nur teilweise ab.');
  if (Number.isSafeInteger(manifest.mappedRecordCount) && manifest.mappedRecordCount <= count) {
    notes.push(`${number(manifest.mappedRecordCount)} mit Kartenbezug, ${number(count - manifest.mappedRecordCount)} ohne Kartenbezug.`);
  }
  if (!bonn && manifest.levelCounts) {
    for (const { id, label: level } of levels) {
      const counts = manifest.levelCounts[id];
      if (counts) notes.push(`Auf Ebene ${level} sind ${number(counts.records)} Vorgänge erfasst, davon ${number(counts.mapped)} mit Kartenbezug.`);
    }
  }
  if (Number.isSafeInteger(manifest.locationAssessment?.unresolved)) {
    notes.push(`Ortsprüfung bei ${number(manifest.locationAssessment.unresolved)} Vorgängen ohne eindeutige Zuordnung.`);
  }
  notes.push('Vorgänge ohne gesicherte Lage bleiben im Dokumentenindex recherchierbar.');
  if (!bonn && manifest.locationRevision > 0 && manifest.locationAssessment?.attempted > 0) {
    notes.push('Das Ortsverzeichnis gleicht Straßen und Hausnummern mit ATKIS-Straßenachsen und INSPIRE-Hauskoordinaten aus ALKIS ab.');
    sources.push(link('LGLN · ATKIS Basis-DLM', ATKIS),
      link('LGLN · INSPIRE-Hauskoordinaten', 'https://numis.niedersachsen.de/trefferanzeige?docuuid=931577a7-6b51-42fc-8409-3431f50abb4c'));
    license += ' Die Ortszuordnung nutzt bearbeitete LGLN-Geodaten unter CC BY 4.0.';
  }
  if (manifest.provenance?.rights?.attribution?.length) {
    license += ' ' + manifest.provenance.rights.attribution.join(' · ');
  }
  if (manifest.refreshFailure) {
    const attempt = manifest.refreshFailure.attemptedAt?.slice(0, 10);
    notes.push(`Die letzte Aktualisierung${attempt ? ' am ' + attempt : ''} schlug fehl. Die Ausgabe verwendet den vorherigen Katalogstand.`);
  }
  const recordedSources = sourceStatusLinks(manifest);
  if (!recordedSources.length) {
    for (const url of manifest.sources || []) recordedSources.push(link('Amtliche Katalogquelle', url));
  }
  return { label, coverage: `${number(count)} Vorgänge`, description: notes.join(' '), sources: [...sources, ...recordedSources], license };
}

function reviewNetwork(root) {
  const directory = path.join(root, 'data/mobility/review-network');
  const catalog = load(directory, 'catalog.json');
  const index = load(directory, 'hannover/index.json');
  const row = {
    label: 'Prüfnetz Hannover', coverage: NOT_SHIPPED,
    description: 'Straßenabschnitte, Knoten und Querungen für die Untersuchung einzelner Orte im Stadtgebiet.',
    sources: [link('OpenStreetMap · Daten und Rechte', OSM_RIGHTS), link('Landeshauptstadt Hannover · SKH5', SKH5)],
    license: `${OSM}. Stadtgrenze aus der statistischen Gliederung SKH5 der Landeshauptstadt Hannover, CC BY 4.0.`
  };
  if (!index && !catalog?.cities?.hannover) return row;
  row.coverage = 'Prüfnetz unvollständig';
  if (!index || !index.revision || index.revision !== catalog?.cities?.hannover || !Array.isArray(index.parts) || !index.parts.length) return row;
  if (!index.parts.every((part, i) => part === i + 1 && fs.existsSync(path.join(directory, 'hannover', part + '.json.gz')))) return row;
  const { segment, junction, crossing } = index.counts || {};
  if (![segment, junction, crossing].every(value => Number.isSafeInteger(value) && value >= 0)) return row;
  row.coverage = `${number(segment)} Abschnitte, ${number(junction)} Knoten, ${number(crossing)} Querungen`;
  if (index.source?.date) row.description += ` OSM-Auszug vom ${index.source.date}.`;
  if (index.source?.url) row.sources[0] = link(index.source.label, index.source.url);
  if (index.boundarySource?.url) row.sources[1] = link(index.boundarySource.label, index.boundarySource.url);
  return row;
}

function mobilityRows(siteRoot) {
  const data = path.join(siteRoot, 'data/mobility');
  const speeds = load(data, 'hannover-speed30.json');
  const tram = load(data, 'hannover-tram-context.json');
  const districts = load(data, 'hannover-stadtbezirke.geojson');
  const bonnDistricts = load(data, 'bonn-stadtbezirke.geojson');
  const schools = load(data, 'hannover-school-plans.json');
  const sites = load(data, 'hannover-discovery-sites.json');
  const labels = load(data, 'road-labels/bonn.json');
  const changes = (sites || []).flatMap(site => site.changes || []);
  return [
    {
      label: 'Tempo 30 in Hannover', coverage: speeds?.ways ? `${number(Object.keys(speeds.ways).length)} OSM-Wege` : NOT_SHIPPED,
      description: 'Aus OSM-Tags abgeleitete Tempo-30-Regeln.' + (speeds?.extractDate ? ` Auszug vom ${speeds.extractDate}.` : ''),
      sources: [link('OpenStreetMap · BBBike-Auszug Hannover', speeds?.sourceUrl || 'https://download.bbbike.org/osm/bbbike/Hannover/'), link('OSM-Nutzungsbedingungen', OSM_RIGHTS)], license: OSM
    },
    {
      label: 'Stadt- und Straßenbahngleise Hannover', coverage: Array.isArray(tram?.lines) ? `${number(tram.lines.length)} Liniengeometrien` : NOT_SHIPPED,
      description: 'Bearbeitete Gleisgeometrien aus dem ATKIS Basis-DLM.' + (tram?.source?.retrievedAt ? ` Abruf ${tram.source.retrievedAt}.` : ''),
      sources: [link('LGLN · ATKIS Basis-DLM', tram?.source?.url || ATKIS), link('Lizenz', CC_BY)], license: 'LGLN, ATKIS Basis-DLM, CC BY 4.0, bearbeitet.'
    },
    {
      label: 'Stadtbezirke Hannover', coverage: Array.isArray(districts?.features) ? `${number(districts.features.length)} Stadtbezirke` : NOT_SHIPPED,
      description: districts?.metadata?.changes || 'Bezirksgrenzen aus der statistischen Gliederung der Landeshauptstadt Hannover.',
      sources: [link('Statistische Gliederung SKH5', districts?.source?.url || SKH5), link('Lizenz', CC_BY)], license: districts?.metadata?.attribution || 'Landeshauptstadt Hannover, CC BY 4.0.'
    },
    {
      label: 'Stadtbezirke Bonn', coverage: bonnDistricts?.features?.length ? number(bonnDistricts.features.length) + ' Stadtbezirke' : NOT_SHIPPED,
      description: 'Amtliche Grenzen für die Bezirkssuche und die Zuordnung zur Bezirksvertretung. Stand der verwendeten Kopie: ' + (bonnDistricts?.metadata?.sourceDate || 'unbekannt') + '.',
      sources: [link('Bundesstadt Bonn · Flächen der Stadtbezirke', bonnDistricts?.source?.url || 'https://opendata.bonn.de/dataset/fl%C3%A4chen-der-stadtbezirke'),
        ...(bonnDistricts?.metadata?.snapshotUrl ? [link('Eingabedatei im Ratsatlas Bonn', bonnDistricts.metadata.snapshotUrl)] : []),
        link('Lizenz', 'https://creativecommons.org/publicdomain/zero/1.0/')],
      license: 'Bundesstadt Bonn, CC0 1.0.'
    },
    {
      label: 'Schulwegpläne Hannover', coverage: Array.isArray(schools?.schools) ? `${number(schools.schools.length)} Schulen` : NOT_SHIPPED,
      description: 'Verzeichnis mit Links zu den Schulwegplänen der Stadt.' + (schools?.year ? ` Verzeichnisjahr ${schools.year}.` : ''),
      sources: [link('Landeshauptstadt Hannover · Schulwegpläne', schools?.source || SCHOOL_PLANS)], license: DOCUMENT_RIGHTS
    },
    {
      label: 'Dokumentierte Straßenänderungen Hannover', coverage: Array.isArray(sites) ? `${number(sites.length)} Orte, ${number(changes.length)} Belege` : NOT_SHIPPED,
      description: 'Ausgewählte Orte mit datierten Ratsunterlagen, Pressemitteilungen und Anlagen. Ein Belegdatum kann zeitlich von der tatsächlichen Änderung abweichen.',
      sources: changes.length ? sites.flatMap(site => site.changes.map(change => link(change.number || (site.label + ' · ' + change.date), change.url))) : [link('Sitzungsmanagement Hannover', SIM)], license: DOCUMENT_RIGHTS
    },
    {
      label: 'Straßenbeschriftung Bonn', coverage: Array.isArray(labels?.labels) ? `${number(labels.labels.length)} Beschriftungspunkte` : NOT_SHIPPED,
      description: 'Für die Kartendarstellung aufbereitete Straßennamen.' + (labels?.source?.timestamp ? ` OSM-Auszug vom ${labels.source.timestamp.slice(0, 10)}.` : ''),
      sources: [link('OpenStreetMap · BBBike-Auszug Bonn', labels?.source?.url || 'https://download.bbbike.org/osm/bbbike/Bonn/'), link('OSM-Nutzungsbedingungen', OSM_RIGHTS)], license: OSM
    }
  ];
}

function buildMunicipalDataSources(siteRoot) {
  return [council(siteRoot, 'bonn'), council(siteRoot, 'hannover'), reviewNetwork(siteRoot), ...mobilityRows(siteRoot)];
}

module.exports = { buildMunicipalDataSources };
