(() => {
  'use strict';

  const UA = (window.UA = window.UA || {});
  const METERS_PER_DEGREE = Math.PI * 6371008.8 / 180;
  const LATITUDE_CELLS_PER_DEGREE = 720;
  const INDEX_ZOOM = 17;
  const TYPES = {
    1: 'Fahrunfall',
    turning: 'Abbiegen oder Einbiegen/Kreuzen (Typ 2/3)',
    4: 'Überschreiten',
    5: 'Ruhender Verkehr',
    6: 'Längsverkehr',
    7: 'Sonstiger Unfall',
  };
  const INVOLVEMENTS = [
    ['istrad', 'Rad'], ['istfuss', 'Fuß'], ['istpkw', 'Pkw'],
    ['istkrad', 'Krad'], ['istgkfz', 'Güter-Kfz'], ['istsonstig', 'Sonstige'],
  ];
  const INVOLVEMENT_FILTERS = Object.freeze({ bike: 1, foot: 2, 'bike-foot': 3, car: 4, heavy: 16 });

  function yearNumber(value) {
    if (typeof value !== 'number' && typeof value !== 'string') return null;
    const year = Number(value);
    return Number.isInteger(year) && year > 0 ? year : null;
  }

  function yearOf(point) {
    const props = point?.props;
    return yearNumber(props?.year) ?? yearNumber(props?.ujahr) ?? yearNumber(props?.UJAHR) ?? yearNumber(props?.Jahr);
  }

  function isSerious(category) {
    return category === '1' || category === '2';
  }

  function isTurning(type) {
    return type === '2' || type === '3';
  }

  function queryPredicate(query) {
    const fromYear = yearNumber(query.fromYear);
    const toYear = yearNumber(query.toYear);
    const severity = String(query.severity ?? 'all');
    const type = String(query.type ?? 'all');
    const involvement = INVOLVEMENT_FILTERS[query.involvement];
    return point => {
      const props = point?.props;
      if (fromYear !== null || toYear !== null) {
        const year = yearOf(point);
        if (year === null || year < (fromYear ?? -Infinity) || year > (toYear ?? Infinity)) return false;
      }
      const category = String(props?.ukategorie);
      if (severity === 'serious' ? !isSerious(category) : severity !== 'all' && severity !== category) return false;
      if (involvement && !(involvementMask(props) & involvement)) return false;
      const pointType = String(props?.utyp1);
      return type === 'turning' ? isTurning(pointType) : type === 'all' || type === pointType;
    };
  }

  function filterPoints(points, query = {}) {
    return points.filter(queryPredicate(query));
  }

  function involvementMask(props) {
    if (UA.maskFromProps) return UA.maskFromProps(props);
    return INVOLVEMENTS.reduce((mask, [field], index) => mask | (String(props[field]) === '1' ? 1 << index : 0), 0);
  }

  function patternForPoints(points, key) {
    if (!key && points.length < 3) return null;
    const patterns = new Map();
    for (const point of points) {
      const props = point?.props;
      const year = yearOf(point);
      const type = String(props?.utyp1);
      const family = isTurning(type) ? 'turning' : type;
      if (year === null || !Object.hasOwn(TYPES, family)) continue;
      const mask = involvementMask(props);
      if (!mask) continue;
      const patternKey = `${family}:${mask}`;
      if (key && key !== patternKey) continue;
      let pattern = patterns.get(patternKey);
      if (!pattern) {
        pattern = { key: patternKey, family, mask, points: [], earliestYear: year, recentYear: year, recentPoints: [] };
        patterns.set(patternKey, pattern);
      }
      pattern.points.push(point);
      pattern.earliestYear = Math.min(pattern.earliestYear, year);
      if (year > pattern.recentYear) {
        pattern.recentYear = year;
        pattern.recentPoints = [];
      }
      if (year === pattern.recentYear) pattern.recentPoints.push(point);
    }

    let selected = null;
    for (const pattern of patterns.values()) {
      if (!key && (pattern.points.length < 3 || pattern.earliestYear === pattern.recentYear)) continue;
      if (!selected || pattern.points.length > selected.points.length
          || (pattern.points.length === selected.points.length
              && (pattern.recentYear > selected.recentYear
                  || (pattern.recentYear === selected.recentYear && pattern.key < selected.key)))) {
        selected = pattern;
      }
    }
    if (!selected) return null;

    const modes = INVOLVEMENTS.filter((_, index) => selected.mask & (1 << index)).map(([, label]) => label);
    return {
      key: selected.key,
      label: `${modes.join(' + ')} · ${TYPES[selected.family]}`,
      points: selected.points,
      recentYear: selected.recentYear,
      recentPoints: selected.recentPoints,
    };
  }

  function longitudeFactor(lat) {
    return Math.cos(lat * Math.PI / 180);
  }

  function validPosition(lat, lon) {
    return Number.isFinite(lat) && Math.abs(lat) <= 90 && Number.isFinite(lon) && Math.abs(lon) <= 180;
  }

  function includePosition(bounds, lat, lon) {
    bounds.south = Math.min(bounds.south, lat);
    bounds.west = Math.min(bounds.west, lon);
    bounds.north = Math.max(bounds.north, lat);
    bounds.east = Math.max(bounds.east, lon);
  }

  function paddedBounds(bounds, paddingMeters, maxSpanMeters) {
    const { south, west, north, east } = bounds;
    const lonMetersPerDegree = METERS_PER_DEGREE * longitudeFactor((south + north) / 2);
    const span = Math.hypot((north - south) * METERS_PER_DEGREE + 2 * paddingMeters,
      (east - west) * lonMetersPerDegree + 2 * paddingMeters);
    if (east - west > 180 || span > maxSpanMeters) return null;

    const latPadding = paddingMeters / METERS_PER_DEGREE;
    const lonPadding = paddingMeters / lonMetersPerDegree;
    return {
      south: Math.max(-90, south - latPadding),
      west: Math.max(-180, west - lonPadding),
      north: Math.min(90, north + latPadding),
      east: Math.min(180, east + lonPadding),
    };
  }

  function boundsForPoints(points, { paddingMeters = 16, maxSpanMeters = 320 } = {}) {
    if (!points.length || !Number.isFinite(paddingMeters) || paddingMeters < 0
        || !Number.isFinite(maxSpanMeters) || maxSpanMeters <= 0) return null;
    const bounds = { south: Infinity, west: Infinity, north: -Infinity, east: -Infinity };
    for (const point of points) {
      const lat = point?.lat;
      const lon = point?.lon ?? point?.lng;
      if (!validPosition(lat, lon)) return null;
      includePosition(bounds, lat, lon);
    }
    return paddedBounds(bounds, paddingMeters, maxSpanMeters);
  }

  function validBounds(bounds) {
    return bounds && validPosition(bounds.south, bounds.west) && validPosition(bounds.north, bounds.east)
      && bounds.south < bounds.north && bounds.west < bounds.east;
  }

  function contains(bounds, lat, lon) {
    return lat >= bounds.south && lat <= bounds.north && lon >= bounds.west && lon <= bounds.east;
  }

  // Each latitude band is roughly 154 m tall. Width is fixed within that
  // band and adjusted for longitude scale. Both axes are anchored at 0°.
  function searchCell(lat, lon) {
    const row = Math.min(LATITUDE_CELLS_PER_DEGREE * 90 - 1, Math.floor(lat * LATITUDE_CELLS_PER_DEGREE));
    const south = row / LATITUDE_CELLS_PER_DEGREE;
    const north = (row + 1) / LATITUDE_CELLS_PER_DEGREE;
    const width = 1 / (LATITUDE_CELLS_PER_DEGREE * Math.max(0.01, longitudeFactor((south + north) / 2)));
    const column = Math.min(Math.ceil(180 / width) - 1, Math.floor(lon / width));
    const west = Math.max(-180, column * width);
    const east = Math.min(180, (column + 1) * width);
    return { key: `${row}:${column}`, bounds: { south, west, north, east } };
  }

  function candidates(points, query = {}, sites = []) {
    const anchors = sites.filter(site => site && typeof site.id === 'string' && validBounds(site.bounds));
    const inScope = queryPredicate(query);
    const groups = new Map();
    const buckets = new Map();
    const { latToTileY, lonToTileX, tileRange } = UA.SpatialGrid;
    for (const point of points) {
      const lat = point?.lat;
      const lon = point?.lon ?? point?.lng;
      if (!validPosition(lat, lon)) continue;
      if (inScope(point)) {
        const tile = `${lonToTileX(lon, INDEX_ZOOM)}:${latToTileY(lat, INDEX_ZOOM)}`;
        if (!buckets.has(tile)) buckets.set(tile, []);
        buckets.get(tile).push(point);
      }
      const site = anchors.find(anchor => contains(anchor.bounds, lat, lon));
      let id;
      let kind;
      let label;
      let bounds;
      if (site) {
        ({ id, label, bounds } = site);
        kind = 'site';
      } else {
        const cell = searchCell(lat, lon);
        const way = String(point.props?.matched_way_id ?? '');
        if (/^[1-9]\d*$/.test(way)) {
          id = `segment:${way}:${cell.key}`;
          kind = 'segment';
          label = `OSM-Straßenabschnitt · Weg ${way}`;
          bounds = { south: lat, west: lon, north: lat, east: lon };
        } else {
          id = `cell:${cell.key}`;
          kind = 'cell';
          label = `Suchzelle ${cell.key}`;
          bounds = cell.bounds;
        }
      }

      let group = groups.get(id);
      if (!group) {
        group = { id, label, kind, bounds, changes: site?.changes || [] };
        groups.set(id, group);
      }
      // Define the extent from the unfiltered road group so changing a time
      // or type filter does not move the area marked for the same segment.
      if (kind === 'segment') includePosition(group.bounds, lat, lon);
    }

    const rows = [];
    for (const group of groups.values()) {
      const bounds = group.kind === 'segment' ? paddedBounds(group.bounds, 16, 320) : group.bounds;
      if (!bounds) continue;
      const range = tileRange(bounds, INDEX_ZOOM);
      const members = [];
      let severeCount = 0;
      const take = bucket => {
        for (const point of bucket || []) {
          if (!contains(bounds, point.lat, point.lon ?? point.lng)) continue;
          members.push(point);
          if (isSerious(String(point.props?.ukategorie))) severeCount++;
        }
      };
      if (range.count > buckets.size) {
        for (const bucket of buckets.values()) take(bucket);
      } else {
        for (let x = range.xMin; x <= range.xMax; x++) {
          for (let y = range.yMin; y <= range.yMax; y++) take(buckets.get(`${x}:${y}`));
        }
      }
      if (!members.length) continue;
      rows.push({
        ...group, bounds, points: members, count: members.length, severeCount,
        pattern: patternForPoints(members),
      });
    }
    return rows.sort((a, b) => b.count - a.count || b.severeCount - a.severeCount
      || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  function validChange(change) {
    if (typeof change?.label !== 'string' || !change.label.trim() || typeof change.url !== 'string') return false;
    try {
      const url = new URL(change.url);
      if (url.protocol !== 'https:' || url.username || url.password) return false;
    } catch (_) {
      return false;
    }
    if (typeof change.date !== 'string') return false;
    const date = change.precision === 'month' ? change.date + '-01' : change.date;
    const operatingDay = change.precision === 'day' && ['in-service', 'implemented'].includes(change.kind);
    if (change.precision !== 'documented-by' && change.precision !== 'month' && !operatingDay) return false;
    if (change.precision === 'month' && !/^\d{4}-\d{2}$/.test(change.date)) return false;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
    const parsed = new Date(date + 'T00:00:00Z');
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
  }

  async function loadSites(city) {
    if (String(city ?? '').trim().toLowerCase() !== 'hannover') return [];
    try {
      const sites = await UA.DataResources?.fetchJson('discoverySites', { city: 'hannover' }, { optional: true });
      if (!Array.isArray(sites)) return [];
      return sites.filter(site => typeof site?.id === 'string' && site.id
        && typeof site.label === 'string' && site.label.trim() && validBounds(site.bounds)
        && Array.isArray(site.changes) && site.changes.length && site.changes.every(validChange));
    } catch (_) {
      return [];
    }
  }

  UA.SiteDiscovery = Object.freeze({ yearOf, filterPoints, queryPredicate, validChange, patternForPoints, candidates, boundsForPoints, loadSites });
})();
