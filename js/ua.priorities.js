(() => {
  'use strict';

  /**
   * ua.priorities.js
   *
   * Frontend-Modul für die Prioritätenansicht der Werkbank.
   *
   * Funktionen:
   *   UA.Priorities.loadProfiles()                – GET /api/priorities/profiles
   *   UA.Priorities.fetchTop(city, profile, n)    – GET /api/priorities/top
   *   UA.Priorities.fetchByLocation(key, profile) – GET /api/priorities/by-location/:key
   *   UA.Priorities.openPanel(ctx)                – öffnet das Prioritäten-Panel
   *   UA.Priorities.init(ctx)                     – bindet Button-Events
   *
   * Das Modul ist fail-safe: wenn der Server-/Analysis-Service nicht
   * verfügbar ist, antwortet die API mit `dataStatus: "fallback_result"`
   * und das Panel zeigt einen klaren Hinweis.  Browser-only Nutzer
   * (statische Auslieferung) sehen lediglich „Service nicht erreichbar"
   * und die Werkbank funktioniert ansonsten unverändert weiter.
   *
   * Stabile dataStatus-Werte (siehe `server/priorities/index.js`):
   *   - freshly_computed
   *   - loaded_from_store
   *   - persisted
   *   - fallback_result
   */

  const UA = (window.UA = window.UA || {});
  UA.Priorities = UA.Priorities || {};

  let panelController = null;

  function getPanelController(panel) {
    if (!panelController) {
      panelController = UA.createModalController(panel, {
        initialFocus: '#prioBtnClose',
        returnFocus: () => document.getElementById('btnPrioritiesOpen'),
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
   * Lädt die unterstützten Profile + dataStatus-Vokabular.
   * Liefert Defaults im Fehlerfall (Browser-only-Modus).
   *
   * @returns {Promise<{profiles:string[], defaultProfile:string|null, dataStatusValues:string[]}>}
   */
  UA.Priorities.loadProfiles = async function loadProfiles() {
    try {
      const r = await fetch('/api/priorities/profiles');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (_) {
      return {
        profiles: [
          'low_hanging_fruit', 'bicycle_safety_priority',
          'severe_accident_priority', 'policy_ready', 'cost_effective'
        ],
        defaultProfile: 'low_hanging_fruit',
        dataStatusValues: ['freshly_computed', 'loaded_from_store', 'persisted', 'fallback_result']
      };
    }
  };

  /**
   * Top-N gespeicherte Briefs einer Stadt für ein Profil.
   *
   * @param {string} city
   * @param {string} profile
   * @param {number} [limit=10]
   * @returns {Promise<object>}
   */
  UA.Priorities.fetchTop = async function fetchTop(city, profile, limit) {
    const qs = new URLSearchParams({
      city: String(city || ''),
      profile: String(profile || ''),
      limit: String(limit || 10)
    });
    const r = await fetch('/api/priorities/top?' + qs.toString());
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.error || ('HTTP ' + r.status));
    }
    return r.json();
  };

  /**
   * Alle gespeicherten Briefs einer Stelle (neuester / passendes Profil zuerst).
   *
   * @param {string} locationKey
   * @param {string} [profile]
   * @returns {Promise<object>}
   */
  UA.Priorities.fetchByLocation = async function fetchByLocation(locationKey, profile) {
    const qs = profile ? '?profile=' + encodeURIComponent(profile) : '';
    const r = await fetch('/api/priorities/by-location/' + encodeURIComponent(locationKey) + qs);
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.error || ('HTTP ' + r.status));
    }
    return r.json();
  };

  // ── Rendering ────────────────────────────────────────────────────────────────

  // Sichtbare Kennzeichnung des Datenstatus.  Vier stabile Werte – die UI
  // muss klar zwischen frisch berechnet, geladen, persistiert und Fallback
  // unterscheiden können.
  const STATUS_BADGE = {
    freshly_computed:  { label: 'frisch berechnet', bg: '#e6f0ff', fg: '#1d4e89' },
    loaded_from_store: { label: 'aus Persistenz',  bg: '#e7f7e9', fg: '#1f6b32' },
    persisted:         { label: 'persistiert',     bg: '#d4edda', fg: '#155724' },
    fallback_result:   { label: 'Fallback (unsicher)', bg: '#fff3cd', fg: '#7a4f01' }
  };

  function escHtml(s) {
    return UA.escHtml ? UA.escHtml(s) : String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function renderStatusBadge(badgeEl, dataStatus, fallbackReason) {
    if (!badgeEl) return;
    const meta = STATUS_BADGE[dataStatus] || { label: dataStatus || '?', bg: '#eee', fg: '#444' };
    badgeEl.style.display = 'inline-block';
    badgeEl.style.background = meta.bg;
    badgeEl.style.color = meta.fg;
    let text = meta.label;
    if (dataStatus === 'fallback_result' && fallbackReason) {
      text += ' · ' + fallbackReason;
    }
    badgeEl.textContent = text;
  }

  function renderConflictPatterns(patterns) {
    if (!patterns || patterns.length === 0) return '<em style="color:#888;">keine Konfliktmuster erkannt</em>';
    return patterns.map(p => {
      const cls = (p.classification || '').toLowerCase();
      const color = cls === 'primary' ? '#c0392b' : '#7f8c8d';
      return `<span style="display:inline-block;background:${color};color:#fff;border-radius:4px;
        padding:2px 7px;font-size:11px;margin-right:4px;margin-bottom:3px;">
        ${escHtml(p.label || p.id)}${p.confidence ? ' · ' + escHtml(p.confidence) : ''}
      </span>`;
    }).join('');
  }

  function renderMeasures(measures) {
    if (!measures || measures.length === 0) return '<em style="color:#888;">keine empfohlenen Maßnahmen</em>';
    return measures.map(m => {
      const meta = [];
      if (m.fitScore != null) meta.push('Fit ' + (Math.round(m.fitScore * 100) / 100));
      if (m.costBand)         meta.push('Kosten: ' + m.costBand);
      if (m.effort)           meta.push('Aufwand: ' + m.effort);
      return `<div style="margin-top:4px;">
        <strong>▸ ${escHtml(m.title || m.id)}</strong>
        ${meta.length ? '<span style="color:#666;font-size:11px;"> (' + escHtml(meta.join(' · ')) + ')</span>' : ''}
      </div>`;
    }).join('');
  }

  function renderPolitical(political) {
    if (!political || !political.count) {
      return '<span style="color:#888;font-size:11px;">kein politischer Kontext erfasst</span>';
    }
    const high = political.hasHighRelevance
      ? ' <span style="color:#c0392b;font-weight:700;">· Hochrelevant</span>'
      : '';
    return `<span style="font-size:11px;color:#444;">📜 ${political.count} politische Vorgänge${high}</span>`;
  }

  function renderCard(item) {
    const score = item.score && item.score.total != null
      ? `<span style="float:right;font-weight:800;color:#6a3f9e;font-size:14px;">
           Score ${Math.round(item.score.total * 10) / 10}
         </span>`
      : '';
    const conf = item.confidence != null
      ? `<span style="font-size:11px;color:#888;">Konfidenz: ${Math.round(item.confidence * 100)}%</span>`
      : '';
    return `<div style="border:1px solid rgba(0,0,0,.12);border-radius:10px;padding:12px 14px;
        margin-bottom:10px;background:rgba(255,255,255,.95);">
      <div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start;">
        <div style="flex:1;">
          <div style="font-weight:800;font-size:14px;">${escHtml(item.title)}</div>
          <div style="font-size:11px;color:#666;margin-top:2px;">
            ${escHtml(item.city || '')}
            ${item.profileKey ? ' · Profil: <code>' + escHtml(item.profileKey) + '</code>' : ''}
            ${item.locationKey ? ' · <code style="color:#888;">' + escHtml(item.locationKey) + '</code>' : ''}
          </div>
        </div>
        ${score}
      </div>
      <div style="margin-top:8px;">
        <div style="font-size:12px;font-weight:700;color:#444;margin-bottom:3px;">Konfliktmuster:</div>
        ${renderConflictPatterns(item.conflictPatterns)}
      </div>
      <div style="margin-top:8px;">
        <div style="font-size:12px;font-weight:700;color:#444;">Empfohlene Maßnahmen:</div>
        ${renderMeasures(item.recommendedMeasures)}
      </div>
      <div style="margin-top:8px;display:flex;justify-content:space-between;gap:10px;align-items:center;flex-wrap:wrap;">
        ${renderPolitical(item.political)}
        ${conf}
      </div>
    </div>`;
  }

  function renderResults(container, response) {
    if (!container) return;
    if (response.empty) {
      const isFallback = response.dataStatus === 'fallback_result';
      const msg = isFallback
        ? `Persistenz-Service nicht verfügbar (${escHtml(response.fallbackReason || 'unbekannt')}). ` +
          'Die Karten- und Export-Wege funktionieren weiterhin; gespeicherte Briefs werden ' +
          'erst sichtbar, wenn der Analysis Service erreichbar ist.'
        : 'Für diese Auswahl liegen <strong>keine gespeicherten Briefs</strong> vor. ' +
          'Du kannst über „Analyse/Export öffnen" einen frischen Brief erzeugen und ' +
          'mit <code>persist: true</code> ablegen.';
      container.innerHTML = `<div style="padding:14px;border:1px dashed rgba(0,0,0,.2);
        border-radius:10px;color:#555;font-size:13px;line-height:1.5;">${msg}</div>`;
      return;
    }
    const cards = response.items.map(renderCard).join('');
    container.innerHTML = `<div style="font-size:11px;color:#888;margin-bottom:6px;">
      ${response.count} Eintrag/Einträge · Modus: <code>${escHtml(response.mode || '')}</code>
    </div>${cards}`;
  }

  // ── Panel öffnen / Eingaben binden ───────────────────────────────────────────

  /**
   * Öffnet das Prioritäten-Panel und füllt Defaults (aktuelle Stadt) vor.
   *
   * @param {object} ctx
   */
  UA.Priorities.openPanel = async function openPanel(ctx) {
    const panel = document.getElementById('prioPanel');
    if (!panel) return;
    showPanel(panel);

    const cityInput    = document.getElementById('prioCity');
    const profileSel   = document.getElementById('prioProfile');
    const modeSel      = document.getElementById('prioMode');
    const byLocRow     = document.getElementById('prioByLocationRow');
    const resultsEl    = document.getElementById('prioResults');
    const statusEl     = document.getElementById('prioStatus');
    const badgeEl      = document.getElementById('prioStatusBadge');

    if (cityInput && !cityInput.value && ctx && ctx.CITY_RAW) {
      cityInput.value = String(ctx.CITY_RAW).trim();
    }
    if (resultsEl && !resultsEl.innerHTML) {
      resultsEl.innerHTML = `<div style="color:#888;font-size:13px;padding:14px;">
        Wähle Modus, Stadt und Profil und klicke „Laden", um gespeicherte Steckbriefe zu sehen.
      </div>`;
    }
    if (statusEl) statusEl.textContent = '';
    if (badgeEl)  badgeEl.style.display = 'none';

    // Profil-Dropdown nur einmal befüllen.
    if (profileSel && profileSel.options.length <= 1) {
      const meta = await UA.Priorities.loadProfiles();
      profileSel.innerHTML = '';
      (meta.profiles || []).forEach(p => {
        const opt = document.createElement('option');
        opt.value = p;
        opt.textContent = p;
        if (p === meta.defaultProfile) opt.selected = true;
        profileSel.appendChild(opt);
      });
    }

    // Modus-Umschaltung sichtbar machen.  Der Handler wird genau einmal
    // pro Element gebunden (markiert über `_uaPrioritiesSyncHandler`),
    // damit wiederholtes Öffnen des Panels nicht jedes Mal einen weiteren
    // Listener anhängt.
    if (modeSel && byLocRow) {
      if (!modeSel._uaPrioritiesSyncHandler) {
        modeSel._uaPrioritiesSyncHandler = () => {
          byLocRow.style.display = modeSel.value === 'byLocation' ? '' : 'none';
        };
        modeSel.addEventListener('change', modeSel._uaPrioritiesSyncHandler);
      }
      modeSel._uaPrioritiesSyncHandler();
    }
  };

  // ── Initialisierung ───────────────────────────────────────────────────────────

  /**
   * Bindet alle Button-Events für die Prioritätenansicht.  Wird aus
   * `ua.app_v2.js` nach `bindExport()` aufgerufen.  Wenn der Open-Button
   * nicht im DOM existiert (z. B. älteres HTML), passiert hier nichts –
   * das Modul ist 100 % optional.
   *
   * @param {object} ctx
   */
  UA.Priorities.init = function init(ctx) {
    const btnOpen   = document.getElementById('btnPrioritiesOpen');
    const btnClose  = document.getElementById('prioBtnClose');
    const btnLoad   = document.getElementById('prioBtnLoad');
    const panel     = document.getElementById('prioPanel');
    const statusEl  = document.getElementById('prioStatus');
    const badgeEl   = document.getElementById('prioStatusBadge');
    const resultsEl = document.getElementById('prioResults');

    if (!btnOpen || !panel) return;

    btnOpen.addEventListener('click', () => UA.Priorities.openPanel(ctx));
    if (btnClose) btnClose.addEventListener('click', () => closePanel(panel));

    if (btnLoad) {
      btnLoad.addEventListener('click', async () => {
        const mode      = document.getElementById('prioMode').value;
        const city      = document.getElementById('prioCity').value.trim();
        const profile   = document.getElementById('prioProfile').value;
        const locKey    = (document.getElementById('prioLocationKey') || {}).value || '';

        if (statusEl) statusEl.textContent = 'Lade…';
        if (badgeEl)  badgeEl.style.display = 'none';
        btnLoad.disabled = true;

        try {
          let response;
          if (mode === 'byLocation') {
            if (!locKey.trim()) throw new Error('Bitte einen Location-Key angeben.');
            response = await UA.Priorities.fetchByLocation(locKey.trim(), profile);
          } else {
            if (!city || !profile) throw new Error('Bitte Stadt und Profil angeben.');
            response = await UA.Priorities.fetchTop(city, profile, 10);
          }
          renderStatusBadge(badgeEl, response.dataStatus, response.fallbackReason);
          renderResults(resultsEl, response);
          if (statusEl) statusEl.textContent = '';
        } catch (err) {
          if (statusEl) statusEl.textContent = 'Fehler: ' + String(err.message || err);
          if (resultsEl) resultsEl.innerHTML = '';
        } finally {
          btnLoad.disabled = false;
        }
      });
    }
  };

})();
