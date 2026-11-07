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
    getPanelController(panel).open();
  }

  function closePanel(panel) {
    if (!panel) return;
    getPanelController(panel).close();
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
    if (inputEl && inputEl.value.trim()) {
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

  /**
   * Rendert eine einzelne Referenz als HTML-Element.
   *
   * @param {object} ref  – PoliticalReference
   * @returns {string}
   */
  function safeReferenceUrl(value) {
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
    } catch (_) {
      return '';
    }
  }

  function renderRef(ref, related) {
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
    return `<div class="polCtxRef" data-url="${UA.escHtml(url)}" data-title="${UA.escHtml(ref.title)}" style="
      border:1px solid rgba(0,0,0,.1);border-radius:8px;padding:10px 12px;
      margin-bottom:8px;background:rgba(255,255,255,.9);cursor:pointer;
      transition:background .15s;">
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
            ${related ? `<small>Gehört zu Drucksache ${UA.escHtml(related.number || related.title)}</small>` : ''}
            ${snippet}
          </div>
        </label>
      </div>
      ${url ? `<a href="${UA.escHtml(url)}" target="_blank" rel="noopener noreferrer">Amtliches Original öffnen</a>` : ''}
    </div>`;
  }

  /**
   * Rendert die Trefferliste ins Panel.
   *
   * @param {HTMLElement} container
   * @param {object}      result   – PoliticalReferenceSearchResult
   */
  function renderResults(container, result) {
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
    const refsHtml = result.references.map(ref => renderRef(ref, byId.get(ref.relatedTo))).join('');
    container.innerHTML = `
      ${note}${limits}
      ${refsHtml}
    `;
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
  async function runSearch(ctx) {
    const statusEl  = document.getElementById('polCtxStatus');
    const resultsEl = document.getElementById('polCtxResults');
    const basisEl   = document.getElementById('polCtxBasis');
    const btnSearch = document.getElementById('polCtxBtnSearch');
    if (!statusEl || !resultsEl) return;

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

    try {
      const result = await UA.PoliticalContext.search({
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
      });
      if (ctx.politicalSearchRequest !== request || (ctx.CITY_RAW || '') !== city) return;
      statusEl.textContent = result.references.length > 0
        ? `${result.references.length} Vorgänge gefunden.`
        : result.meta.searchStatus === 'searched-no-results'
          ? 'Keine Vorgänge im durchsuchten Bestand.'
          : 'Recherche unvollständig.';
      renderResults(resultsEl, result);
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

    // Suchbegriffe vorbelegen
    const terms = UA.PoliticalContext.buildSearchTerms(ctx);
    if (inputEl && !inputEl.value.trim()) {
      // Nur die nicht-Stadt-Begriffe vorbelegen (Stadt steht schon im Kontext).
      // Beide Seiten gleich normalisieren (Trim), damit führende/folgende
      // Leerzeichen in CITY_RAW nicht dazu führen, dass die Stadt
      // versehentlich doch ins Suchfeld geschrieben wird.
      const city = ((ctx && ctx.CITY_RAW) || '').trim();
      const filtered = terms.filter(t => ((t || '').trim()) !== city);
      inputEl.value = filtered.join(', ');
    }

    // Issue 3: Auto-Suche, sobald ein Ortsbezug ableitbar war oder ein
    // Gremium aus einem vorigen Export bekannt ist. Sonst (nur Stadt +
    // generischer Fallback) bleibt es beim Klick-Trigger, damit die KI-
    // Quote des Servers nicht für reine Stadt-Topic-Suchen verbraucht wird.
    const hint = (ctx && ctx.locationHint) || {};
    const hasLocation = !!(hint.street || hint.district || hint.suburb);
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

  UA.PoliticalContext.addReferences = function addReferences(ctx, selected) {
    const city = ctx.CITY_RAW || '';
    const sameCity = !ctx.politicalReferencesCity || ctx.politicalReferencesCity === city;
    const refs = new Map();
    for (const ref of [...(sameCity ? (ctx.politicalReferences || []) : []), ...selected]) {
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
    ctx.politicalSearchRequest = null;
    ctx.politicalContextResearch = null;
    ctx.__uaPoliticalResearchKey = null;
    ctx.__uaPoliticalResearchPromise = null;
    const input = document.getElementById('polCtxSearchInput');
    if (input) input.value = '';
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
      btnAdopt.addEventListener('click', () => {
        const selected = UA.PoliticalContext.getSelectedReferences();
        if (!selected.length) {
          alert('Bitte mindestens einen Vorgang auswählen.');
          return;
        }
        // In ctx speichern, damit computeExportReport() sie einbeziehen kann
        UA.PoliticalContext.addReferences(ctx, selected);
        closePanel(panel);
        const count = selected.length;
        const btnOpenExport = document.getElementById('btnOpenExport');
        if (btnOpenExport) {
          alert(`${count} Vorgang/Vorgänge übernommen. Bitte jetzt „Analyse/Export öffnen" klicken.`);
        }
      });
    }
  };

})();
