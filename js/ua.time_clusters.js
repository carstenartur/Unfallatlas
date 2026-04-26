/**
 * UA.timeClusters — Verkehrs-Zeitkontext-Cluster (Schul-/Berufs-/Tag-/Nachtverkehr × Werktag/Wochenende).
 *
 * Stellt Defaults bereit und lädt optional eine stadtspezifische Konfiguration
 * (`templates/time_clusters_<citySlug>.json`). Fallback-Kette analog `gremien_*.json`:
 *   1. stadtspezifisch (`templates/time_clusters_<city>.json`)
 *   2. generisch        (`templates/time_clusters.json`)
 *   3. eingebauter Default (`DEFAULT_CLUSTERS`)
 *
 * Cluster-Format:
 *   {
 *     id:        "werktag_schule_morgens",
 *     label:     "Schulverkehr (morgens)",
 *     weekdayGroup: "Werktag" | "Wochenende" | "Beide",
 *     hours:     [[startH, startM], [endH, endM]]  // [[7,0],[8,30]] = 07:00–08:30 inkl.
 *   }
 *
 * Cluster-Reihenfolge in der Konfiguration ist signifikant: das ERSTE
 * matchende Cluster gewinnt. Konsequenz: Schule sollte vor Berufsverkehr
 * stehen, wenn deren Zeitfenster überlappt.
 *
 * Werktagsgruppe verwendet die schon vorhandenen Strings "Werktag" /
 * "Wochenende" (siehe ua.accident_views.js: it.weekdayGroup).
 *
 * Items ohne erkennbare Stunde landen im Bucket `andere`.
 */
(() => {
  const UA = (window.UA = window.UA || {});

  const TEMPLATE_DIR = "templates";

  /**
   * Eingebauter Default-Cluster-Satz. Reihenfolge ist relevant – das erste
   * matchende Cluster gewinnt (Schule schlägt Berufsverkehr).
   *
   * Hour-Ranges sind halboffene Intervalle [start, end), gemessen in Minuten
   * seit 00:00. So liegt 08:30 selbst noch im Schul-Slot, wenn end=[8,30] ist
   * (08:30:00 == 510 Min, < 510 ist false → 08:30 ist NICHT im Slot). Für die
   * öffentliche Konfig dokumentieren wir das Slot inklusiv (07:00–08:30
   * heißt: 07:00, 07:01, …, 08:29; 08:30 wäre eine eigene Stunde 8 mit
   * Minute 30, die in der Statistik aber nur als ganze Stunde 8 vorkommt).
   *
   * Für die Auswertung steht in der Praxis nur eine Stunde (0–23) pro
   * Item zur Verfügung (siehe accident_views: `it.hour`). Die clusterMatch-
   * Funktion vergleicht daher die Stunde + Minute-Komponente — bei nur Stunde
   * verwendet sie Minute=0.
   */
  const DEFAULT_CLUSTERS = Object.freeze([
    {
      id: "werktag_schule_morgens",
      label: "Schulverkehr (morgens)",
      weekdayGroup: "Werktag",
      hours: [[7, 0], [8, 30]],
      typicalParticipants: ["Kinder", "Rad", "Fuß"]
    },
    {
      id: "werktag_schule_nachmittags",
      label: "Schulverkehr (nachmittags)",
      weekdayGroup: "Werktag",
      hours: [[12, 0], [14, 0]],
      typicalParticipants: ["Kinder", "Rad", "Fuß"]
    },
    {
      id: "werktag_berufsverkehr_morgens",
      label: "Berufsverkehr (morgens)",
      weekdayGroup: "Werktag",
      hours: [[6, 30], [9, 30]],
      typicalParticipants: ["PKW", "Rad"]
    },
    {
      id: "werktag_berufsverkehr_abends",
      label: "Berufsverkehr (abends)",
      weekdayGroup: "Werktag",
      hours: [[16, 0], [19, 0]],
      typicalParticipants: ["PKW", "Rad"]
    },
    {
      id: "werktag_tag",
      label: "Werktag (sonst tagsüber)",
      weekdayGroup: "Werktag",
      hours: [[9, 30], [16, 0]],
      typicalParticipants: ["gemischt"]
    },
    {
      id: "werktag_abend",
      label: "Werktag (Abend)",
      weekdayGroup: "Werktag",
      hours: [[19, 0], [22, 0]],
      typicalParticipants: ["gemischt"]
    },
    {
      id: "werktag_nacht",
      label: "Werktag (Nacht)",
      weekdayGroup: "Werktag",
      // Crosses midnight: 22:00–05:00. We model this as two ranges in DEFAULT.
      hours: [[22, 0], [29, 0]],
      typicalParticipants: ["wenig", "oft schwerer"]
    },
    {
      id: "wochenende_tag",
      label: "Wochenende (Tag)",
      weekdayGroup: "Wochenende",
      hours: [[8, 0], [22, 0]],
      typicalParticipants: ["Freizeit", "Familie"]
    },
    {
      id: "wochenende_nacht",
      label: "Wochenende (Nacht)",
      weekdayGroup: "Wochenende",
      hours: [[22, 0], [29, 0]],
      typicalParticipants: ["Ausgehverkehr", "Alkohol"]
    }
  ]);

  // Fallback-Container, der wie eine geladene Konfig aussieht
  const FALLBACK = Object.freeze({
    version: 1,
    source: "ua.time_clusters.js DEFAULT_CLUSTERS",
    clusters: DEFAULT_CLUSTERS
  });

  let _genericCache = undefined; // undefined = not yet attempted
  const _cityCache = new Map();

  function _resetCache() {
    _genericCache = undefined;
    _cityCache.clear();
  }

  /**
   * Lädt die generische Konfig (`templates/time_clusters.json`) wenn vorhanden.
   * @returns {Promise<object|null>}
   */
  async function _loadGeneric() {
    if (_genericCache !== undefined) return _genericCache;
    try {
      const r = await fetch(`${TEMPLATE_DIR}/time_clusters.json`, { cache: "no-store" });
      if (!r.ok) {
        _genericCache = null;
        return null;
      }
      const data = await r.json();
      _genericCache = (data && Array.isArray(data.clusters)) ? data : null;
      return _genericCache;
    } catch {
      _genericCache = null;
      return null;
    }
  }

  /**
   * Lädt eine stadtspezifische Konfig (`templates/time_clusters_<city>.json`).
   * @param {string} citySlug
   * @returns {Promise<object|null>}
   */
  async function _loadCity(citySlug) {
    if (!citySlug) return null;
    if (_cityCache.has(citySlug)) return _cityCache.get(citySlug);
    try {
      const r = await fetch(`${TEMPLATE_DIR}/time_clusters_${citySlug}.json`, { cache: "no-store" });
      if (!r.ok) { _cityCache.set(citySlug, null); return null; }
      const data = await r.json();
      const out = (data && Array.isArray(data.clusters)) ? data : null;
      _cityCache.set(citySlug, out);
      return out;
    } catch {
      _cityCache.set(citySlug, null);
      return null;
    }
  }

  /**
   * Lädt die effektiven Cluster für eine Stadt. Fallback-Kette:
   *   stadtspezifisch → generisch → DEFAULT_CLUSTERS.
   *
   * @param {string} [citySlug]
   * @returns {Promise<object>} `{ version, source, clusters }`
   */
  async function loadTimeClusters(citySlug) {
    const city = await _loadCity(citySlug);
    if (city) return city;
    const generic = await _loadGeneric();
    if (generic) return generic;
    return FALLBACK;
  }

  /**
   * Konvertiert [h, m] zu Minuten seit Mitternacht.
   * @param {[number, number]} hm
   */
  function _toMin(hm) {
    if (!Array.isArray(hm) || hm.length < 1) return null;
    const h = Number(hm[0]);
    const m = Number(hm[1] || 0);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
    return h * 60 + m;
  }

  /**
   * Prüft, ob ein Item (mit hour [+ ggf. minute] und weekdayGroup) in das Cluster fällt.
   *
   * Item-Felder:
   *   it.hour          : 0–23 oder null
   *   it.minute        : 0–59 (optional, default 0)
   *   it.weekdayGroup  : "Werktag" | "Wochenende"
   *
   * @param {object} item
   * @param {object} cluster
   * @returns {boolean}
   */
  function matchesCluster(item, cluster) {
    if (!item || !cluster) return false;
    const wg = cluster.weekdayGroup || "Beide";
    if (wg !== "Beide" && item.weekdayGroup !== wg) return false;

    const h = (item.hour != null && Number.isFinite(Number(item.hour))) ? Number(item.hour) : null;
    if (h === null) return false;
    const m = (item.minute != null && Number.isFinite(Number(item.minute))) ? Number(item.minute) : 0;
    const itemMin = h * 60 + m;

    const start = _toMin(cluster.hours && cluster.hours[0]);
    const end   = _toMin(cluster.hours && cluster.hours[1]);
    if (start === null || end === null) return false;

    // [start, end) — auch über Mitternacht (end > 24*60 erlaubt: Wert mod 1440)
    if (end > start) {
      // Normaler Bereich
      if (itemMin >= start && itemMin < end) return true;
      // Wenn end > 24h (z. B. [22,0]–[29,0]), zusätzlich frühe Tagesstunden prüfen
      if (end > 24 * 60 && itemMin < (end - 24 * 60)) return true;
      return false;
    }
    if (end === start) return false;
    // end < start: Bereich überspannt Mitternacht (z. B. 22:00–05:00 als [22,0]→[5,0])
    return itemMin >= start || itemMin < end;
  }

  /**
   * Klassifiziert ein Item in das erste matchende Cluster (oder `null` für andere).
   * @param {object} item
   * @param {object[]} clusters
   * @returns {string|null} cluster-id oder null
   */
  function classify(item, clusters) {
    if (!Array.isArray(clusters)) return null;
    for (const c of clusters) {
      if (matchesCluster(item, c)) return c.id;
    }
    return null;
  }

  UA.timeClusters = {
    DEFAULT_CLUSTERS,
    FALLBACK,
    loadTimeClusters,
    matchesCluster,
    classify,
    _resetCache
  };
})();
