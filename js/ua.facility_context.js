(() => {
  'use strict';

  const UA = (window.UA = window.UA || {});
  const BUFFER_METERS = 200;
  const DEG = Math.PI / 180;
  const EARTH_METERS = 6371008.8;

  function rectangle(bounds) {
    const sw = bounds?.getSouthWest?.();
    const ne = bounds?.getNorthEast?.();
    const area = sw && ne ? { south: sw.lat, west: sw.lng, north: ne.lat, east: ne.lng } : bounds;
    if (!area) return null;
    const { south, west, north, east } = area;
    return [south, west, north, east].every(Number.isFinite)
      && south >= -90 && north <= 90 && west >= -180 && east <= 180
      && south <= north && west <= east ? { south, west, north, east } : null;
  }

  function position(coords) {
    return Array.isArray(coords) && Number.isFinite(coords[0]) && Number.isFinite(coords[1])
      && Math.abs(coords[0]) <= 180 && Math.abs(coords[1]) <= 90;
  }

  function distanceToRectangle([lon, lat], area) {
    if (lon >= area.west && lon <= area.east && lat >= area.south && lat <= area.north) return 0;
    const longitudeDelta = edge => Math.abs(((lon - edge + 540) % 360) - 180);
    const dLon = lon >= area.west && lon <= area.east
      ? 0 : Math.min(longitudeDelta(area.west), longitudeDelta(area.east)) * DEG;
    const phi = lat * DEG;
    // On a meridian the closest latitude may differ slightly from the point's latitude.
    const nearest = Math.atan2(Math.sin(phi), Math.cos(phi) * Math.cos(dLon));
    const latitudeCandidates = [area.south * DEG, area.north * DEG];
    if (nearest >= latitudeCandidates[0] && nearest <= latitudeCandidates[1]) latitudeCandidates.push(nearest);
    const haversine = target => Math.sin((target - phi) / 2) ** 2
      + Math.cos(phi) * Math.cos(target) * Math.sin(dLon / 2) ** 2;
    const closest = Math.min(...latitudeCandidates.map(haversine));
    return 2 * EARTH_METERS * Math.asin(Math.min(1, Math.sqrt(closest)));
  }

  function segmentIntersectsRectangle(a, b, area) {
    const lower = [area.west, area.south];
    const upper = [area.east, area.north];
    let start = 0;
    let end = 1;
    for (let axis = 0; axis < 2; axis++) {
      const delta = b[axis] - a[axis];
      if (delta === 0) {
        if (a[axis] < lower[axis] || a[axis] > upper[axis]) return false;
        continue;
      }
      const from = (lower[axis] - a[axis]) / delta;
      const to = (upper[axis] - a[axis]) / delta;
      start = Math.max(start, Math.min(from, to));
      end = Math.min(end, Math.max(from, to));
      if (start > end) return false;
    }
    return true;
  }

  function routeIntersectsRectangle(route, area) {
    const geometry = route?.geometry;
    // Optional plan.routes entries contain verified WGS84 GeoJSON route lines,
    // a redistribution license, and verified:true for the linked official source.
    if (route?.verified !== true || typeof route.license !== 'string' || !route.license.trim()) return false;
    const lines = geometry?.type === 'LineString' ? [geometry.coordinates]
      : geometry?.type === 'MultiLineString' ? geometry.coordinates : null;
    return Array.isArray(lines) && lines.length > 0
      && lines.every(line => Array.isArray(line) && line.length >= 2 && line.every(position))
      && lines.some(line => line.some((point, i) => i > 0 && segmentIntersectsRectangle(line[i - 1], point, area)));
  }

  function planSource(plan, year) {
    try {
      const url = new URL(plan?.url);
      if (url.origin !== 'https://www.hannover.de' || url.username || url.password) return null;
      return {
        label: (typeof plan.name === 'string' && plan.name || 'Schulwegplan') + ' der Landeshauptstadt Hannover',
        url: url.href,
        date: Number.isInteger(year) ? String(year) : null,
      };
    } catch {
      return null;
    }
  }

  function pointSource(poiData, id) {
    const properties = poiData.properties || {};
    const osmId = typeof id === 'string' && id.match(/^osm:(node|way|relation):(\d+)$/);
    return {
      label: properties.source?.requiredAttribution || '© OpenStreetMap contributors',
      url: osmId ? `https://www.openstreetmap.org/${osmId[1]}/${osmId[2]}` : 'https://www.openstreetmap.org/',
      date: typeof properties.retrievedAt === 'string' ? properties.retrievedAt.slice(0, 10) : null,
    };
  }

  function analyze(poiData, bounds, schoolPlans) {
    const area = rectangle(bounds);
    if (!Array.isArray(poiData?.features) || !area) return null;
    const schoolRows = Array.isArray(schoolPlans?.schools) ? schoolPlans.schools : [];
    const schools = new Map(schoolRows.filter(school => school?.osmId).map(school => [school.osmId, school]));
    const withinArea = [];
    const nearArea = [];
    const facilities = [];

    for (const feature of poiData.features) {
      const coords = feature?.geometry?.coordinates;
      if (feature?.geometry?.type !== 'Point' || !position(coords)) continue;
      const { id, type, name } = feature.properties || {};
      const [lon, lat] = coords;
      const distance = distanceToRectangle(coords, area);
      const school = type === 'school' ? schools.get(id) : null;
      const plans = Array.isArray(school?.plans) ? school.plans : [];
      const planSources = [];
      let routeCrossing = null;
      let routeSource = null;
      for (const plan of plans) {
        const source = planSource(plan, schoolPlans.year);
        if (!source) continue;
        planSources.push(source);
        if (routeCrossing || !Array.isArray(plan.routes)) continue;
        const route = plan.routes.find(item => routeIntersectsRectangle(item, area));
        if (route) {
          routeCrossing = { geometryType: route.geometry.type, license: route.license };
          routeSource = source;
        }
      }
      const poi = { lat, lon, id, type: typeof type === 'string' && type || 'unknown',
        name: typeof name === 'string' && name || 'Unbenannt' };
      if (distance === 0) withinArea.push(poi);
      else if (distance < BUFFER_METERS) nearArea.push(poi);
      else if (!routeCrossing) continue;

      const locationSource = pointSource(poiData, id);
      const positionNote = distance === 0
        ? 'Standortpunkt im markierten Bereich.' : 'Standortpunkt im Umkreis von weniger als 200 m um den Bereich.';
      facilities.push({
        ...poi,
        name: planSources.length && typeof school.name === 'string' && school.name || poi.name,
        distanceMeters: Math.round(distance),
        relation: routeCrossing ? 'Wegebezug belegt' : planSources.length ? 'vor Ort prüfen' : 'im Umfeld',
        reason: routeCrossing
          ? 'Eine nachgewiesene Linie aus dem amtlichen Schulwegplan berührt oder schneidet den markierten Bereich. Die Nutzung am Unfallort bleibt offen.'
          : planSources.length
            ? positionNote + ' Der amtliche Schulwegplan ist verlinkt. Eingang, Weg und Querung zum markierten Bereich sind vor Ort zu prüfen.'
            : positionNote + ' Der Standortdatensatz enthält keine Eingänge oder Wege.',
        source: routeSource || planSources[0] || locationSource,
        locationSource,
        planSources,
        ...(routeCrossing ? { routeCrossing } : {}),
      });
    }

    const countTypes = rows => {
      const counts = new Map();
      for (const { type } of rows) counts.set(type, (counts.get(type) || 0) + 1);
      return Object.fromEntries(counts);
    };
    facilities.sort((a, b) => Number(!!b.routeCrossing) - Number(!!a.routeCrossing)
      || a.distanceMeters - b.distanceMeters || a.name.localeCompare(b.name, 'de'));
    return {
      withinArea, nearArea, facilities,
      withinByType: countTypes(withinArea), nearByType: countTypes(nearArea),
      totalWithin: withinArea.length, totalNear: nearArea.length,
    };
  }

  async function load(city, bounds, poiData) {
    const get = async kind => {
      try { return await UA.DataResources?.fetchJson(kind, { city }, { optional: true }); }
      catch { return null; }
    };
    const [poi, plans] = await Promise.all([
      poiData === undefined ? get('poiGeoJson') : poiData,
      String(city).trim().toLowerCase() === 'hannover' ? get('schoolPlans') : null,
    ]);
    return analyze(poi, bounds, plans);
  }

  UA.FacilityContext = Object.freeze({ analyze, load });
})();
