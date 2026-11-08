(() => {
  'use strict';

  const UA = (window.UA = window.UA || {});

  /**
   * ua.political-context.js
   *
   * Frontend-Modul für die serverseitige Recherche politischer Vorgänge.
   *
   * Funktionen:
   *   UA.PoliticalContext.search(params)   – ruft POST /api/political-context/search auf
   *   UA.PoliticalContext.openPanel(ctx)   – öffnet das Recherche-Panel
   *   UA.PoliticalContext.buildSearchTerms(ctx) – leitet Suchbegriffe aus Kartenkontext ab
   *   UA.PoliticalContext.init(ctx)        – bindet Button-Events
   *
   * Das Modul ist fail-safe: Fehler werden gezeigt, aber blockieren nicht
   * den Rest der Anwendung.
   */

  UA.PoliticalContext = UA.PoliticalContext || {};

  let panelController = null;
  let mapRequest = null;
  const generatedSearchInputs = new WeakMap();
  const observedSearchInputs = new WeakSet();

  function isGeneratedSearchInput(input) {
    return input && generatedSearchInputs.has(input) && generatedSearchInputs.get(input) === input.value;
  }

  function refreshGeneratedSearchInput(ctx, fillEmpty = false) {
    const input = document.getElementById('polCtxSearchInput');
    if (!input || (!isGeneratedSearchInput(input) && (!fillEmpty || input.value.trim()))) return;
    // Do not feed the panel's previous generated terms back into the builder.
    input.value = '';
    const city = (ctx.CITY_RAW || '').trim();
    input.value = UA.PoliticalContext.buildSearchTerms(ctx)
      .filter(term => (term || '').trim() !== city).join(', ');
    generatedSearchInputs.set(input, input.value);
    if (!observedSearchInputs.has(input)) {
      input.addEventListener('input', () => generatedSearchInputs.delete(input));
      observedSearchInputs.add(input);
    }
  }

  function getPanelController(panel) {
    if (!panelController) {
      panelController = UA.createModalController(panel, {
        initialFocus: '#polCtxBtnClose',
        returnFocus: () => document.getElementById('btnPolCtxOpen'),
        fallbackFocus: () => document.getElementById('collapseBtn'),
      });
    }
    return panelController;
  }

  function showPanel(panel) {
    if (!panel) return;
    mapRequest = null;
    getPanelController(panel).open();
  }

  function closePanel(panel, options) {
    if (!panel) return;
    getPanelController(panel).close(options);
  }

  // ── API-Zugriff ──────────────────────────────────────────────────────────────

  /**
   * Ruft den politischen Recherche-Endpunkt auf.
   *
   * @param {object}   params
   * @param {string}   params.city
   * @param {string[]} params.searchTerms
   * @param {object}   [params.context]
   * @param {number}   [params.maxResults=10]
   * @returns {Promise<object>}  PoliticalReferenceSearchResult
   */
  UA.PoliticalContext.search = async function search(params) {
    const res = await fetch('/api/political-context/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params)
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    return res.json();
  };

  // ── Suchbegriffe aus Kartenkontext ableiten ───────────────────────────────────

  /**
   * Leitet relevante Suchbegriffe aus dem aktuellen Kartenkontext ab.
   * Nutzt Stadtbezirk, Adresse, Straßennamen und Gremiumsinformationen.
   *
   * @param {object} ctx  – Anwendungskontext (ctx.CITY_RAW, ctx.selectionBounds, …)
   * @returns {string[]}
   */
  UA.PoliticalContext.buildSearchTerms = function buildSearchTerms(ctx) {
    const terms = new Set();

    // Stadtname immer ergänzen (Basiskontext)
    if (ctx.CITY_RAW) terms.add(ctx.CITY_RAW.trim());

    // Straßenname / Stadtbezirk aus ctx.locationHint (vom Reverse-Geocoder
    // via UA.ensureLocationHint() oder UA.computeExportReport() befüllt).
    const hint = ctx.locationHint || {};
    if (hint.street)   terms.add(hint.street);
    if (hint.district) terms.add(hint.district);
    if (hint.suburb && hint.suburb !== hint.district) terms.add(hint.suburb);

    // Gremium aus dem Export-Kontext
    const gremiumName = ctx.ui && ctx.ui._lastExportResult &&
      ctx.ui._lastExportResult.structured &&
      ctx.ui._lastExportResult.structured.meta &&
      ctx.ui._lastExportResult.structured.meta.gremium &&
      ctx.ui._lastExportResult.structured.meta.gremium.name;
    if (gremiumName) terms.add(gremiumName);

    // Manuelle Eingabe aus dem Suchfeld (falls vorhanden)
    const inputEl = document.getElementById('polCtxSearchInput');
    if (inputEl && !isGeneratedSearchInput(inputEl) && inputEl.value.trim()) {
      inputEl.value.trim().split(/[,;]+/).forEach(t => {
        if (t.trim()) terms.add(t.trim());
      });
    }

    // Fallback auf allgemeines Verkehrsthema NUR, wenn weder Straße noch
    // Stadtbezirk/Suburb ableitbar sind. Sonst würde der Topic-only-Pfad
    // die orts-spezifischen Treffer überdecken.
    const hasLocation = !!(hint.street || hint.district || hint.suburb);
    if (!hasLocation && terms.size <= 1) {
      terms.add('Radverkehr');
    }

    return [...terms].filter(Boolean).slice(0, 5);
  };

  // ── Panel-Rendering ───────────────────────────────────────────────────────────

  function safeReferenceUrl(value) {
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
    } catch (_) {
      return '';
    }
  }

  const locationKinds = new Map([
    ['junction', 'Kreuzung'], ['section', 'Abschnitt'], ['street', 'Straßenbezug'],
    ['address', 'Adresse'], ['place', 'Ort'],
  ]);
  const locationStatuses = new Map([
    ['mapped', 'Auf der Karte verortet'], ['partial', 'Teilweise auf der Karte verortet'],
    ['unresolved', 'Kein eindeutiger Ortsbezug für die Karte'], ['unavailable', 'Keine geeigneten Geodaten für die Ortsprüfung'],
  ]);
  const locationReasons = new Map([
    ['gazetteer_unavailable', 'Für diese Stadt fehlen geeignete Geodaten.'],
    ['document_text_unavailable', 'Der Dokumenttext war nicht vollständig verfügbar.'],
    ['evidence_truncated', 'Der geprüfte Dokumenttext ist begrenzt.'],
    ['location_limit', 'Es konnten nicht alle erkannten Orte übernommen werden.'],
    ['unverified_name', 'Ein Ortsname ist nicht eindeutig oder nicht ausreichend belegt.'],
    ['no_specific_location', 'Die geprüften Angaben enthalten keinen eindeutig zuordenbaren Ort.'],
    ['unmapped_location', 'Mindestens eine genannte Lage ist noch ungeklärt.'],
    ['non_traffic_address', 'Eine Adresse ohne Verkehrsbezug wird nur als Ortsangabe angezeigt.'],
  ]);

  function renderLocationAssessment(assessment) {
    const label = locationStatuses.get(assessment?.status);
    if (!label) return null;
    const section = document.createElement('section');
    section.setAttribute('aria-label', 'Ortsprüfung');
    section.style.cssText = 'margin:8px 0;font-size:13px;line-height:1.4';
    const heading = document.createElement('strong');
    heading.textContent = label;
    section.append(heading);
    const sourceLabels = new Map([['title', 'Titel'], ['document', 'Dokumenttext'], ['official', 'amtliche Geometrie']]);
    const sources = (Array.isArray(assessment.sources) ? assessment.sources : []).map(source => sourceLabels.get(source)).filter(Boolean);
    if (sources.length) {
      const basis = document.createElement('div');
      basis.textContent = `Geprüfte Grundlage: ${sources.join(', ')}`;
      section.append(basis);
    }
    const reasons = (Array.isArray(assessment.reasons) ? assessment.reasons : []).map(reason => locationReasons.get(reason)).filter(Boolean);
    if (reasons.length) {
      const detail = document.createElement('div');
      detail.textContent = reasons.join(' ');
      section.append(detail);
    }
    return section;
  }

  function renderLocation(location) {
    if (typeof location?.label !== 'string' || !location.label.trim()) return null;
    const details = document.createElement('div');
    const label = document.createElement('strong');
    label.textContent = location.label;
    details.append(`${locationKinds.get(location.kind) || 'Ort'} · `, label);
    if (location.mapped === false) details.append(' · Nicht auf der Karte verortet');
    const evidence = location.evidence;
    const source = evidence?.source === 'title' ? 'Titel' : evidence?.source === 'document' ? 'Dokument' : '';
    if (source && typeof evidence.text === 'string' && evidence.text.trim()) {
      const quote = document.createElement('div');
      quote.style.color = '#555';
      quote.textContent = `Beleg im ${source}: „${evidence.text}“`;
      details.append(quote);
    }
    return details;
  }
  UA.PoliticalContext.renderLocation = renderLocation;

  function mapButton(ctx, ref, location, index) {
    if (location.mapped !== true || !ref.snapshot?.sha256 || !ref.snapshot.mapSha256 || !ref.id || !ctx.map
        || typeof UA.RisLayer?.showLocation !== 'function') return null;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'smallBtn';
    button.textContent = 'Auf Karte zeigen';
    button.setAttribute('aria-label', `Auf Karte zeigen: ${location.label}`);
    button.addEventListener('click', async () => {
      const panel = document.getElementById('polCtxPanel');
      if (!panel || !getPanelController(panel).isOpen()) return;
      const request = mapRequest = Symbol('political-map-location');
      const active = () => mapRequest === request && button.isConnected && getPanelController(panel).isOpen();
      button.disabled = true;
      try {
        const target = await UA.RisLayer.showLocation(ctx, ref, index, active);
        if (!target || !active()) return;
        closePanel(panel, { restoreFocus: false });
        target.focus({ preventScroll: true });
      } catch (error) {
        const status = document.getElementById('polCtxStatus');
        if (active() && status) status.textContent = error?.message || 'Die Lage konnte nicht angezeigt werden.';
      } finally {
        button.disabled = false;
      }
    });
    return button;
  }

  function renderLocations(ref, ctx) {
    if (!Array.isArray(ref.locations) && !ref.geometryIds?.length) return null;
    const list = document.createElement('ul');
    list.style.cssText = 'margin:4px 0 0;padding-inline-start:1.3em';
    const section = document.createElement('section');
    section.setAttribute('aria-label', 'Genannte Orte');
    section.style.cssText = 'margin:8px 0;font-size:13px;line-height:1.4;overflow-wrap:anywhere';
    const heading = document.createElement('strong');
    heading.textContent = 'Genannte Orte';
    section.append(heading, list);
    const viewRef = { ...ref, locations: [...(ref.locations || [])] };
    const shown = new Set();
    function appendLocation(location, index) {
      const identity = location.id || index;
      if (shown.has(identity)) return;
      shown.add(identity);
      const details = renderLocation(location);
      if (!details) return;
      const row = document.createElement('li');
      row.style.marginBottom = '4px';
      row.append(details);
      const button = mapButton(ctx, viewRef, location, identity);
      if (button) row.append(button);
      list.append(row);
    }
    viewRef.locations.forEach(appendLocation);
    const city = ctx.CITY_RAW;
    const revision = ctx.politicalContextCityRevision;
    const active = () => section.isConnected && ctx.CITY_RAW === city && ctx.politicalContextCityRevision === revision
      && getPanelController(document.getElementById('polCtxPanel')).isOpen();
    const status = document.createElement('div');
    status.setAttribute('role', 'status');
    section.append(status);
    function pageButton(label, firstPage, loader, append) {
      if (firstPage == null || typeof loader !== 'function') return;
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'smallBtn'; button.textContent = label;
      section.append(button);
      let page = firstPage;
      button.addEventListener('click', async () => {
        if (button.disabled || !active()) return;
        button.disabled = true;
        status.textContent = 'Weitere Kartenbezüge werden geladen …';
        try {
          const result = await loader(city, ref.id, page, { snapshot: ref.snapshot });
          if (!active()) return;
          append(result);
          status.textContent = result.complete === false ? 'Kartenbezüge unvollständig; Daten fehlen.' : '';
          if (result.complete === false) button.textContent = 'Erneut versuchen';
          else if (result.nextPage != null) { page = result.nextPage; button.textContent = label; }
          else button.hidden = true;
        } catch (error) {
          if (active()) status.textContent = error?.message || 'Kartenbezüge konnten nicht geladen werden. Bitte erneut versuchen.';
        } finally { button.disabled = false; }
      });
    }
    pageButton('Weitere Orte laden', ref.locationsNextPage, UA.RisCatalogue?.loadRecordLocations, result => {
      for (const location of result.locations) {
        if (!viewRef.locations.some(item => item.id === location.id)) viewRef.locations.push(location);
        appendLocation(location, viewRef.locations.indexOf(location));
      }
    });
    const geometrySeen = new Set();
    function appendGeometry(geometryId) {
      if (geometrySeen.has(geometryId) || viewRef.locations.some(location => location.geometryId === geometryId)) return;
      geometrySeen.add(geometryId);
      const location = { mapped: true, label: `${ref.locations?.length ? 'Kartenlage' : 'Amtliche Kartenlage'} ${geometrySeen.size}` };
      const button = mapButton(ctx, viewRef, location, { geometryId });
      if (button) { const row = document.createElement('li'); row.append(button); list.append(row); }
    }
    (ref.geometryIds || []).forEach(appendGeometry);
    pageButton('Weitere Kartenlagen laden', ref.geometryNextPage, UA.RisCatalogue?.loadRecordGeometries,
      result => result.geometryIds.forEach(appendGeometry));
    return list.childElementCount || ref.locationsNextPage != null || ref.geometryNextPage != null ? section : null;
  }

  function renderRef(ref, related, ctx, includeRelated = true) {
    const typeColors = {
      'Antrag':            '#2563eb',
      'Änderungsantrag':   '#7c3aed',
      'Anfrage':           '#0891b2',
      'Beschluss':         '#059669',
      'Verwaltungsantwort':'#d97706',
      'Protokoll':         '#6b7280',
      'Sonstige':          '#9ca3af'
    };
    const color = typeColors[ref.type] || '#6b7280';
    const score = Number.isFinite(ref.relevanceScore) ? `Score: ${ref.relevanceScore}` : '';
    const dateStr = ref.date ? ` · ${UA.escHtml(ref.date)}` : '';
    const gremiumStr = ref.gremium ? ` · ${UA.escHtml(ref.gremium)}` : '';
    const numberStr = ref.number ? ` · ${UA.escHtml(ref.number)}` : '';
    const snippet = ref.snippet
      ? `<div style="margin-top:4px;font-size:11px;color:#555;line-height:1.4;">${UA.escHtml(ref.snippet.substring(0, 200))}</div>`
      : '';

    const url = safeReferenceUrl(ref.url);
    const card = document.createElement('div');
    card.className = 'polCtxRef';
    card.dataset.url = url;
    card.dataset.referenceId = ref.id || url;
    card.dataset.title = ref.title ?? '';
    card.style.cssText = `
      border:1px solid rgba(0,0,0,.1);border-radius:8px;padding:10px 12px;
      margin-bottom:8px;background:rgba(255,255,255,.9);transition:background .15s;`;
    card.innerHTML = `
      <div style="display:flex;align-items:flex-start;gap:8px;">
        <label style="display:flex;align-items:flex-start;gap:8px;cursor:pointer;flex:1;">
          <input type="checkbox" class="polCtxCheck" style="margin-top:2px;cursor:pointer;"
            data-url="${UA.escHtml(url)}"
            data-id="${UA.escHtml(ref.id || '')}"
            data-related-to="${UA.escHtml(ref.relatedTo || '')}"
            data-snapshot="${UA.escHtml(JSON.stringify(ref.snapshot || null))}"
            data-title="${UA.escHtml(ref.title)}"
            data-type="${UA.escHtml(ref.type)}"
            data-date="${UA.escHtml(ref.date || '')}"
            data-gremium="${UA.escHtml(ref.gremium || '')}"
            data-number="${UA.escHtml(ref.number || '')}"
            data-reference-type="${UA.escHtml(ref.referenceType || '')}"
            data-reason="${UA.escHtml(ref.reason || '')}"
            data-snippet="${UA.escHtml(ref.snippet || '')}"
            data-source="${UA.escHtml(ref.source || '')}"
          />
          <div style="flex:1;">
            <div style="font-weight:700;font-size:13px;line-height:1.3;">
              ${UA.escHtml(ref.title)}
            </div>
            <div style="margin-top:3px;font-size:11px;color:#555;">
              <span style="background:${color};color:#fff;border-radius:4px;padding:1px 6px;font-size:10px;font-weight:700;">${UA.escHtml(ref.type)}</span>
              <span style="color:#888;">${dateStr}${gremiumStr}${numberStr}</span>
              <span style="float:right;color:#aaa;font-size:10px;">${score}</span>
            </div>
            ${related ? `<small>${ref.relatedTo === related.id ? 'Gehört zu Drucksache' : 'Verknüpfter Vorgang:'} ${UA.escHtml(related.number || related.title)}</small>` : ''}
            ${snippet}
          </div>
        </label>
      </div>
      ${url ? `<a href="${UA.escHtml(url)}" target="_blank" rel="noopener noreferrer">Amtliches Original öffnen</a>` : ''}`;
    const assessment = renderLocationAssessment(ref.locationAssessment);
    if (assessment) card.insertBefore(assessment, card.querySelector('a'));
    const locations = renderLocations(ref, ctx);
    if (locations) card.insertBefore(locations, card.querySelector('a'));
    if (ref.id && ref.snapshot && typeof UA.RisDetails?.open === 'function') {
      const open = document.createElement('button');
      open.type = 'button'; open.className = 'smallBtn';
      open.textContent = 'Verlauf und Zusammenhänge';
      open.setAttribute('aria-label', `Verlauf und Zusammenhänge: ${ref.title}`);
      open.addEventListener('click', () => {
        const panel = document.getElementById('polCtxPanel');
        if (panel) closePanel(panel, { restoreFocus: false });
        UA.RisDetails.open(ctx, ref.id, { trigger: document.getElementById('btnPolCtxOpen') });
      });
      card.append(open);
    }
    if (includeRelated && ref.id && ref.snapshot && typeof UA.RisCatalogue?.loadRelatedRecords === 'function') {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'smallBtn'; button.textContent = 'Verknüpfte Vorgänge anzeigen';
      const relatives = document.createElement('section');
      relatives.setAttribute('aria-label', 'Verknüpfte Vorgänge');
      const status = document.createElement('div'); status.setAttribute('role', 'status');
      card.append(button, status, relatives);
      let page = 0;
      const seen = new Set([ref.id]);
      const city = ctx.CITY_RAW, revision = ctx.politicalContextCityRevision;
      const active = () => button.isConnected && city === ctx.CITY_RAW && revision === ctx.politicalContextCityRevision
        && getPanelController(document.getElementById('polCtxPanel')).isOpen();
      button.addEventListener('click', async () => {
        if (button.disabled || !active()) return;
        button.disabled = true;
        status.textContent = 'Verknüpfte Vorgänge werden geladen …';
        try {
          const result = await UA.RisCatalogue.loadRelatedRecords(city, ref.id, page, { snapshot: ref.snapshot });
          if (!active()) return;
          for (const entry of result.records) {
            if (seen.has(entry.id)) continue;
            seen.add(entry.id);
            relatives.append(renderRef(entry, ref, ctx, false));
          }
          status.textContent = result.complete === false ? 'Verknüpfte Vorgänge unvollständig; Daten fehlen.'
            : seen.size === 1 ? 'Keine verknüpften Vorgänge.' : `${seen.size - 1} verknüpfte Vorgänge geladen.`;
          if (result.complete === false) button.textContent = 'Erneut versuchen';
          else if (result.nextPage != null) { page = result.nextPage; button.textContent = 'Weitere verknüpfte Vorgänge laden'; }
          else button.hidden = true;
        } catch (error) {
          if (active()) status.textContent = error?.message || 'Verknüpfte Vorgänge konnten nicht geladen werden. Bitte erneut versuchen.';
        } finally { button.disabled = false; }
      });
    }
    return card;
  }

  /**
   * Rendert die Trefferliste ins Panel.
   *
   * @param {HTMLElement} container
   * @param {object}      result   – PoliticalReferenceSearchResult
   * @param {object}      ctx      – Anwendungskontext
   */
  function renderResults(container, result, ctx) {
    if (!result.meta.supported) {
      container.innerHTML = `<div style="color:#888;font-size:13px;padding:12px 0;">
        Für die Stadt <strong>${UA.escHtml(result.meta.city)}</strong> ist noch kein Portal-Provider verfügbar.
      </div>`;
      return;
    }
    const { coverage, generatedAt, warnings = [], searchStatus } = result.meta;
    const note = generatedAt ? `<p>Datenstand ${UA.escHtml(generatedAt.slice(0, 10))}${
      coverage?.from && coverage?.to ? ` · Zeitraum ${UA.escHtml(coverage.from)} bis ${UA.escHtml(coverage.to)}` : ''
    }${coverage?.bodies?.length ? ` · ${UA.escHtml(coverage.bodies.join(', '))}` : ''}</p>` : '';
    const limits = warnings.length ? `<p>${UA.escHtml(warnings.join(' '))}</p>` : '';
    if (!result.references || result.references.length === 0) {
      const message = searchStatus === 'searched-no-results'
        ? 'Keine passenden Vorgänge im durchsuchten Bestand.'
        : 'Der verfügbare Datenstand erlaubt keinen vollständigen Befund.';
      const portal = safeReferenceUrl(result.meta.sourceUrl);
      container.innerHTML = `${note}<p>${message}</p>${limits}${portal
        ? `<a href="${UA.escHtml(portal)}" target="_blank" rel="noopener noreferrer">Amtliche Quelle öffnen</a>`
        : ''}`;
      return;
    }
    const byId = new Map(result.references.map(ref => [ref.id, ref]));
    container.innerHTML = `${note}${limits}`;
    for (const ref of result.references) container.append(renderRef(ref, byId.get(ref.relatedTo), ctx));
  }

  // ── Panel öffnen ─────────────────────────────────────────────────────────────

  /**
   * Führt die Suche mit dem aktuellen ctx + UI-Input aus und rendert das
   * Ergebnis ins Panel. Wiederverwendet vom „Suchen"-Button und von der
   * Auto-Suche beim Panel-Open.
   *
   * @param {object} ctx
   * @returns {Promise<void>}
   */
  function hasSearchContinuation(value) {
    return (Number.isSafeInteger(value) && value >= 0)
      || (typeof value === 'string' && value.length <= 2048 && /^ris2\.[A-Za-z0-9_-]+\.[a-f0-9]{64}$/.test(value));
  }

  async function runSearch(ctx) {
    const statusEl  = document.getElementById('polCtxStatus');
    const resultsEl = document.getElementById('polCtxResults');
    const basisEl   = document.getElementById('polCtxBasis');
    const btnSearch = document.getElementById('polCtxBtnSearch');
    if (!statusEl || !resultsEl) return;

    refreshGeneratedSearchInput(ctx);
    const input = document.getElementById('polCtxSearchInput');
    const enteredTerms = (input?.value || '').split(/[,;]+/).map(term => term.trim()).filter(Boolean);
    const terms = enteredTerms.length ? enteredTerms.slice(0, 5) : UA.PoliticalContext.buildSearchTerms(ctx);
    const city = ctx.CITY_RAW || '';
    const request = Symbol('political-search');
    ctx.politicalSearchRequest = request;

    // „Suche basiert auf …": macht für Nutzer transparent, welche Begriffe
    // die Auto-Suche einsetzt (Stadt + Straße + Stadtbezirk + ggf. Gremium).
    if (basisEl) {
      basisEl.replaceChildren('Suche basiert auf: ');
      if (terms.length) {
        terms.forEach((term, index) => {
          if (index) basisEl.append(', ');
          const label = document.createElement('strong');
          label.textContent = term;
          basisEl.append(label);
        });
      } else {
        const label = document.createElement('em');
        label.textContent = '(keine Suchbegriffe)';
        basisEl.append(label);
      }
    }

    statusEl.textContent = 'Suche läuft…';
    resultsEl.innerHTML  = '';
    if (btnSearch) btnSearch.disabled = true;

    const params = {
        city,
        searchTerms: terms,
        context: {
          gremium: (ctx.ui && ctx.ui._lastExportResult &&
            ctx.ui._lastExportResult.structured &&
            ctx.ui._lastExportResult.structured.meta &&
            ctx.ui._lastExportResult.structured.meta.gremium &&
            ctx.ui._lastExportResult.structured.meta.gremium.name) || ''
        },
        maxResults: 15
    };
    try {
      const result = await UA.PoliticalContext.search(params);
      if (ctx.politicalSearchRequest !== request || (ctx.CITY_RAW || '') !== city) return;
      statusEl.textContent = result.references.length > 0
        ? `${result.references.length} Vorgänge gefunden.`
        : result.meta.searchStatus === 'searched-no-results'
          ? 'Keine Vorgänge im durchsuchten Bestand.'
          : 'Recherche unvollständig.';
      renderResults(resultsEl, result, ctx);
      if (hasSearchContinuation(result.meta.nextPage)) {
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'smallBtn'; button.textContent = 'Weitere Suchtreffer laden';
        resultsEl.append(button);
        let page = result.meta.nextPage;
        const snapshot = result.meta.snapshot || result.references.find(ref => ref.snapshot)?.snapshot
          || (result.meta.generation ? { city, generation: result.meta.generation } : null);
        const generation = value => value?.generation || value?.sha256;
        const active = () => button.isConnected && ctx.politicalSearchRequest === request && (ctx.CITY_RAW || '') === city
          && getPanelController(document.getElementById('polCtxPanel')).isOpen();
        button.addEventListener('click', async () => {
          if (button.disabled || !active()) return;
          button.disabled = true;
          statusEl.textContent = 'Weitere Suchtreffer werden geladen …';
          try {
            const next = await UA.PoliticalContext.search({ ...params, page, ...(snapshot ? { snapshot } : {}) });
            if (!active()) return;
            const expected = generation(snapshot);
            const incoming = generation(next.meta.snapshot) || next.meta.generation;
            if (expected && ((incoming && incoming !== expected)
                || next.references.some(ref => ref.snapshot && generation(ref.snapshot) !== expected))) {
              throw new Error('Die Suchseiten stammen aus unterschiedlichen Datenständen. Bitte die Recherche erneut starten.');
            }
            const seen = new Set([...resultsEl.querySelectorAll('.polCtxRef')].map(card => card.dataset.referenceId));
            const byId = new Map(next.references.map(ref => [ref.id, ref]));
            for (const ref of next.references) {
              const id = ref.id || ref.url;
              if (seen.has(id)) continue;
              seen.add(id);
              resultsEl.insertBefore(renderRef(ref, byId.get(ref.relatedTo), ctx), button);
            }
            statusEl.textContent = `${seen.size} Vorgänge geladen.` + (next.meta.complete === false || next.meta.truncated ? ' Recherche unvollständig.' : '');
            if (hasSearchContinuation(next.meta.nextPage)) page = next.meta.nextPage;
            else button.hidden = true;
          } catch (error) {
            if (active()) statusEl.textContent = error?.message || 'Weitere Suchtreffer konnten nicht geladen werden. Bitte erneut versuchen.';
          } finally { button.disabled = false; }
        });
      }
    } catch (err) {
      if (ctx.politicalSearchRequest === request && (ctx.CITY_RAW || '') === city) {
        statusEl.textContent = 'Fehler bei der Recherche. ' + String(err.message || err);
      }
    } finally {
      if (btnSearch && ctx.politicalSearchRequest === request) btnSearch.disabled = false;
    }
  }
  UA.PoliticalContext._runSearch = runSearch;

  /**
   * Öffnet das politische Recherche-Panel und startet ggf. direkt die Suche.
   *
   * @param {object} ctx
   */
  UA.PoliticalContext.openPanel = async function openPanel(ctx) {
    const panel = document.getElementById('polCtxPanel');
    if (!panel) return;

    showPanel(panel);
    const inputEl = document.getElementById('polCtxSearchInput');
    const previousInput = inputEl?.value;
    const previousSearch = ctx.politicalSearchRequest;
    const cityRevision = ctx.politicalContextCityRevision;

    // Issue 3: Vor dem Vorbelegen / Auto-Suche sicherstellen, dass
    // ctx.locationHint mit Straße/Stadtbezirk gefüllt ist (on-demand
    // Reverse-Geocoding über den vorhandenen _rgCache).
    try {
      if (typeof UA.ensureLocationHint === 'function') {
        await UA.ensureLocationHint(ctx);
      }
    } catch (_) { /* defensive: ohne Hint geht's mit Stadt + Fallback */ }

    // The location lookup may finish after the user starts typing or searching.
    if (panel.getAttribute('aria-hidden') === 'true' || ctx.politicalContextCityRevision !== cityRevision
        || ctx.politicalSearchRequest !== previousSearch
        || (inputEl && (document.activeElement === inputEl || inputEl.value !== previousInput))) return;

    // Refresh our own defaults for the current confirmation, preserving edits.
    refreshGeneratedSearchInput(ctx, true);

    // Issue 3: Auto-Suche, sobald ein Ortsbezug ableitbar war oder ein
    // Gremium aus einem vorigen Export bekannt ist. Sonst (nur Stadt +
    // generischer Fallback) bleibt es beim Klick-Trigger, damit die KI-
    // Quote des Servers nicht für reine Stadt-Topic-Suchen verbraucht wird.
    const hint = (ctx && ctx.locationHint) || {};
    const hasLocation = !!UA.AreaNameControl?.researchContext?.(ctx)
      || !!(hint.street || hint.district || hint.suburb);
    const hasGremium = !!(ctx.ui && ctx.ui._lastExportResult &&
      ctx.ui._lastExportResult.structured &&
      ctx.ui._lastExportResult.structured.meta &&
      ctx.ui._lastExportResult.structured.meta.gremium &&
      ctx.ui._lastExportResult.structured.meta.gremium.name);
    if (hasLocation || hasGremium) {
      try { await runSearch(ctx); } catch (_) { /* status zeigt Fehler */ }
    }
  };

  // ── Ausgewählte Vorgänge in Export übernehmen ────────────────────────────────

  /**
   * Liest alle angehakten Vorgänge aus dem Panel und gibt sie zurück.
   *
   * @returns {object[]}  Array von { title, type, date, gremium, number, url }
   */
  UA.PoliticalContext.getSelectedReferences = function getSelectedReferences() {
    const checks = document.querySelectorAll('.polCtxCheck:checked');
    return [...checks].map(cb => ({
      id:            cb.dataset.id            || undefined,
      relatedTo:     cb.dataset.relatedTo     || undefined,
      snapshot:      JSON.parse(cb.dataset.snapshot || 'null') || undefined,
      title:         cb.dataset.title         || '',
      type:          cb.dataset.type          || 'Sonstige',
      date:          cb.dataset.date          || null,
      gremium:       cb.dataset.gremium       || null,
      number:        cb.dataset.number        || null,
      url:           cb.dataset.url           || '',
      // Issue 2 (e): zusätzliche Felder aus dem Suchergebnis übernehmen,
      // damit alle Renderer (TEXT/HTML/DOCX/PDF) Klassifikation,
      // Begründung, Auszug und Portal-Quelle anzeigen können.
      referenceType: cb.dataset.referenceType || null,
      reason:        cb.dataset.reason        || null,
      snippet:       cb.dataset.snippet       || null,
      source:        cb.dataset.source        || null
    }));
  };

  UA.PoliticalContext.addReferences = async function addReferences(ctx, selected) {
    const city = ctx.CITY_RAW || '';
    const revision = ctx.politicalContextCityRevision;
    let verified = selected;
    if (selected.some(ref => ref.snapshot)) {
      if (typeof UA.RisCatalogue?.resolveReferences !== 'function') {
        throw new Error('Der Ratsdatenstand für die Auswahl konnte nicht geprüft werden.');
      }
      verified = await UA.RisCatalogue.resolveReferences(city, selected);
      if (revision !== ctx.politicalContextCityRevision || city !== (ctx.CITY_RAW || '')) {
        throw new Error('Die Stadt hat sich während der Prüfung geändert.');
      }
    }
    const sameCity = !ctx.politicalReferencesCity || ctx.politicalReferencesCity === city;
    const refs = new Map();
    for (const ref of [...(sameCity ? (ctx.politicalReferences || []) : []), ...verified]) {
      if (ref.snapshot?.city && UA.RisCatalogue?.cityKey?.(city) !== ref.snapshot.city) continue;
      const url = safeReferenceUrl(ref.url);
      if (url && ref.title) refs.set(url, { ...ref, url });
    }
    ctx.politicalReferencesCity = city;
    ctx.politicalReferences = [...refs.values()];
    return ctx.politicalReferences.length;
  };

  UA.PoliticalContext.resetCity = function resetCity(ctx) {
    ctx.politicalReferences = [];
    ctx.politicalReferencesCity = ctx.CITY_RAW || '';
    ctx.politicalContextCityRevision = Symbol('political-city');
    UA.RisDetails?.refresh(ctx);
    ctx.politicalSearchRequest = null;
    ctx.politicalContextResearch = null;
    UA.lastPoliticalContextResearch = null;
    ctx.__uaPoliticalResearchKey = null;
    ctx.__uaPoliticalResearchRequest = null;
    ctx.__uaPoliticalResearchPromise = null;
    const input = document.getElementById('polCtxSearchInput');
    if (input) { input.value = ''; generatedSearchInputs.delete(input); }
    const button = document.getElementById('polCtxBtnSearch');
    if (button) {
      button.disabled = false;
      button.removeAttribute('aria-disabled');
    }
    for (const id of ['polCtxStatus', 'polCtxResults', 'polCtxBasis']) {
      document.getElementById(id)?.replaceChildren();
    }
  };

  // ── Initialisierung ───────────────────────────────────────────────────────────

  /**
   * Bindet alle Button-Events für das politische Recherche-Panel.
   * Wird aus ua.app_v2.js nach bindExport() aufgerufen.
   *
   * @param {object} ctx
   */
  UA.PoliticalContext.init = function init(ctx) {
    const btnOpen    = document.getElementById('btnPolCtxOpen');
    const btnClose   = document.getElementById('polCtxBtnClose');
    const btnSearch  = document.getElementById('polCtxBtnSearch');
    const btnAdopt   = document.getElementById('polCtxBtnAdopt');
    const statusEl   = document.getElementById('polCtxStatus');
    const resultsEl  = document.getElementById('polCtxResults');
    const panel      = document.getElementById('polCtxPanel');

    if (!btnOpen || !panel) return;

    // Panel öffnen
    btnOpen.addEventListener('click', () => {
      // openPanel ist async; wir fangen Errors defensiv ab, damit das
      // Click-Handler-Promise keinen unhandled-rejection-Logspam verursacht.
      Promise.resolve(UA.PoliticalContext.openPanel(ctx)).catch(() => {});
    });

    // Panel schließen
    if (btnClose) {
      btnClose.addEventListener('click', () => closePanel(panel));
    }

    // Suche starten
    if (btnSearch) {
      btnSearch.addEventListener('click', () => {
        Promise.resolve(runSearch(ctx)).catch(() => {});
      });
    }

    // Ausgewählte Vorgänge in den Export-Kontext übernehmen
    if (btnAdopt) {
      btnAdopt.addEventListener('click', async () => {
        const revision = ctx.politicalContextCityRevision;
        try {
          const selected = UA.PoliticalContext.getSelectedReferences();
          if (!selected.length) {
            alert('Bitte mindestens einen Vorgang auswählen.');
            return;
          }
          await UA.PoliticalContext.addReferences(ctx, selected);
          if (revision !== ctx.politicalContextCityRevision) return;
          closePanel(panel);
          if (document.getElementById('btnOpenExport')) {
            alert(`${selected.length} Vorgang/Vorgänge übernommen. Bitte jetzt „Analyse/Export öffnen“ klicken.`);
          }
        } catch (error) {
          if (statusEl && revision === ctx.politicalContextCityRevision) {
            statusEl.textContent = `Übernahme fehlgeschlagen. ${error.message}`;
          }
        }
      });
    }
  };

})();
