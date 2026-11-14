(() => {
  'use strict';
  const UA = window.UA = window.UA || {};
  const SCHOOL_RADIUS_M = 200;
  const EARTH_RADIUS_M = 6371008.8;
  const DEG = Math.PI / 180;
  const INDEX_ZOOM = 15;

  async function loadDistricts(city) {
    const source = UA.DistrictBoundaries;
    if (!source) return null;
    const slug = UA.normKey ? UA.normKey(city) : String(city).toLowerCase();
    const config = await source.loadGremienData(slug);
    if (!config?.stadtbezirksgrenzen) return null;
    const data = await source.loadDistrictBoundaries(config.stadtbezirksgrenzen);
    const entries = (data?.features || []).flatMap(feature => {
      const name = feature.properties?.district;
      if (typeof name !== 'string' || !name.trim() || !['Polygon','MultiPolygon'].includes(feature.geometry?.type)) return [];
      const extent = UA.SpatialGrid.geometryBounds(feature.geometry);
      return extent ? [{name, extent, feature}] : [];
    });
    const names = [...new Set(entries.map(entry => entry.name))].sort((a,b) => a.localeCompare(b,'de'));
    return names.length ? { names, entries, source: data.source, matches: new Map(), cells: new Map() } : null;
  }

  function inDistrict(row, district, districts) {
    if (!district) return true;
    if (!districts || !row.bounds) return false;
    const { west, south, east, north } = row.bounds;
    const entries = districts.entries.filter(({ extent: [w, s, e, n] }) =>
      w <= east && e >= west && s <= north && n >= south);
    if (!entries.some(entry => entry.name === district)) return false;
    const key = [west, south, east, north].join(',');
    if (!districts.matches.has(key)) {
      // Most footprints and their entire tile belong to one district. An
      // ambiguous tile is resolved against the exact footprint (border, hole,
      // exclave, etc.). Cache both results across filter and district changes.
      const range = UA.SpatialGrid.tileRange(row.bounds, INDEX_ZOOM);
      let name = null;
      if (range.count === 1) {
        const tile = range.xMin + ':' + range.yMin;
        if (!districts.cells.has(tile)) {
          const [w, s, e, n] = UA.SpatialGrid.tileBounds(range.xMin, range.yMin, INDEX_ZOOM);
          const features = districts.entries.filter(({ extent }) =>
            extent[0] <= e && extent[2] >= w && extent[1] <= n && extent[3] >= s);
          districts.cells.set(tile, UA.DistrictBoundaries.districtForSelection(features.map(entry => entry.feature),
            { lng: w, lat: s }, { lng: e, lat: n }));
        }
        name = districts.cells.get(tile);
      }
      if (!name) name = UA.DistrictBoundaries.districtForSelection(entries.map(entry => entry.feature),
        { lng: west, lat: south }, { lng: east, lat: north });
      districts.matches.set(key, name);
    }
    return districts.matches.get(key) === district;
  }

  function schoolIndex(data) {
    if (!Array.isArray(data?.features)) return null;
    const {lonToTileX, latToTileY} = UA.SpatialGrid;
    const schools = new Map();
    for (const feature of data.features) {
      if (feature.geometry?.type !== 'Point' || feature.properties?.type !== 'school') continue;
      const [lon,lat] = feature.geometry.coordinates || [];
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      const key = lonToTileX(lon, INDEX_ZOOM) + ':' + latToTileY(lat, INDEX_ZOOM);
      if (!schools.has(key)) schools.set(key, []);
      schools.get(key).push({name:feature.properties.name || 'Schule ohne Namensangabe',lon,lat});
    }
    return schools;
  }

  function nearestSchool(lat, lon, schools) {
    const dLat = SCHOOL_RADIUS_M / (EARTH_RADIUS_M * DEG);
    const dLon = dLat / Math.cos((Math.abs(lat) + dLat) * DEG);
    const range = UA.SpatialGrid.tileRange({south:lat-dLat,west:lon-dLon,north:lat+dLat,east:lon+dLon}, INDEX_ZOOM);
    let nearest = null;
    for (let x = range.xMin; x <= range.xMax; x++) {
      for (let y = range.yMin; y <= range.yMax; y++) {
        for (const school of schools.get(x + ':' + y) || []) {
          const h = Math.sin((school.lat-lat)*DEG/2)**2
            + Math.cos(lat*DEG)*Math.cos(school.lat*DEG)*Math.sin((school.lon-lon)*DEG/2)**2;
          const meters = 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
          if (meters <= SCHOOL_RADIUS_M && (!nearest || meters < nearest.meters)) nearest = {...school,meters};
        }
      }
    }
    return nearest;
  }

  function schoolCrossings(result, query, schools) {
    if (!schools || !result) return [];
    const rows = [];
    for (const site of result.network.sites.values()) {
      if (site.kind !== 'crossing' || !site.crossingFeatures?.some(f => f === 'unlit' || f === 'unmarked')) continue;
      const [lat,lon] = site.coordinates;
      const school = nearestSchool(lat,lon,schools);
      if (school) rows.push({...UA.ReviewNetwork.row(result,site.id,query),school});
    }
    return rows;
  }

  function rank(rows, priority) {
    if (priority === 'pattern') return rows.filter(row => row.pattern)
      .sort((a,b) => b.pattern.points.length - a.pattern.points.length || b.count - a.count || a.id.localeCompare(b.id));
    if (priority === 'severe') return rows.filter(row => row.severeCount > 0)
      .sort((a,b) => b.severeCount - a.severeCount || b.count - a.count || a.id.localeCompare(b.id));
    if (priority === 'school') return rows.slice()
      .sort((a,b) => a.school.meters - b.school.meters || a.id.localeCompare(b.id));
    return rows;
  }

  function reason(row, priority) {
    if (priority === 'pattern' && row.pattern) return row.pattern.points.length + ' Fälle desselben Musters in mehreren Jahren · ' + row.pattern.label;
    if (priority === 'severe') return row.severeCount + (row.severeCount === 1 ? ' Unfall' : ' Unfälle') + ' mit tödlichen oder schweren Folgen';
    if (priority === 'school' && row.school) {
      const hints = row.crossingFeatures.filter(f => f === 'unmarked' || f === 'unlit')
        .map(f => f === 'unlit' ? 'unbeleuchtet' : 'ohne Markierung');
      return row.school.name + ' · ' + Math.round(row.school.meters) + ' m zum Schulstandort · laut OSM ' + hints.join(', ');
    }
    return '';
  }

  UA.DistrictDiscovery = Object.freeze({loadDistricts,inDistrict,schoolIndex,schoolCrossings,rank,reason});
})();
