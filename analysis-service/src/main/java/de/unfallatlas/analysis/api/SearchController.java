package de.unfallatlas.analysis.api;

import de.unfallatlas.analysis.domain.CandidateMeasureAssessmentEntity;
import de.unfallatlas.analysis.domain.ConflictPatternAssessmentEntity;
import de.unfallatlas.analysis.domain.LocationActionBriefEntity;
import de.unfallatlas.analysis.domain.PoliticalReferenceSummaryEntity;
import de.unfallatlas.analysis.search.SearchService;
import de.unfallatlas.analysis.search.SearchService.BriefSearchRequest;
import de.unfallatlas.analysis.search.SearchService.PoliticalRefSearchRequest;
import de.unfallatlas.analysis.search.SearchService.SearchResultPage;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * REST-Schicht für die Hibernet-Search-basierte Suche.
 *
 * <p>Drei Suchfälle, alle bewusst einfach ohne eigene Suchsyntax:</p>
 * <ul>
 *   <li>{@code GET /api/search/briefs} – freie Begriffssuche und Filter
 *       über persistierte LocationActionBriefs.</li>
 *   <li>{@code GET /api/search/political-refs} – Suche über politische
 *       Referenzen (Verkehrsbezug, Typ, Topic, Begriff).</li>
 *   <li>{@code GET /api/search/similar/{briefId}} – ähnliche Fälle zu
 *       einem Referenz-Brief auf Basis seiner Konfliktmuster und
 *       Maßnahmen-Kategorien.</li>
 * </ul>
 *
 * <p>Antworten enthalten immer ein Envelope mit
 * {@code searchAvailable}, damit der Client sauber zwischen „Suche
 * gerade nicht verfügbar" (Hibernate Search nicht initialisiert) und
 * „kein Treffer" unterscheiden kann.  Im erstgenannten Fall liefern wir
 * weiterhin HTTP 200 mit {@code items: []} und
 * {@code searchAvailable: false}, statt 5xx zu werfen – das hält das UI
 * auf Linie mit der bestehenden Fail-Soft-Konvention der Prioritäten-API.</p>
 */
@RestController
@RequestMapping("/api/search")
public class SearchController {

    private static final Logger LOG = LoggerFactory.getLogger(SearchController.class);

    private final SearchService search;

    public SearchController(SearchService search) {
        this.search = search;
    }

    @GetMapping("/briefs")
    public ResponseEntity<Map<String, Object>> searchBriefs(
            @RequestParam(value = "q",               required = false) String q,
            @RequestParam(value = "city",            required = false) String city,
            @RequestParam(value = "profile",         required = false) String profile,
            @RequestParam(value = "conflictPattern", required = false) String conflictPattern,
            @RequestParam(value = "limit",           required = false) Integer limit) {

        BriefSearchRequest req = new BriefSearchRequest();
        req.q = q;
        req.city = city;
        req.profile = profile;
        req.conflictPattern = conflictPattern;
        req.limit = limit;

        boolean available = search.isAvailable();
        SearchResultPage<LocationActionBriefEntity> page = available
            ? search.searchBriefs(req)
            : SearchResultPage.empty();

        LOG.info("[search][briefs] q='{}' city='{}' profile='{}' conflictPattern='{}' available={} hits={}",
            safe(q), safe(city), safe(profile), safe(conflictPattern), available, page.totalHitCount);

        Map<String, Object> body = new LinkedHashMap<>();
        body.put("mode", "briefs");
        body.put("searchAvailable", available);
        body.put("totalHitCount", page.totalHitCount);
        body.put("count", page.hits.size());
        body.put("truncated", page.truncated);
        List<Map<String, Object>> items = new ArrayList<>(page.hits.size());
        for (LocationActionBriefEntity b : page.hits) items.add(toBriefHitView(b));
        body.put("items", items);
        return ResponseEntity.ok(body);
    }

    @GetMapping("/political-refs")
    public ResponseEntity<Map<String, Object>> searchPoliticalRefs(
            @RequestParam(value = "q",     required = false) String q,
            @RequestParam(value = "type",  required = false) String type,
            @RequestParam(value = "topic", required = false) String topic,
            @RequestParam(value = "limit", required = false) Integer limit) {

        PoliticalRefSearchRequest req = new PoliticalRefSearchRequest();
        req.q = q;
        req.type = type;
        req.topic = topic;
        req.limit = limit;

        boolean available = search.isAvailable();
        SearchResultPage<PoliticalReferenceSummaryEntity> page = available
            ? search.searchPoliticalRefs(req)
            : SearchResultPage.empty();

        LOG.info("[search][political-refs] q='{}' type='{}' topic='{}' available={} hits={}",
            safe(q), safe(type), safe(topic), available, page.totalHitCount);

        Map<String, Object> body = new LinkedHashMap<>();
        body.put("mode", "political-refs");
        body.put("searchAvailable", available);
        body.put("totalHitCount", page.totalHitCount);
        body.put("count", page.hits.size());
        body.put("truncated", page.truncated);
        List<Map<String, Object>> items = new ArrayList<>(page.hits.size());
        for (PoliticalReferenceSummaryEntity p : page.hits) items.add(toPoliticalRefHitView(p));
        body.put("items", items);
        return ResponseEntity.ok(body);
    }

    @GetMapping("/similar/{briefId}")
    public ResponseEntity<Map<String, Object>> findSimilar(
            @PathVariable("briefId") String briefId,
            @RequestParam(value = "limit", required = false) Integer limit) {

        boolean available = search.isAvailable();
        SearchResultPage<LocationActionBriefEntity> page = available
            ? search.findSimilarBriefs(briefId, limit == null ? 10 : limit)
            : SearchResultPage.empty();

        LOG.info("[search][similar] refBriefId='{}' available={} hits={}",
            safe(briefId), available, page.totalHitCount);

        Map<String, Object> body = new LinkedHashMap<>();
        body.put("mode", "similar");
        body.put("refBriefId", briefId);
        body.put("searchAvailable", available);
        body.put("totalHitCount", page.totalHitCount);
        body.put("count", page.hits.size());
        body.put("truncated", page.truncated);
        List<Map<String, Object>> items = new ArrayList<>(page.hits.size());
        for (LocationActionBriefEntity b : page.hits) items.add(toBriefHitView(b));
        body.put("items", items);
        return ResponseEntity.ok(body);
    }

    // ── View-Mapper ─────────────────────────────────────────────────────────

    private static Map<String, Object> toBriefHitView(LocationActionBriefEntity b) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id",            b.getId());
        m.put("locationKey",   b.getLocationKey());
        m.put("city",          b.getCity());
        m.put("title",         b.getTitle());
        m.put("profileKey",    b.getProfileKey());
        m.put("createdAt",     b.getCreatedAt() != null ? b.getCreatedAt().toString() : null);
        m.put("schemaVersion", b.getSchemaVersion());
        m.put("sourceFingerprint", b.getSourceFingerprint());

        // Kompakte Konfliktmuster-/Maßnahmen-Übersicht (max. 3 Items)
        List<Map<String, Object>> patterns = new ArrayList<>();
        int n = 0;
        for (ConflictPatternAssessmentEntity p : b.getConflictPatterns()) {
            if (n++ >= 3) break;
            Map<String, Object> pm = new LinkedHashMap<>();
            pm.put("patternId",      p.getPatternId());
            pm.put("aliasId",        p.getAliasId());
            pm.put("label",          p.getLabel());
            pm.put("classification", p.getClassification() == null ? null : p.getClassification().name());
            patterns.add(pm);
        }
        m.put("conflictPatterns", patterns);

        List<Map<String, Object>> measures = new ArrayList<>();
        n = 0;
        for (CandidateMeasureAssessmentEntity me : b.getCandidateMeasures()) {
            if (n++ >= 3) break;
            Map<String, Object> mm = new LinkedHashMap<>();
            mm.put("measureId", me.getMeasureId());
            mm.put("title",     me.getTitle());
            mm.put("category",  me.getCategory());
            measures.add(mm);
        }
        m.put("candidateMeasures", measures);

        return m;
    }

    private static Map<String, Object> toPoliticalRefHitView(PoliticalReferenceSummaryEntity p) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id",        p.getId());
        m.put("title",     p.getTitle());
        m.put("url",       p.getUrl());
        m.put("type",      p.getType());
        m.put("topic",     p.getTopic());
        m.put("relevance", p.getRelevance());
        if (p.getBrief() != null) {
            Map<String, Object> br = new LinkedHashMap<>();
            br.put("id",          p.getBrief().getId());
            br.put("locationKey", p.getBrief().getLocationKey());
            br.put("city",        p.getBrief().getCity());
            br.put("title",       p.getBrief().getTitle());
            m.put("brief", br);
        }
        return m;
    }

    private static String safe(String v) {
        return v == null ? "" : v;
    }
}
