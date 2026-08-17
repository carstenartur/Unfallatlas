/**
 * UA.aiPoliticalEvidence — binds political-context research into AI handoffs.
 *
 * The political portal search used to be a separate, manual UI step. As a
 * result, an AI proposal could silently omit existing motions, decisions or
 * administrative replies even though the city had a supported provider. This
 * adapter starts the search for AI workflows, records its exact state and
 * carries suitable references into the same structured report that is handed
 * to the model.
 *
 * Important distinction:
 *   - no search performed / search failed / unsupported
 *   - search completed with no hits
 *   - search completed with references available
 *
 * None of the first two states is proof that no prior political proceedings
 * exist. A ready-to-file application remains blocked until the status is
 * explicit and the result has been reviewed.
 */
(() => {
  'use strict';

  const root = (typeof window !== 'undefined') ? window : globalThis;
  const UA = (root.UA = root.UA || {});
  const SCHEMA_VERSION = 'unfallwerkbank.politicalContextResearch.v1';
  const MAX_AUTO_REFERENCES = 10;
  const POLL_INTERVAL_MS = 25;
  const MAX_INSTALL_ATTEMPTS = 240;

  const OFFICIAL_PORTALS = Object.freeze({
    bonn: Object.freeze({
      providerKey: 'bonn-allris',
      portalUrl: 'https://www.bonn.sitzung-online.de/public/',
      searchUrl(term) {
        return `https://www.bonn.sitzung-online.de/public/tr010?q=${encodeURIComponent(term)}`;
      },
    }),
    hannover: Object.freeze({
      providerKey: 'hannover-sim',
      portalUrl: 'https://e-government.hannover-stadt.de/lhhsimwebre.nsf',
      searchUrl() {
        return 'https://e-government.hannover-stadt.de/lhhsimwebre.nsf/ds_suchformular';
      },
    }),
    berlin: Object.freeze({
      providerKey: 'berlin-allris',
      portalUrl: 'https://pardok.parlament-berlin.de/',
      searchUrl() {
        return 'https://pardok.parlament-berlin.de/';
      },
    }),
    hamburg: Object.freeze({
      providerKey: 'hamburg-parldok',
      portalUrl: 'https://www.buergerschaft-hh.de/parldok/formalkriterien',
      searchUrl() {
        return 'https://www.buergerschaft-hh.de/parldok/formalkriterien';
      },
    }),
  });

  function runtimeContext(fallback) {
    return fallback
      || (typeof UA.getRuntimeContext === 'function' ? UA.getRuntimeContext() : null)
      || {};
  }

  function cleanText(value) {
    return String(value == null ? '' : value).trim();
  }

  function cityKey(value) {
    if (typeof UA.normKey === 'function') return UA.normKey(value);
    return cleanText(value)
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
      .replace(/ß/g, 'ss')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
  }

  function currentGremium(ctx) {
    return cleanText(
      ctx?.ui?._lastExportResult?.structured?.meta?.gremium?.name
      || ctx?.gremium?.name
      || ctx?.gremium
    );
  }

  function currentLocationContext(ctx) {
    const hint = ctx?.locationHint || {};
    return {
      location: cleanText(hint.label || hint.displayName || hint.street || hint.district || hint.suburb),
      street: cleanText(hint.street),
      district: cleanText(hint.district || hint.suburb),
      gremium: currentGremium(ctx),
    };
  }

  function portalDescriptor(city, searchTerms) {
    const definition = OFFICIAL_PORTALS[cityKey(city)] || null;
    const terms = Array.isArray(searchTerms) ? searchTerms.map(cleanText).filter(Boolean) : [];
    if (!definition) {
      return {
        officialPortalUrl: null,
        portalSearchUrls: [],
        expectedProviderKey: null,
      };
    }
    return {
      officialPortalUrl: definition.portalUrl,
      portalSearchUrls: [...new Set(terms.map(term => definition.searchUrl(term)).filter(Boolean))],
      expectedProviderKey: definition.providerKey,
    };
  }

  function exportReference(ref) {
    return {
      title: cleanText(ref?.title),
      type: cleanText(ref?.type) || 'Sonstige',
      date: ref?.date || null,
      gremium: ref?.gremium || null,
      number: ref?.number || null,
      url: cleanText(ref?.url),
      referenceType: ref?.referenceType || null,
      reason: ref?.reason || ref?.trafficReason || ref?.aiGating?.reason || null,
      snippet: ref?.snippet || null,
      source: ref?.source || null,
      relevanceScore: Number.isFinite(Number(ref?.relevanceScore)) ? Number(ref.relevanceScore) : null,
      trafficCategory: ref?.trafficCategory || null,
      trafficRelevanceScore: Number.isFinite(Number(ref?.trafficRelevanceScore))
        ? Number(ref.trafficRelevanceScore)
        : null,
      isTrafficRelevant: ref?.isTrafficRelevant == null ? null : Boolean(ref.isTrafficRelevant),
      aiGating: ref?.aiGating || null,
    };
  }

  function isSuitableForAutomaticHandoff(ref) {
    if (!ref || !cleanText(ref.url) || !cleanText(ref.title)) return false;
    if (ref.aiGating && ref.aiGating.allowed === false) return false;
    if (ref.trafficCategory === 'non_traffic') return false;
    if (ref.isTrafficRelevant === false) return false;
    return true;
  }

  function stateForMissingSearch(ctx, status, message, details) {
    const city = cleanText(details?.city || ctx?.CITY_RAW || ctx?.city);
    const searchTerms = Array.isArray(details?.searchTerms)
      ? details.searchTerms.map(cleanText).filter(Boolean)
      : [];
    const portal = portalDescriptor(city, searchTerms);
    const state = {
      schemaVersion: SCHEMA_VERSION,
      status,
      city,
      providerSupported: null,
      providerKey: null,
      searchedAt: null,
      searchTerms,
      totalFound: null,
      usableReferenceCount: 0,
      references: [],
      selectedReferences: Array.isArray(ctx?.politicalReferences)
        ? ctx.politicalReferences.map(exportReference)
        : [],
      automaticallyAdopted: false,
      reviewRequired: true,
      readyToFileBlocked: true,
      ...portal,
      message,
      details: details || null,
      qaInstruction: 'Nicht als „keine politische Vorbefassung vorhanden“ formulieren. Der Suchstatus ist unvollständig; vor einem einreichungsreifen Antrag sind das offizielle Ratsinformationssystem und gegebenenfalls weitere amtliche Quellen nachvollziehbar nach Anträgen, Beschlüssen, Anfragen, Verwaltungsantworten und laufenden Planungen zu durchsuchen.',
    };
    ctx.politicalContextResearch = state;
    UA.lastPoliticalContextResearch = state;
    return state;
  }

  function stateFromResult(ctx, result, options) {
    const refs = Array.isArray(result?.references) ? result.references.map(exportReference) : [];
    const usable = refs.filter(isSuitableForAutomaticHandoff);
    const meta = result?.meta || {};
    const supported = meta.supported !== false;
    const status = !supported
      ? 'unsupported'
      : refs.length === 0
        ? 'searched-no-results'
        : usable.length === 0
          ? 'results-found-unusable'
          : 'results-found';
    const selected = Array.isArray(ctx?.politicalReferences)
      ? ctx.politicalReferences.map(exportReference)
      : [];
    const city = cleanText(meta.city || ctx?.CITY_RAW || ctx?.city);
    const searchTerms = Array.isArray(meta.searchTerms)
      ? meta.searchTerms.map(cleanText).filter(Boolean)
      : (options?.searchTerms || []);
    const portal = portalDescriptor(city, searchTerms);
    const state = {
      schemaVersion: SCHEMA_VERSION,
      status,
      city,
      providerSupported: supported,
      providerKey: meta.providerKey || portal.expectedProviderKey || null,
      searchedAt: meta.searchedAt || new Date().toISOString(),
      searchTerms,
      totalFound: Number.isFinite(Number(meta.totalFound)) ? Number(meta.totalFound) : refs.length,
      usableReferenceCount: usable.length,
      references: refs,
      selectedReferences: selected,
      automaticallyAdopted: Boolean(options?.automaticallyAdopted),
      reviewRequired: true,
      readyToFileBlocked: status !== 'results-found',
      ...portal,
      message: status === 'results-found'
        ? `${usable.length} fachlich vorgefilterte politische Vorgänge wurden für die KI- und QA-Auswertung gebunden; ihre tatsächliche Relevanz ist noch zu prüfen.`
        : status === 'results-found-unusable'
          ? `${refs.length} Portaltreffer wurden gefunden, aber keiner erfüllte den deterministischen Verkehrs- und KI-Gating-Vertrag.`
          : status === 'searched-no-results'
            ? 'Die konfigurierte Portalsuche lieferte keine Treffer. Das ist kein Beweis dafür, dass keine politische Vorbefassung existiert.'
            : 'Für die Stadt stand kein unterstützter Portalprovider zur Verfügung.',
      qaInstruction: status === 'results-found'
        ? 'Prüfe Titel, Datum, Gremium, Vorgangsnummer, Quelle, Ortsbezug und tatsächliche Relevanz jedes Treffers. Übernimm nur belegte Aussagen in den Antrag und stelle Widersprüche zu früheren Beschlüssen, laufenden Verkehrsversuchen oder bereits beauftragten Planungen ausdrücklich dar.'
        : 'Nicht als „keine politische Vorbefassung vorhanden“ formulieren. Vor einem einreichungsreifen Antrag ist eine zusätzliche manuelle beziehungsweise alternative Recherche erforderlich; nutze dazu insbesondere officialPortalUrl und portalSearchUrls.',
    };
    ctx.politicalContextResearch = state;
    UA.lastPoliticalContextResearch = state;
    return state;
  }

  async function ensurePoliticalResearch(ctxValue) {
    const ctx = runtimeContext(ctxValue);
    const political = UA.PoliticalContext;
    if (!political || typeof political.search !== 'function' || typeof political.buildSearchTerms !== 'function') {
      return stateForMissingSearch(
        ctx,
        'unavailable',
        'Die politische Recherchekomponente ist in dieser Laufzeit nicht verfügbar.',
        { city: cleanText(ctx.CITY_RAW || ctx.city), searchTerms: [] }
      );
    }

    const city = cleanText(ctx.CITY_RAW || ctx.city);
    const searchTerms = political.buildSearchTerms(ctx).map(cleanText).filter(Boolean);
    if (!city || !searchTerms.length) {
      return stateForMissingSearch(
        ctx,
        'not-searchable',
        'Für die politische Recherche fehlen Stadt oder belastbare Suchbegriffe.',
        { city, searchTerms }
      );
    }

    const locationContext = currentLocationContext(ctx);
    const searchKey = JSON.stringify({ city, searchTerms, locationContext });
    if (ctx.__uaPoliticalResearchKey === searchKey && ctx.__uaPoliticalResearchPromise) {
      return ctx.__uaPoliticalResearchPromise;
    }

    ctx.__uaPoliticalResearchKey = searchKey;
    ctx.__uaPoliticalResearchPromise = Promise.resolve()
      .then(() => political.search({
        city,
        searchTerms,
        context: locationContext,
        maxResults: 15,
      }))
      .then(result => {
        const refs = Array.isArray(result?.references) ? result.references : [];
        const suitable = refs.filter(isSuitableForAutomaticHandoff).slice(0, MAX_AUTO_REFERENCES);
        let automaticallyAdopted = false;
        if (suitable.length > 0 && (!Array.isArray(ctx.politicalReferences) || ctx.politicalReferences.length === 0)) {
          ctx.politicalReferences = suitable.map(exportReference);
          automaticallyAdopted = true;
        }
        return stateFromResult(ctx, result, { searchTerms, automaticallyAdopted });
      })
      .catch(error => stateForMissingSearch(
        ctx,
        'failed',
        'Die konfigurierte politische Portalsuche ist fehlgeschlagen.',
        { error: cleanText(error?.message || error), city, searchTerms }
      ));

    return ctx.__uaPoliticalResearchPromise;
  }

  function currentState(ctxValue) {
    const ctx = runtimeContext(ctxValue);
    if (ctx.politicalContextResearch) return ctx.politicalContextResearch;
    if (UA.lastPoliticalContextResearch) return UA.lastPoliticalContextResearch;
    return stateForMissingSearch(
      ctx,
      'not-searched',
      'Vor Erzeugung dieses Faktenpakets wurde keine politische Portalsuche dokumentiert.',
      { city: cleanText(ctx.CITY_RAW || ctx.city), searchTerms: [] }
    );
  }

  function wrapPoliticalSearch() {
    const political = UA.PoliticalContext;
    if (!political || typeof political.search !== 'function' || political.search._uaPoliticalEvidenceWrapped) {
      return;
    }
    const original = political.search;
    const wrapped = async function searchWithEvidence(params) {
      const ctx = runtimeContext();
      try {
        const result = await original.call(political, params);
        stateFromResult(ctx, result, {
          searchTerms: Array.isArray(params?.searchTerms) ? params.searchTerms : [],
          automaticallyAdopted: false,
        });
        return result;
      } catch (error) {
        stateForMissingSearch(ctx, 'failed', 'Die politische Portalsuche ist fehlgeschlagen.', {
          error: cleanText(error?.message || error),
          city: cleanText(params?.city),
          searchTerms: Array.isArray(params?.searchTerms) ? params.searchTerms : [],
        });
        throw error;
      }
    };
    wrapped._uaPoliticalEvidenceWrapped = true;
    wrapped._uaOriginal = original;
    political.search = wrapped;
  }

  function wrapAiFactsAndAwaitResearch() {
    const internal = UA.aiProposal?._internal;
    if (!internal) return false;

    if (typeof internal.mirrorExportOptions === 'function'
        && !internal.mirrorExportOptions._uaPoliticalEvidenceWrapped) {
      const originalMirror = internal.mirrorExportOptions;
      const wrappedMirror = function mirrorWithPoliticalResearch(ctxValue) {
        const result = originalMirror.call(internal, ctxValue);
        const ctx = runtimeContext(ctxValue);
        ctx.__uaPoliticalResearchPromise = ensurePoliticalResearch(ctx);
        return result;
      };
      wrappedMirror._uaPoliticalEvidenceWrapped = true;
      wrappedMirror._uaOriginal = originalMirror;
      internal.mirrorExportOptions = wrappedMirror;
    }

    if (typeof internal.buildExternalAiFactsPackage === 'function'
        && !internal.buildExternalAiFactsPackage._uaPoliticalEvidenceWrapped) {
      const originalFacts = internal.buildExternalAiFactsPackage;
      const wrappedFacts = function factsWithPoliticalEvidence(input) {
        const facts = originalFacts.call(internal, input);
        const state = currentState();
        return {
          ...facts,
          politicalContextResearch: state,
          politicalContextQaRule: {
            rule: 'Ein fehlender politischer Abschnitt darf nie stillschweigend als „keine Vorgänge vorhanden“ interpretiert werden.',
            blockingStatuses: [
              'not-searched',
              'not-searchable',
              'unavailable',
              'failed',
              'unsupported',
              'searched-no-results',
              'results-found-unusable',
            ],
            requiredAction: 'Öffne die angegebenen amtlichen Portal- und Such-URLs, dokumentiere Suchbegriffe und Abrufstatus, prüfe Treffer einzeln und stelle bestehende Anträge, Beschlüsse, Verwaltungsantworten, laufende Versuche und Planungen dem neuen Antrag gegenüber. Bleibt die Recherche unvollständig, darf nur ein Entwurf mit ausdrücklich offener politischer Vorbefassung entstehen.',
          },
        };
      };
      wrappedFacts._uaPoliticalEvidenceWrapped = true;
      wrappedFacts._uaOriginal = originalFacts;
      internal.buildExternalAiFactsPackage = wrappedFacts;
    }

    if (typeof UA.computeExportReport === 'function'
        && !UA.computeExportReport._uaPoliticalEvidenceWrapped) {
      const originalCompute = UA.computeExportReport;
      const wrappedCompute = async function computeAfterPoliticalResearch(ctxValue, ...args) {
        const ctx = runtimeContext(ctxValue);
        if (ctx.__uaPoliticalResearchPromise) {
          await Promise.resolve(ctx.__uaPoliticalResearchPromise);
        }
        const report = await originalCompute.call(this, ctxValue, ...args);
        try {
          if (report?.structured && typeof report.structured === 'object') {
            report.structured.politicalContextResearch = currentState(ctx);
          }
        } catch (_) { /* structured report may be immutable in a test double */ }
        return report;
      };
      wrappedCompute._uaPoliticalEvidenceWrapped = true;
      wrappedCompute._uaOriginal = originalCompute;
      UA.computeExportReport = wrappedCompute;
    }

    return true;
  }

  function install() {
    wrapPoliticalSearch();
    return wrapAiFactsAndAwaitResearch();
  }

  UA.aiPoliticalEvidence = Object.freeze({
    SCHEMA_VERSION,
    OFFICIAL_PORTALS,
    install,
    ensurePoliticalResearch,
    currentState,
    _internal: Object.freeze({
      cleanText,
      cityKey,
      currentGremium,
      currentLocationContext,
      portalDescriptor,
      exportReference,
      isSuitableForAutomaticHandoff,
      stateForMissingSearch,
      stateFromResult,
      runtimeContext,
    }),
  });

  let attempts = 0;
  const installWhenReady = () => {
    if (install()) return;
    if (attempts++ < MAX_INSTALL_ATTEMPTS && typeof root.setTimeout === 'function') {
      root.setTimeout(installWhenReady, POLL_INTERVAL_MS);
    }
  };
  installWhenReady();
})();
