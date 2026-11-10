(() => {
  const UA = (window.UA = window.UA || {});
  const panels = new WeakMap();
  const cityOf = ctx => String(ctx.CITY_RAW || '').trim();
  const normalized = value => UA.RisViewState.normalize(value);

  function button(parent, label, accessibleLabel, action) {
    const element = document.createElement('button');
    element.type = 'button';
    element.textContent = label;
    if (accessibleLabel) element.setAttribute('aria-label', accessibleLabel);
    element.addEventListener('click', action);
    parent.append(element);
    return element;
  }

  function sync(ctx) {
    if (!UA._hydrating) UA.syncAllToUrl?.(ctx);
  }

  function invalidateMapAction(state) {
    state.actionEpoch = (state.actionEpoch || 0) + 1;
    if (state.mapPending) {
      state.mapPending = false;
      state.status.textContent = '';
    }
  }

  function project(ctx, state) {
    // A transition remains an interruption even if the user returns to the
    // same section/page before the outstanding map lookup completes.
    const viewKey = JSON.stringify(ctx.risView);
    if (viewKey !== state.viewKey) {
      state.viewKey = viewKey;
      invalidateMapAction(state);
    }
    const { collapsed } = ctx.risView;
    state.root.classList.toggle('ris-details--collapsed', collapsed);
    state.body.hidden = collapsed;
    state.status.hidden = collapsed;
    state.share.textContent = collapsed ? 'Teilen' : 'Ansicht teilen';
    state.collapse.textContent = collapsed ? 'Öffnen' : 'Einklappen';
    state.collapse.setAttribute('aria-label', `Vorgangsansicht ${collapsed ? 'ausklappen' : 'einklappen'}`);
    state.collapse.setAttribute('aria-expanded', String(!collapsed));
    state.root.setAttribute('aria-label', state.record?.title ? `Ratsvorgang: ${state.record.title}` : 'Ratsvorgang');
    state.heading.textContent = collapsed && state.record ? state.record.number || 'Ratsvorgang' : 'Ratsvorgang';
    if (state.back) state.back.hidden = !ctx.risView.listOpen;
    UA.PoliticalContext?.refreshPanel?.(ctx, { load: false });
  }

  function change(ctx, state, patch) {
    ctx.risView = normalized({ ...ctx.risView, ...patch });
    project(ctx, state);
    state.view?.update(ctx.risView);
    sync(ctx);
  }

  function invalidate(state) {
    invalidateMapAction(state);
    state.token = null;
    state.pending = null;
    state.view?.destroy();
    state.view = null;
    state.record = null;
  }

  function hide(state) {
    invalidate(state);
    state.root.hidden = true;
    state.body.replaceChildren();
    state.status.replaceChildren();
    state.recordId = null;
  }

  function close(ctx, { restoreFocus = true } = {}) {
    ctx.risView = normalized({ ...ctx.risView, recordId: null });
    UA.PoliticalContext?.refreshPanel?.(ctx, { load: false });
    const state = panels.get(ctx);
    if (state) {
      const target = state.returnFocus;
      hide(state);
      if (restoreFocus && target?.isConnected && !target.closest('[hidden], [inert], [aria-hidden="true"]')) {
        target.focus({ preventScroll: true });
      } else if (restoreFocus) ctx.map?.getContainer?.()?.focus({ preventScroll: true });
    }
    sync(ctx);
  }

  async function share(ctx, state) {
    sync(ctx);
    const url = window.location.href;
    const token = state.token;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard-unavailable');
      await navigator.clipboard.writeText(url);
      if (state.token === token && !state.root.hidden) {
        state.status.textContent = 'Link zur aktuellen Ansicht kopiert.';
        state.status.hidden = false;
      }
    } catch (_) {
      if (state.token !== token || state.root.hidden) return;
      state.status.replaceChildren('Diesen Link kopieren und weitergeben: ');
      const input = document.createElement('input');
      input.type = 'text'; input.readOnly = true; input.value = url;
      input.setAttribute('aria-label', 'Link zur aktuellen Ansicht');
      state.status.append(input);
      // The fallback must stay available even when sharing a collapsed view.
      state.status.hidden = false;
      input.focus(); input.select();
    }
  }

  function ensure(ctx) {
    let state = panels.get(ctx);
    if (state) return state;
    const root = document.createElement('section');
    root.id = 'risDetails'; root.className = 'ris-details'; root.hidden = true;
    root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'false');
    root.setAttribute('aria-label', 'Ratsvorgang');
    const toolbar = document.createElement('header'); toolbar.className = 'ris-details__toolbar';
    const heading = document.createElement('h2'); heading.textContent = 'Ratsvorgang'; heading.tabIndex = -1;
    const actions = document.createElement('div'); actions.className = 'ris-details__actions';
    toolbar.append(heading, actions);
    const body = document.createElement('div'); body.className = 'ris-details__body';
    const status = document.createElement('div'); status.className = 'ris-details__status';
    status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    state = { root, toolbar, heading, body, status, city: cityOf(ctx) };
    state.back = button(toolbar, '← Trefferliste', 'Zur Trefferliste', () => UA.PoliticalContext?.returnToResults?.(ctx));
    state.back.className = 'ris-details__back';
    state.back.hidden = !ctx.risView?.listOpen;
    state.share = button(actions, 'Ansicht teilen', 'Link zur aktuellen Ansicht kopieren', () => share(ctx, state));
    state.collapse = button(actions, 'Einklappen', 'Vorgangsansicht einklappen', () => {
      const collapsed = !ctx.risView.collapsed;
      change(ctx, state, { collapsed });
      if (collapsed && ctx.risView.listOpen && !ctx.risView.listCollapsed
          && window.matchMedia?.(UA.COMPACT_MAP_QUERY)?.matches) {
        UA.PoliticalContext?.focusResults?.();
      }
    });
    button(actions, 'Schließen', 'Vorgangsansicht schließen', () => close(ctx));
    root.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault(); event.stopPropagation(); close(ctx);
      }
    });
    root.append(toolbar, body, status);
    document.body.append(root);
    panels.set(ctx, state);
    return state;
  }

  async function showLocation(ctx, state, record, location, options, active) {
    if (!active()) return;
    invalidateMapAction(state);
    const epoch = state.actionEpoch;
    const current = () => active() && state.actionEpoch === epoch;
    let ref = record;
    let index;
    const geometryId = options?.geometryId || location?.geometryId;
    if (geometryId) index = { geometryId };
    else if (location?.id) {
      ref = { ...record, locations: [...(record.locations || []).filter(item => item.id !== location.id), location] };
      index = location.id;
    } else index = options?.index ?? record.locations?.indexOf(location);
    state.mapPending = true;
    state.status.textContent = 'Kartenlage wird geöffnet …';
    try {
      const target = await UA.RisLayer.showLocation(ctx, ref, index, current);
      if (!current()) return;
      state.mapPending = false;
      state.status.textContent = '';
      if (!target) return;
      change(ctx, state, { collapsed: true,
        ...(ctx.risView.listOpen && window.matchMedia?.(UA.COMPACT_MAP_QUERY)?.matches
          ? { listCollapsed: true } : {}) });
      target.focus({ preventScroll: true });
    } catch (error) {
      if (current()) {
        state.mapPending = false;
        state.status.textContent = error?.message || 'Die Kartenlage konnte nicht geöffnet werden.';
      }
    }
  }

  async function refresh(ctx) {
    ctx.risView = normalized(ctx.risView);
    let state = panels.get(ctx);
    const city = cityOf(ctx);
    if (state && state.city !== city) {
      hide(state);
      state.city = city;
      ctx.risView = normalized({ ...ctx.risView, recordId: null });
      sync(ctx);
      return null;
    }
    const id = ctx.risView.recordId;
    if (!id) { if (state) hide(state); return null; }
    state = ensure(ctx);
    state.root.hidden = false;
    project(ctx, state);
    const revision = ctx.politicalContextCityRevision;
    if (state.recordId === id && state.revision === revision && state.token) {
      state.view?.update(ctx.risView);
      return state.pending || state.record;
    }
    invalidate(state);
    const token = state.token = Symbol('ris-detail');
    state.recordId = id; state.revision = revision;
    const active = () => state.token === token && !state.root.hidden && cityOf(ctx) === city
      && ctx.risView?.recordId === id && ctx.politicalContextCityRevision === revision;
    state.body.replaceChildren();
    state.body.scrollTop = 0;
    state.status.textContent = 'Vorgang wird geladen …';
    const pending = (async () => {
      try {
        const manifest = await UA.RisCatalogue.loadManifest(city);
        if (!active()) return null;
        const record = await UA.RisCatalogue.loadRecord(city, id, { snapshot: manifest });
        if (!active()) return null;
        if (!record) {
          state.status.textContent = 'Dieser Vorgang ist im aktuellen Datenbestand dieser Stadt nicht verfügbar. Der Link bleibt erhalten; Sie können es erneut versuchen.';
          button(state.body, 'Erneut versuchen', null, () => { state.token = null; refresh(ctx); });
          return null;
        }
        state.record = record;
        state.view = UA.RisRecordView.create({
          record, city, snapshot: record.snapshot || manifest, view: ctx.risView, isActive: active,
          onViewChange: patch => { if (active()) change(ctx, state, patch); },
          onOpenRecord: targetId => { if (active()) open(ctx, targetId); },
          onShowLocation: (ref, location, options) => showLocation(ctx, state, ref, location, options, active),
          onAdopt: async () => {
            if (!active()) return;
            return UA.PoliticalContext.addReferences(ctx, [record]);
          },
        });
        state.body.replaceChildren(state.view.element);
        state.status.textContent = '';
        project(ctx, state);
        return record;
      } catch (error) {
        if (active()) {
          state.status.textContent = error?.message || 'Der Vorgang konnte nicht geladen werden.';
          button(state.body, 'Erneut versuchen', null, () => { state.token = null; refresh(ctx); });
        }
        return null;
      } finally { if (active()) state.pending = null; }
    })();
    state.pending = pending;
    return pending;
  }

  async function open(ctx, id, { section, trigger } = {}) {
    const previous = normalized(ctx.risView);
    const next = normalized({ ...previous, ...(previous.recordId !== id ? {
      eventsPage: 0, relationsPage: 0, relatedPage: 0, locationsPage: 0, section: 'history',
    } : {}), recordId: id, collapsed: false, ...(section ? { section } : {}) });
    if (!next.recordId) return null;
    const state = ensure(ctx);
    const origin = trigger || document.activeElement;
    if (origin && !state.root.contains(origin)) state.returnFocus = origin;
    ctx.risView = next;
    ctx.map?.closePopup?.();
    sync(ctx);
    const result = refresh(ctx);
    state.heading.focus({ preventScroll: true });
    return result;
  }

  function setCollapsed(ctx, collapsed) {
    const state = panels.get(ctx);
    if (state) change(ctx, state, { collapsed });
  }

  UA.RisDetails = { open, refresh, close, setCollapsed };
})();
