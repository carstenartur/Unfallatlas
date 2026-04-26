/**
 * UA.accidentViews — strategy registry for the accident detail section.
 *
 * Each strategy describes
 *   - how to GROUP a flat list of accident items into [{key, items, meta}],
 *   - how to RENDER the group header and individual rows in the three output
 *     formats (text, html, docx).
 *
 * The export pipeline consumes the registry so that adding a new view is a
 * single-file change and never requires touching ua.export_v2.js / ua.report_v2.js.
 *
 * Item shape (produced by accidentDetailTable in ua.export_v2.js):
 *   {
 *     lat, lon, year, severity (string "1"|"2"|"3"), sevLabel,
 *     involved (emoji string), hour, weekday, roadCondition, mask
 *   }
 *
 * Group shape (produced by view.group):
 *   {
 *     key:   string (severity key / mask number / "all"),
 *     items: Item[]      // post-sort; not yet capped
 *     meta:  { ...arbitrary, e.g. severityCounts, totalCount, histogram }
 *   }
 *
 * The cap (rowCap) is enforced by the consumer (renderAccidentSection),
 * NOT by view.group, so unit tests can inspect the full group sizes.
 */
(() => {
  const UA = (window.UA = window.UA || {});

  // Re-use the involvement bit table (same convention as ua.filters.js):
  // [bit, emoji-label] in display order Rad, Fuß, PKW, Krad, Gkfz, Sonst.
  const COMBO_BITS = [
    [1,  "🚲"],
    [2,  "🚶"],
    [4,  "🚗"],
    [8,  "🏍️"],
    [16, "🚛"],
    [32, "🚌"]
  ];

  const SEV_LABEL_MAP = { "1": "Getötet", "2": "Schwerverletzt", "3": "Leichtverletzt" };
  // Plural forms used in group headers ("Getötete (n=X)") and overflow notices.
  const SEV_HEADER_LABEL = { "1": "Getötete", "2": "Schwerverletzte", "3": "Leichtverletzte" };
  // Compact severity badges used by byInvolvement headers (in display order † S L).
  const SEV_BADGE = { "1": "†", "2": "S", "3": "L" };
  const SEV_KEYS = ["1", "2", "3"];

  // Sentinel used to sort null/undefined hours after all real hours (0–23).
  const HOUR_SORT_LAST = 99;

  function escHtml(s) {
    if (UA.escHtml) return UA.escHtml(s);
    return String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function fmtHour(h) {
    return h != null ? String(h).padStart(2, "0") + ":00" : "—";
  }
  function fmtCoords(lat, lon) {
    if (lat != null && lon != null) return `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
    return "—";
  }
  // Combine weekday label with day-type ("Werktag" / "Wochenende"). When the
  // group is unknown (e.g. raw code missing) the bare day token is returned —
  // and "—" is used as a final fallback so tables stay aligned.
  function fmtWeekday(it) {
    const day = it.weekday || "—";
    if (it.weekdayGroup === "Werktag" || it.weekdayGroup === "Wochenende") {
      return `${day} (${it.weekdayGroup})`;
    }
    return day;
  }

  // Build histogram "🚲: 7 · 🚗: 9" over a list of items (bit-counts over masks,
  // skipping zero counts; preserves COMBO_BITS order Rad, Fuß, PKW, Krad, Gkfz, Sonst.).
  function buildInvolvementHistogram(items) {
    const parts = [];
    for (const [bit, emoji] of COMBO_BITS) {
      const c = items.filter(r => (r.mask & bit) !== 0).length;
      if (c > 0) parts.push(`${emoji}: ${c}`);
    }
    return parts.join(" · ");
  }

  // Count how many items fall into Werktag vs. Wochenende. Items without a
  // recognized weekdayGroup are silently skipped (counted in neither bucket).
  function buildWeekdayGroupCounts(items) {
    const c = { Werktag: 0, Wochenende: 0 };
    for (const it of items) {
      if (it.weekdayGroup === "Werktag" || it.weekdayGroup === "Wochenende") {
        c[it.weekdayGroup] += 1;
      }
    }
    return c;
  }

  // Format weekday-group counts as "Werktag: 9 · Wochenende: 3" (only counts > 0).
  // Returns "" when both counts are 0 so callers can omit the block entirely.
  function fmtWeekdayGroupCounts(counts) {
    if (!counts) return "";
    const parts = [];
    if (counts.Werktag > 0) parts.push(`Werktag: ${counts.Werktag}`);
    if (counts.Wochenende > 0) parts.push(`Wochenende: ${counts.Wochenende}`);
    return parts.join(" · ");
  }

  // Severity-count map { "1": n1, "2": n2, "3": n3 } over a list of items.
  function buildSeverityCounts(items) {
    const c = { "1": 0, "2": 0, "3": 0 };
    for (const it of items) {
      if (c[it.severity] !== undefined) c[it.severity] += 1;
    }
    return c;
  }

  // Format severity counts as "† 1 / S 4 / L 7" (only counts > 0, fixed order † S L).
  function fmtSeverityBadges(severityCounts) {
    const parts = [];
    for (const k of SEV_KEYS) {
      const n = severityCounts[k] || 0;
      if (n > 0) parts.push(`${SEV_BADGE[k]} ${n}`);
    }
    return parts.join(" / ");
  }

  // Common helpers to produce one row in each format.
  // Columns differ by view (severity column makes sense for byInvolvement / flat
  // but is redundant when rows are already grouped by severity).
  function renderRowTextWithSeverity(it, idx) {
    return `  ${idx + 1} | ${it.year ?? "—"} | ${it.sevLabel} | ${it.involved} | ${fmtHour(it.hour)} | ${fmtWeekday(it)} | ${it.roadCondition} | ${fmtCoords(it.lat, it.lon)}`;
  }
  function renderRowTextNoSeverity(it, idx) {
    return `  ${idx + 1} | ${it.year ?? "—"} | ${it.involved} | ${fmtHour(it.hour)} | ${fmtWeekday(it)} | ${it.roadCondition} | ${fmtCoords(it.lat, it.lon)}`;
  }
  function renderRowHtmlWithSeverity(it, idx) {
    return `<tr><td>${idx + 1}</td><td style="text-align:right;">${it.year ?? "—"}</td><td>${escHtml(it.sevLabel)}</td><td>${escHtml(it.involved)}</td><td style="text-align:right;">${fmtHour(it.hour)}</td><td>${escHtml(fmtWeekday(it))}</td><td>${escHtml(it.roadCondition)}</td><td style="font-size:11px; color:#555;">${escHtml(fmtCoords(it.lat, it.lon))}</td></tr>`;
  }
  function renderRowHtmlNoSeverity(it, idx) {
    return `<tr><td>${idx + 1}</td><td style="text-align:right;">${it.year ?? "—"}</td><td>${escHtml(it.involved)}</td><td style="text-align:right;">${fmtHour(it.hour)}</td><td>${escHtml(fmtWeekday(it))}</td><td>${escHtml(it.roadCondition)}</td><td style="font-size:11px; color:#555;">${escHtml(fmtCoords(it.lat, it.lon))}</td></tr>`;
  }
  // DOCX/PDF row producers return raw cell strings; the export module wraps
  // them via the existing makeDocxTable / makePdfTable helpers.
  function renderRowCellsWithSeverity(it, idx) {
    return [String(idx + 1), String(it.year ?? "—"), it.sevLabel, it.involved, fmtHour(it.hour), fmtWeekday(it), it.roadCondition || "—", fmtCoords(it.lat, it.lon)];
  }
  function renderRowCellsNoSeverity(it, idx) {
    return [String(idx + 1), String(it.year ?? "—"), it.involved, fmtHour(it.hour), fmtWeekday(it), it.roadCondition || "—", fmtCoords(it.lat, it.lon)];
  }

  // Column header lists used by the export consumer to build tables.
  const COLS_WITH_SEVERITY    = ["#", "Jahr", "Schwere", "Beteiligte", "Uhrzeit", "Wochentag", "Fahrbahnzustand", "Koordinaten"];
  const COLS_WITHOUT_SEVERITY = ["#", "Jahr",            "Beteiligte", "Uhrzeit", "Wochentag", "Fahrbahnzustand", "Koordinaten"];

  // -------------------------------------------------------------------------
  // bySeverity (default — same visual result as PR #219)
  // -------------------------------------------------------------------------
  const bySeverity = {
    id: "bySeverity",
    label: "nach Schwere",
    rowCap: 20,
    columns: COLS_WITHOUT_SEVERITY,
    group(items) {
      const groups = [];
      for (const sevKey of SEV_KEYS) {
        const sub = items.filter(r => r.severity === sevKey);
        if (sub.length === 0) continue;
        sub.sort((a, b) => {
          const yd = (b.year || 0) - (a.year || 0);
          if (yd !== 0) return yd;
          return (a.hour != null ? a.hour : HOUR_SORT_LAST) - (b.hour != null ? b.hour : HOUR_SORT_LAST);
        });
        groups.push({
          key: sevKey,
          items: sub,
          meta: {
            totalCount: sub.length,
            histogram: buildInvolvementHistogram(sub),
            weekdayGroupCounts: buildWeekdayGroupCounts(sub),
            sevLabel: SEV_HEADER_LABEL[sevKey] || sevKey,
            sevSingular: SEV_LABEL_MAP[sevKey] || sevKey
          }
        });
      }
      return groups;
    },
    renderHeader: {
      text(g) {
        const wg = fmtWeekdayGroupCounts(g.meta.weekdayGroupCounts);
        const tail = [g.meta.histogram, wg].filter(Boolean).join(" · ");
        return `--- ${g.meta.sevLabel} (n=${g.meta.totalCount})${tail ? " | " + tail : ""} ---`;
      },
      html(g) {
        const wg = fmtWeekdayGroupCounts(g.meta.weekdayGroupCounts);
        const tail = [g.meta.histogram, wg].filter(Boolean).join(" · ");
        const hist = tail
          ? ` <span style="font-weight:400; font-size:12px;"> — ${escHtml(tail)}</span>`
          : "";
        return `<div style="font-weight:700; margin-top:10px;">${escHtml(g.meta.sevLabel)} (n=${g.meta.totalCount})${hist}</div>`;
      },
      docx(g) {
        const wg = fmtWeekdayGroupCounts(g.meta.weekdayGroupCounts);
        const tail = [g.meta.histogram, wg].filter(Boolean).join(" · ");
        const headerText = `${g.meta.sevLabel} (n=${g.meta.totalCount})${tail ? "  —  " + tail : ""}`;
        return [{ text: headerText, bold: true }];
      }
    },
    renderRow: {
      text: renderRowTextNoSeverity,
      html: renderRowHtmlNoSeverity,
      docx: renderRowCellsNoSeverity
    },
    overflowLabel(g) {
      return `weitere ${g.meta.sevLabel}`;
    }
  };

  // -------------------------------------------------------------------------
  // byInvolvement — group by mask, severity badges in header
  // -------------------------------------------------------------------------
  const byInvolvement = {
    id: "byInvolvement",
    label: "nach Beteiligung",
    rowCap: 20,
    columns: COLS_WITH_SEVERITY,
    group(items) {
      const byMask = new Map();
      for (const it of items) {
        const arr = byMask.get(it.mask) || [];
        arr.push(it);
        byMask.set(it.mask, arr);
      }
      const groups = [];
      for (const [mask, sub] of byMask) {
        if (sub.length === 0) continue;
        sub.sort((a, b) => {
          const sa = Number(a.severity) || 99;
          const sb = Number(b.severity) || 99;
          if (sa !== sb) return sa - sb;
          return (b.year || 0) - (a.year || 0);
        });
        const sevCounts = buildSeverityCounts(sub);
        groups.push({
          key: String(mask),
          items: sub,
          meta: {
            mask,
            label: (UA.COMBO_LABEL && UA.COMBO_LABEL[mask]) || ("Mask " + mask),
            totalCount: sub.length,
            severityCounts: sevCounts,
            severityBadges: fmtSeverityBadges(sevCounts),
            weekdayGroupCounts: buildWeekdayGroupCounts(sub)
          }
        });
      }
      // Most frequent pattern first; tiebreaker: smaller mask first (deterministic).
      groups.sort((a, b) => {
        const cd = b.meta.totalCount - a.meta.totalCount;
        if (cd !== 0) return cd;
        return a.meta.mask - b.meta.mask;
      });
      return groups;
    },
    renderHeader: {
      text(g) {
        const badges = g.meta.severityBadges ? ` [${g.meta.severityBadges}]` : "";
        const wg = fmtWeekdayGroupCounts(g.meta.weekdayGroupCounts);
        return `--- ${g.meta.label} (n=${g.meta.totalCount})${badges}${wg ? " | " + wg : ""} ---`;
      },
      html(g) {
        const badges = g.meta.severityBadges
          ? ` <span style="font-weight:400; font-size:12px;"> [${escHtml(g.meta.severityBadges)}]</span>`
          : "";
        const wg = fmtWeekdayGroupCounts(g.meta.weekdayGroupCounts);
        const wgHtml = wg ? ` <span style="font-weight:400; font-size:12px;"> — ${escHtml(wg)}</span>` : "";
        return `<div style="font-weight:700; margin-top:10px;">${escHtml(g.meta.label)} (n=${g.meta.totalCount})${badges}${wgHtml}</div>`;
      },
      docx(g) {
        const badges = g.meta.severityBadges ? `  [${g.meta.severityBadges}]` : "";
        const wg = fmtWeekdayGroupCounts(g.meta.weekdayGroupCounts);
        const headerText = `${g.meta.label} (n=${g.meta.totalCount})${badges}${wg ? "  —  " + wg : ""}`;
        return [{ text: headerText, bold: true }];
      }
    },
    renderRow: {
      text: renderRowTextWithSeverity,
      html: renderRowHtmlWithSeverity,
      docx: renderRowCellsWithSeverity
    },
    overflowLabel(g) {
      return `weitere Unfälle (${g.meta.label})`;
    }
  };

  // -------------------------------------------------------------------------
  // flat — single group, chronological, retains the historic 50-row cap
  // -------------------------------------------------------------------------
  const flat = {
    id: "flat",
    label: "chronologisch",
    rowCap: 50,
    columns: COLS_WITH_SEVERITY,
    group(items) {
      if (items.length === 0) return [];
      const sub = items.slice().sort((a, b) => {
        const yd = (b.year || 0) - (a.year || 0);
        if (yd !== 0) return yd;
        const sa = Number(a.severity) || 99;
        const sb = Number(b.severity) || 99;
        return sa - sb;
      });
      return [{
        key: "all",
        items: sub,
        meta: { totalCount: sub.length }
      }];
    },
    renderHeader: {
      // Single group, no header (consumer should skip empty headers).
      text(/*g*/) { return ""; },
      html(/*g*/) { return ""; },
      docx(/*g*/) { return []; }
    },
    renderRow: {
      text: renderRowTextWithSeverity,
      html: renderRowHtmlWithSeverity,
      docx: renderRowCellsWithSeverity
    },
    overflowLabel(/*g*/) {
      return "weitere Unfälle";
    }
  };

  // -------------------------------------------------------------------------
  // byTimePattern — group by traffic-time cluster (Schul-/Berufs-/Tag-/Nachtverkehr × Werktag/Wochenende)
  //
  // Uses UA.timeClusters (default cluster set, optionally city-overridden via
  // UA.timeClusters.loadTimeClusters(citySlug)). The classifier is *injected*
  // by the export pipeline so this strategy stays pure & testable: callers
  // can pass their own cluster set via `UA.applyAccidentView(items, "byTimePattern", { clusters })`.
  //
  // Each cluster becomes one group. Items not matching any cluster fall into
  // the "andere" bucket. Group sort: totalCount desc (most frequent first);
  // within a group: severity asc, year desc.
  // -------------------------------------------------------------------------
  function _resolveClusters(opts) {
    if (opts && Array.isArray(opts.clusters) && opts.clusters.length > 0) {
      return opts.clusters;
    }
    if (UA.timeClusters && Array.isArray(UA.timeClusters.DEFAULT_CLUSTERS)) {
      return UA.timeClusters.DEFAULT_CLUSTERS;
    }
    return [];
  }

  // Format a cluster's hour range for the header: [[7,0],[8,30]] → "07:00–08:30"
  function _fmtHoursRange(hours) {
    if (!Array.isArray(hours) || hours.length < 2) return "";
    const pad = (n) => String(n).padStart(2, "0");
    const fmt = (hm) => {
      if (!Array.isArray(hm)) return "";
      const h = Number(hm[0]);
      const m = Number(hm[1] || 0);
      // Hours > 23 mean "next day" — wrap for display.
      const hh = ((h % 24) + 24) % 24;
      return `${pad(hh)}:${pad(m)}`;
    };
    return `${fmt(hours[0])}–${fmt(hours[1])}`;
  }

  function _fmtWeekdayShort(wg) {
    if (wg === "Werktag")    return "Mo–Fr";
    if (wg === "Wochenende") return "Sa/So";
    return "";
  }

  const byTimePattern = {
    id: "byTimePattern",
    label: "nach Verkehrszeit-Muster",
    rowCap: 20,
    columns: COLS_WITH_SEVERITY,
    group(items, opts) {
      const clusters = _resolveClusters(opts);
      if (clusters.length === 0) return [];

      // Bucket items by classifier; preserve cluster order (Schule wins).
      const buckets = new Map(); // clusterId → items
      for (const c of clusters) buckets.set(c.id, []);
      buckets.set("andere", []);

      const classify = (UA.timeClusters && UA.timeClusters.classify)
        ? (item) => UA.timeClusters.classify(item, clusters)
        : () => null;

      for (const it of items || []) {
        const id = classify(it);
        if (id && buckets.has(id)) {
          buckets.get(id).push(it);
        } else {
          buckets.get("andere").push(it);
        }
      }

      const clusterById = new Map();
      for (const c of clusters) clusterById.set(c.id, c);

      const groups = [];
      for (const [id, sub] of buckets) {
        if (sub.length === 0) continue;
        sub.sort((a, b) => {
          const sa = Number(a.severity) || 99;
          const sb = Number(b.severity) || 99;
          if (sa !== sb) return sa - sb;
          return (b.year || 0) - (a.year || 0);
        });
        const cluster = clusterById.get(id);
        const sevCounts = buildSeverityCounts(sub);
        const label = cluster ? cluster.label : "Andere / unbekannte Uhrzeit";
        const weekdayShort = cluster ? _fmtWeekdayShort(cluster.weekdayGroup) : "";
        const hoursStr = cluster ? _fmtHoursRange(cluster.hours) : "";
        const condition = [weekdayShort, hoursStr].filter(Boolean).join(" ");
        groups.push({
          key: id,
          items: sub,
          meta: {
            clusterId: id,
            label,
            condition,
            totalCount: sub.length,
            severityCounts: sevCounts,
            severityBadges: fmtSeverityBadges(sevCounts),
            histogram: buildInvolvementHistogram(sub)
          }
        });
      }
      // Most-frequent cluster first; tiebreaker: original cluster order.
      const orderIdx = new Map();
      let i = 0;
      for (const c of clusters) orderIdx.set(c.id, i++);
      orderIdx.set("andere", i);
      groups.sort((a, b) => {
        const cd = b.meta.totalCount - a.meta.totalCount;
        if (cd !== 0) return cd;
        return (orderIdx.get(a.key) ?? 0) - (orderIdx.get(b.key) ?? 0);
      });
      return groups;
    },
    renderHeader: {
      text(g) {
        const badges = g.meta.severityBadges ? ` [${g.meta.severityBadges}]` : "";
        const condition = g.meta.condition ? ` (${g.meta.condition})` : "";
        const hist = g.meta.histogram ? ` · ${g.meta.histogram}` : "";
        return `--- ${g.meta.label}${condition} — n=${g.meta.totalCount}${badges}${hist} ---`;
      },
      html(g) {
        const badges = g.meta.severityBadges
          ? ` <span style="font-weight:400; font-size:12px;"> [${escHtml(g.meta.severityBadges)}]</span>`
          : "";
        const condition = g.meta.condition
          ? ` <span style="font-weight:400; font-size:12px; color:#666;">(${escHtml(g.meta.condition)})</span>`
          : "";
        const hist = g.meta.histogram
          ? ` <span style="font-weight:400; font-size:12px;"> — ${escHtml(g.meta.histogram)}</span>`
          : "";
        return `<div style="font-weight:700; margin-top:10px;">${escHtml(g.meta.label)}${condition} (n=${g.meta.totalCount})${badges}${hist}</div>`;
      },
      docx(g) {
        const badges = g.meta.severityBadges ? `  [${g.meta.severityBadges}]` : "";
        const condition = g.meta.condition ? `  ${g.meta.condition}` : "";
        const hist = g.meta.histogram ? `  —  ${g.meta.histogram}` : "";
        const headerText = `${g.meta.label}${condition} (n=${g.meta.totalCount})${badges}${hist}`;
        return [{ text: headerText, bold: true }];
      }
    },
    renderRow: {
      text: renderRowTextWithSeverity,
      html: renderRowHtmlWithSeverity,
      docx: renderRowCellsWithSeverity
    },
    overflowLabel(g) {
      return `weitere Unfälle (${g.meta.label})`;
    }
  };

  UA.accidentViews = { bySeverity, byInvolvement, flat, byTimePattern };
  UA.ACCIDENT_VIEW_DEFAULT = "bySeverity";
  // Re-export weekday formatting + group-count helpers so legacy/non-strategy
  // code paths render the same "Mi (Werktag)" string and use the same Werktag/
  // Wochenende counts.
  UA.fmtWeekday = fmtWeekday;
  UA.buildWeekdayGroupCounts = buildWeekdayGroupCounts;
  UA.fmtWeekdayGroupCounts = fmtWeekdayGroupCounts;

  // Resolve a view id to a strategy, falling back to the default for unknown ids.
  UA.resolveAccidentView = function resolveAccidentView(viewId) {
    if (viewId && UA.accidentViews[viewId]) return UA.accidentViews[viewId];
    return UA.accidentViews[UA.ACCIDENT_VIEW_DEFAULT];
  };

  /**
   * Apply a view to a flat item list and return:
   *   { viewId, columns, groups: [{ key, meta, rows, count, overflow, headers }], total, truncated }
   *
   * `rows` is the post-cap list (length ≤ effective cap) with the original items.
   * `headers` is a pre-rendered map { text, html, docx } for each group, using
   * the view's renderHeader callbacks. Consumers stay format-agnostic.
   *
   * `opts.rowCap` (optional) overrides the strategy's default `rowCap` for this
   * call only — without mutating the shared strategy object. Pass a finite
   * number to take effect; anything else falls back to `view.rowCap`.
   */
  UA.applyAccidentView = function applyAccidentView(items, viewId, opts) {
    const view = UA.resolveAccidentView(viewId);
    const rawGroups = view.group(items || [], opts || {});
    const overrideCap = opts && Number.isFinite(Number(opts.rowCap)) ? Number(opts.rowCap) : null;
    const cap = overrideCap !== null
      ? overrideCap
      : (Number.isFinite(view.rowCap) ? view.rowCap : 20);
    const groups = rawGroups.map(g => {
      const count = g.items.length;
      const rows = g.items.slice(0, cap);
      const overflow = count - rows.length;
      const overflowLabel = view.overflowLabel ? view.overflowLabel(g) : "weitere Unfälle";
      return {
        key: g.key,
        meta: g.meta,
        rows,
        count,
        overflow,
        overflowLabel,
        headers: {
          text: view.renderHeader.text(g),
          html: view.renderHeader.html(g),
          docx: view.renderHeader.docx(g)
        }
      };
    });
    const total = (items || []).length;
    const truncated = groups.some(g => g.overflow > 0);
    return {
      viewId: view.id,
      columns: view.columns,
      groups,
      total,
      truncated
    };
  };
})();
