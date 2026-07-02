(() => {
  const UA = (window.UA = window.UA || {});

  const MAP_MODE_LABELS = Object.freeze({
    standard: 'Standardkarte',
    orthophoto: 'Orthofoto',
    hybrid: 'Hybrid',
    analysis: 'Analyseansicht'
  });
  const VALID_MAP_MODES = new Set(Object.keys(MAP_MODE_LABELS));

  const LAYER_DEFINITIONS = Object.freeze([
    Object.freeze({
      id: 'standard-osm',
      displayName: 'OpenStreetMap Standard',
      provider: 'OpenStreetMap',
      layerType: 'base',
      technicalType: 'XYZ',
      url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
      minZoom: 0,
      maxZoom: 19,
      projection: 'EPSG:3857',
      scope: 'de',
      attribution: '&copy; OpenStreetMap-Mitwirkende',
      license: 'ODbL 1.0',
      priority: 10
    }),
    Object.freeze({
      id: 'hybrid-labels',
      displayName: 'Beschriftungen & Straßennamen',
      provider: 'CARTO / OpenStreetMap',
      layerType: 'overlay',
      technicalType: 'XYZ',
      url: 'https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}.png',
      subdomains: 'abcd',
      minZoom: 0,
      maxZoom: 20,
      projection: 'EPSG:3857',
      scope: 'de',
      attribution: '&copy; OpenStreetMap-Mitwirkende, &copy; CARTO',
      license: 'ODbL 1.0 / CARTO',
      priority: 20,
      pane: 'overlayPane'
    }),
    Object.freeze({
      // Source: https://stadtplan.bonn.de/ (ArcGIS-WMS der Bundesstadt Bonn)
      // WMS GetCapabilities: https://www.bonn.de/stadtplan-wms/services/orthofoto/MapServer/WMSServer?SERVICE=WMS&REQUEST=GetCapabilities
      // Layer: "Orthophoto" – EPSG:3857 nativ unterstützt
      // Lizenz: Kommunales Open Data gemäß Dienst-Metadaten
      id: 'bonn-orthophoto',
      displayName: 'Bonn Orthofoto',
      provider: 'Bundesstadt Bonn',
      layerType: 'orthophoto',
      technicalType: 'WMS',
      url: 'https://www.bonn.de/stadtplan-wms/services/orthofoto/MapServer/WMSServer',
      layers: 'Orthophoto',
      format: 'image/png',
      transparent: false,
      minZoom: 0,
      maxZoom: 20,
      projection: 'EPSG:3857',
      scope: 'city:bonn',
      attribution: 'Quelle: Bundesstadt Bonn – Orthofoto',
      license: 'Kommunales Open Data / siehe Dienst-Metadaten',
      metadataUrl: 'https://www.bonn.de/stadtplan-wms/services/orthofoto/MapServer/WMSServer?SERVICE=WMS&REQUEST=GetCapabilities',
      officialForExport: true,
      usageConstraint: 'Für amtliche Berichte geeignet',
      coverageNote: 'Kommunaler Layer für Bonn',
      updateInfo: 'Befliegungsjahr laut Dienst-Metadaten',
      priority: 400,
      fallbackLayerId: 'nrw-orthophoto'
    }),
    Object.freeze({
      // Source: https://www.wms.nrw.de/geobasis/wms_nw_dop (Geobasis NRW)
      // WMS GetCapabilities: https://www.wms.nrw.de/geobasis/wms_nw_dop?SERVICE=WMS&REQUEST=GetCapabilities
      // Layer: "nw_dop" – EPSG:3857 wird unterstützt
      // Lizenz: Datenlizenz Deutschland – Zero – Version 2.0
      id: 'nrw-orthophoto',
      displayName: 'NRW Orthofoto (DOP)',
      provider: 'Geobasis NRW',
      layerType: 'orthophoto',
      technicalType: 'WMS',
      url: 'https://www.wms.nrw.de/geobasis/wms_nw_dop',
      layers: 'nw_dop',
      format: 'image/png',
      transparent: false,
      minZoom: 0,
      maxZoom: 20,
      projection: 'EPSG:3857',
      scope: 'state:nw',
      attribution: 'Quelle: Geobasis NRW',
      license: 'Datenlizenz Deutschland – Zero – Version 2.0',
      metadataUrl: 'https://www.wms.nrw.de/geobasis/wms_nw_dop?SERVICE=WMS&REQUEST=GetCapabilities',
      officialForExport: true,
      usageConstraint: 'Für amtliche Berichte geeignet',
      coverageNote: 'Landesweiter Fallback für Nordrhein-Westfalen',
      updateInfo: 'Befliegungsjahr laut Dienst-Metadaten',
      priority: 300,
      fallbackLayerId: 'bkg-orthophoto'
    }),
    Object.freeze({
      // Source: https://opendata.lgln.niedersachsen.de/ (LGLN Niedersachsen Open Data)
      // WMS GetCapabilities: https://opendata.lgln.niedersachsen.de/doorman/noauth/dop_wms?SERVICE=WMS&REQUEST=GetCapabilities
      // Layer: "dop20" – EPSG:3857 wird unterstützt
      // Lizenz: Datenlizenz Deutschland – Namensnennung – Version 2.0
      id: 'niedersachsen-orthophoto',
      displayName: 'Niedersachsen Orthofoto (DOP)',
      provider: 'LGLN Niedersachsen',
      layerType: 'orthophoto',
      technicalType: 'WMS',
      url: 'https://opendata.lgln.niedersachsen.de/doorman/noauth/dop_wms',
      layers: 'dop20',
      format: 'image/png',
      transparent: false,
      minZoom: 0,
      maxZoom: 20,
      projection: 'EPSG:3857',
      scope: 'state:ni',
      attribution: 'Quelle: LGLN Niedersachsen',
      license: 'Datenlizenz Deutschland – Namensnennung – Version 2.0',
      metadataUrl: 'https://opendata.lgln.niedersachsen.de/doorman/noauth/dop_wms?SERVICE=WMS&REQUEST=GetCapabilities',
      officialForExport: true,
      usageConstraint: 'Für amtliche Berichte geeignet',
      coverageNote: 'Landesweiter Fallback für Hannover/Niedersachsen',
      updateInfo: 'Befliegungsjahr laut Dienst-Metadaten',
      priority: 300,
      fallbackLayerId: 'bkg-orthophoto'
    }),
    Object.freeze({
      // Source: https://gdz.bkg.bund.de/index.php/default/digitale-geodaten/digitale-luftbilder.html (BKG Geodatenzentrum)
      // WMS GetCapabilities: https://sg.geodatenzentrum.de/wms_dop20?SERVICE=WMS&REQUEST=GetCapabilities
      // Layer: "dop20" – EPSG:3857 wird unterstützt
      // Lizenz: Siehe Nutzungsbedingungen des BKG (kostenpflichtig für kommerzielle Nutzung)
      id: 'bkg-orthophoto',
      displayName: 'Deutschland Orthofoto (BKG)',
      provider: 'Geodatenzentrum / BKG',
      layerType: 'orthophoto',
      technicalType: 'WMS',
      url: 'https://sg.geodatenzentrum.de/wms_dop20',
      layers: 'dop20',
      format: 'image/png',
      transparent: false,
      minZoom: 0,
      maxZoom: 19,
      projection: 'EPSG:3857',
      scope: 'de',
      attribution: 'Quelle: BKG',
      license: 'Siehe Nutzungsbedingungen des BKG',
      metadataUrl: 'https://sg.geodatenzentrum.de/wms_dop20?SERVICE=WMS&REQUEST=GetCapabilities',
      officialForExport: true,
      usageConstraint: 'Für amtliche Berichte geeignet, BKG-Nutzungsbedingungen beachten',
      coverageNote: 'Bundesweiter amtlicher Fallback',
      updateInfo: 'Befliegungsjahr laut Dienst-Metadaten',
      priority: 200,
      fallbackLayerId: 'esri-world-imagery'
    }),
    Object.freeze({
      // Source: https://www.arcgis.com/home/item.html?id=10df2279f9684e4a9f6a7f08febac2a9 (Esri World Imagery)
      // Technischer Typ: XYZ-Kacheln; keine WMS-Anfragen erforderlich
      // Lizenz: Esri Terms of Use – nicht-amtlich, nur zur Vorschau geeignet
      // HINWEIS: Dieser Dienst ist NICHT für amtliche Berichte oder Exporte geeignet.
      //          Er dient ausschließlich als interaktiver Fallback, wenn alle amtlichen Dienste nicht erreichbar sind.
      id: 'esri-world-imagery',
      displayName: 'World Imagery Fallback',
      provider: 'Esri',
      layerType: 'orthophoto',
      technicalType: 'XYZ',
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      minZoom: 0,
      maxZoom: 19,
      projection: 'EPSG:3857',
      scope: 'global',
      attribution: 'Tiles &copy; Esri',
      license: 'Esri Terms of Use',
      metadataUrl: 'https://www.arcgis.com/home/item.html?id=10df2279f9684e4a9f6a7f08febac2a9',
      officialForExport: false,
      usageConstraint: 'Nur Vorschau/interaktiv – nicht für amtliche Berichte geeignet',
      coverageNote: 'Nicht-amtlicher Fallback, falls regionale Dienste nicht erreichbar sind',
      updateInfo: 'Stand laut Esri-Dienst',
      priority: 100
    })
  ]);

  const DEF_BY_ID = Object.freeze(Object.fromEntries(LAYER_DEFINITIONS.map(def => [def.id, def])));
  const CITY_STATE_HINTS = Object.freeze({ bonn: 'nw', hannover: 'ni' });

  function norm(value) {
    return String(value || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
  }

  function asCityContext(input) {
    if (typeof input === 'string') return { city: input, state: CITY_STATE_HINTS[norm(input)] || '' };
    const city = input && (input.city || input.CITY_RAW || input.displayName || input.id || '');
    const stateRaw = input && (input.state || input.STATE || '');
    const state = norm(stateRaw) || CITY_STATE_HINTS[norm(city)] || '';
    return { city, state };
  }

  function getDefinition(id) {
    return DEF_BY_ID[id] || null;
  }

  function candidateIdsForContext(input) {
    const ctx = asCityContext(input);
    const city = norm(ctx.city);
    const state = norm(ctx.state);
    const ids = [];
    if (city === 'bonn') ids.push('bonn-orthophoto');
    if (city === 'bonn' || state === 'nw') ids.push('nrw-orthophoto');
    if (city === 'hannover' || state === 'ni') ids.push('niedersachsen-orthophoto');
    ids.push('bkg-orthophoto', 'esri-world-imagery');
    return Array.from(new Set(ids));
  }

  function resolveOrthophotoCandidates(input) {
    return candidateIdsForContext(input)
      .map(getDefinition)
      .filter(Boolean);
  }

  function resolveMapMode(raw) {
    const mode = norm(raw).replace(/^map_/, '');
    return VALID_MAP_MODES.has(mode) ? mode : 'standard';
  }

  function normalizeMapOpacity(raw, fallback = 0.92) {
    const value = Number(raw);
    if (!Number.isFinite(value)) return fallback;
    return Math.max(0.2, Math.min(1, value));
  }

  function setDefinedOption(target, key, value) {
    if (value !== undefined && value !== null) target[key] = value;
  }

  function leafletOptions(definition) {
    const options = {};
    setDefinedOption(options, 'minZoom', definition.minZoom);
    setDefinedOption(options, 'maxZoom', definition.maxZoom);
    setDefinedOption(options, 'attribution', definition.attribution);
    // Do not pass `pane: undefined`: Leaflet treats that as an explicit pane
    // value and can leave GridLayers half-initialized during later setView().
    setDefinedOption(options, 'pane', definition.pane);
    return options;
  }

  function createMapLayer(definition) {
    if (!definition || !window.L) return null;
    const common = leafletOptions(definition);
    if (definition.technicalType === 'WMS') {
      if (!window.L.tileLayer || typeof window.L.tileLayer.wms !== 'function') return null;
      return window.L.tileLayer.wms(definition.url, {
        ...common,
        layers: definition.layers || '',
        format: definition.format || 'image/png',
        transparent: !!definition.transparent,
        uppercase: true
      });
    }
    if (typeof window.L.tileLayer !== 'function') return null;
    const xyzOptions = { ...common };
    setDefinedOption(xyzOptions, 'subdomains', definition.subdomains);
    return window.L.tileLayer(definition.url, xyzOptions);
  }

  UA.MAP_MODE_LABELS = MAP_MODE_LABELS;
  UA.getMapLayerRegistry = function getMapLayerRegistry() {
    return LAYER_DEFINITIONS.slice();
  };
  UA.getMapLayerDefinition = getDefinition;
  UA.resolveRegionalOrthophotoCandidates = resolveOrthophotoCandidates;
  UA.resolveMapMode = resolveMapMode;
  UA.normalizeMapOpacity = normalizeMapOpacity;
  UA.createMapLayer = createMapLayer;
  UA.getExportSuitableOrthophotoProviders = function getExportSuitableOrthophotoProviders() {
    return LAYER_DEFINITIONS.filter(def => def.layerType === 'orthophoto' && def.officialForExport === true);
  };
})();
