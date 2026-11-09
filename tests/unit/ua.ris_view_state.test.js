'use strict';

const fs = require('fs');
const path = require('path');

function loadState() {
  const win = { UA: {} };
  const file = path.resolve(__dirname, '../../js/ua.ris_view_state.js');
  if (fs.existsSync(file)) {
    (function (window) { eval(fs.readFileSync(file, 'utf8')); })(win);
  }
  return win.UA.RisViewState;
}

const listDefaults = { listOpen: false, listCollapsed: false, query: '', sourceLevels: [], searchCursor: null, searchGeneration: null };
const queryDefaults = { risList: null, risListCollapsed: null, risQuery: null, risLevels: null, risSearchPage: null, risSearchSnapshot: null };
const defaults = {
  ...listDefaults,
  selectionOnly: false, recordId: null, section: 'history', collapsed: false,
  eventsPage: 0, relationsPage: 0, relatedPage: 0, locationsPage: 0,
};

describe('RIS view state boundary', () => {
  test('normalizes a worked document view without retaining runtime data', () => {
    const state = loadState();
    const input = {
      selectionOnly: true, recordId: 'region-hannover-ris:2026/123', section: 'relations', collapsed: true,
      eventsPage: 3, relationsPage: 2, relatedPage: 5, locationsPage: 1,
      loadedRecords: ['runtime-only'],
    };
    const normalized = state?.normalize(input);
    expect(normalized).toEqual({
      ...listDefaults,
      selectionOnly: true, recordId: 'region-hannover-ris:2026/123', section: 'relations', collapsed: true,
      eventsPage: 3, relationsPage: 2, relatedPage: 5, locationsPage: 1,
    });
    expect(normalized).not.toBe(input);
  });

  test('decodes every shared option and an encoded stable record ID', () => {
    const state = loadState();
    expect(state?.fromSearch('?risSelectionOnly=1&risRecord=region%3A2026%2F123%2BAnfrage%20A&risView=locations&risCollapsed=1&risEventsPage=3&risRelationsPage=2&risRelatedPage=5&risLocationsPage=1')).toEqual({
      ...listDefaults,
      selectionOnly: true, recordId: 'region:2026/123+Anfrage A', section: 'locations', collapsed: true,
      eventsPage: 3, relationsPage: 2, relatedPage: 5, locationsPage: 1,
    });
  });

  test('serializes document state with explicit removal values for defaults', () => {
    const state = loadState();
    expect(state?.toQuery({ recordId: 'hannover-sim:123', selectionOnly: true, relatedPage: 7 })).toEqual({
      ...queryDefaults,
      risSelectionOnly: 1, risRecord: 'hannover-sim:123', risView: null, risCollapsed: null,
      risEventsPage: null, risRelationsPage: null, risRelatedPage: 7, risLocationsPage: null,
    });
  });

  test('closing a record clears its section, collapse state and pages but retains the area filter', () => {
    const state = loadState();
    expect(state?.normalize({
      selectionOnly: true, recordId: null, section: 'relations', collapsed: true,
      eventsPage: 1, relationsPage: 2, relatedPage: 3, locationsPage: 4,
    })).toEqual({ ...defaults, selectionOnly: true });
    expect(state?.toQuery({ selectionOnly: true })).toEqual({
      ...queryDefaults,
      risSelectionOnly: 1, risRecord: null, risView: null, risCollapsed: null,
      risEventsPage: null, risRelationsPage: null, risRelatedPage: null, risLocationsPage: null,
    });
  });

  test.each([undefined, null, '', '   ', 12, {}, 'a'.repeat(2049)])('invalid record identity %p clears detail state', recordId => {
    const state = loadState();
    expect(state?.normalize({ recordId, section: 'locations', collapsed: true, eventsPage: 9 })).toEqual(defaults);
  });

  test('accepts a full-length stable ID and safe page values without applying a catalogue-specific cap', () => {
    const state = loadState();
    expect(state?.normalize({ recordId: 'a'.repeat(2048), eventsPage: Number.MAX_SAFE_INTEGER })).toEqual({
      ...defaults, recordId: 'a'.repeat(2048), eventsPage: Number.MAX_SAFE_INTEGER,
    });
  });

  test.each(['-1', '1.5', '2oops', 'Infinity', 'NaN', '9007199254740992', ''])('invalid URL page %p resets to the first page', page => {
    const state = loadState();
    const query = new URLSearchParams({ risRecord: 'A', risEventsPage: page, risRelationsPage: page, risRelatedPage: page, risLocationsPage: page });
    expect(state?.fromSearch(query)).toEqual({ ...defaults, recordId: 'A' });
  });

  test('unknown sections and disabled booleans use defaults without modifying the supplied search', () => {
    const state = loadState();
    const query = new URLSearchParams('risRecord=A&risView=unknown&risSelectionOnly=0&risCollapsed=false');
    expect(state?.fromSearch(query)).toEqual({ ...defaults, recordId: 'A' });
    expect(query.toString()).toBe('risRecord=A&risView=unknown&risSelectionOnly=0&risCollapsed=false');
  });
});
