/**
 * Canonical, browser/server shared request contract for video exports.
 *
 * The API deliberately accepts a nested state object.  This prevents the
 * client, the Express route and the Playwright worker from each maintaining a
 * subtly different list of query-string fields.  `fromLegacyParams` is kept
 * only for backwards-compatible API callers; every path is normalized through
 * the same strict validator before Chromium is started.
 */
(function initVideoExportContract(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) {
    const UA = root.UA = root.UA || {};
    UA.videoExportContract = api;
  }
})(typeof window !== 'undefined' ? window : null, function createVideoExportContract() {
  'use strict';

  const SCHEMA_VERSION = 1;
  const FORMAT_VALUES = Object.freeze(['gif', 'webp', 'apng']);
  const SEVERITY_VALUES = Object.freeze(['all', '1', '2', '3']);
  const INVOLVEMENT_MODE_VALUES = Object.freeze(['or', 'and', 'solo']);
  const DAY_TYPE_VALUES = Object.freeze(['all', 'weekday', 'weekend']);
  const ROAD_CONDITION_VALUES = Object.freeze(['all', '0', '1', '2', '__unknown__']);
  const SLOPE_CLASS_VALUES = Object.freeze(['flat', 'gentle', 'moderate', 'steep', 'very_steep']);
  const TRAFFIC_CLASS_VALUES = Object.freeze(['low', 'medium', 'high', 'very_high']);
  const LEGACY_KEYS = Object.freeze([
    'city', 'severity', 'includeCyclist', 'includePedestrian', 'includeCar',
    'includeMotorcycle', 'includeGkfz', 'includeSonstig', 'involvementMode',
    'hourFrom', 'hourTo', 'dayType', 'roadCondition', 'showCluster',
    'showHeatmap', 'showOnlyAboveAverage', 'centerLat', 'centerLon', 'zoom',
    'selSouth', 'selWest', 'selNorth', 'selEast', 'maxPoints',
    'viewportPaddingPct', 'heatRadius', 'ctxSlope', 'ctxTraffic',
    'ctxOnlyMatched', 'mapLayer',
  ]);

  class VideoExportContractError extends Error {
    constructor(code, path, value, message) {
      super(message ? `${code}: ${message}` : `${code}:${path}`);
      this.name = 'VideoExportContractError';
      this.code = code;
      this.path = path;
      this.value = value;
      this.status = 400;
    }
  }

  function fail(code, path, value, message) {
    throw new VideoExportContractError(code, path, value, message);
  }

  function asObject(value, path) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      fail('invalid_state', path, value, `${path} must be an object`);
    }
    return value;
  }

  function assertKnownKeys(value, allowed, path) {
    const unknown = Object.keys(value).filter(key => !allowed.includes(key));
    if (unknown.length) {
      fail(
        'unknown_parameter',
        path,
        unknown,
        `${path} contains unknown fields: ${unknown.join(', ')}`
      );
    }
  }

  function assertRequiredKeys(value, required, path) {
    const missing = required.filter(key => !Object.prototype.hasOwnProperty.call(value, key));
    if (missing.length) {
      fail(
        'incomplete_state',
        path,
        missing,
        `${path} is missing required fields: ${missing.join(', ')}`
      );
    }
  }

  function assertExplicitValues(value, keys, path) {
    const empty = keys.filter(key => value[key] == null || value[key] === '');
    if (empty.length) {
      fail(
        'incomplete_state',
        path,
        empty,
        `${path} contains empty required fields: ${empty.join(', ')}`
      );
    }
  }

  function enumValue(value, allowed, fallback, path) {
    const normalized = value == null || value === '' ? fallback : String(value);
    if (!allowed.includes(normalized)) {
      fail('invalid_enum', path, normalized, `${path} has unsupported value ${normalized}`);
    }
    return normalized;
  }

  function booleanValue(value, fallback, path) {
    if (value == null || value === '') return fallback;
    if (value === true || value === 1 || value === '1' || value === 'true') return true;
    if (value === false || value === 0 || value === '0' || value === 'false') return false;
    fail('invalid_boolean', path, value, `${path} must be a boolean`);
  }

  function numberValue(value, fallback, path, opts) {
    if (value == null || value === '') return fallback;
    const number = Number(value);
    const options = opts || {};
    if (!Number.isFinite(number) || (options.integer && !Number.isInteger(number)) ||
        (options.min != null && number < options.min) ||
        (options.max != null && number > options.max)) {
      fail('invalid_number', path, value, `${path} is outside the supported range`);
    }
    return number;
  }

  function stringList(value, allowed, path) {
    let input = value;
    if (input == null || input === '') input = [];
    if (typeof input === 'string') input = input.split(',');
    if (input instanceof Set) input = Array.from(input);
    if (!Array.isArray(input)) fail('invalid_list', path, value, `${path} must be an array`);
    const output = [];
    for (const raw of input) {
      const item = String(raw).trim();
      if (!item) continue;
      if (!allowed.includes(item)) {
        fail('invalid_enum', path, item, `${path} contains unsupported value ${item}`);
      }
      if (!output.includes(item)) output.push(item);
    }
    return output.sort((a, b) => allowed.indexOf(a) - allowed.indexOf(b));
  }

  function normalizeViewport(value) {
    if (value == null) return null;
    const viewport = asObject(value, 'state.viewport');
    assertKnownKeys(viewport, ['center', 'zoom'], 'state.viewport');
    const center = asObject(viewport.center, 'state.viewport.center');
    assertKnownKeys(center, ['lat', 'lon'], 'state.viewport.center');
    const lat = numberValue(center.lat, null, 'state.viewport.center.lat', { min: -90, max: 90 });
    const lon = numberValue(center.lon, null, 'state.viewport.center.lon', { min: -180, max: 180 });
    const zoom = numberValue(viewport.zoom, null, 'state.viewport.zoom', {
      integer: true, min: 0, max: 24,
    });
    if (lat == null || lon == null || zoom == null) {
      fail('incomplete_view', 'state.viewport', value, 'viewport requires center.lat, center.lon and zoom');
    }
    return { center: { lat, lon }, zoom };
  }

  function normalizeSelection(value) {
    if (value == null) return null;
    const selection = asObject(value, 'state.selection');
    assertKnownKeys(selection, ['south', 'west', 'north', 'east'], 'state.selection');
    const south = numberValue(selection.south, null, 'state.selection.south', { min: -90, max: 90 });
    const west = numberValue(selection.west, null, 'state.selection.west', { min: -180, max: 180 });
    const north = numberValue(selection.north, null, 'state.selection.north', { min: -90, max: 90 });
    const east = numberValue(selection.east, null, 'state.selection.east', { min: -180, max: 180 });
    if ([south, west, north, east].some(item => item == null)) {
      fail('incomplete_selection', 'state.selection', value, 'selection requires south, west, north and east');
    }
    if (south >= north || west >= east) {
      fail('invalid_selection', 'state.selection', value, 'selection bounds must have positive area');
    }
    return { south, west, north, east };
  }

  function normalizeState(rawState) {
    const raw = asObject(rawState, 'state');
    assertKnownKeys(
      raw,
      ['schemaVersion', 'city', 'filters', 'context', 'layers', 'viewport', 'selection'],
      'state'
    );
    if (raw.schemaVersion == null || raw.schemaVersion === '') {
      fail(
        'invalid_schema_version',
        'state.schemaVersion',
        raw.schemaVersion,
        `canonical state requires schemaVersion ${SCHEMA_VERSION}`
      );
    }
    assertRequiredKeys(
      raw,
      ['schemaVersion', 'city', 'filters', 'context', 'layers', 'viewport', 'selection'],
      'state'
    );
    const schemaVersion = Number(raw.schemaVersion);
    if (!Number.isInteger(schemaVersion) || schemaVersion !== SCHEMA_VERSION) {
      fail(
        'invalid_schema_version',
        'state.schemaVersion',
        raw.schemaVersion,
        `supported schemaVersion is ${SCHEMA_VERSION}`
      );
    }
    const city = typeof raw.city === 'string' ? raw.city.trim() : '';
    if (!city || city.length > 120 || /[\u0000-\u001f\u007f]/.test(city)) {
      fail('invalid_city', 'state.city', raw.city, 'city must be a printable name of at most 120 characters');
    }

    const rawFilters = raw.filters == null ? {} : asObject(raw.filters, 'state.filters');
    const rawInvolvement = rawFilters.involvement == null
      ? {}
      : asObject(rawFilters.involvement, 'state.filters.involvement');
    assertKnownKeys(
      rawFilters,
      [
        'severity', 'involvementMode', 'hourFrom', 'hourTo', 'dayType',
        'roadCondition', 'maxPoints', 'viewportPaddingPct', 'heatRadius', 'involvement',
      ],
      'state.filters'
    );
    assertRequiredKeys(
      rawFilters,
      [
        'severity', 'involvementMode', 'hourFrom', 'hourTo', 'dayType',
        'roadCondition', 'maxPoints', 'viewportPaddingPct', 'heatRadius', 'involvement',
      ],
      'state.filters'
    );
    assertExplicitValues(
      rawFilters,
      [
        'severity', 'involvementMode', 'hourFrom', 'hourTo', 'dayType',
        'roadCondition', 'maxPoints', 'viewportPaddingPct', 'heatRadius', 'involvement',
      ],
      'state.filters'
    );
    assertKnownKeys(
      rawInvolvement,
      ['cyclist', 'pedestrian', 'car', 'motorcycle', 'gkfz', 'sonstig'],
      'state.filters.involvement'
    );
    assertExplicitValues(
      rawInvolvement,
      ['cyclist', 'pedestrian', 'car', 'motorcycle', 'gkfz', 'sonstig'],
      'state.filters.involvement'
    );
    assertRequiredKeys(
      rawInvolvement,
      ['cyclist', 'pedestrian', 'car', 'motorcycle', 'gkfz', 'sonstig'],
      'state.filters.involvement'
    );
    const hourFrom = numberValue(rawFilters.hourFrom, 0, 'state.filters.hourFrom', {
      integer: true, min: 0, max: 23,
    });
    const hourTo = numberValue(rawFilters.hourTo, 23, 'state.filters.hourTo', {
      integer: true, min: 0, max: 23,
    });
    if (hourFrom > hourTo) {
      fail('invalid_hour_range', 'state.filters', { hourFrom, hourTo }, 'hourFrom must not exceed hourTo');
    }

    const rawContext = raw.context == null ? {} : asObject(raw.context, 'state.context');
    const rawLayers = raw.layers == null ? {} : asObject(raw.layers, 'state.layers');
    assertKnownKeys(
      rawContext,
      ['slopeClasses', 'trafficClasses', 'onlyMatchedWays'],
      'state.context'
    );
    assertExplicitValues(
      rawContext,
      ['slopeClasses', 'trafficClasses', 'onlyMatchedWays'],
      'state.context'
    );
    assertRequiredKeys(
      rawContext,
      ['slopeClasses', 'trafficClasses', 'onlyMatchedWays'],
      'state.context'
    );
    assertKnownKeys(
      rawLayers,
      ['cluster', 'heatmap', 'onlyAboveAverage', 'slope', 'traffic'],
      'state.layers'
    );
    assertExplicitValues(
      rawLayers,
      ['cluster', 'heatmap', 'onlyAboveAverage', 'slope', 'traffic'],
      'state.layers'
    );
    assertRequiredKeys(
      rawLayers,
      ['cluster', 'heatmap', 'onlyAboveAverage', 'slope', 'traffic'],
      'state.layers'
    );
    const clusterLayer = booleanValue(rawLayers.cluster, true, 'state.layers.cluster');
    const heatmapLayer = booleanValue(rawLayers.heatmap, false, 'state.layers.heatmap');
    if (!clusterLayer && !heatmapLayer) {
      fail(
        'invalid_layers',
        'state.layers',
        rawLayers,
        'at least one accident layer (cluster or heatmap) must be visible'
      );
    }
    const involvementMode = enumValue(
      rawFilters.involvementMode,
      INVOLVEMENT_MODE_VALUES,
      'or',
      'state.filters.involvementMode'
    );
    const involvement = {
      cyclist: booleanValue(rawInvolvement.cyclist, true, 'state.filters.involvement.cyclist'),
      pedestrian: booleanValue(rawInvolvement.pedestrian, true, 'state.filters.involvement.pedestrian'),
      car: booleanValue(rawInvolvement.car, true, 'state.filters.involvement.car'),
      motorcycle: booleanValue(rawInvolvement.motorcycle, false, 'state.filters.involvement.motorcycle'),
      gkfz: booleanValue(rawInvolvement.gkfz, false, 'state.filters.involvement.gkfz'),
      sonstig: booleanValue(rawInvolvement.sonstig, false, 'state.filters.involvement.sonstig'),
    };
    if ((involvementMode === 'or' || involvementMode === 'solo') &&
        !Object.values(involvement).some(Boolean)) {
      fail(
        'invalid_involvement',
        'state.filters.involvement',
        rawInvolvement,
        `${involvementMode} mode requires at least one involvement class`
      );
    }

    return {
      schemaVersion,
      city,
      filters: {
        severity: enumValue(rawFilters.severity, SEVERITY_VALUES, 'all', 'state.filters.severity'),
        involvementMode,
        hourFrom,
        hourTo,
        dayType: enumValue(rawFilters.dayType, DAY_TYPE_VALUES, 'all', 'state.filters.dayType'),
        roadCondition: enumValue(
          rawFilters.roadCondition,
          ROAD_CONDITION_VALUES,
          'all',
          'state.filters.roadCondition'
        ),
        maxPoints: numberValue(rawFilters.maxPoints, 100000, 'state.filters.maxPoints', {
          integer: true, min: 500, max: 200000,
        }),
        viewportPaddingPct: numberValue(
          rawFilters.viewportPaddingPct,
          20,
          'state.filters.viewportPaddingPct',
          { integer: true, min: 0, max: 100 }
        ),
        heatRadius: numberValue(rawFilters.heatRadius, 25, 'state.filters.heatRadius', {
          integer: true, min: 5, max: 60,
        }),
        involvement,
      },
      context: {
        slopeClasses: stringList(rawContext.slopeClasses, SLOPE_CLASS_VALUES, 'state.context.slopeClasses'),
        trafficClasses: stringList(
          rawContext.trafficClasses,
          TRAFFIC_CLASS_VALUES,
          'state.context.trafficClasses'
        ),
        onlyMatchedWays: booleanValue(
          rawContext.onlyMatchedWays,
          false,
          'state.context.onlyMatchedWays'
        ),
      },
      layers: {
        cluster: clusterLayer,
        heatmap: heatmapLayer,
        onlyAboveAverage: booleanValue(
          rawLayers.onlyAboveAverage,
          false,
          'state.layers.onlyAboveAverage'
        ),
        slope: booleanValue(rawLayers.slope, false, 'state.layers.slope'),
        traffic: booleanValue(rawLayers.traffic, false, 'state.layers.traffic'),
      },
      viewport: normalizeViewport(raw.viewport),
      selection: normalizeSelection(raw.selection),
    };
  }

  function atomicLegacyGroup(params, keys, code, path, mapper) {
    const present = keys.filter(key => params[key] != null && params[key] !== '');
    if (present.length === 0) return null;
    if (present.length !== keys.length) {
      fail(code, path, present, `${path} must be supplied atomically`);
    }
    return mapper(params);
  }

  function fromLegacyParams(params) {
    const raw = params && typeof params === 'object' ? params : {};
    const unknown = Object.keys(raw).filter(key => !LEGACY_KEYS.includes(key));
    if (unknown.length) {
      fail(
        'unknown_parameter',
        'request',
        unknown,
        `legacy video state contains unknown fields: ${unknown.join(', ')}`
      );
    }
    const mapLayer = String(raw.mapLayer || '').split(',').map(item => item.trim());
    return normalizeState({
      schemaVersion: SCHEMA_VERSION,
      city: raw.city || 'Hannover',
      filters: {
        severity: raw.severity == null || raw.severity === '' ? 'all' : raw.severity,
        involvementMode: raw.involvementMode == null || raw.involvementMode === '' ? 'or' : raw.involvementMode,
        hourFrom: raw.hourFrom == null || raw.hourFrom === '' ? 0 : raw.hourFrom,
        hourTo: raw.hourTo == null || raw.hourTo === '' ? 23 : raw.hourTo,
        dayType: raw.dayType == null || raw.dayType === '' ? 'all' : raw.dayType,
        roadCondition: raw.roadCondition == null || raw.roadCondition === '' ? 'all' : raw.roadCondition,
        maxPoints: raw.maxPoints == null || raw.maxPoints === '' ? 100000 : raw.maxPoints,
        viewportPaddingPct: raw.viewportPaddingPct == null || raw.viewportPaddingPct === ''
          ? 20
          : raw.viewportPaddingPct,
        heatRadius: raw.heatRadius == null || raw.heatRadius === '' ? 25 : raw.heatRadius,
        involvement: {
          cyclist: raw.includeCyclist == null || raw.includeCyclist === '' ? true : raw.includeCyclist,
          pedestrian: raw.includePedestrian == null || raw.includePedestrian === '' ? true : raw.includePedestrian,
          car: raw.includeCar == null || raw.includeCar === '' ? true : raw.includeCar,
          motorcycle: raw.includeMotorcycle == null || raw.includeMotorcycle === '' ? false : raw.includeMotorcycle,
          gkfz: raw.includeGkfz == null || raw.includeGkfz === '' ? false : raw.includeGkfz,
          sonstig: raw.includeSonstig == null || raw.includeSonstig === '' ? false : raw.includeSonstig,
        },
      },
      context: {
        slopeClasses: raw.ctxSlope == null || raw.ctxSlope === '' ? [] : raw.ctxSlope,
        trafficClasses: raw.ctxTraffic == null || raw.ctxTraffic === '' ? [] : raw.ctxTraffic,
        onlyMatchedWays: raw.ctxOnlyMatched == null || raw.ctxOnlyMatched === '' ? false : raw.ctxOnlyMatched,
      },
      layers: {
        cluster: raw.showCluster == null || raw.showCluster === '' ? true : raw.showCluster,
        heatmap: raw.showHeatmap == null || raw.showHeatmap === '' ? false : raw.showHeatmap,
        onlyAboveAverage: raw.showOnlyAboveAverage == null || raw.showOnlyAboveAverage === ''
          ? false
          : raw.showOnlyAboveAverage,
        slope: mapLayer.includes('slope'),
        traffic: mapLayer.includes('traffic'),
      },
      viewport: atomicLegacyGroup(
        raw,
        ['centerLat', 'centerLon', 'zoom'],
        'incomplete_view',
        'state.viewport',
        source => ({ center: { lat: source.centerLat, lon: source.centerLon }, zoom: source.zoom })
      ),
      selection: atomicLegacyGroup(
        raw,
        ['selSouth', 'selWest', 'selNorth', 'selEast'],
        'incomplete_selection',
        'state.selection',
        source => ({
          south: source.selSouth,
          west: source.selWest,
          north: source.selNorth,
          east: source.selEast,
        })
      ),
    });
  }

  function stableStringify(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    return `{${Object.keys(value).sort().map(key =>
      `${JSON.stringify(key)}:${stableStringify(value[key])}`
    ).join(',')}}`;
  }

  return Object.freeze({
    SCHEMA_VERSION,
    FORMAT_VALUES,
    LEGACY_KEYS,
    VideoExportContractError,
    fromLegacyParams,
    normalizeState,
    stableStringify,
  });
});
