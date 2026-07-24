(() => {
  'use strict';

  const UA = (window.UA = window.UA || {});
  if (UA.AnalysisScope) return;

  const HOOK_MARK = '_uaAnalysisScopeWrapped';
  const hookRecords = new Map();

  function finite(value) {
    return Number.isFinite(Number(value));
  }

  function plainBounds(bounds) {
    if (!bounds) return null;
    if (typeof bounds.getSouth === 'function') {
      return {
        south: Number(bounds.getSouth()), west: Number(bounds.getWest()),
        north: Number(bounds.getNorth()), east: Number(bounds.getEast()),
      };
    }
    if (typeof bounds.getSouthWest === 'function' && typeof bounds.getNorthEast === 'function') {
      const sw = bounds.getSouthWest();
      const ne = bounds.getNorthEast();
      return { south: Number(sw.lat), west: Number(sw.lng), north: Number(ne.lat), east: Number(ne.lng) };
    }
    if (Array.isArray(bounds) && bounds.length === 4) {
      return { south: Number(bounds[0]), west: Number(bounds[1]), north: Number(bounds[2]), east: Number(bounds[3]) };
    }
    if (typeof bounds === 'object') {
      return {
        south: Number(bounds.south), west: Number(bounds.west),
        north: Number(bounds.north), east: Number(bounds.east),
      };
    }
    return null;
  }

  function validBounds(bounds) {
    const b = plainBounds(bounds);
    if (!b || !Object.values(b).every(finite)) return null;
    if (b.south > b.north || b.west > b.east) return null;
    return b;
  }

  function pointInBounds(point, bounds) {
    const b = validBounds(bounds);
    return !!b && !!point && finite(point.lat) && finite(point.lon)
      && Number(point.lat) >= b.south && Number(point.lat) <= b.north
      && Number(point.lon) >= b.west && Number(point.lon) <= b.east;
  }

  function fallbackMask(props) {
    const pr = props || {};
    const flag = (lower, upper) => String(pr[lower] ?? pr[upper] ?? '') === '1';
    return (flag('istrad', 'IstRad') ? 1 : 0)
      | (flag('istfuss', 'IstFuss') ? 2 : 0)
      | (flag('istpkw', 'IstPKW') ? 4 : 0)
      | (flag('istkrad', 'IstKrad') ? 8 : 0)
      | (flag('istgkfz', 'IstGkfz') ? 16 : 0)
      | (flag('istsonstig', 'IstSonstig') ? 32 : 0);
  }

  function maskFromPoint(point) {
    const props = point && point.props;
    return typeof UA.maskFromProps === 'function' ? UA.maskFromProps(props || {}) : fallbackMask(props);
  }

  function fallbackInvolvementMatch(ctx, mask) {
    const ui = (ctx && ctx.ui) || {};
    const wanted = [
      [1, ui.incBikeEl], [2, ui.incPedEl], [4, ui.incCarEl],
      [8, ui.incMotoEl], [16, ui.incGkfzEl], [32, ui.incSonEl],
    ].filter(([, el]) => !!(el && el.checked)).map(([bit]) => bit);
    if (wanted.length === 0) return false;
    const mode = (ctx && ctx.involvementMode) || 'or';
    if (mode === 'and') return wanted.every(bit => (mask & bit) !== 0);
    if (mode === 'solo') return wanted.includes(mask) && mask > 0 && (mask & (mask - 1)) === 0;
    return wanted.some(bit => (mask & bit) !== 0);
  }

  function matchesNonInvolvement(ctx, point) {
    if (!point || !point.props) return false;
    return typeof UA.matchesNonInvolvementFilters !== 'function'
      || UA.matchesNonInvolvementFilters(ctx, point.props);
  }

  function matchesActiveFilters(ctx, point) {
    if (!matchesNonInvolvement(ctx, point)) return false;
    const mask = maskFromPoint(point);
    if (!mask) return false;
    return typeof UA.matchesInvolvementFilter === 'function'
      ? UA.matchesInvolvementFilter(ctx, mask)
      : fallbackInvolvementMatch(ctx, mask);
  }

  function getActiveFilteredPoints(ctx) {
    return (Array.isArray(ctx && ctx.allPts) ? ctx.allPts : []).filter(point => matchesActiveFilters(ctx, point));
  }

  function getContextAreaPoints(ctx, bounds) {
    return (Array.isArray(ctx && ctx.allPts) ? ctx.allPts : []).filter(point =>
      matchesNonInvolvement(ctx, point) && !!maskFromPoint(point) && pointInBounds(point, bounds));
  }

  function currentMapBounds(ctx) {
    try {
      return ctx && ctx.map && typeof ctx.map.getBounds === 'function' ? ctx.map.getBounds() : null;
    } catch (_) {
      return null;
    }
  }

  function exportBounds(ctx) {
    return (ctx && ctx.selectionBounds) || currentMapBounds(ctx);
  }

  function pointsInBounds(points, bounds) {
    const b = validBounds(bounds);
    if (!b) return [];
    return (Array.isArray(points) ? points : []).filter(point => pointInBounds(point, b));
  }

  function refreshScopePoints(ctx) {
    if (!ctx) return { active: [], visible: [], selected: [], buffered: [] };
    const active = getActiveFilteredPoints(ctx);
    // Both geographic counts intentionally use the same uncapped population.
    // `maxPoints` limits rendering performance, not the analytical truth set.
    const visible = pointsInBounds(active, currentMapBounds(ctx));
    const selected = ctx.selectionBounds ? pointsInBounds(active, ctx.selectionBounds) : [];
    const buffered = Array.isArray(ctx.viewportPts) ? ctx.viewportPts.slice() : [];
    ctx.activeFilteredPoints = active;
    ctx.visibleViewportPts = visible;
    ctx.selectionPts = selected;
    ctx.bufferedViewportPts = buffered;
    return { active, visible, selected, buffered };
  }

  function computeMaskCounts(points) {
    const counts = { total: 0, byMask: {} };
    for (const point of points || []) {
      const mask = maskFromPoint(point);
      if (!mask) continue;
      counts.total += 1;
      counts.byMask[mask] = (counts.byMask[mask] || 0) + 1;
    }
    return counts;
  }

  function maxRenderedPoints(ctx) {
    const raw = Number(ctx && ctx.ui && ctx.ui.maxPointsEl && ctx.ui.maxPointsEl.value);
    return Number.isFinite(raw) ? Math.max(500, Math.floor(raw)) : 100000;
  }

  function createScopedContext(ctx) {
    if (!ctx || typeof ctx !== 'object') return ctx;
    const active = getActiveFilteredPoints(ctx);
    const maxPoints = maxRenderedPoints(ctx);
    const visible = pointsInBounds(active, currentMapBounds(ctx));
    const selected = ctx.selectionBounds ? pointsInBounds(active, ctx.selectionBounds) : [];
    return Object.assign(Object.create(Object.getPrototypeOf(ctx) || Object.prototype), ctx, {
      allPts: active,
      filteredAll: active,
      filteredCapped: active.slice(0, maxPoints),
      viewportPts: visible,
      visibleViewportPts: visible,
      selectionPts: selected,
      baselineCounts: computeMaskCounts(active),
      __analysisScopeOriginalCtx: ctx,
    });
  }

  function countLabel(count) {
    return Number(count || 0).toLocaleString('de-DE');
  }

  function accidentPhrase(count) {
    const n = Number(count || 0);
    return `${countLabel(n)} ${n === 1 ? 'Unfall' : 'Unfälle'}`;
  }

  function areaLabel(ctx) {
    return ctx && ctx.selectionBounds ? 'markierten Bereich' : 'sichtbaren Kartenausschnitt';
  }

  function replaceMisleadingScopeWording(text) {
    return String(text || '')
      .replace(/unter denselben Nicht-Beteiligungsfiltern\s*\(Schwere\/Zeit\/Zustand\/Wochentag\)/g,
        'unter denselben aktiven Filtern einschließlich Beteiligungsfilter')
      .replace(/Nicht-Beteiligungsfiltern/g, 'aktiven Filtern einschließlich Beteiligungsfilter')
      .replace(/Nicht-Beteiligungsfilter/g, 'aktive Filter einschließlich Beteiligungsfilter');
  }

  function decorateReport(report, originalCtx, scopedCtx) {
    if (!report || typeof report !== 'object') return report;
    const bounds = exportBounds(originalCtx);
    const activeInArea = pointsInBounds(scopedCtx && scopedCtx.allPts, bounds).length;
    const contextInArea = getContextAreaPoints(originalCtx, bounds).length;
    const scope = refreshScopePoints(originalCtx);
    const label = areaLabel(originalCtx);
    const counts = Object.freeze({
      activeInArea,
      areaBeforeInvolvementFilter: contextInArea,
      visibleActive: scope.visible.length,
      bufferedActive: scope.buffered.length,
      selectedActive: originalCtx && originalCtx.selectionBounds ? scope.selected.length : null,
    });

    if (report.structured && typeof report.structured === 'object') {
      report.structured.scopeCounts = counts;
      report.structured.totalAccidents = activeInArea;
      if (report.structured.severity && typeof report.structured.severity === 'object') {
        report.structured.severity.total = activeInArea;
      }
      const meta = report.structured.meta || (report.structured.meta = {});
      meta.countScope = {
        primary: 'active-filter-selection', area: label,
        activeInArea, areaBeforeInvolvementFilter: contextInArea,
        includesInvolvementFilter: true,
      };
      if (meta.baselineScope && typeof meta.baselineScope === 'object') {
        meta.baselineScope.basis = 'Stadtweite Population mit identischen aktiven Filtern einschließlich Beteiligungsfilter';
        meta.baselineScope.filters = meta.filters || meta.baselineScope.filters || {};
      }
      report.structured.methodikScope = {
        title: 'Methodik – eindeutige Zählbereiche',
        lines: [
          `Aktive Auswertung: ${accidentPhrase(activeInArea)} im ${label}; berücksichtigt werden alle aktiven Filter einschließlich des Beteiligungsmodus.`,
          `Gebietsbestand vor Beteiligungsfilter: ${accidentPhrase(contextInArea)} im selben Gebiet unter den übrigen Filtern. Dieser Wert dient nur als Kontext und ist nicht die Fallzahl des gefilterten Antrags.`,
          'Sichtbar- und Markierungszahlen werden aus derselben ungekappte Filterpopulation und den exakten geometrischen Grenzen berechnet; Renderlimit und technischer Ladepuffer verändern diese Fallzahlen nicht.',
          'Der stadtweite Vergleich verwendet dieselben aktiven Filter einschließlich Beteiligungsfilter.',
        ],
      };
    }

    const scopeText = [
      'Hinweis zur Zählweise:',
      `Aktive Auswahl im ${label}: ${accidentPhrase(activeInArea)} (einschließlich Beteiligungsfilter).`,
      `Gebietsbestand vor Beteiligungsfilter: ${accidentPhrase(contextInArea)}; dieser Wert ist nur eine Kontextgröße.`,
      'Renderlimit und technischer Ladepuffer verändern weder die sichtbare noch die markierte Fallzahl.',
    ].join('\n');

    if (typeof report.text === 'string' && !report.text.includes('Hinweis zur Zählweise:\nAktive Auswahl')) {
      const text = replaceMisleadingScopeWording(report.text);
      const splitAt = text.indexOf('\n\n');
      report.text = splitAt >= 0
        ? `${text.slice(0, splitAt)}\n\n${scopeText}\n\n${text.slice(splitAt + 2)}`
        : `${scopeText}\n\n${text}`;
    } else if (typeof report.text === 'string') {
      report.text = replaceMisleadingScopeWording(report.text);
    }

    if (typeof report.html === 'string') {
      let html = replaceMisleadingScopeWording(report.html);
      if (!html.includes('data-ua-count-scope="active"')) {
        const box = `<div data-ua-count-scope="active" style="margin-top:8px;padding:9px 11px;border-left:4px solid #2c5aa0;background:#eef4fb;border-radius:4px;font-size:12px;line-height:1.45;">`
          + `<strong>Hinweis zur Zählweise:</strong> Aktive Auswahl im ${label}: <strong>${accidentPhrase(activeInArea)}</strong> einschließlich Beteiligungsfilter. `
          + `Vor dem Beteiligungsfilter liegen im selben Gebiet <strong>${accidentPhrase(contextInArea)}</strong>; diese Zahl ist nur Kontext. `
          + 'Renderlimit und technischer Ladepuffer verändern die Fallzahlen nicht.</div>';
        html = html.replace(/(<div style="font-weight:950; font-size:16px;">[\s\S]*?<\/div>)/, `$1${box}`);
      }
      report.html = html;
    }
    return report;
  }

  function hasScopeHookInChain(fn) {
    let current = fn;
    const seen = new Set();
    for (let depth = 0; typeof current === 'function' && depth < 16 && !seen.has(current); depth += 1) {
      if (current[HOOK_MARK]) return true;
      seen.add(current);
      current = current._original || current.original || null;
    }
    return false;
  }

  function wrapApplyViewportFilter(original) {
    if (typeof original !== 'function' || hasScopeHookInChain(original)) return original;
    const wrapped = function applyViewportFilterWithExactScopes(ctx) {
      const result = original.apply(this, arguments);
      refreshScopePoints(ctx);
      return result;
    };
    wrapped[HOOK_MARK] = true;
    wrapped._original = original;
    return wrapped;
  }

  function wrapUpdateStats(original) {
    if (typeof original !== 'function' || hasScopeHookInChain(original)) return original;
    const wrapped = function updateStatsWithExactScopes(ctx, hotInfo) {
      const scope = refreshScopePoints(ctx);
      const statEl = ctx && ctx.ui && ctx.ui.statEl;
      if (!statEl) return original.apply(this, arguments);
      const loaded = Array.isArray(ctx.allPts) ? ctx.allPts.length : 0;
      const filtered = scope.active.length;
      const capped = Array.isArray(ctx.filteredCapped) ? ctx.filteredCapped.length : filtered;
      let text = `Stadt: ${ctx.CITY_RAW || '—'} | geladen: ${countLabel(loaded)} | stadtweit nach Filtern: ${countLabel(filtered)}`;
      if (capped < filtered) text += ` (Darstellung begrenzt auf ${countLabel(capped)})`;
      text += ` | sichtbar: ${countLabel(scope.visible.length)}`;
      if (ctx.selectionBounds) text += ` | markierter Bereich: ${countLabel(scope.selected.length)}`;
      const suffix = hotInfo === undefined ? (ctx._lastHotInfo || '') : hotInfo;
      if (suffix) text += ` | ${suffix}`;
      statEl.textContent = text;
      const explanations = [];
      if (capped < filtered) {
        explanations.push(`Renderlimit: ${countLabel(capped)} von ${countLabel(filtered)} stadtweit gefilterten Punkten werden gezeichnet; die Fallzahlen bleiben ungekürzt.`);
      }
      if (scope.buffered.length > scope.visible.length) {
        explanations.push(`Technischer Ladepuffer: ${accidentPhrase(scope.buffered.length)}; diese Pufferpunkte sind nicht in „sichtbar“ oder „markierter Bereich“ enthalten.`);
      }
      statEl.title = explanations.join(' ') || 'Sichtbar und markierter Bereich werden aus derselben ungekürzten Filterpopulation berechnet.';
      return undefined;
    };
    wrapped[HOOK_MARK] = true;
    wrapped._original = original;
    return wrapped;
  }

  function wrapComputeExportReport(original) {
    if (typeof original !== 'function' || hasScopeHookInChain(original)) return original;
    const wrapped = async function computeExportReportWithActiveScope(ctx, ...args) {
      const scoped = createScopedContext(ctx);
      const report = await original.call(this, scoped, ...args);
      if (ctx && scoped && scoped.locationHint) ctx.locationHint = scoped.locationHint;
      return decorateReport(report, ctx, scoped);
    };
    wrapped[HOOK_MARK] = true;
    wrapped._original = original;
    return wrapped;
  }

  function wrapDataExport(original) {
    if (typeof original !== 'function' || hasScopeHookInChain(original)) return original;
    const wrapped = function dataExportWithActiveScope(ctx, ...args) {
      return original.call(this, createScopedContext(ctx), ...args);
    };
    wrapped[HOOK_MARK] = true;
    wrapped._original = original;
    return wrapped;
  }

  const wrappers = Object.freeze({
    applyViewportFilter: wrapApplyViewportFilter,
    updateStats: wrapUpdateStats,
    computeExportReport: wrapComputeExportReport,
    exportToCSV: wrapDataExport,
    exportToGeoJSON: wrapDataExport,
    exportToKML: wrapDataExport,
  });

  function installPersistentHook(name, wrapperFactory) {
    const previousRecord = hookRecords.get(name);
    const descriptor = Object.getOwnPropertyDescriptor(UA, name);
    if (previousRecord && descriptor && descriptor.get === previousRecord.getter) return;

    let value;
    try { value = UA[name]; } catch (_) { value = undefined; }
    if (typeof value === 'function') value = wrapperFactory(value);

    const record = {
      getter() { return value; },
      setter(next) { value = typeof next === 'function' ? wrapperFactory(next) : next; },
    };
    try {
      Object.defineProperty(UA, name, {
        configurable: true, enumerable: true,
        get: record.getter, set: record.setter,
      });
      hookRecords.set(name, record);
    } catch (_) {
      if (typeof value === 'function') {
        try { UA[name] = value; } catch (_) {}
      }
    }
  }

  function install() {
    for (const [name, wrapper] of Object.entries(wrappers)) installPersistentHook(name, wrapper);
    return true;
  }

  function refreshRuntime() {
    install();
    // Re-apply the existing partial-coverage guard through our persistent
    // setters. The chain detector prevents duplicate count-scope wrappers.
    if (typeof UA.installAccidentCoverageExportGuards === 'function') {
      try { UA.installAccidentCoverageExportGuards(); } catch (_) {}
    }
    const ctx = typeof UA.getRuntimeContext === 'function' ? UA.getRuntimeContext() : null;
    if (!ctx || !ctx.ui) return;
    refreshScopePoints(ctx);
    if (typeof UA.updateStats === 'function') {
      try { UA.updateStats(ctx); } catch (_) {}
    }
    const modal = ctx.ui.modalOverlay;
    const isOpen = modal && (modal.style.display === 'flex' || modal.getAttribute('aria-hidden') === 'false');
    const wantsExport = typeof UA.qBool === 'function' && UA.qBool('export', false);
    if (isOpen && wantsExport && !ctx._analysisScopeAutoRerendered && ctx.ui.btnOpenExport) {
      ctx._analysisScopeAutoRerendered = true;
      setTimeout(() => {
        try { ctx.ui.btnOpenExport.click(); } catch (_) {}
      }, 0);
    }
  }

  UA.AnalysisScope = Object.freeze({
    plainBounds, pointInBounds, matchesActiveFilters,
    getActiveFilteredPoints, getContextAreaPoints, pointsInBounds,
    refreshScopePoints, createScopedContext, decorateReport, install,
  });

  install();

  const scheduleRefresh = () => {
    refreshRuntime();
    const optional = UA.optionalModulePromises || {};
    const pending = Object.entries(optional)
      .filter(([name]) => name !== 'analysisScope')
      .map(([, promise]) => Promise.resolve(promise).catch(() => false));
    Promise.all(pending).then(refreshRuntime).catch(() => {});
    if (UA.exportProvenanceReady && typeof UA.exportProvenanceReady.then === 'function') {
      UA.exportProvenanceReady.then(refreshRuntime).catch(() => {});
    }
  };

  if (typeof document !== 'undefined' && document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scheduleRefresh, { once: true });
  } else {
    scheduleRefresh();
  }
  for (const delay of [0, 100, 500, 1500]) setTimeout(refreshRuntime, delay);
})();
