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

    // Straßenname aus ctx (falls vorhanden, z. B. vom Reverse-Geocoder)
    if (ctx.locationHint && ctx.locationHint.street) {
      terms.add(ctx.locationHint.street);
    }
    if (ctx.locationHint && ctx.locationHint.district) {
      terms.add(ctx.locationHint.district);
    }

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

    // Fallback: allgemeines Thema Verkehr
    if (terms.size <= 1) {
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
  function renderRef(ref) {
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
    const score = ref.relevanceScore != null ? `${ref.relevanceScore}` : '–';
    const dateStr = ref.date ? ` · ${UA.escHtml(ref.date)}` : '';
    const gremiumStr = ref.gremium ? ` · ${UA.escHtml(ref.gremium)}` : '';
    const numberStr = ref.number ? ` · ${UA.escHtml(ref.number)}` : '';
    const snippet = ref.snippet
      ? `<div style="margin-top:4px;font-size:11px;color:#555;line-height:1.4;">${UA.escHtml(ref.snippet.substring(0, 200))}</div>`
      : '';

    return `<div class="polCtxRef" data-url="${UA.escHtml(ref.url)}" data-title="${UA.escHtml(ref.title)}" style="
      border:1px solid rgba(0,0,0,.1);border-radius:8px;padding:10px 12px;
      margin-bottom:8px;background:rgba(255,255,255,.9);cursor:pointer;
      transition:background .15s;">
      <div style="display:flex;align-items:flex-start;gap:8px;">
        <label style="display:flex;align-items:flex-start;gap:8px;cursor:pointer;flex:1;">
          <input type="checkbox" class="polCtxCheck" style="margin-top:2px;cursor:pointer;"
            data-url="${UA.escHtml(ref.url)}"
            data-title="${UA.escHtml(ref.title)}"
            data-type="${UA.escHtml(ref.type)}"
            data-date="${UA.escHtml(ref.date || '')}"
            data-gremium="${UA.escHtml(ref.gremium || '')}"
            data-number="${UA.escHtml(ref.number || '')}"
          />
          <div style="flex:1;">
            <div style="font-weight:700;font-size:13px;line-height:1.3;">
              ${UA.escHtml(ref.title)}
            </div>
            <div style="margin-top:3px;font-size:11px;color:#555;">
              <span style="background:${color};color:#fff;border-radius:4px;padding:1px 6px;font-size:10px;font-weight:700;">${UA.escHtml(ref.type)}</span>
              <span style="color:#888;">${dateStr}${gremiumStr}${numberStr}</span>
              <span style="float:right;color:#aaa;font-size:10px;">Score: ${score}</span>
            </div>
            ${snippet}
          </div>
        </label>
      </div>
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
        Unterstützte Städte: Hannover.
      </div>`;
      return;
    }
    if (!result.references || result.references.length === 0) {
      container.innerHTML = `<div style="color:#888;font-size:13px;padding:12px 0;">
        Keine passenden Vorgänge gefunden.
      </div>`;
      return;
    }
    const refsHtml = result.references.map(renderRef).join('');
    container.innerHTML = `
      <div style="font-size:12px;color:#888;margin-bottom:8px;">
        ${result.meta.totalFound} Treffer (nach Relevanz sortiert, max. ${result.references.length} angezeigt)
      </div>
      ${refsHtml}
    `;
  }

  // ── Panel öffnen ─────────────────────────────────────────────────────────────

  /**
   * Öffnet das politische Recherche-Panel und startet ggf. direkt die Suche.
   *
   * @param {object} ctx
   */
  UA.PoliticalContext.openPanel = function openPanel(ctx) {
    const panel = document.getElementById('polCtxPanel');
    if (!panel) return;

    panel.style.display = 'flex';

    // Suchbegriffe vorbelegen
    const inputEl = document.getElementById('polCtxSearchInput');
    const terms = UA.PoliticalContext.buildSearchTerms(ctx);
    if (inputEl && !inputEl.value.trim()) {
      // Nur die nicht-Stadt-Begriffe vorbelegen (Stadt steht schon im Kontext)
      const filtered = terms.filter(t => t !== ctx.CITY_RAW);
      inputEl.value = filtered.join(', ');
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
      title:   cb.dataset.title   || '',
      type:    cb.dataset.type    || 'Sonstige',
      date:    cb.dataset.date    || null,
      gremium: cb.dataset.gremium || null,
      number:  cb.dataset.number  || null,
      url:     cb.dataset.url     || ''
    }));
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
      UA.PoliticalContext.openPanel(ctx);
    });

    // Panel schließen
    if (btnClose) {
      btnClose.addEventListener('click', () => {
        if (panel) panel.style.display = 'none';
      });
    }

    // Suche starten
    if (btnSearch) {
      btnSearch.addEventListener('click', async () => {
        if (!statusEl || !resultsEl) return;

        const inputEl = document.getElementById('polCtxSearchInput');
        const terms = UA.PoliticalContext.buildSearchTerms(ctx);

        statusEl.textContent = 'Suche läuft…';
        resultsEl.innerHTML = '';
        btnSearch.disabled = true;

        try {
          const result = await UA.PoliticalContext.search({
            city: ctx.CITY_RAW || '',
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
          statusEl.textContent = result.references.length > 0
            ? `${result.references.length} Vorgänge gefunden.`
            : 'Keine Vorgänge gefunden.';
          renderResults(resultsEl, result);
        } catch (err) {
          statusEl.textContent = 'Fehler: ' + String(err.message || err);
        } finally {
          btnSearch.disabled = false;
        }
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
        ctx.politicalReferences = selected;
        if (panel) panel.style.display = 'none';
        const count = selected.length;
        const btnOpenExport = document.getElementById('btnOpenExport');
        if (btnOpenExport) {
          alert(`${count} Vorgang/Vorgänge übernommen. Bitte jetzt „Analyse/Export öffnen" klicken.`);
        }
      });
    }
  };

})();
