(() => {
  'use strict';

  const UA = (window.UA = window.UA || {});
  const WORKFLOW_URL = 'https://github.com/carstenartur/Unfallatlas/actions/workflows/generate-context-city.yml';
  const CAPABILITY_URL = '/data/context-generation-status.json';
  const POLL_INTERVAL_MS = 2000;
  const TERMINAL = new Set(['succeeded', 'failed']);

  function selectedCity() {
    const select = document.getElementById('citySel');
    if (select && select.value) return select.value;
    try { return new URL(window.location.href).searchParams.get('city') || 'Hannover'; }
    catch (_) { return 'Hannover'; }
  }

  function setStatus(element, text, kind) {
    if (!element) return;
    element.textContent = text || '';
    element.dataset.kind = kind || '';
    element.style.color = kind === 'error' ? '#a40000' : (kind === 'success' ? '#176b36' : '#555');
  }

  function lastLogLine(job) {
    const logs = job && Array.isArray(job.logs) ? job.logs : [];
    return logs.length ? logs[logs.length - 1].line : '';
  }

  async function readJson(response) {
    const type = response && response.headers && response.headers.get('content-type');
    if (!response || !type || !type.includes('application/json')) return null;
    try { return await response.json(); }
    catch (_) { return null; }
  }

  async function detectLocalCapability(city) {
    try {
      const response = await fetch(`${CAPABILITY_URL}?city=${encodeURIComponent(city)}`, {
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      });
      return await readJson(response);
    } catch (_) {
      return null;
    }
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      return false;
    }
  }

  async function pollJob(jobId, token, statusEl, button) {
    while (true) {
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
      const headers = { Accept: 'application/json' };
      if (token) headers.Authorization = `Bearer ${token}`;
      let payload = null;
      try {
        payload = await readJson(await fetch(`/api/context-generation/jobs/${encodeURIComponent(jobId)}`, {
          cache: 'no-store', headers,
        }));
      } catch (_) { /* handled below */ }
      if (!payload || !payload.job) {
        setStatus(statusEl, 'Status des Generierungsauftrags konnte nicht gelesen werden.', 'error');
        button.disabled = false;
        return;
      }
      const job = payload.job;
      const log = lastLogLine(job);
      setStatus(statusEl, log ? `Generierung läuft: ${log}` : `Generierung läuft (${job.status}) …`, 'progress');
      if (!TERMINAL.has(job.status)) continue;
      if (job.status === 'succeeded') {
        setStatus(statusEl, 'Kontextdaten wurden erzeugt. Die Seite wird mit den neuen Daten neu geladen.', 'success');
        setTimeout(() => window.location.reload(), 700);
      } else {
        setStatus(statusEl, job.error || log || 'Generierung ist fehlgeschlagen.', 'error');
        button.disabled = false;
      }
      return;
    }
  }

  async function startLocalGeneration(city, capability, statusEl, button) {
    let token = '';
    if (capability.requiresToken) {
      try { token = sessionStorage.getItem('ua_context_generation_token') || ''; } catch (_) { /* ignore */ }
      if (!token) token = window.prompt('Administrations-Token für die lokale Kontextdatengenerierung:') || '';
      if (!token) {
        setStatus(statusEl, 'Generierung abgebrochen: kein Administrations-Token angegeben.', 'error');
        return;
      }
      try { sessionStorage.setItem('ua_context_generation_token', token); } catch (_) { /* ignore */ }
    }

    button.disabled = true;
    setStatus(statusEl, `Generierung für ${city} wird gestartet …`, 'progress');
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    let response;
    let payload;
    try {
      response = await fetch('/api/context-generation/jobs', {
        method: 'POST', headers, body: JSON.stringify({ city, force: true }),
      });
      payload = await readJson(response);
    } catch (_) {
      payload = null;
    }
    if (!payload) {
      setStatus(statusEl, 'Der lokale Generierungsdienst ist nicht erreichbar.', 'error');
      button.disabled = false;
      return;
    }
    if (!response.ok && response.status !== 409) {
      setStatus(statusEl, payload.message || payload.error || 'Generierung konnte nicht gestartet werden.', 'error');
      button.disabled = false;
      return;
    }
    const job = payload.job;
    if (!job || !job.id) {
      setStatus(statusEl, 'Der Server hat keine Auftrags-ID geliefert.', 'error');
      button.disabled = false;
      return;
    }
    await pollJob(job.id, token, statusEl, button);
  }

  async function openGitHubWorkflow(city, statusEl) {
    const copied = await copyText(city);
    const url = `${WORKFLOW_URL}?city=${encodeURIComponent(city)}`;
    window.open(url, '_blank', 'noopener');
    setStatus(
      statusEl,
      copied
        ? `„${city}“ wurde kopiert. Im geöffneten GitHub-Workflow „Run workflow“ wählen und die Stadt einfügen.`
        : `Im geöffneten GitHub-Workflow „Run workflow“ wählen und als Stadt „${city}“ eintragen.`,
      'progress'
    );
  }

  function missingContextLabels() {
    const section = document.getElementById('ctxFilterSection');
    if (!section || section.hidden) return [];
    const rows = [
      ['Steigung', document.getElementById('ctxSlopeRow')],
      ['Verkehrsproxy', document.getElementById('ctxTrafficRow')],
      ['OSM-Straßenbezug', document.getElementById('ctxOnlyMatchedRow')],
    ];
    return rows.filter(([, row]) => !row || row.hidden).map(([label]) => label);
  }

  function buildControls(container) {
    let wrap = document.getElementById('ctxGenerationActions');
    if (wrap) return wrap;
    wrap = document.createElement('div');
    wrap.id = 'ctxGenerationActions';
    wrap.hidden = true;
    wrap.style.marginTop = '8px';
    wrap.style.padding = '8px';
    wrap.style.border = '1px solid rgba(0,0,0,.14)';
    wrap.style.borderRadius = '8px';
    wrap.style.background = 'rgba(255,255,255,.72)';

    const heading = document.createElement('div');
    heading.id = 'ctxGenerationHeading';
    heading.style.fontSize = '12px';
    heading.style.fontWeight = '700';
    heading.style.marginBottom = '6px';

    const button = document.createElement('button');
    button.id = 'ctxGenerateMissingBtn';
    button.type = 'button';
    button.className = 'btn';
    button.style.width = '100%';
    button.style.cursor = 'pointer';

    const status = document.createElement('div');
    status.id = 'ctxGenerationStatus';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.style.marginTop = '6px';
    status.style.fontSize = '11px';
    status.style.lineHeight = '1.4';

    wrap.append(heading, button, status);
    container.appendChild(wrap);
    return wrap;
  }

  async function configure() {
    const section = document.getElementById('ctxFilterSection');
    if (!section) return;
    const wrap = buildControls(section);
    const button = wrap.querySelector('#ctxGenerateMissingBtn');
    const status = wrap.querySelector('#ctxGenerationStatus');
    const heading = wrap.querySelector('#ctxGenerationHeading');
    if (!button || button.dataset.configuring === '1') return;

    const missing = missingContextLabels();
    wrap.hidden = missing.length === 0;
    if (wrap.hidden) return;
    if (heading) heading.textContent = `Fehlende Kontextdaten: ${missing.join(', ')}`;

    button.dataset.configuring = '1';
    const city = selectedCity();
    setStatus(status, 'Prüfe verfügbaren Generierungsweg …', 'progress');
    const capability = await detectLocalCapability(city);
    button.onclick = null;
    button.disabled = false;

    if (capability && capability.available && capability.execution === 'local-docker') {
      button.textContent = `Kontextdaten für ${city} lokal neu erzeugen`;
      button.onclick = () => startLocalGeneration(city, capability, status, button);
      const active = capability.activeJob;
      if (active && active.id) {
        let token = '';
        try { token = sessionStorage.getItem('ua_context_generation_token') || ''; } catch (_) { /* ignore */ }
        if (capability.requiresToken && !token) {
          button.textContent = `Laufenden Auftrag für ${active.city} mit Token verfolgen`;
          setStatus(status, 'Ein Auftrag läuft bereits. Zum Anzeigen des Status ist das Administrations-Token nötig.', 'progress');
        } else {
          button.disabled = true;
          setStatus(status, `Ein Auftrag für ${active.city} läuft bereits. Status wird verfolgt …`, 'progress');
          pollJob(active.id, token, status, button);
        }
      } else {
        setStatus(status, 'Die Erzeugung läuft im Docker-Container und installiert die Daten erst nach erfolgreicher Prüfung.', 'progress');
      }
    } else {
      button.textContent = `GitHub-Workflow für ${city} öffnen`;
      button.onclick = () => openGitHubWorkflow(city, status);
      setStatus(status, 'Auf der statischen Seite wird kein Zugangsschlüssel gespeichert; der Start erfolgt sicher in GitHub Actions.', 'progress');
    }
    button.dataset.configuring = '0';
  }

  function init() {
    configure();
    const observed = [
      document.getElementById('ctxFilterSection'),
      document.getElementById('ctxSlopeRow'),
      document.getElementById('ctxTrafficRow'),
      document.getElementById('ctxOnlyMatchedRow'),
    ].filter(Boolean);
    if (typeof MutationObserver !== 'undefined') {
      const observer = new MutationObserver(() => configure());
      for (const element of observed) observer.observe(element, { attributes: true, attributeFilter: ['hidden'] });
    }
  }

  UA.ContextGeneration = {
    CAPABILITY_URL,
    init,
    configure,
    detectLocalCapability,
    selectedCity,
    missingContextLabels,
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
