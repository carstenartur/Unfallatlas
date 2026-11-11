(() => {
  'use strict';

  const UA = (window.UA = window.UA || {});
  const states = new WeakMap();
  const vmz = 'https://www.vmz-niedersachsen.de';
  const vmzData = vmz + '/geojson/region-hannover-radzaehler.geojson';
  const maxFileSize = 2 * 1024 * 1024;
  const schoolAttribution = 'Schulwegpläne © Landeshauptstadt Hannover · Standorte © OpenStreetMap-Mitwirkende';
  const bikeAttribution = 'Radverkehrszählung: Verkehrsmanagementzentrale Niedersachsen (VMZ)';

  function isHannover(ctx) {
    return String(ctx.CITY_RAW || '').trim().toLowerCase() === 'hannover';
  }

  function element(tag, value) {
    const node = document.createElement(tag);
    if (value) node.textContent = value;
    return node;
  }

  function link(label, href) {
    const node = element('a', label);
    node.href = href;
    node.target = '_blank';
    node.rel = 'noopener noreferrer';
    return node;
  }

  function cityLink(value) {
    try {
      const url = new URL(value);
      if (url.protocol === 'https:' && url.origin === 'https://www.hannover.de' && !url.username && !url.password) {
        return url.href;
      }
    } catch (_) { /* Ignore an invalid link. */ }
    return null;
  }

  function position(geometry) {
    if (geometry?.type !== 'Point' || !Array.isArray(geometry.coordinates)) return null;
    const [lon, lat] = geometry.coordinates;
    if (geometry.coordinates.length !== 2 || !Number.isFinite(lon) || !Number.isFinite(lat)
        || Math.abs(lon) > 180 || Math.abs(lat) > 90) return null;
    return [lat, lon];
  }

  function marker(latLng, name, symbol, color, popup) {
    const badge = element('div', symbol);
    badge.setAttribute('aria-hidden', 'true');
    badge.style.cssText = `background:${color};color:white;border:2px solid white;border-radius:50%;
      box-shadow:0 1px 4px #0007;box-sizing:border-box;width:26px;height:26px;
      display:grid;place-items:center;font:bold 15px system-ui;`;
    const icon = window.L.divIcon({
      className: 'mobility-layer-marker', html: badge, iconSize: [26, 26],
      iconAnchor: [13, 13], popupAnchor: [0, -13],
    });
    const point = window.L.marker(latLng, { icon, title: name, alt: name, zIndexOffset: 500 });
    point.on('add', () => point.getElement()?.setAttribute('aria-label', name));
    return point.bindPopup(popup);
  }

  function schoolGroup(data, features) {
    const locations = new Map();
    for (const feature of features) {
      if (feature.properties?.type !== 'school') continue;
      const latLng = position(feature.geometry);
      if (latLng) locations.set(feature.properties.id, latLng);
    }
    const points = [];
    for (const school of data.schools) {
      const latLng = locations.get(school?.osmId);
      if (!latLng || typeof school.name !== 'string' || !Array.isArray(school.plans)) continue;
      const list = element('ul');
      for (const plan of school.plans) {
        const url = cityLink(plan?.url);
        if (!url || typeof plan.name !== 'string') continue;
        const item = element('li');
        item.append(link(plan.name + ' (PDF)', url));
        list.append(item);
      }
      if (!list.childElementCount) continue;
      const popup = element('div');
      popup.append(element('strong', school.name), element('div', 'Städtische Schulwegpläne ' + data.year), list,
        element('small', 'Schulstandort aus OpenStreetMap.'));
      points.push(marker(latLng, school.name + ' – Schulwegplan', 'S', '#314f9c', popup));
    }
    return window.L.layerGroup(points, { attribution: schoolAttribution });
  }

  function latestReading(readings, byYear) {
    if (!Array.isArray(readings)) throw new Error('Ungültige Messreihe');
    let latest = null;
    for (const reading of readings) {
      const datetime = reading?.datetime;
      const raw = reading?.value;
      if (typeof datetime !== 'string' || !/^\d{4}-\d{2}-\d{2}(?: (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d)?$/.test(datetime)
          || (typeof raw !== 'number' && (typeof raw !== 'string' || !/^\d+$/.test(raw)))) {
        throw new Error('Ungültiger Messwert');
      }
      const day = datetime.slice(0, 10);
      const date = new Date(day + 'T00:00:00Z');
      const count = Number(raw);
      if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== day
          || !Number.isSafeInteger(count) || count < 0) {
        throw new Error('Ungültiger Messwert');
      }
      const entry = { datetime, count };
      const year = Number(day.slice(0, 4));
      if (!byYear.has(year) || datetime > byYear.get(year).datetime) byYear.set(year, entry);
      if (!latest || datetime > latest.datetime) latest = entry;
    }
    return latest;
  }

  function stationData(payload) {
    if (payload?.type !== 'FeatureCollection' || !Array.isArray(payload.features) || !payload.features.length
        || (payload.crs && (payload.crs.type !== 'name' || payload.crs.properties?.name !== 'EPSG:4326'))) {
      throw new Error('Ungültige VMZ-Datei');
    }
    const stations = new Map();
    for (const feature of payload.features) {
      const id = feature?.id;
      const latLng = position(feature?.geometry);
      const props = feature?.properties;
      if (feature?.type !== 'Feature' || typeof id !== 'string' || !/^wheel-counter-\d{1,20}$/.test(id)
          || !latLng || typeof props?.name !== 'string' || !props.name.trim() || props.name.length > 250
          || props.externalId !== id.slice('wheel-counter-'.length)) {
        throw new Error('Ungültige Zählstelle');
      }
      const prior = stations.get(id);
      const dailyByYear = prior?.dailyByYear || new Map();
      const monthlyByYear = prior?.monthlyByYear || new Map();
      const daily = latestReading(props.wheelCountingDataDaily, dailyByYear);
      const monthly = latestReading(props.wheelCountingDataMonthly, monthlyByYear);
      if (prior && (prior.latLng[0] !== latLng[0] || prior.latLng[1] !== latLng[1])) {
        throw new Error('Widersprüchliche Standorte für eine Zählstelle');
      }
      stations.set(id, {
        id, latLng, name: props.name.trim(), dailyByYear, monthlyByYear,
        daily: prior?.daily && (!daily || prior.daily.datetime >= daily.datetime) ? prior.daily : daily,
        monthly: prior?.monthly && (!monthly || prior.monthly.datetime >= monthly.datetime) ? prior.monthly : monthly,
      });
    }
    return Array.from(stations.values());
  }

  function readingText(label, reading, monthly) {
    if (!reading) return label + ' – kein Messwert in der Datei';
    const [year, month, day] = reading.datetime.slice(0, 10).split('-');
    const period = monthly ? month + '.' + year : day + '.' + month + '.' + year;
    return label + ' ' + period + ' – ' + reading.count.toLocaleString('de-DE') + ' gezählte Fahrräder';
  }

  function bikeGroup(stations) {
    const points = stations.map((station) => {
      const popup = element('div');
      popup.append(
        element('strong', station.name),
        element('div', readingText('Letzter gemeldeter Tag', station.daily, false)),
        element('div', readingText('Letzter gemeldeter Monat', station.monthly, true)),
        element('p', 'Aus lokal geladener VMZ-Datei. Die letzten Zeiträume können unvollständig sein.'),
        link('Zählstelle bei der VMZ', vmz + '/region-hannover/radzaehler/' + station.id + '/')
      );
      return marker(station.latLng, station.name + ' – Radzählstelle', 'R', '#00665e', popup);
    });
    return window.L.layerGroup(points, { attribution: bikeAttribution });
  }

  function active(ctx, kind) {
    return isHannover(ctx) && ctx.contextOverlays?.active?.[kind] === true;
  }

  function syncLayer(map, layer, visible) {
    if (!layer || map.hasLayer(layer) === visible) return;
    if (visible) layer.addTo(map);
    else map.removeLayer(layer);
  }

  function updateStatus(node, message) {
    if (node.textContent !== message) node.textContent = message;
  }

  function refresh(ctx, state) {
    const showSchools = active(ctx, 'schoolRoutes');
    const showBikes = active(ctx, 'bikeCounts');
    const poi = ctx.poiData;
    const ui = state.ui;
    ui.school.checked = showSchools;
    ui.bike.checked = showBikes;
    ui.tools.hidden = !showBikes;

    if (!showSchools) state.schoolError = false;
    if (showSchools && !state.schoolData && !state.schoolRequest && !state.schoolError) {
      const city = ctx.CITY_RAW;
      state.schoolRequest = Promise.resolve()
        .then(() => UA.DataResources.fetchJson('schoolPlans', { city }))
        .then((data) => {
          const source = cityLink(data?.source);
          if (!source || !Number.isInteger(data.year) || !Array.isArray(data.schools)) {
            throw new Error('Ungültige Schulwegplanliste');
          }
          state.schoolData = { ...data, source };
        })
        .catch(() => { state.schoolError = true; })
        .finally(() => {
          state.schoolRequest = null;
          if (states.get(ctx) === state && isHannover(ctx)) refresh(ctx, state);
        });
    }
    if (state.schoolPoi !== poi || (showSchools && !state.schoolLayer && state.schoolData)) {
      syncLayer(state.map, state.schoolLayer, false);
      state.schoolLayer = null;
      state.schoolPoi = poi;
      if (showSchools && state.schoolData && Array.isArray(poi?.features)) {
        state.schoolLayer = schoolGroup(state.schoolData, poi.features);
      }
    }
    syncLayer(state.map, state.schoolLayer, showSchools);
    syncLayer(state.map, state.bikeLayer, showBikes);
    ui.schoolSource.hidden = !showSchools || !state.schoolData;
    if (state.schoolData) ui.schoolSource.href = state.schoolData.source;

    let schoolStatus = '';
    if (showSchools) {
      if (state.schoolError) schoolStatus = 'Die städtische Schulwegplanliste konnte nicht geladen werden. Zum erneuten Laden aus- und einschalten.';
      else if (!state.schoolData || poi === undefined) schoolStatus = 'Schulwegpläne und Schulstandorte werden geladen …';
      else if (!state.schoolLayer?.getLayers().length) schoolStatus = 'Für die Schulwegpläne sind keine Schulstandorte verfügbar.';
      else schoolStatus = state.schoolLayer.getLayers().length + ' Schulstandorte mit städtischen PDF-Schulwegplänen (' + state.schoolData.year + ').';
    }
    updateStatus(ui.schoolStatus, schoolStatus);

    if (!showBikes && state.fileReading) {
      state.fileRevision++;
      state.fileReading = false;
    }
    let bikeStatus = '';
    if (showBikes) {
      if (state.fileReading) bikeStatus = 'Lokale Datei wird gelesen …';
      else if (state.fileError) {
        bikeStatus = state.fileError + (state.bikeLayer ? ' Die bisherige Datei bleibt geladen.' : '');
      } else if (state.bikeLayer) bikeStatus = state.bikeLayer.getLayers().length + ' Radzählstellen aus der lokalen VMZ-Datei geladen.';
      else bikeStatus = 'Für Messwerte die VMZ-Datei speichern und hier auswählen.';
    }
    updateStatus(ui.bikeStatus, bikeStatus);
  }

  function openFile(ctx, state, file) {
    const revision = ++state.fileRevision;
    state.fileError = '';
    state.fileReading = true;
    refresh(ctx, state);
    const complete = (read) => {
      if (states.get(ctx) !== state || !active(ctx, 'bikeCounts') || revision !== state.fileRevision) return;
      try {
        const stations = stationData(JSON.parse(read()));
        const layer = bikeGroup(stations);
        syncLayer(state.map, layer, true);
        syncLayer(state.map, state.bikeLayer, false);
        state.bikeLayer = layer;
        state.stations = stations;
      } catch (_) {
        state.fileError = 'Die Datei ist ungültig oder konnte nicht gelesen werden.';
      }
      state.fileReading = false;
      refresh(ctx, state);
      UA.SiteDiscoveryUI?.exposureChanged?.(ctx);
    };
    if (file.size > maxFileSize) {
      state.fileError = 'Die Datei ist größer als 2 MB.';
      state.fileReading = false;
      refresh(ctx, state);
      return;
    }
    const reader = new window.FileReader();
    reader.onload = () => complete(() => reader.result);
    reader.onerror = () => complete(() => { throw reader.error; });
    reader.readAsText(file);
  }

  function makeControl(ctx, state) {
    const root = element('div');
    root.className = 'hannover-mobility-layers';
    const choices = element('div');
    choices.className = 'mapSettingsChoices';

    function choice(kind, text) {
      const label = element('label');
      const input = element('input');
      input.type = 'checkbox';
      input.name = kind;
      input.addEventListener('change', () => {
        if (states.get(ctx) !== state || !isHannover(ctx)) return;
        ctx.contextOverlays.active[kind] = input.checked;
        refresh(ctx, state);
        UA.syncAllToUrl?.(ctx);
      });
      label.append(input, document.createTextNode(' ' + text));
      choices.append(label);
      return input;
    }

    const school = choice('schoolRoutes', 'Schulwegpläne');
    const bike = choice('bikeCounts', 'Rad-Zählstellen');
    const tools = element('div');
    tools.className = 'mobility-layer-tools';
    const fileLabel = element('label', 'VMZ-GeoJSON lokal öffnen');
    const fileInput = element('input');
    fileInput.type = 'file';
    fileInput.accept = '.geojson,.json,application/geo+json,application/vnd.geo+json,application/json';
    fileInput.addEventListener('change', () => {
      const file = fileInput.files[0];
      fileInput.value = '';
      if (file && active(ctx, 'bikeCounts') && states.get(ctx) === state) openFile(ctx, state, file);
    });
    fileLabel.append(fileInput);
    tools.append(link('VMZ-GeoJSON bei der Quelle öffnen', vmzData), fileLabel,
      element('small', 'Die Datei wird nur in dieser Kartenansicht im Browser verwendet.'));
    const status = element('div');
    status.className = 'mobility-layer-status';
    status.setAttribute('role', 'status');
    const schoolStatus = element('div');
    const bikeStatus = element('div');
    status.append(schoolStatus, bikeStatus);
    const schoolSource = element('a', 'Alle Schulwegpläne bei Hannover.de');
    schoolSource.target = '_blank';
    schoolSource.rel = 'noopener noreferrer';
    const terrain = element('p');
    terrain.append(link('Geländeprofile für sechs Hannoveraner Straßenabschnitte', 'docs/qa/hannover-dgm1-profile.html'));
    root.append(choices, tools, status, schoolSource, terrain);
    return { root, school, bike, tools, schoolStatus, bikeStatus, schoolSource };
  }

  UA.HannoverLayers = {
    stationReadings(ctx, bounds, query = {}) {
      const stations = isHannover(ctx) && states.get(ctx)?.stations;
      if (!stations || !bounds) return [];
      const results = [];
      for (const station of stations) {
        const [lat, lon] = station.latLng;
        if (lat < bounds.south || lat > bounds.north || lon < bounds.west || lon > bounds.east) continue;
        for (const [series, monthly] of [[station.dailyByYear, false], [station.monthlyByYear, true]]) {
          const years = [...series.keys()].filter(year => year >= (query.fromYear ?? 0) && year <= (query.toYear ?? Infinity));
          if (!years.length) continue;
          const reading = series.get(Math.max(...years));
          results.push({
            name: station.name, url: vmz + '/region-hannover/radzaehler/' + station.id + '/',
            text: readingText(monthly ? 'Gemeldeter Monatswert' : 'Gemeldeter Tageswert', reading, monthly),
          });
        }
      }
      return results;
    },
    controlContent(ctx) {
      if (!ctx) return null;
      let state = states.get(ctx);
      const available = isHannover(ctx) && ctx.map && window.L;
      if (state && (!available || state.map !== ctx.map)) {
        state.dispose();
        state = null;
      }
      if (!available) return null;
      if (!state) {
        ctx.contextOverlays ||= {};
        ctx.contextOverlays.active ||= {};
        state = { map: ctx.map, fileRevision: 0 };
        state.ui = makeControl(ctx, state);
        state.dispose = () => {
          states.delete(ctx);
          state.map.off('unload', state.dispose);
          syncLayer(state.map, state.schoolLayer, false);
          syncLayer(state.map, state.bikeLayer, false);
        };
        state.map.once('unload', state.dispose);
        states.set(ctx, state);
      }
      refresh(ctx, state);
      return state.ui.root;
    },
  };
})();
