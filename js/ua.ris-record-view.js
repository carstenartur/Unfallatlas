/* Shared, bounded record presentation for map, research and URL-selected RIS records. */
(() => {
  'use strict';
  const UA = (window.UA = window.UA || {});
  const PAGE_SIZE = 64;
  const SECTIONS = [['history', 'Beratungsverlauf'], ['relations', 'Zusammenhänge'], ['locations', 'Orte']];
  const SOURCE_LABELS = {
    'hannover-sim': 'Landeshauptstadt Hannover · SIM',
    'region-hannover-ris': 'Region Hannover · ALLRIS',
    'region-hannover-bekanntmachungen': 'Region Hannover · Bekanntmachungen',
    'niedersachsen-landtag': 'Niedersächsischer Landtag',
    'bonn-oparl': 'Bundesstadt Bonn · Ratsinformationssystem',
  };
  const SOURCE_LEVELS = { 'hannover-sim': 'city', 'region-hannover-ris': 'region',
    'region-hannover-bekanntmachungen': 'region', 'niedersachsen-landtag': 'state', 'bonn-oparl': 'city' };
  const LEVELS = { city: 'Stadt', region: 'Region', state: 'Land' };
  const DOCUMENT_KINDS = { proposal: 'Vorlage / Antrag', answer: 'Antwort', agenda: 'Tagesordnung', minutes: 'Protokoll', other: 'Sonstiges' };
  const DOCUMENT_KIND_NAMES = {
    proposal: /^(?:vorlage|antrag|änderungsantrag|anfrage|beschlussdrucksache|beschlussvorlage|beschlussempfehlung)$/i,
    answer: /^(?:antwort|verwaltungsantwort|stellungnahme)$/i,
    agenda: /^(?:tagesordnung|bekanntmachung)$/i,
    minutes: /^(?:protokoll|niederschrift|stenografischer bericht)$/i,
    other: /^(?:sonstige|sonstiges)$/i,
  };
  const LOCATION_KINDS = { junction: 'Kreuzung', section: 'Abschnitt', street: 'Straßenbezug', address: 'Adresse', place: 'Ort' };
  let nextId = 0;

  function element(tag, content, className) {
    const node = document.createElement(tag);
    if (content != null) node.textContent = content;
    if (className) node.className = className;
    return node;
  }

  function append(parent, tag, content, className) {
    const node = element(tag, content, className);
    parent.append(node);
    return node;
  }

  function httpsUrl(value) {
    if (typeof value !== 'string') return '';
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password ? url.href : '';
    } catch (_) { return ''; }
  }

  function externalLink(parent, value, label) {
    const url = httpsUrl(value);
    if (!url) return null;
    const link = append(parent, 'a', label, 'ris-record-view__link');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    return link;
  }

  function sourceLabel(record) {
    return SOURCE_LABELS[record.source] || record.sourceContext?.publisher || record.source || 'Quelle nicht angegeben';
  }

  function headerQualifiers(record, kind) {
    const context = record.sourceContext;
    if (!context) return [];
    const key = value => String(value).trim().replace(/\s+/g, ' ').toLocaleLowerCase('de');
    const source = sourceLabel(record);
    const seen = new Set([kind, source, ...source.split('·')].map(key));
    if (SOURCE_LEVELS[record.source] === context.level) seen.add(key(LEVELS[context.level]));
    // Suppress a coarse category only when the displayed type already states it.
    // Unrecognized or differing document metadata remains visible.
    if ([kind, context.documentKind].some(value => value && DOCUMENT_KIND_NAMES[context.status]?.test(value.trim()))) {
      seen.add(key(DOCUMENT_KINDS[context.status]));
    }
    return [LEVELS[context.level], context.publisher, context.issuer, context.documentKind, DOCUMENT_KINDS[context.status]]
      .filter(value => {
        if (!value || seen.has(key(value))) return false;
        seen.add(key(value));
        return true;
      });
  }

  function dateLabel(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
    return match ? `${match[3]}.${match[2]}.${match[1]}` : value || 'Datum nicht angegeben';
  }

  function date(parent, value) {
    const node = append(parent, value ? 'time' : 'span', dateLabel(value));
    if (value) node.dateTime = value;
    return node;
  }

  function evidence(parent, value, label = 'Beleg aus der Quelle') {
    if (!value) {
      append(parent, 'p', 'Quellenbeleg nicht dokumentiert.', 'ris-record-view__gap');
      return;
    }
    const block = append(parent, 'div', null, 'ris-record-view__evidence');
    append(block, 'p', label, 'ris-record-view__evidence-label');
    append(block, 'blockquote', value);
  }

  function button(parent, label, action) {
    const node = append(parent, 'button', label, 'ris-record-view__button');
    node.type = 'button';
    node.addEventListener('click', event => {
      if (node.getAttribute('aria-disabled') === 'true') { event.preventDefault(); return; }
      action(event);
    });
    return node;
  }

  const pageNumber = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
  const knownCount = value => Number.isSafeInteger(value) && value >= 0;
  const stableId = value => typeof value === 'string' && value.length > 0 && value.length <= 2048 && !/[\u0000-\u001f\u007f]/.test(value);
  const missingPage = error => error?.code === 'RIS_SNAPSHOT_INVALID' && error.message === 'RIS page does not exist';

  function range(result, length, noun) {
    if (!length) return '';
    const first = (result.start || 0) + 1;
    const last = first + length - 1;
    return `${noun} ${first === last ? first : `${first}–${last}`}${result.total == null ? '' : ` von ${result.total}`} auf dieser Seite.`;
  }

  function create(options) {
    const { record, city, snapshot = record.snapshot } = options;
    const root = element('article', null, 'ris-record-view');
    const prefix = `ris-record-${++nextId}`;
    let view = {}, destroyed = false;
    const streams = [], panels = new Map(), tabs = new Map();
    const pendingMapActions = new Set();
    const active = () => !destroyed && (typeof options.isActive !== 'function' || options.isActive());
    const visible = section => active() && !view.collapsed && view.section === section;
    const change = patch => {
      if (!active()) return;
      if (typeof options.onViewChange === 'function') options.onViewChange(patch);
      else update({ ...view, ...patch });
    };

    const header = append(root, 'header', null, 'ris-record-view__header');
    const eyebrow = append(header, 'div', null, 'ris-record-view__eyebrow');
    const kind = record.type || record.sourceContext?.documentKind || 'Ratsvorgang';
    append(eyebrow, 'span', kind, 'ris-record-view__kind');
    if (record.number) append(eyebrow, 'span', record.number, 'ris-record-view__number');
    const title = append(header, 'h3', record.title || 'Ratsvorgang ohne Titel', 'ris-record-view__title');
    title.tabIndex = -1;
    append(header, 'p', `Quelle: ${sourceLabel(record)}`, 'ris-record-view__source');
    const context = record.sourceContext;
    const qualifiers = headerQualifiers(record, kind);
    if (qualifiers.length) append(header, 'p', qualifiers.join(' · '), 'ris-record-view__metadata');
    const dates = [['publicationDate', 'Veröffentlicht'], ['documentDate', 'Dokumentdatum'], ['meetingDate', 'Sitzungsdatum']];
    const dateRows = context ? dates.filter(([field]) => context[field]).map(([field, label]) => [context[field], label]) : [];
    if (!dateRows.length && record.date) dateRows.push([record.date, 'Datum']);
    if (dateRows.length || record.gremium) {
      const facts = append(header, 'dl', null, 'ris-record-view__facts');
      for (const [value, label] of dateRows) { append(facts, 'dt', label); date(append(facts, 'dd'), value); }
      if (record.gremium) { append(facts, 'dt', 'Gremium'); append(facts, 'dd', record.gremium); }
    }
    const actions = append(header, 'div', null, 'ris-record-view__actions');
    externalLink(actions, record.url, 'Amtliches Dokument');
    externalLink(actions, record.originalPdfUrl, 'Original-PDF');
    const actionStatus = append(header, 'div', '', 'ris-record-view__status');
    actionStatus.setAttribute('role', 'status');

    function cancelMapActions() {
      for (const cancel of pendingMapActions) cancel();
      pendingMapActions.clear();
    }

    async function runAction(control, status, callback, success, stillCurrent = active, cancelOnViewChange = false) {
      if (!active() || !stillCurrent() || control.getAttribute('aria-disabled') === 'true') return;
      let cancelled = false;
      const current = () => !cancelled && stillCurrent();
      const cancel = () => {
        cancelled = true;
        control.setAttribute('aria-disabled', 'false');
      };
      if (cancelOnViewChange) pendingMapActions.add(cancel);
      control.setAttribute('aria-disabled', 'true');
      try {
        await callback();
        if (active() && current() && success) status.textContent = success;
      } catch (error) {
        if (active() && current()) status.textContent = error?.message || 'Die Aktion konnte nicht ausgeführt werden. Bitte erneut versuchen.';
      } finally {
        pendingMapActions.delete(cancel);
        if (active() && current()) control.setAttribute('aria-disabled', 'false');
      }
    }

    if (typeof options.onAdopt === 'function') {
      const adopt = button(actions, 'Für Bericht übernehmen', () => runAction(adopt, actionStatus,
        () => options.onAdopt(record), 'Vorgang für den Bericht übernommen.'));
    }
    if (snapshot?.stale) append(header, 'p', 'Dieser Datenstand ist älter. Neuere Beratungen können noch fehlen.', 'ris-record-view__notice');
    else if (snapshot?.complete === false) append(header, 'p', 'Unvollständiger Datenbestand: Vorgänge oder Belege können fehlen.', 'ris-record-view__notice');

    const tablist = append(root, 'div', null, 'ris-record-view__tabs');
    tablist.setAttribute('role', 'tablist');
    tablist.setAttribute('aria-label', 'Bereiche des Ratsvorgangs');
    for (const [key, label] of SECTIONS) {
      const tab = button(tablist, label, () => change({ section: key }));
      tab.id = `${prefix}-tab-${key}`;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-controls', `${prefix}-panel-${key}`);
      tabs.set(key, tab);
      const panel = append(root, 'section', null, 'ris-record-view__panel');
      panel.id = `${prefix}-panel-${key}`;
      panel.dataset.risSection = key;
      panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-labelledby', tab.id);
      panels.set(key, panel);
      tab.addEventListener('keydown', event => {
        const current = SECTIONS.findIndex(([section]) => section === key);
        const index = event.key === 'ArrowRight' ? (current + 1) % SECTIONS.length
          : event.key === 'ArrowLeft' ? (current + SECTIONS.length - 1) % SECTIONS.length
            : event.key === 'Home' ? 0 : event.key === 'End' ? SECTIONS.length - 1 : -1;
        if (index < 0 || !active()) return;
        event.preventDefault();
        tabs.get(SECTIONS[index][0]).focus({ preventScroll: true });
        change({ section: SECTIONS[index][0] });
      });
    }

    function renderHistory(parent, result) {
      const events = (result.events || []).map((item, index) => ({ item, index }));
      const dated = events.filter(({ item }) => item.date).sort((a, b) => a.item.date.localeCompare(b.item.date) || a.index - b.index);
      const undated = events.filter(({ item }) => !item.date);
      for (const [items, label, unknown] of [[dated, 'Datierte Beratungen', false], [undated, 'Beratungen ohne Datumsangabe', true]]) {
        if (!items.length) continue;
        if (unknown) append(parent, 'h5', 'Ohne Datumsangabe', 'ris-record-view__undated-title');
        const list = append(parent, 'ol', null, `ris-process${unknown ? ' ris-process--undated' : ''}`);
        list.setAttribute('aria-label', label);
        for (const { item } of items) {
          const step = append(list, 'li', null, 'ris-process-step');
          date(append(step, 'div', null, 'ris-process-step__date'), item.date);
          append(step, 'h5', item.body || 'Gremium nicht angegeben', 'ris-process-step__body');
          append(step, 'p', item.outcome || 'Ergebnis nicht dokumentiert', item.outcome ? 'ris-process-step__outcome' : 'ris-record-view__gap');
          evidence(step, item.evidence);
          const link = externalLink(step, item.url, 'Amtlicher Sitzungsbeleg');
          if (link) append(step, 'span', new URL(link.href).hostname.replace(/^www\./, ''), 'ris-record-view__source-host');
        }
      }
    }

    function openRecordButton(parent, id, label) {
      if (!stableId(id) || typeof options.onOpenRecord !== 'function') return;
      const open = button(parent, 'Vorgang öffnen', () => { if (active()) options.onOpenRecord(id); });
      open.setAttribute('aria-label', `Vorgang öffnen: ${label}`);
    }

    function renderRelationships(parent, result) {
      const list = append(parent, 'ul', null, 'ris-record-view__cards');
      const roles = { answer: 'Antwort', proposal: 'Vorlage / Antrag', amendment: 'Änderungsantrag' };
      for (const item of result.relationships || []) {
        const row = append(list, 'li', null, 'ris-record-view__card');
        append(row, 'p', [item.type === 'mentions' ? 'Im Dokument erwähnt' : 'Amtlicher Querverweis', roles[item.targetRole]].filter(Boolean).join(' · '), 'ris-record-view__eyebrow');
        append(row, 'h5', item.label || 'Verweis ohne Titel');
        evidence(row, item.evidence);
        const controls = append(row, 'div', null, 'ris-record-view__actions');
        openRecordButton(controls, item.targetId, item.label);
        externalLink(controls, item.targetUrl, 'Amtlichen Verweis öffnen');
      }
    }

    function renderRelated(parent, result) {
      const list = append(parent, 'ul', null, 'ris-record-view__cards');
      for (const related of result.records || []) {
        const row = append(list, 'li', null, 'ris-record-view__card');
        append(row, 'h5', related.title || 'Vorgang ohne Titel');
        append(row, 'p', [related.type, related.number, related.date && dateLabel(related.date)].filter(Boolean).join(' · '), 'ris-record-view__metadata');
        append(row, 'p', `Quelle: ${sourceLabel(related)}`, 'ris-record-view__metadata');
        const controls = append(row, 'div', null, 'ris-record-view__actions');
        openRecordButton(controls, related.id, related.title);
        externalLink(controls, related.url, 'Amtliches Dokument');
      }
    }

    function emptyPage(field, index, known = true) {
      return { [field]: [], known, total: known ? 0 : null, start: 0, page: index, nextPage: null, complete: true, missing: [] };
    }

    function localPage(field, items, index, total = items.length, nextPage = null) {
      return { [field]: items, known: true, total, start: index * PAGE_SIZE, page: index, nextPage, complete: true, missing: [] };
    }

    async function cataloguePage(method, index) {
      const loader = UA.RisCatalogue?.[method];
      if (typeof loader !== 'function') throw new Error('Dieser Quellenbereich ist derzeit nicht verfügbar.');
      return loader.call(UA.RisCatalogue, city, record.id, index, { snapshot });
    }

    function historyPage(field, method, index) {
      if (Array.isArray(record[field])) return localPage(field, record[field].slice(index * PAGE_SIZE, (index + 1) * PAGE_SIZE), index,
        record[field].length, (index + 1) * PAGE_SIZE < record[field].length ? index + 1 : null);
      return cataloguePage(method, index);
    }

    let geometryTotal = Array.isArray(record.geometryIds) && record.geometryNextPage == null ? record.geometryIds.length : null;
    // Entry totals do not reveal remote page counts: the writer also splits
    // at a byte budget. Only an explicitly terminal page bounds a part.
    const lastPages = {
      locations: record.locationCount === 0 || Array.isArray(record.locations) && record.locationsNextPage == null
        && (!knownCount(record.locationCount) || record.locationCount === record.locations.length) ? 0 : null,
      geometryIds: Array.isArray(record.geometryIds) && record.geometryNextPage == null ? 0 : null,
    };
    async function locationPart(field, method, index) {
      const places = field === 'locations';
      const count = places ? record.locationCount : geometryTotal;
      if (knownCount(lastPages[field]) && index > lastPages[field]) return { ...emptyPage(field, index), absent: true };
      if (index === 0 && (Array.isArray(record[field]) || places && record.locationCount === 0)) {
        const values = record[field] || [];
        const nextPage = record[places ? 'locationsNextPage' : 'geometryNextPage'] ?? (places && knownCount(count) && count > values.length ? 1 : null);
        return localPage(field, values, index, knownCount(count) ? count : nextPage == null ? values.length : null, nextPage);
      }
      try {
        const result = await cataloguePage(method, index);
        if (!places && knownCount(result.total)) geometryTotal = result.total;
        if (result.complete === true && result.nextPage === null && knownCount(result.page)) lastPages[field] = result.page;
        return result;
      } catch (error) {
        if (index > 0 && missingPage(error)) return { ...emptyPage(field, index), absent: true };
        throw error;
      }
    }

    async function locationsPage(index) {
      const [places, geometries] = await Promise.all([
        locationPart('locations', 'loadRecordLocations', index),
        locationPart('geometryIds', 'loadRecordGeometries', index),
      ]);
      if (index > 0 && places.absent && geometries.absent) throw Object.assign(new Error('RIS page does not exist'), { code: 'RIS_SNAPSHOT_INVALID' });
      const nextPages = [places.nextPage, geometries.nextPage].filter(Number.isSafeInteger);
      return {
        locations: places.locations, geometryIds: geometries.geometryIds, places, geometries,
        known: Array.isArray(record.locations) || knownCount(record.locationCount) || !!record.locationAssessment || !!places.locations.length || !!geometries.geometryIds.length,
        total: places.total, start: places.start, page: index, nextPage: nextPages.length ? Math.max(...nextPages) : null,
        complete: places.complete !== false && geometries.complete !== false,
      };
    }

    function renderLocations(parent, result, stream) {
      const list = append(parent, 'ul', null, 'ris-record-view__cards');
      const mapped = new Set();
      function showButton(row, place, label, mapOptions) {
        if (typeof options.onShowLocation !== 'function') return;
        const requestToken = stream.token;
        const current = () => visible('locations') && stream.token === requestToken;
        const control = button(row, 'Auf Karte zeigen', () => runAction(control, stream.actionStatus,
          () => options.onShowLocation(record, place, mapOptions), '', current, true));
        control.setAttribute('aria-label', `Auf Karte zeigen: ${label}`);
      }
      for (const [index, place] of (result.locations || []).entries()) {
        const row = append(list, 'li', null, 'ris-record-view__card');
        append(row, 'p', LOCATION_KINDS[place.kind] || 'Ort', 'ris-record-view__eyebrow');
        append(row, 'h5', place.label || 'Ort ohne Bezeichnung');
        append(row, 'p', place.mapped ? 'Auf der Karte verortet' : 'Nicht auf der Karte verortet', 'ris-record-view__metadata');
        evidence(row, place.evidence?.text, place.evidence?.source === 'title' ? 'Beleg im Titel' : 'Beleg im Dokument');
        if (place.geometryId) mapped.add(place.geometryId);
        if (place.mapped) showButton(row, place, place.label, { index: (result.places.start || 0) + index, geometryId: place.geometryId });
      }
      for (const [index, geometryId] of (result.geometryIds || []).entries()) {
        if (mapped.has(geometryId)) continue;
        mapped.add(geometryId);
        const row = append(list, 'li', null, 'ris-record-view__card');
        const label = `Kartenlage ${(result.geometries.start || 0) + index + 1}`;
        append(row, 'h5', label);
        append(row, 'p', 'Im Datenbestand verfügbare Geometrie.', 'ris-record-view__metadata');
        showButton(row, null, label, { geometryId });
      }
    }

    function collection(config) {
      const wrapper = append(panels.get(config.section), 'section', null, 'ris-record-view__collection');
      wrapper.dataset.risCollection = config.key;
      wrapper.setAttribute('aria-label', config.title);
      append(wrapper, 'h4', config.title, 'ris-record-view__section-title');
      if (config.intro) append(wrapper, 'p', config.intro, 'ris-record-view__intro');
      const status = append(wrapper, 'p', '', 'ris-record-view__status');
      status.setAttribute('role', 'status');
      status.tabIndex = -1;
      const content = append(wrapper, 'div', null, 'ris-record-view__content');
      const actionStatus = append(wrapper, 'div', '', 'ris-record-view__status');
      actionStatus.setAttribute('role', 'status');
      const pager = append(wrapper, 'nav', null, 'ris-record-view__pager');
      pager.setAttribute('aria-label', `Seiten: ${config.title}`);
      const stream = { ...config, wrapper, status, content, actionStatus, pager, token: 0, page: null, pending: false, data: null };
      const previous = button(pager, '← Zurück', () => { if (visible(config.section) && !stream.pending && stream.page > 0) change({ [config.pageKey]: stream.page - 1 }); });
      previous.setAttribute('aria-label', `Vorherige Seite ${config.title}`);
      const pageLabel = append(pager, 'span', '', 'ris-record-view__page-label');
      const next = button(pager, 'Weiter →', () => {
        if (visible(config.section) && !stream.pending && Number.isSafeInteger(stream.data?.nextPage)) change({ [config.pageKey]: stream.data.nextPage });
      });
      next.setAttribute('aria-label', `Nächste Seite ${config.title}`);
      const retry = button(wrapper, 'Erneut laden', () => load(true));
      retry.hidden = true;

      function focusStatusIfRemoved(focused) {
        if (focused && !root.contains(focused) && document.activeElement === document.body && active()) status.focus({ preventScroll: true });
      }

      function paging() {
        const canNext = Number.isSafeInteger(stream.data?.nextPage);
        previous.setAttribute('aria-disabled', String(stream.pending || !(stream.page > 0)));
        next.setAttribute('aria-disabled', String(stream.pending || !canNext));
        retry.setAttribute('aria-disabled', String(stream.pending));
        pageLabel.textContent = `Seite ${(stream.page || 0) + 1}`;
        const focused = pager.contains(document.activeElement) ? document.activeElement : null;
        pager.hidden = !(stream.page > 0 || canNext);
        if (focused && pager.hidden && active()) status.focus({ preventScroll: true });
      }

      function correct(index, requested, token) {
        Promise.resolve().then(() => {
          if (visible(config.section) && stream.token === token && view[config.pageKey] === requested) change({ [config.pageKey]: index });
        });
      }

      async function load(force = false) {
        if (!visible(config.section)) return;
        const requested = view[config.pageKey];
        if (!force && stream.page === requested && (stream.pending || stream.data)) return;
        // Fixed-size arithmetic applies only to arrays sliced in this renderer.
        const total = config.localCount?.();
        if (knownCount(total) && requested > Math.max(0, Math.ceil(total / PAGE_SIZE) - 1)) {
          const token = ++stream.token;
          correct(Math.max(0, Math.ceil(total / PAGE_SIZE) - 1), requested, token);
          return;
        }
        const token = ++stream.token;
        const current = () => visible(config.section) && stream.token === token && stream.page === requested;
        if (stream.page !== requested) {
          const focused = content.contains(document.activeElement) ? document.activeElement : null;
          content.replaceChildren();
          stream.data = null;
          focusStatusIfRemoved(focused);
        }
        stream.page = requested;
        stream.pending = true;
        wrapper.setAttribute('aria-busy', 'true');
        status.textContent = 'Quellenbelege werden geladen …';
        actionStatus.textContent = '';
        paging();
        try {
          const result = await config.load(requested);
          if (!current()) return;
          const unknownHistory = (config.field === 'events' || config.field === 'relationships')
            && result.known === false && result.complete === true && result.nextPage === null && result[config.field]?.length === 0;
          const noEntries = result.total === 0 && result.complete !== false && !result.geometryIds?.length;
          const differentPage = Number.isSafeInteger(result.page) && result.page !== requested;
          if (differentPage || requested > 0 && (noEntries || unknownHistory)) {
            stream.pending = false;
            correct(noEntries || unknownHistory ? 0 : result.page, requested, token);
            return;
          }
          const focused = content.contains(document.activeElement) ? document.activeElement : null;
          content.replaceChildren();
          stream.data = result;
          config.render(content, result, stream);
          const length = (result[config.field] || []).length + (config.key === 'locations' ? (result.geometryIds || []).length : 0);
          const rangeText = config.describe ? config.describe(result) : range(result, length, config.noun);
          status.textContent = result.complete === false ? `${rangeText ? `${rangeText} ` : ''}Der Abruf ist unvollständig. Weitere Belege konnten nicht geladen werden.`
            : result.known === false ? config.unknown
              : !length ? config.empty : rangeText;
          status.classList.toggle('ris-record-view__notice', result.complete === false || result.known === false);
          const retryFocused = document.activeElement === retry;
          retry.hidden = result.complete !== false;
          if (retryFocused && retry.hidden) status.focus({ preventScroll: true });
          focusStatusIfRemoved(focused);
        } catch (error) {
          if (!current()) return;
          if (requested > 0 && missingPage(error)) { correct(0, requested, token); return; }
          status.textContent = error?.code === 'RIS_SNAPSHOT_REFERENCE_MISMATCH'
            ? 'Vorgang und Belege stammen aus verschiedenen Datenständen. Bitte den Vorgang erneut öffnen.'
            : 'Quellenbelege konnten nicht geladen werden. Bitte erneut versuchen.';
          status.classList.add('ris-record-view__notice');
          retry.hidden = false;
        } finally {
          if (current()) {
            stream.pending = false;
            wrapper.setAttribute('aria-busy', 'false');
            paging();
          }
        }
      }

      stream.refresh = () => {
        if (!visible(config.section)) {
          if (stream.pending) {
            stream.token++;
            stream.pending = false;
            stream.data = null;
            wrapper.setAttribute('aria-busy', 'false');
          }
          return;
        }
        load();
      };
      streams.push(stream);
      return stream;
    }

    collection({ key: 'events', section: 'history', title: 'Beratungsverlauf', pageKey: 'eventsPage', field: 'events', noun: 'Quellenbelege',
      intro: 'Dokumentierte Beratungen dieses Vorgangs. Die Belege der angezeigten Seite sind nach Datum geordnet.',
      localCount: () => Array.isArray(record.events) ? record.events.length : undefined,
      load: index => historyPage('events', 'loadRecordEvents', index), render: renderHistory,
      unknown: 'Beratungsverlauf im geprüften Datenbestand nicht dokumentiert.',
      empty: 'Keine öffentlichen Beratungen im geprüften Datenbestand dokumentiert.' });
    collection({ key: 'relationships', section: 'relations', title: 'Direkte Querverweise', pageKey: 'relationsPage', field: 'relationships', noun: 'Querverweise',
      intro: 'Verweise und Erwähnungen, die in der amtlichen Quelle belegt sind.',
      localCount: () => Array.isArray(record.relationships) ? record.relationships.length : undefined,
      load: index => historyPage('relationships', 'loadRecordRelationships', index), render: renderRelationships,
      unknown: 'Direkte Querverweise im geprüften Datenbestand nicht dokumentiert.', empty: 'Keine direkten amtlichen Querverweise dokumentiert.' });
    collection({ key: 'related', section: 'relations', title: 'Verknüpfte Vorgänge', pageKey: 'relatedPage', field: 'records', noun: 'Vorgänge',
      intro: 'Weitere Vorgänge aus dem Zusammenhang dieses Dokuments. Die Verbindung allein belegt keine Reihenfolge oder Zuständigkeit.',
      load: index => cataloguePage('loadRelatedRecords', index), render: renderRelated,
      unknown: 'Verknüpfte Vorgänge im geprüften Datenbestand nicht dokumentiert.', empty: 'Keine weiteren verknüpften Vorgänge im geprüften Datenbestand.' });
    if (record.locationAssessment) {
      const assessment = record.locationAssessment;
      const labels = {
        mapped: 'Auf der Karte verortet', partial: 'Teilweise auf der Karte verortet',
        unresolved: 'Kein eindeutiger Ortsbezug für die Karte', unavailable: 'Keine geeigneten Geodaten für die Ortsprüfung',
      };
      const reasons = {
        gazetteer_unavailable: 'Für diese Stadt fehlen geeignete Geodaten.',
        document_text_unavailable: 'Der Dokumenttext war nicht vollständig verfügbar.',
        evidence_truncated: 'Der geprüfte Dokumenttext ist begrenzt.',
        location_limit: 'Es konnten nicht alle erkannten Orte übernommen werden.',
        unverified_name: 'Ein Ortsname ist nicht eindeutig oder nicht ausreichend belegt.',
        no_specific_location: 'Die geprüften Angaben enthalten keinen eindeutig zuordenbaren Ort.',
        unmapped_location: 'Mindestens eine genannte Lage ist noch ungeklärt.',
        non_traffic_address: 'Eine Adresse ohne Verkehrsbezug wird nur als Ortsangabe angezeigt.',
      };
      const section = append(panels.get('locations'), 'aside', null, 'ris-record-view__assessment');
      section.setAttribute('aria-label', 'Ortsprüfung');
      append(section, 'h4', labels[assessment.status] || 'Ortsprüfung');
      const sources = { title: 'Titel', document: 'Dokumenttext', official: 'amtliche Geometrie' };
      const basis = (assessment.sources || []).map(source => sources[source]).filter(Boolean);
      if (basis.length) append(section, 'p', `Geprüfte Grundlage: ${basis.join(', ')}.`);
      for (const reason of assessment.reasons || []) if (reasons[reason]) append(section, 'p', reasons[reason]);
      if (assessment.truncated) append(section, 'p', 'Die Ortsprüfung ist begrenzt; weitere Ortsbezüge können fehlen.');
    }
    collection({ key: 'locations', section: 'locations', title: 'Orte', pageKey: 'locationsPage', field: 'locations', noun: 'Ortsangaben',
      intro: 'Genannte Orte mit ihrer Fundstelle und den verfügbaren Kartenlagen.', load: locationsPage, render: renderLocations,
      describe: result => [range(result.places, result.locations.length, 'Ortsangaben'), range(result.geometries, result.geometryIds.length, 'Kartenlagen')].filter(Boolean).join(' '),
      unknown: 'Ortsangaben im geprüften Datenbestand nicht dokumentiert.', empty: 'Keine Ortsangaben oder Kartenlagen im geprüften Datenbestand dokumentiert.' });

    function update(nextView = {}) {
      if (!active()) return;
      const next = {
        ...nextView,
        section: SECTIONS.some(([key]) => key === nextView.section) ? nextView.section : 'history',
        collapsed: nextView.collapsed === true,
        eventsPage: pageNumber(nextView.eventsPage), relationsPage: pageNumber(nextView.relationsPage),
        relatedPage: pageNumber(nextView.relatedPage), locationsPage: pageNumber(nextView.locationsPage),
      };
      if (['recordId', 'section', 'collapsed', 'selectionOnly', 'eventsPage', 'relationsPage', 'relatedPage', 'locationsPage']
        .some(key => view[key] !== next[key])) cancelMapActions();
      view = next;
      for (const [key, tab] of tabs) {
        const selected = view.section === key;
        tab.setAttribute('aria-selected', String(selected));
        tab.tabIndex = selected ? 0 : -1;
        panels.get(key).hidden = !selected;
      }
      streams.forEach(stream => stream.refresh());
    }

    function destroy() {
      destroyed = true;
      cancelMapActions();
      streams.forEach(stream => { stream.token++; stream.pending = false; });
    }

    update(options.view);
    return { element: root, update, destroy };
  }

  UA.RisRecordView = { create };
})();
