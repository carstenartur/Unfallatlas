/**
 * UA.osmContext — OSM-Kontext-Anreicherung (#C4).
 *
 * Fragt für eine markierte Bounding-Box die Overpass-API ab und aggregiert
 * grobe verkehrsräumliche Kennzahlen, die im Antrag den Sachverhalt schärfen:
 *
 *  - dominante `maxspeed`-Werte (Tempolimit-Mix der Strecken im Bereich)
 *  - Vorhandensein/Anzahl von Radverkehrsanlagen (`cycleway:*`, `highway=cycleway`,
 *    `bicycle=designated`) ⇒ Hinweis auf "kein geschützter Radweg" o. ä.
 *  - Anzahl signalisierter Knoten (`highway=traffic_signals`) und Querungen
 *    (`highway=crossing` mit `crossing=*`)
 *  - durchschnittliche `lanes` und sofern getaggt `width` von Hauptachsen
 *
 * Designprinzipien:
 *  - **Pures DOM-freies Modul** – nutzt nur `fetch` (window/global) + `URLSearchParams`,
 *    damit Tests es ohne jsdom/Leaflet ausführen können.
 *  - **Optional** – jeder Renderer prüft `structured.osmContext != null`.
 *  - **Defensiv** – jeder Netzfehler/Timeout liefert `null` (kein Throw),
 *    `quality.error` enthält die Ursache.
 *  - **Frei-Tier-schonend** – In-Memory-Cache (key: gerundete bbox + tag-set),
 *    Standardtimeout 8 s, Standard-Endpoint via `OVERPASS_ENDPOINT` ersetzbar
 *    (siehe `setEndpoint`); kein automatisches Polling.
 */
(() => {
  const root = (typeof window !== "undefined") ? window : globalThis;
  const UA = root.UA = root.UA || {};

  const DEFAULT_ENDPOINT = "https://overpass-api.de/api/interpreter";
  const DEFAULT_TIMEOUT_MS = 8000;
  const CACHE_TTL_MS = 60 * 60 * 1000; // 1 h

  let _endpoint = DEFAULT_ENDPOINT;
  /** @type {Map<string, {at:number, value:any}>} */
  const _cache = new Map();
  const MAX_CACHE = 50;

  /** Allow tests / ops to point at a different (e.g. self-hosted) Overpass instance. */
  function setEndpoint(url) { _endpoint = String(url || DEFAULT_ENDPOINT); }
  function getEndpoint()    { return _endpoint; }

  /** Deterministic cache key for a bbox (rounded to 5 decimals ≈ 1 m). */
  function cacheKey(bbox) {
    const round = (n) => Number(n).toFixed(5);
    return [round(bbox.south), round(bbox.west), round(bbox.north), round(bbox.east)].join(",");
  }

  /**
   * Build an Overpass QL query for the given bbox covering the road network
   * relevant for our aggregations. We restrict to highways (driveable +
   * cycleable + crossings + signals) so the response stays small.
   */
  function buildQuery(bbox, opts) {
    const timeoutS = Math.max(5, Math.floor((opts && opts.timeoutMs ? opts.timeoutMs : DEFAULT_TIMEOUT_MS) / 1000));
    // bbox order in Overpass: (south, west, north, east)
    const b = `(${bbox.south},${bbox.west},${bbox.north},${bbox.east})`;
    return [
      `[out:json][timeout:${timeoutS}];`,
      `(`,
      // road segments
      `  way["highway"]${b};`,
      // signals & crossings (nodes)
      `  node["highway"="traffic_signals"]${b};`,
      `  node["highway"="crossing"]${b};`,
      `);`,
      `out tags;`
    ].join("\n");
  }

  /** Normalize maxspeed string to a numeric km/h (or null). */
  function parseMaxspeed(v) {
    if (v == null) return null;
    const s = String(v).trim().toLowerCase();
    if (s === "" || s === "none" || s === "signals" || s === "variable") return null;
    if (s === "walk") return 7;
    // mph?
    const mph = s.match(/^(\d+(?:\.\d+)?)\s*mph$/);
    if (mph) return Math.round(Number(mph[1]) * 1.60934);
    const km = s.match(/^(\d+(?:\.\d+)?)\s*(?:km\/?h)?$/);
    if (km) return Math.round(Number(km[1]));
    return null;
  }

  /** Return true if the way carries explicit cycling infrastructure. */
  function hasCycleInfra(tags) {
    if (!tags) return false;
    if (tags.highway === "cycleway") return true;
    if (tags.bicycle === "designated") return true;
    for (const k of Object.keys(tags)) {
      if (k === "cycleway" || k.startsWith("cycleway:")) {
        const v = String(tags[k]).toLowerCase();
        if (v && v !== "no" && v !== "separate") return true;
      }
    }
    return false;
  }

  /**
   * Aggregate raw Overpass elements into a compact summary that's safe to
   * embed into reports.
   *
   * @param {Array<{type:string,tags?:object}>} elements
   * @returns {object}
   */
  function aggregate(elements) {
    const ways = [];
    let trafficSignals = 0;
    let crossings = 0;
    for (const el of (elements || [])) {
      if (!el) continue;
      const tags = el.tags || {};
      if (el.type === "way" && tags.highway) ways.push(tags);
      else if (el.type === "node" && tags.highway === "traffic_signals") trafficSignals++;
      else if (el.type === "node" && tags.highway === "crossing") crossings++;
    }

    // Maxspeed distribution (count of ways per limit)
    const speedHist = {};
    let speedKnown = 0;
    for (const t of ways) {
      const ms = parseMaxspeed(t.maxspeed);
      if (ms != null) {
        speedHist[ms] = (speedHist[ms] || 0) + 1;
        speedKnown++;
      }
    }
    const dominantSpeed = (() => {
      let best = null, bestN = 0;
      for (const k of Object.keys(speedHist)) {
        if (speedHist[k] > bestN) { best = Number(k); bestN = speedHist[k]; }
      }
      return best;
    })();

    // Cycling infrastructure: count of ways tagged + share of named/classified ways.
    let cycleWays = 0, namedWays = 0;
    for (const t of ways) {
      if (hasCycleInfra(t)) cycleWays++;
      // "namedWays" = ways with a name OR a non-residential highway class
      // serving as denominator for the cycle-share computation. Pure
      // residential/service stretches are commonly bicycle-permitted by
      // default and would distort the share.
      if (t.name || (t.highway && t.highway !== "service" && t.highway !== "footway" && t.highway !== "path")) {
        namedWays++;
      }
    }
    const cycleShare = namedWays > 0 ? (cycleWays / namedWays) : null;

    // Lanes & width on classified roads (avoid service/path noise).
    const lanesVals = [];
    const widthVals = [];
    for (const t of ways) {
      if (!t.highway || t.highway === "service" || t.highway === "footway" || t.highway === "path" || t.highway === "cycleway") continue;
      const ln = Number(t.lanes);
      if (Number.isFinite(ln) && ln > 0 && ln < 12) lanesVals.push(ln);
      const wm = Number(String(t.width || "").replace(",", "."));
      if (Number.isFinite(wm) && wm > 0 && wm < 50) widthVals.push(wm);
    }
    const avg = (arr) => arr.length === 0 ? null : (arr.reduce((a, b) => a + b, 0) / arr.length);

    return {
      summary: {
        wayCount: ways.length,
        dominantMaxspeed: dominantSpeed,
        speedSampleSize: speedKnown,
        speedHistogram: speedHist,
        cycleInfraWays: cycleWays,
        cycleInfraShare: cycleShare,    // null if nothing classifiable
        trafficSignals,
        crossings,
        avgLanes: avg(lanesVals),
        avgWidthMeters: avg(widthVals),
        lanesSampleSize: lanesVals.length,
        widthSampleSize: widthVals.length
      },
      // Provenance for the report footer.
      source: {
        publisher: "OpenStreetMap-Mitwirkende",
        license: "ODbL 1.0",
        url: "https://www.openstreetmap.org/copyright",
        retrievedVia: "Overpass API"
      }
    };
  }

  /**
   * Public entry point. Returns `null` on failure so callers can fall back
   * to the "no OSM context" rendering path.
   *
   * @param {{south:number, west:number, north:number, east:number}} bbox
   * @param {{ timeoutMs?:number, fetch?:Function, endpoint?:string, force?:boolean }} [opts]
   * @returns {Promise<object|null>}
   */
  async function fetchOsmContext(bbox, opts) {
    if (!bbox || !Number.isFinite(bbox.south) || !Number.isFinite(bbox.west) ||
        !Number.isFinite(bbox.north) || !Number.isFinite(bbox.east)) {
      return null;
    }
    const ep = (opts && opts.endpoint) || _endpoint;
    const fetchFn = (opts && opts.fetch) || (typeof root.fetch === "function" ? root.fetch.bind(root) : null);
    if (!fetchFn) return null;

    const key = ep + "|" + cacheKey(bbox);
    const now = Date.now();
    if (!opts || !opts.force) {
      const hit = _cache.get(key);
      if (hit && (now - hit.at) < CACHE_TTL_MS) return hit.value;
    }

    const query = buildQuery(bbox, opts);
    const timeoutMs = (opts && opts.timeoutMs) || DEFAULT_TIMEOUT_MS;
    let response, body;
    try {
      const controller = (typeof AbortController !== "undefined") ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
      try {
        response = await fetchFn(ep, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: "data=" + encodeURIComponent(query),
          signal: controller ? controller.signal : undefined
        });
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (!response.ok) {
        const out = { quality: { error: `HTTP ${response.status}`, fetchedAt: new Date(now).toISOString() } };
        _rememberInCache(key, out, now);
        return out;
      }
      body = await response.json();
    } catch (e) {
      const out = { quality: { error: String(e && e.message || e), fetchedAt: new Date(now).toISOString() } };
      _rememberInCache(key, out, now);
      return out;
    }

    const elements = (body && Array.isArray(body.elements)) ? body.elements : [];
    const agg = aggregate(elements);
    const result = Object.assign({}, agg, {
      bbox: {
        south: bbox.south, west: bbox.west, north: bbox.north, east: bbox.east
      },
      quality: {
        elementCount: elements.length,
        fetchedAt: new Date(now).toISOString(),
        endpoint: ep
      }
    });
    _rememberInCache(key, result, now);
    return result;
  }

  function _rememberInCache(key, value, at) {
    if (_cache.size >= MAX_CACHE) {
      // Evict oldest (insertion order) entry — Map preserves insertion order.
      const firstKey = _cache.keys().next().value;
      if (firstKey) _cache.delete(firstKey);
    }
    _cache.set(key, { at, value });
  }

  function clearCache() { _cache.clear(); }

  /**
   * Build a short German-language summary line that's suitable for the
   * Plain-Text export. Returns `null` when the input cannot be summarised.
   */
  function summarizeForText(ctx) {
    if (!ctx || !ctx.summary) return null;
    const s = ctx.summary;
    const parts = [];
    if (s.dominantMaxspeed != null) {
      parts.push(`vorherrschendes Tempolimit ${s.dominantMaxspeed} km/h (n=${s.speedSampleSize})`);
    } else if (s.wayCount > 0) {
      parts.push("Tempolimit nicht aus OSM ableitbar");
    }
    if (s.cycleInfraWays > 0) {
      const sh = s.cycleInfraShare != null ? ` (${Math.round(s.cycleInfraShare * 100)} % der Hauptachsen)` : "";
      parts.push(`Radinfrastruktur an ${s.cycleInfraWays} Wegabschnitten${sh}`);
    } else if (s.wayCount > 0) {
      parts.push("keine separaten Radverkehrsanlagen erkannt");
    }
    if (s.trafficSignals > 0) parts.push(`${s.trafficSignals} signalisierte Knoten`);
    if (s.crossings > 0)      parts.push(`${s.crossings} markierte Querungen`);
    if (s.avgLanes != null)   parts.push(`Ø ${s.avgLanes.toFixed(1)} Fahrstreifen`);
    if (parts.length === 0) return null;
    return parts.join("; ") + ".";
  }

  UA.osmContext = {
    fetchOsmContext,
    aggregate,
    parseMaxspeed,
    hasCycleInfra,
    buildQuery,
    summarizeForText,
    setEndpoint,
    getEndpoint,
    clearCache,
    DEFAULT_ENDPOINT
  };
})();
