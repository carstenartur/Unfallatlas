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
 *  - **Defensiv** – Netz-/HTTP-/Timeout-Fehler werfen nicht, sondern liefern
 *    einen Ergebnis-Stub `{ quality: { error } }`; Renderer überspringen den
 *    Block dann (`summary` fehlt).
 *  - **Frei-Tier-schonend** – In-Memory-Cache (Schlüssel: Endpoint + gerundete
 *    bbox) mit TTL 1 h und LRU-Eviction (Cache-Hits aktualisieren die
 *    Recency, transiente Fehler werden mit deutlich kürzerer TTL gecached,
 *    damit ein 1-Sekunden-Hänger nicht 1 h "OSM nicht verfügbar" auslöst);
 *    Standardtimeout 8 s, Standard-Endpoint via `OVERPASS_ENDPOINT` ersetzbar
 *    (siehe `setEndpoint`); kein automatisches Polling.
 */
(() => {
  const root = (typeof window !== "undefined") ? window : globalThis;
  const UA = root.UA = root.UA || {};

  const DEFAULT_ENDPOINT = "https://overpass-api.de/api/interpreter";
  const DEFAULT_TIMEOUT_MS = 8000;
  const CACHE_TTL_MS = 60 * 60 * 1000; // 1 h für erfolgreiche Aggregationen
  // Fehler-Stubs (HTTP/Netz/Timeout) werden mit deutlich kürzerer TTL
  // gecached, damit ein transienter Overpass-Hänger nicht 1 h lang als
  // "OSM nicht verfügbar" durchschlägt.
  const ERROR_CACHE_TTL_MS = 60 * 1000; // 1 min

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
      // Stationen / Haltepunkte (nodes): railway=station, public_transport=station,
      // amenity=bus_station — versorgen die Kontext-Erkennung in
      // js/ua.context_measures.js mit `bahnhof` / `busbahnhof`.
      `  node["railway"="station"]${b};`,
      `  node["public_transport"="station"]${b};`,
      `  node["amenity"="bus_station"]${b};`,
      // Schienen (ways): tram + light_rail. Stadtbahn-Schienen sind die
      // direkte Evidenz für `straßenbahn_schienen`/`gleisquerung`-Kontexte
      // (Spec-Item 2). Vollbahn (railway=rail) wird hier bewusst NICHT
      // erfasst — die Kontext-Sprache adressiert nur Straßen-Gleise.
      `  way["railway"="tram"]${b};`,
      `  way["railway"="light_rail"]${b};`,
      `);`,
      `out tags;`
    ].join("\n");
  }

  /** Normalize maxspeed string to a numeric km/h (or null). */
  function parseMaxspeed(v) {
    if (v == null) return null;
    const s = String(v).trim().toLowerCase();
    if (s === "" || s === "none" || s === "signals" || s === "variable") return null;
    // OSM-Konvention: maxspeed=walk meint "Schritttempo" – wir setzen
    // pragmatisch ~7 km/h an (entspricht etwa StVO-Schrittgeschwindigkeit).
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
   * Test whether a way's tags suggest a shared foot+cycle surface — used
   * to surface `gemeinsame_fuss_rad_flaeche` (Spec-Item 2). Heuristik:
   *  - highway=path mit foot=designated UND bicycle=designated
   *  - highway=footway mit bicycle in {designated, yes, permissive}
   *  - highway=cycleway mit foot in {designated, yes, permissive}
   *  - segregated=no in Kombination mit Fuß-/Rad-Erlaubnis (StVO Z. 240)
   */
  function isMixedFootCycle(tags) {
    if (!tags) return false;
    const hw = tags.highway;
    const bike = String(tags.bicycle || "").toLowerCase();
    const foot = String(tags.foot || "").toLowerCase();
    const seg  = String(tags.segregated || "").toLowerCase();
    const positiveBike = bike === "designated" || bike === "yes" || bike === "permissive";
    const positiveFoot = foot === "designated" || foot === "yes" || foot === "permissive";
    if (hw === "path" && foot === "designated" && bike === "designated") return true;
    if (hw === "footway" && positiveBike) return true;
    if (hw === "cycleway" && positiveFoot) return true;
    if (seg === "no" && (positiveBike || hw === "cycleway") && (positiveFoot || hw === "footway")) return true;
    return false;
  }

  /** Cobblestone / sett surfaces — `kopfsteinpflaster` context (Spec-Item 2). */
  function isCobblestoneSurface(tags) {
    if (!tags) return false;
    const s = String(tags.surface || "").toLowerCase();
    return s === "cobblestone" || s === "sett" || s === "unhewn_cobblestone";
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
    // Kontext-Zähler für UA.contextMeasures.detectContexts (Spec-Items 2/4).
    // Werden über `contexts: { … }` ausgespielt, damit der Konsument keine
    // OSM-Tags re-parsen muss.
    let trainStations = 0;
    let busStations = 0;
    let tramTrackWays = 0;
    let cobblestoneWays = 0;
    let mixedFootCycleWays = 0;
    for (const el of (elements || [])) {
      if (!el) continue;
      const tags = el.tags || {};
      if (el.type === "way") {
        const isRailWay = (tags.railway === "tram" || tags.railway === "light_rail");
        // Schienen-Ways werden NICHT in `ways` aufgenommen (würden sonst die
        // Tempo-/Cycle-Statistiken verzerren), aber für den Kontext gezählt.
        if (tags.highway && !isRailWay) {
          ways.push(tags);
          if (isMixedFootCycle(tags)) mixedFootCycleWays++;
          if (isCobblestoneSurface(tags)) cobblestoneWays++;
        }
        if (isRailWay) tramTrackWays++;
      } else if (el.type === "node") {
        if (tags.highway === "traffic_signals") trafficSignals++;
        else if (tags.highway === "crossing") crossings++;
        if (tags.railway === "station" || tags.public_transport === "station") trainStations++;
        if (tags.amenity === "bus_station") busStations++;
      }
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
      // "namedWays" = ways with a name OR a non-residential, non-service highway
      // class — serves as denominator for the cycle-share computation. Pure
      // residential/service stretches are commonly bicycle-permitted by
      // default and would distort the share, so we exclude them here too.
      if (t.name || (t.highway && t.highway !== "residential" && t.highway !== "service" && t.highway !== "footway" && t.highway !== "path")) {
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
      // Counters für UA.contextMeasures.detectContexts. Bewusst eigener
      // Sub-Block (kein Mischen mit `summary`), damit der Konsument klar
      // erkennt, dass es sich um Kontext-Evidenz und nicht um Geometrie-
      // Kennzahlen handelt. Felder bleiben 0, wenn nichts erkannt wurde —
      // detectContexts fragt strikt `> 0` ab.
      contexts: {
        trainStations,
        busStations,
        tramTrackWays,
        cobblestoneWays,
        mixedFootCycleWays
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
      if (hit) {
        // TTL hängt vom Eintragstyp ab: Fehler-Stubs altern schnell, damit
        // transiente Overpass-Probleme keine Stundensperre erzeugen.
        const ttl = hit.ttl || CACHE_TTL_MS;
        if ((now - hit.at) < ttl) {
          // True LRU: refresh recency on hit, indem wir den Eintrag löschen
          // und am Ende der Map (jüngste Position) wieder einfügen.
          _cache.delete(key);
          _cache.set(key, hit);
          return hit.value;
        }
        // expired → drop
        _cache.delete(key);
      }
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
        _rememberInCache(key, out, now, ERROR_CACHE_TTL_MS);
        return out;
      }
      body = await response.json();
    } catch (e) {
      const out = { quality: { error: String(e && e.message || e), fetchedAt: new Date(now).toISOString() } };
      _rememberInCache(key, out, now, ERROR_CACHE_TTL_MS);
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
    _rememberInCache(key, result, now, CACHE_TTL_MS);
    return result;
  }

  function _rememberInCache(key, value, at, ttl) {
    // True-LRU-Eviction: bereits vorhandenen Eintrag mit gleichem Key zuerst
    // entfernen, dann am Ende einfügen — damit ist der jüngste Eintrag
    // immer der zuletzt eingefügte. Wenn die Größe das Limit erreicht,
    // verwerfen wir den ältesten Eintrag (Map-Iterationsreihenfolge =
    // Einfügereihenfolge ⇒ keys().next().value ist least-recently-used).
    if (_cache.has(key)) _cache.delete(key);
    while (_cache.size >= MAX_CACHE) {
      const firstKey = _cache.keys().next().value;
      if (!firstKey) break;
      _cache.delete(firstKey);
    }
    _cache.set(key, { at, value, ttl: ttl || CACHE_TTL_MS });
  }

  function clearCache() { _cache.clear(); }

  /**
   * Build a short German-language summary line that's suitable for the
   * Plain-Text export. Returns `null` when the input cannot be summarised.
   */
  function summarizeForText(ctx) {
    if (!ctx || !ctx.summary) return null;
    const s = ctx.summary;
    const c = ctx.contexts || {};
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
    // Kontext-Evidenz (Spec-Item 2 Felder) — knapp anhängen, nur wenn ≥1.
    if (c.trainStations > 0)       parts.push(`${c.trainStations} Bahnhof/Haltepunkt(e) im Bereich`);
    if (c.busStations > 0)         parts.push(`${c.busStations} Busbahnhof(/e) im Bereich`);
    if (c.tramTrackWays > 0)       parts.push(`${c.tramTrackWays} Schienen-Wegabschnitt(e) (Tram/Stadtbahn)`);
    if (c.cobblestoneWays > 0)     parts.push(`${c.cobblestoneWays} Wegabschnitt(e) mit Pflaster/Kopfstein`);
    if (c.mixedFootCycleWays > 0)  parts.push(`${c.mixedFootCycleWays} gemeinsame Fuß-/Radfläche(n)`);
    if (parts.length === 0) return null;
    return parts.join("; ") + ".";
  }

  UA.osmContext = {
    fetchOsmContext,
    aggregate,
    parseMaxspeed,
    hasCycleInfra,
    isMixedFootCycle,
    isCobblestoneSurface,
    buildQuery,
    summarizeForText,
    setEndpoint,
    getEndpoint,
    clearCache,
    DEFAULT_ENDPOINT
  };
})();
