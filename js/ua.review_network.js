(() => {
  'use strict';

  const UA = window.UA = window.UA || {};
  const MAX_SITE_DISTANCE = Object.freeze({ segment: 28, junction: 19, crossing: 13 });
  const METRES_PER_DEGREE = 111195.08;
  const TILE_ZOOM = 18;
  const AMBIGUITY_METRES = 3;
  const LOAD_LIMIT_MS = 20000;
  const MAX_SITES = 250000;
  const ID = /^[a-z0-9][a-z0-9:-]{0,95}$/;
  const REVISION = /^[a-z0-9][a-z0-9-]{7,63}$/;
  const crossingLabels = Object.freeze({
    unmarked: 'ohne Markierung', marked: 'mit Markierung', lit: 'beleuchtet', unlit: 'unbeleuchtet',
    signals: 'mit Lichtsignalanlage', unsignalled: 'ohne Lichtsignalanlage', island: 'mit Mittelinsel', noisland: 'ohne Mittelinsel',
  });
  const indexes = new WeakMap();
  let catalog;

  function sourceUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password;
    } catch {
      return false;
    }
  }

  function validSource(source) {
    return typeof source?.label === 'string' && source.label.trim()
      && sourceUrl(source.url) && sourceUrl(source.licenseUrl);
  }

  function parseNetwork(city, revision, index, parts) {
    const sites = new Map();
    const counts = { segment: 0, junction: 0, crossing: 0 };
    for (const part of parts) {
      if (part?.schemaVersion !== 1 || part.revision !== revision || !Array.isArray(part.sites)) return null;
      for (const [id, kind, label, wayIds, coordinates] of part.sites) {
        if (typeof id !== 'string' || !ID.test(id) || sites.has(id) || !Object.hasOwn(counts, kind)
            || typeof label !== 'string' || !label.trim() || label.length > 300
            || !Array.isArray(wayIds) || !wayIds.every(way => /^[1-9]\d{0,15}$/.test(way))
            || !Array.isArray(coordinates) || coordinates.length > 4096 || coordinates.length % 2 !== 0
            || (kind === 'segment' ? coordinates.length < 4 : coordinates.length !== 2)) return null;
        const positions = [];
        for (let i = 0; i < coordinates.length; i += 2) {
          positions.push({ lat: coordinates[i], lon: coordinates[i + 1] });
        }
        const bounds = UA.SiteDiscovery.boundsForPoints(positions, {
          paddingMeters: MAX_SITE_DISTANCE[kind] + 2, maxSpanMeters: 750,
        });
        if (!bounds || sites.size >= MAX_SITES) return null;
        sites.set(id, { id, kind, label, wayIds: wayIds.map(String), coordinates, bounds });
        counts[kind]++;
      }
    }
    if (!sites.size || Object.keys(counts).some(kind => counts[kind] !== index.counts?.[kind])) return null;
    for (const record of Array.isArray(index.caseHistory) ? index.caseHistory : []) {
      const site = sites.get(record?.id);
      if (!site || !Array.isArray(record.coordinates) || record.coordinates.length !== site.coordinates.length
          || !site.coordinates.every((value, i) => value === record.coordinates[i])) continue;
      if (Array.isArray(record.changes) && record.changes.every(UA.SiteDiscovery.validChange)) site.changes = record.changes;
    }
    return { city, revision, sites, counts, source: index.source, boundarySource: index.boundarySource };
  }

  async function readNetwork(city, signal) {
    const read = (kind, params) => UA.DataResources.fetchJson(kind, params, {
      optional: true,
      fetch: (url, options) => fetch(url, { ...options, signal }),
    });
    catalog ||= await read('reviewNetworkCatalog', {});
    if (catalog?.schemaVersion !== 1 || !catalog.cities || !Object.hasOwn(catalog.cities, city)) return null;
    const revision = catalog.cities[city];
    if (typeof revision !== 'string' || !REVISION.test(revision)) return null;
    const index = await read('reviewNetworkIndex', { city });
    if (index?.schemaVersion !== 1 || index.city !== city || index.revision !== revision
        || !validSource(index.source) || !validSource(index.boundarySource)
        || !/^\d{4}-\d{2}-\d{2}$/.test(index.source.date) || !/^[a-f0-9]{64}$/.test(index.source.sha256)
        || !Array.isArray(index.parts) || !index.parts.length || index.parts.length > 128
        || index.parts.some((part, i) => part !== i + 1)) return null;
    const scheduler = UA.DataBudget?.createScheduler(6);
    const parts = await Promise.all(index.parts.map(part => {
      const readPart = async () => {
        const payload = await read('reviewNetworkPart', { city, part });
        if (payload?.schemaVersion !== 1 || payload.revision !== revision || !Array.isArray(payload.sites)) {
          throw new Error('Incomplete network snapshot');
        }
        return payload;
      };
      return scheduler ? scheduler.run(readPart) : readPart();
    }));
    const network = signal.aborted ? null : parseNetwork(city, revision, index, parts);
    if (network && index.crossingContext === true) {
      // This enrichment is optional. A failed request must leave the street network usable.
      network.crossingContextReady = UA.DataResources.fetchJson('reviewNetworkCrossings', { city }, { optional: true }).then(context => {
        if (context?.revision !== revision || !context.features || typeof context.features !== 'object'
            || Array.isArray(context.features)) return;
        let documented = 0;
        for (const [id, features] of Object.entries(context.features)) {
          const site = network.sites.get(id);
          if (site?.kind === 'crossing' && Array.isArray(features) && features.length > 0 && features.length <= 4
              && features.every(value => typeof value === 'string' && Object.hasOwn(crossingLabels, value))) {
            site.crossingFeatures = features;
            documented++;
          }
        }
        network.documentedCrossings = documented;
      }).catch(() => {});
    }
    return network;
  }

  async function load(cityRaw) {
    if (!UA.DataResources) return null;
    const controller = new AbortController();
    let deadline;
    try {
      return await Promise.race([
        readNetwork(UA.normKey(cityRaw), controller.signal),
        new Promise(resolve => { deadline = setTimeout(() => resolve(null), LOAD_LIMIT_MS); }),
      ]);
    } catch {
      return null;
    } finally {
      clearTimeout(deadline);
      controller.abort();
    }
  }

  function networkIndex(network) {
    if (indexes.has(network)) return indexes.get(network);
    const buckets = new Map();
    const { tileRange } = UA.SpatialGrid;
    for (const site of network.sites.values()) {
      const range = tileRange(site.bounds, TILE_ZOOM);
      for (let x = range.xMin; x <= range.xMax; x++) {
        for (let y = range.yMin; y <= range.yMax; y++) {
          const tile = x + ':' + y;
          if (!buckets.has(tile)) buckets.set(tile, []);
          buckets.get(tile).push(site);
        }
      }
    }
    indexes.set(network, buckets);
    return buckets;
  }

  function distanceToSite(lat, lon, metresPerLongitude, site) {
    const g = site.coordinates;
    let x = (g[1] - lon) * metresPerLongitude;
    let y = (g[0] - lat) * METRES_PER_DEGREE;
    let closestSquared = x * x + y * y;
    for (let i = 2; i < g.length; i += 2) {
      const nextX = (g[i + 1] - lon) * metresPerLongitude;
      const nextY = (g[i] - lat) * METRES_PER_DEGREE;
      const dx = nextX - x, dy = nextY - y;
      const lengthSquared = dx * dx + dy * dy;
      const t = lengthSquared ? Math.max(0, Math.min(1, -(x * dx + y * dy) / lengthSquared)) : 0;
      closestSquared = Math.min(closestSquared, (x + t * dx) ** 2 + (y + t * dy) ** 2);
      x = nextX;
      y = nextY;
    }
    return Math.sqrt(closestSquared);
  }

  function assign(point, index) {
    const { lat, lon } = point;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { status: 'unmatched' };
    const { lonToTileX, latToTileY } = UA.SpatialGrid;
    const tile = lonToTileX(lon, TILE_ZOOM) + ':' + latToTileY(lat, TILE_ZOOM);
    const metresPerLongitude = Math.cos(lat * Math.PI / 180) * METRES_PER_DEGREE;
    const way = String(point.props?.matched_way_id ?? '');
    const nearby = [];
    for (const site of index.get(tile) || []) {
      const distance = distanceToSite(lat, lon, metresPerLongitude, site);
      if (distance > MAX_SITE_DISTANCE[site.kind]) continue;
      const matched = site.wayIds.includes(way);
      if (!matched && site.kind !== 'segment' && distance > 8) continue;
      nearby.push({ site, matched, distance });
    }
    if (!nearby.length) return { status: 'unmatched' };
    const matched = nearby.filter(item => item.matched);
    const eligible = matched.length ? matched : nearby;
    const nodes = eligible.filter(item => item.site.kind !== 'segment');
    const ranked = (nodes.length ? nodes : eligible).sort((a, b) => a.distance - b.distance);
    if (ranked.length > 1 && ranked[1].distance - ranked[0].distance <= AMBIGUITY_METRES) {
      return { status: 'ambiguous' };
    }
    const winner = ranked[0];
    return { status: 'assigned', siteId: winner.site.id, method: winner.matched ? 'matched-way' : 'distance' };
  }

  function analyze(network, points) {
    const index = networkIndex(network);
    const assignments = new Map();
    const bySite = new Map();
    const counts = { total: points.length, assigned: 0, ambiguous: 0, unmatched: 0 };
    for (const point of points) {
      const match = assign(point, index);
      assignments.set(point, match);
      counts[match.status]++;
      if (match.status !== 'assigned') continue;
      if (!bySite.has(match.siteId)) bySite.set(match.siteId, []);
      bySite.get(match.siteId).push(point);
    }
    return { network, assignments, bySite, counts };
  }

  function row(result, siteId, query = {}, predicate) {
    const site = result.network.sites.get(siteId);
    if (!site) return null;
    const assigned = result.bySite.get(siteId) || [];
    const points = UA.SiteDiscovery.filterPoints(predicate ? assigned.filter(predicate) : assigned, query);
    return {
      id: site.id, label: site.label, kind: site.kind, bounds: site.bounds, coordinates: site.coordinates,
      crossingFeatures: site.crossingFeatures, points, count: points.length, assignedCount: assigned.length,
      severeCount: points.filter(point => ['1', '2'].includes(String(point.props?.ukategorie))).length,
      pattern: UA.SiteDiscovery.patternForPoints(points), changes: site.changes || [],
    };
  }

  function rows(result, query, { kind = 'all', onlyEmpty = false } = {}) {
    const candidates = [];
    const ids = onlyEmpty ? result.network.sites.keys() : result.bySite.keys();
    for (const id of ids) {
      const site = result.network.sites.get(id);
      if (kind !== 'all' && site.kind !== kind && !site.crossingFeatures?.includes(kind)) continue;
      const candidate = row(result, id, query);
      if (onlyEmpty ? candidate.count === 0 : candidate.count > 0) candidates.push(candidate);
    }
    return candidates.sort((a, b) => b.count - a.count || b.severeCount - a.severeCount
      || a.label.localeCompare(b.label, 'de') || a.id.localeCompare(b.id));
  }

  function compareSites(result, siteId, query, predicate) {
    const site = result.network.sites.get(siteId);
    if (!site) return null;
    const filter = UA.SiteDiscovery.queryPredicate(query || {});
    const matches = point => filter(point) && (!predicate || predicate(point));
    const selected = (result.bySite.get(siteId) || []).filter(matches);
    const peers = result.network.counts[site.kind] - 1;
    let higher = 0;
    let equal = selected.length === 0 ? peers : 0;
    for (const [id, points] of result.bySite) {
      if (id === siteId || result.network.sites.get(id).kind !== site.kind) continue;
      let count = 0;
      for (const point of points) if (matches(point)) count++;
      if (count > selected.length) {
        higher++;
        if (!selected.length) equal--;
      } else if (selected.length && count === selected.length) equal++;
    }
    return { peers, higher, equal, count: selected.length,
      severe: selected.filter(p => String(p.props.ukategorie) === '2').length,
      fatal: selected.filter(p => String(p.props.ukategorie) === '1').length };
  }

  function comparisonLines(comparison, features) {
    const lines = [];
    if (comparison) {
      const { peers, higher, equal, count, severe, fatal } = comparison;
      lines.push('Unfälle nach Suchkriterien: ' + count + ', davon ' + severe
        + ' mit Schwerverletzten und ' + fatal + ' mit Getöteten.');
      if (peers > 0) lines.push('Von ' + peers.toLocaleString('de-DE') + ' anderen Netzstellen desselben Typs haben '
        + higher.toLocaleString('de-DE') + ' mehr und ' + equal.toLocaleString('de-DE')
        + ' gleich viele zugeordnete Fälle unter denselben Filtern. Der Vergleich berücksichtigt auch Stellen mit null Fällen. Verkehrsmengen und Bauform können abweichen.');
    }
    if (features?.length) lines.push('In OpenStreetMap erfasste Querungsmerkmale: '
      + features.map(key => crossingLabels[key]).filter(Boolean).join(', ') + '.');
    return lines;
  }

  function findingLines(finding) {
    if (finding.status === 'unavailable') return [
      'Der im Link angegebene Netzstand ' + finding.site.revision + ' ist für diese Markierung nicht verfügbar. Die übrige Auswertung zeigt den markierten Bereich.',
    ];
    const kinds = { segment: 'Straßenabschnitt', junction: 'Knoten', crossing: 'Querung' };
    const next = {
      segment: 'Streckenverlauf, Verkehrsführung und passende Zählungen für den Abschnitt prüfen.',
      junction: 'Unfallskizzen, Knotenarme und die jeweils geltende Verkehrsführung abgleichen.',
      crossing: 'Querungsführung und tatsächliche Wege vor Ort prüfen.',
    };
    return [
      finding.label + ' · ' + kinds[finding.kind] + ' · Kennung ' + finding.site.id + ' · Netzstand ' + finding.site.revision,
      finding.assignedCount + ' räumlich zugeordnete Fälle im geladenen Bestand, ' + finding.queryCount
        + ' nach Suchkriterien und davon ' + finding.mapCount + ' unter den Kartenfiltern.',
      'Die Übersicht und der vollständige Fallanhang zeigen das markierte Umfeld. Die Zuordnung zum Netzobjekt beruht auf den veröffentlichten Unfallkoordinaten und der kartierten Lage.',
      ...comparisonLines(finding.comparison, finding.crossingFeatures),
      next[finding.kind],
    ];
  }

  UA.ReviewNetwork = Object.freeze({ load, analyze, row, rows, compareSites, comparisonLines, findingLines });
})();
