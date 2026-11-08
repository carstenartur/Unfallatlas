(() => {
  const UA = (window.UA = window.UA || {});
  const sections = new Set(['history', 'relations', 'locations']);
  const enabled = value => value === true || value === 1 || value === '1';

  function pageNumber(value) {
    if (typeof value === 'string') {
      if (!/^\d+$/.test(value)) return 0;
      value = Number(value);
    }
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  }

  function normalize(value) {
    const source = value && typeof value === 'object' ? value : {};
    const id = typeof source.recordId === 'string' ? source.recordId.trim() : '';
    const recordId = id && id.length <= 2048 ? id : null;
    return {
      selectionOnly: enabled(source.selectionOnly),
      recordId,
      section: recordId && sections.has(source.section) ? source.section : 'history',
      collapsed: !!recordId && enabled(source.collapsed),
      // These are individual catalogue pages, never a count of pages to fetch.
      // The catalogue/renderer resolves an out-of-range page against its total.
      eventsPage: recordId ? pageNumber(source.eventsPage) : 0,
      relationsPage: recordId ? pageNumber(source.relationsPage) : 0,
      relatedPage: recordId ? pageNumber(source.relatedPage) : 0,
      locationsPage: recordId ? pageNumber(source.locationsPage) : 0,
    };
  }

  function fromSearch(search) {
    const query = search && typeof search.get === 'function'
      ? search : new URLSearchParams(typeof search === 'string' ? search.replace(/^\?/, '') : '');
    return normalize({
      selectionOnly: query.get('risSelectionOnly'),
      recordId: query.get('risRecord'),
      section: query.get('risView'),
      collapsed: query.get('risCollapsed'),
      eventsPage: query.get('risEventsPage'),
      relationsPage: query.get('risRelationsPage'),
      relatedPage: query.get('risRelatedPage'),
      locationsPage: query.get('risLocationsPage'),
    });
  }

  function toQuery(value) {
    const view = normalize(value);
    // Nulls deliberately remove stale URL values when a record is closed or
    // a section returns to its default. UA.setQS owns the actual URL write.
    return {
      risSelectionOnly: view.selectionOnly ? 1 : null,
      risRecord: view.recordId,
      risView: view.section === 'history' ? null : view.section,
      risCollapsed: view.collapsed ? 1 : null,
      risEventsPage: view.eventsPage || null,
      risRelationsPage: view.relationsPage || null,
      risRelatedPage: view.relatedPage || null,
      risLocationsPage: view.locationsPage || null,
    };
  }

  UA.RisViewState = { normalize, fromSearch, toQuery };
})();
