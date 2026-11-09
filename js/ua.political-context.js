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
  let workspaceContext = null;
  const normalizeView = value => UA.RisViewState?.normalize(value) || { listOpen: false, listCollapsed: false,
    query: '', sourceLevels: [], searchCursor: null, searchGeneration: null, ...value };
  const levelNames = () => UA.RisSources?.levels || [
    { id: 'city', label: 'Stadt' }, { id: 'region', label: 'Region' }, { id: 'state', label: 'Land' },
    { id: 'federal', label: 'Deutschland' }, { id: 'eu', label: 'EU' },
  ];
  const pageKey = ctx => JSON.stringify([ctx.CITY_RAW, ctx.risView?.query, ctx.risView?.sourceLevels,
    ctx.risView?.searchCursor, ctx.risView?.searchGeneration]);

  function updateView(ctx, patch) {
    ctx.risView = normalizeView({ ...ctx.risView, ...patch });
    if (!UA._hydrating) UA.syncAllToUrl?.(ctx);
    projectWorkspace(ctx);
  }

  function projectWorkspace(ctx) {
    const view = normalizeView(ctx.risView);
    const panel = document.getElementById('polCtxPanel');
    if (!panel) return;
    const detailOpen = !!view.recordId && !view.collapsed;
    document.body.classList.toggle('ris-list-open', view.listOpen);
    document.body.classList.toggle('ris-list-collapsed', view.listCollapsed);
    document.body.classList.toggle('ris-document-open', detailOpen);
    panel.classList.toggle('ris-browser--collapsed', view.listCollapsed);
    const mobileDetail = detailOpen && window.matchMedia?.('(max-width: 980px)').matches;
    panel.inert = !!mobileDetail;
    for (const control of [document.getElementById('btnPolCtxOpen'), document.getElementById('btnRisBrowse')]) {
      control?.setAttribute('aria-expanded', String(view.listOpen && !view.listCollapsed));
    }
    const collapse = document.getElementById('polCtxBtnCollapse');
    if (collapse) {
      collapse.textContent = view.listCollapsed ? 'Ausklappen' : 'Einklappen';
      collapse.setAttribute('aria-expanded', String(!view.listCollapsed));
      collapse.setAttribute('aria-label', `Trefferliste ${view.listCollapsed ? 'ausklappen' : 'einklappen'}`);
    }
    const body = panel.querySelector('.ris-browser__body');
    if (body) body.hidden = view.listCollapsed;
    const city = document.getElementById('polCtxCity');
    if (city) city.textContent = ctx.CITY_RAW || 'Aktuelle Stadt';
    UA.PoliticalContext.selectRecord?.(ctx, view.recordId);
  }

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
      let returnFocus;
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-modal', 'false');
      panelController = {
        isOpen: () => panel.style.display === 'flex',
        open({ focus = true } = {}) {
          if (panel.style.display !== 'flex') returnFocus = document.activeElement;
          panel.style.display = 'flex'; panel.removeAttribute('aria-hidden');
          if (focus) document.getElementById('polCtxBtnClose')?.focus({ preventScroll: true });
        },
        close({ restoreFocus = true } = {}) {
          const wasOpen = panel.style.display === 'flex';
          panel.style.display = 'none'; panel.setAttribute('aria-hidden', 'true'); panel.inert = false;
          mapRequest = null;
          if (workspaceContext) {
            workspaceContext.politicalSearchRequest = null;
            workspaceContext.politicalPendingPageKey = null;
            updateView(workspaceContext, { listOpen: false, listCollapsed: false });
          }
          document.getElementById('polCtxResults')?.setAttribute('aria-busy', 'false');
          const searchButton = document.getElementById('polCtxBtnSearch');
          if (searchButton) searchButton.disabled = false;
          if (wasOpen && restoreFocus) {
            const target = returnFocus?.isConnected && !returnFocus.closest('[hidden], [inert], [aria-hidden="true"]')
              ? returnFocus : document.getElementById('btnPolCtxOpen') || document.getElementById('btnRisBrowse');
            target?.focus({ preventScroll: true });
          }
        },
      };
      document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && !event.defaultPrevented && panelController.isOpen()
            && panel.contains(document.activeElement)) {
          event.preventDefault(); panelController.close();
        }
      });
    }
    return panelController;
  }

  function showPanel(panel, options) {
    if (!panel) return;
    mapRequest = null;
    getPanelController(panel).open(options);
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

  function renderRef(ref, related, ctx) {
    const node = (tag, text, className) => {
      const el = document.createElement(tag);
      if (text != null) el.textContent = text;
      if (className) el.className = className;
      return el;
    };
    const url = safeReferenceUrl(ref.url);
    const card = node('article', null, 'polCtxRef ris-result');
    card.dataset.url = url; card.dataset.referenceId = ref.id || url; card.dataset.title = ref.title || '';
    card.setAttribute('aria-current', String(ctx.risView?.recordId === ref.id));
    const heading = node('div', null, 'ris-result__heading');
    const level = UA.RisSources?.levelOf(ref) || ref.sourceContext?.level;
    const label = levelNames().find(item => item.id === level)?.label;
    const badge = node('span', label || 'Ebene nicht angegeben', 'ris-record-view__level');
    badge.dataset.level = label ? level : 'unknown';
    heading.append(badge, node('span', ref.type || 'Ratsvorgang', 'ris-result__kind'));
    card.append(heading);
    const canOpen = ref.id && ref.snapshot && typeof UA.RisDetails?.open === 'function';
    const title = node(canOpen ? 'button' : url ? 'a' : 'h3', ref.title || 'Vorgang ohne Titel', 'ris-result__title');
    if (canOpen) {
      title.type = 'button'; title.dataset.risOpenRecord = ref.id;
      title.setAttribute('aria-label', `Verlauf und Zusammenhänge: ${ref.title}`);
      title.addEventListener('click', () => {
        UA.PoliticalContext.selectRecord(ctx, ref.id);
        UA.RisDetails.open(ctx, ref.id, { trigger: title });
      });
    } else if (url) {
      title.href = url; title.target = '_blank'; title.rel = 'noopener noreferrer';
    }
    card.append(title);
    const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ref.date || '');
    const dateText = date ? `${date[3]}.${date[2]}.${date[1]}` : ref.date;
    card.append(node('p', [ref.number, dateText, ref.gremium].filter(Boolean).join(' · '), 'ris-result__meta'));
    card.append(node('p', UA.RisSources?.sourceLabel(ref) || ref.sourceContext?.publisher || ref.source || 'Quelle nicht angegeben', 'ris-result__source'));
    if (related) card.append(node('p', `Verknüpft mit ${related.number || related.title}`, 'ris-result__meta'));
    if (ref.snippet) card.append(node('p', ref.snippet.slice(0, 180), 'ris-result__snippet'));
    if (canOpen) {
      const places = ref.locationCount ?? ref.locations?.length;
      const description = places > 0 ? `${places} ${places === 1 ? 'Ortsbezug' : 'Ortsbezüge'}`
        : ref.locationAssessment?.status === 'unresolved' ? 'Ortsbezug ungeklärt'
          : places === 0 ? 'Ohne Kartenlage' : null;
      if (description) card.append(node('p', description, 'ris-result__location'));
    } else {
      // Live references without a published record remain readable. Published
      // records have one shared detail renderer, including its bounded loaders.
      const assessment = renderLocationAssessment(ref.locationAssessment);
      const locations = renderLocations(ref, ctx);
      if (assessment || locations) {
        const disclosure = node('details', null, 'ris-result__legacy-details');
        disclosure.append(node('summary', 'Ortsbezug und Belege'));
        if (assessment) disclosure.append(assessment);
        if (locations) disclosure.append(locations);
        card.append(disclosure);
      }
    }
    const actions = node('div', null, 'ris-result__actions');
    const selection = node('label', null, 'ris-result__selection');
    const check = node('input', null, 'polCtxCheck'); check.type = 'checkbox';
    check.checked = !!ctx.politicalSelectedRecords?.has(ref.id || url);
    for (const field of ['id', 'relatedTo', 'title', 'type', 'date', 'gremium', 'number', 'referenceType', 'reason', 'snippet', 'source']) {
      check.dataset[field] = ref[field] || '';
    }
    check.dataset.url = url;
    check.dataset.snapshot = JSON.stringify(ref.snapshot || null);
    check.setAttribute('aria-label', `Für Bericht auswählen: ${ref.title}`);
    selection.append(check, node('span', 'Für Bericht'));
    check.addEventListener('change', () => {
      ctx.politicalSelectedRecords ||= new Map();
      if (check.checked) ctx.politicalSelectedRecords.set(ref.id || url, ref);
      else ctx.politicalSelectedRecords.delete(ref.id || url);
      updateSelectionCount();
    });
    actions.append(selection);
    if (url) {
      const link = node('a', 'Original ↗'); link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer';
      link.setAttribute('aria-label', `Amtliches Original öffnen: ${ref.title}`); actions.append(link);
    }
    card.append(actions);
    return card;
  }

  function updateSelectionCount() {
    const count = workspaceContext?.politicalSelectedRecords?.size || document.querySelectorAll('#polCtxResults .polCtxCheck:checked').length;
    const label = document.getElementById('polCtxSelectionCount');
    if (label) label.textContent = count ? `${count} für den Bericht ausgewählt` : 'Vorgänge für den Bericht auswählen';
  }

  UA.PoliticalContext.selectRecord = function selectRecord(ctx, id) {
    for (const card of document.querySelectorAll('#polCtxResults .polCtxRef')) {
      card.setAttribute('aria-current', String(card.dataset.referenceId === id));
    }
  };

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
    }</p>` : '';
    const limits = warnings.length ? `<p>${UA.escHtml(warnings.join(' '))}</p>` : '';
    const coverageNote = note || limits ? `<details class="ris-browser__coverage"><summary>Datenstand und Quellenhinweise${warnings.length ? ' · Hinweise vorhanden' : ''}</summary>${note}${limits}</details>` : '';
    if (!result.references || result.references.length === 0) {
      const message = searchStatus === 'searched-no-results'
        ? 'Keine passenden Vorgänge im durchsuchten Bestand.'
        : 'Der verfügbare Datenstand erlaubt keinen vollständigen Befund.';
      const portal = safeReferenceUrl(result.meta.sourceUrl);
      container.innerHTML = `${coverageNote}<p class="ris-browser__empty">${message}</p>${portal
        ? `<a href="${UA.escHtml(portal)}" target="_blank" rel="noopener noreferrer">Amtliche Quelle öffnen</a>`
        : ''}`;
      return;
    }
    const byId = new Map(result.references.map(ref => [ref.id, ref]));
    container.innerHTML = coverageNote;
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

  async function runSearch(ctx, { restore = false, page, snapshot: pageSnapshot, focusResults = false } = {}) {
    const statusEl = document.getElementById('polCtxStatus');
    const resultsEl = document.getElementById('polCtxResults');
    const basisEl = document.getElementById('polCtxBasis');
    const btnSearch = document.getElementById('polCtxBtnSearch');
    if (!statusEl || !resultsEl) return;
    workspaceContext = ctx;
    UA.PoliticalContext.getSelectedReferences();
    if (!restore) refreshGeneratedSearchInput(ctx);
    const input = document.getElementById('polCtxSearchInput');
    const level = document.getElementById('polCtxLevel');
    const previousView = normalizeView(ctx.risView);
    const entered = restore ? previousView.query : input?.value || '';
    const enteredTerms = entered.split(/[,;]+/).map(term => term.trim()).filter(Boolean);
    const terms = enteredTerms.length ? enteredTerms.slice(0, 5) : UA.PoliticalContext.buildSearchTerms(ctx);
    const sourceLevels = restore ? previousView.sourceLevels : level
      ? level.value.split(',').filter(Boolean) : previousView.sourceLevels;
    updateView(ctx, { query: enteredTerms.length ? entered : terms.filter(term => term !== ctx.CITY_RAW).join(', '), sourceLevels,
      ...(restore ? {} : { searchCursor: null, searchGeneration: null }) });
    const view = normalizeView(ctx.risView);
    const city = ctx.CITY_RAW || '';
    const request = Symbol('political-search');
    const key = pageKey(ctx);
    ctx.politicalSearchRequest = request;
    ctx.politicalPendingPageKey = key;
    ctx.politicalLoadedPageKey = null;
    const current = () => ctx.politicalSearchRequest === request && (ctx.CITY_RAW || '') === city;
    if (basisEl) {
      basisEl.replaceChildren('Suche nach: ');
      terms.forEach((term, index) => {
        if (index) basisEl.append(', ');
        const label = document.createElement('strong'); label.textContent = term; basisEl.append(label);
      });
    }
    statusEl.textContent = 'Vorgänge werden gesucht …';
    if (page == null && !view.searchCursor) resultsEl.replaceChildren();
    resultsEl.setAttribute('aria-busy', 'true');
    if (btnSearch) btnSearch.disabled = true;
    const snapshot = pageSnapshot || (view.searchGeneration ? {
      city: UA.RisCatalogue?.cityKey?.(city) || city.toLocaleLowerCase('de'), sha256: view.searchGeneration,
    } : null);
    const params = { city, searchTerms: terms,
      context: { gremium: ctx.ui?._lastExportResult?.structured?.meta?.gremium?.name || '' },
      maxResults: 15, ...(sourceLevels.length ? { sourceLevels } : {}),
      ...((page ?? view.searchCursor) != null ? { page: page ?? view.searchCursor, ...(snapshot ? { snapshot } : {}) } : {}),
    };
    try {
      const result = await UA.PoliticalContext.search(params);
      if (!current()) return;
      const expected = snapshot?.generation || snapshot?.sha256;
      const incoming = result.meta.snapshot?.generation || result.meta.snapshot?.sha256 || result.meta.generation;
      if (expected && ((incoming && expected !== incoming) || result.references.some(ref => ref.snapshot
          && (ref.snapshot.generation || ref.snapshot.sha256) !== expected))) {
        throw new Error('Der Datenstand der Suchseite hat sich geändert. Bitte die Suche neu starten.');
      }
      const count = result.references.length;
      const continuation = hasSearchContinuation(result.meta.nextPage);
      statusEl.textContent = count ? `${count} ${count === 1 ? 'Vorgang' : 'Vorgänge'} auf dieser Suchseite.`
        : continuation ? 'Noch kein Treffer auf dieser Suchseite. Weitere Suchtreffer können folgen.'
          : result.meta.searchStatus === 'searched-no-results' ? 'Keine Vorgänge im durchsuchten Bestand.' : 'Recherche unvollständig.';
      if (count && (result.meta.complete === false || result.meta.truncated || result.meta.searchStatus === 'partial-results')) {
        statusEl.textContent += ' Recherche unvollständig.';
      }
      renderResults(resultsEl, result, ctx);
      const controls = document.createElement('nav'); controls.className = 'ris-browser__pager';
      controls.setAttribute('aria-label', 'Suchseiten');
      const firstPage = () => {
        updateView(ctx, { searchCursor: null, searchGeneration: null });
        return runSearch(ctx, { restore: true, focusResults: true });
      };
      if (params.page != null) {
        const first = document.createElement('button'); first.type = 'button'; first.textContent = 'Zur ersten Suchseite';
        first.addEventListener('click', firstPage); controls.append(first);
      }
      if (continuation) {
        const next = document.createElement('button'); next.type = 'button'; next.textContent = 'Weitere Suchtreffer laden';
        const nextSnapshot = result.meta.snapshot || result.references.find(ref => ref.snapshot)?.snapshot
          || (result.meta.generation ? { city: UA.RisCatalogue?.cityKey?.(city) || city.toLocaleLowerCase('de'), generation: result.meta.generation } : null);
        next.addEventListener('click', () => {
          if (!current() || next.disabled) return;
          next.disabled = true;
          updateView(ctx, { searchCursor: result.meta.nextPage,
            searchGeneration: nextSnapshot?.generation || nextSnapshot?.sha256 });
          runSearch(ctx, { restore: true, page: result.meta.nextPage, snapshot: nextSnapshot, focusResults: true });
        });
        controls.append(next);
      }
      if (controls.childElementCount) resultsEl.append(controls);
      ctx.politicalLoadedPageKey = key;
      updateSelectionCount();
      if (focusResults) {
        resultsEl.scrollTop = 0;
        const target = resultsEl.querySelector('[data-ris-open-record]') || statusEl;
        if (target === statusEl) statusEl.tabIndex = -1;
        target.focus({ preventScroll: true });
      }
    } catch (error) {
      if (current()) {
        statusEl.textContent = 'Fehler bei der Recherche. ' + String(error.message || error);
        const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = 'Suche neu starten';
        retry.addEventListener('click', () => {
          updateView(ctx, { searchCursor: null, searchGeneration: null });
          runSearch(ctx, { restore: true, focusResults: true });
        });
        resultsEl.append(retry);
        if (focusResults) retry.focus();
      }
    } finally {
      if (current()) {
        ctx.politicalPendingPageKey = null;
        resultsEl.setAttribute('aria-busy', 'false');
        if (btnSearch) btnSearch.disabled = false;
      }
    }
  }
  UA.PoliticalContext._runSearch = runSearch;

  function projectSearchFields(ctx) {
    const view = normalizeView(ctx.risView);
    const input = document.getElementById('polCtxSearchInput');
    if (input && input.value !== view.query) input.value = view.query;
    const level = document.getElementById('polCtxLevel');
    if (level) {
      const value = view.sourceLevels.join(',');
      if (value && ![...level.options].some(option => option.value === value)) {
        const option = document.createElement('option'); option.value = value;
        option.textContent = levelNames().filter(item => view.sourceLevels.includes(item.id)).map(item => item.label).join(' + ');
        level.append(option);
      }
      level.value = value;
    }
  }

  UA.PoliticalContext.refreshPanel = function refreshPanel(ctx, { load = true } = {}) {
    workspaceContext = ctx;
    const panel = document.getElementById('polCtxPanel');
    if (!panel) return;
    ctx.risView = normalizeView(ctx.risView);
    projectWorkspace(ctx);
    if (!ctx.risView.listOpen) {
      panel.style.display = 'none'; panel.setAttribute('aria-hidden', 'true');
      return;
    }
    showPanel(panel, { focus: false });
    if (!load) return;
    projectSearchFields(ctx);
    const key = pageKey(ctx);
    if (ctx.risView.query && !ctx.risView.listCollapsed && ctx.politicalLoadedPageKey !== key && ctx.politicalPendingPageKey !== key) {
      return runSearch(ctx, { restore: true });
    }
  };

  UA.PoliticalContext.returnToResults = function returnToResults(ctx) {
    UA.RisDetails?.setCollapsed?.(ctx, true);
    updateView(ctx, { listOpen: true, listCollapsed: false });
    const pending = UA.PoliticalContext.refreshPanel(ctx);
    const panel = document.getElementById('polCtxPanel');
    (panel?.querySelector('.polCtxRef[aria-current="true"] [data-ris-open-record]')
      || document.getElementById('polCtxSearchInput'))?.focus({ preventScroll: true });
    return pending;
  };

  /**
   * Öffnet das politische Recherche-Panel und startet ggf. direkt die Suche.
   *
   * @param {object} ctx
   */
  UA.PoliticalContext.openPanel = async function openPanel(ctx) {
    const panel = document.getElementById('polCtxPanel');
    if (!panel) return;

    workspaceContext = ctx;
    if (ctx.risView?.recordId && !ctx.risView.collapsed && window.matchMedia?.('(max-width: 980px)').matches) {
      UA.RisDetails?.setCollapsed?.(ctx, true);
    }
    updateView(ctx, { listOpen: true, listCollapsed: false });
    showPanel(panel);
    const existingInput = document.getElementById('polCtxSearchInput');
    const editedQuery = existingInput?.value.trim() && existingInput.value !== ctx.risView.query && !isGeneratedSearchInput(existingInput);
    if (ctx.risView.query && !editedQuery && !isGeneratedSearchInput(existingInput)) return UA.PoliticalContext.refreshPanel(ctx);
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
    const selected = [...checks].map(cb => ({
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
    if (!workspaceContext) return selected;
    const retained = new Map(workspaceContext.politicalSelectedRecords || []);
    for (const check of document.querySelectorAll('#polCtxResults .polCtxCheck:not(:checked)')) retained.delete(check.dataset.id || check.dataset.url);
    for (const ref of selected) retained.set(ref.id || ref.url, ref);
    workspaceContext.politicalSelectedRecords = retained;
    return [...retained.values()];
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
    ctx.politicalLoadedPageKey = null;
    ctx.politicalPendingPageKey = null;
    ctx.politicalSelectedRecords = new Map();
    ctx.risView = normalizeView({ ...ctx.risView, query: '', sourceLevels: [], searchCursor: null, searchGeneration: null });
    ctx.politicalContextResearch = null;
    UA.lastPoliticalContextResearch = null;
    ctx.__uaPoliticalResearchKey = null;
    ctx.__uaPoliticalResearchRequest = null;
    ctx.__uaPoliticalResearchPromise = null;
    const input = document.getElementById('polCtxSearchInput');
    if (input) { input.value = ''; generatedSearchInputs.delete(input); }
    const level = document.getElementById('polCtxLevel');
    if (level) level.value = '';
    const button = document.getElementById('polCtxBtnSearch');
    if (button) {
      button.disabled = false;
      button.removeAttribute('aria-disabled');
    }
    for (const id of ['polCtxStatus', 'polCtxResults', 'polCtxBasis']) {
      document.getElementById(id)?.replaceChildren();
    }
    projectWorkspace(ctx);
    updateSelectionCount();
  };

  // ── Initialisierung ───────────────────────────────────────────────────────────

  /**
   * Bindet alle Button-Events für das politische Recherche-Panel.
   * Wird aus ua.app_v2.js nach bindExport() aufgerufen.
   *
   * @param {object} ctx
   */
  UA.PoliticalContext.init = function init(ctx) {
    workspaceContext = ctx;
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
    document.getElementById('btnRisBrowse')?.addEventListener('click', () => {
      Promise.resolve(UA.PoliticalContext.openPanel(ctx)).catch(() => {});
    });
    document.getElementById('polCtxBtnCollapse')?.addEventListener('click', () => {
      updateView(ctx, { listCollapsed: !ctx.risView?.listCollapsed });
      UA.PoliticalContext.refreshPanel(ctx);
    });
    document.getElementById('polCtxLevel')?.addEventListener('change', () => {
      Promise.resolve(runSearch(ctx)).catch(() => {});
    });
    document.getElementById('polCtxSearchInput')?.addEventListener('keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); Promise.resolve(runSearch(ctx)).catch(() => {}); }
    });
    window.matchMedia?.('(max-width: 980px)').addEventListener?.('change', () => projectWorkspace(ctx));

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
