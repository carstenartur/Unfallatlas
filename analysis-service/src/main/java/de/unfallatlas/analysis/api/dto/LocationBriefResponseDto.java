package de.unfallatlas.analysis.api.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import de.unfallatlas.analysis.domain.LocationActionBriefEntity;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

/**
 * Antwort-DTO für gespeicherte Briefs.  Bewusst flach gehalten – ergänzt
 * die Stammdaten um die wichtigsten Aggregationsergebnisse.  Konsumenten
 * können bei Bedarf zusätzliche Endpunkte für Details aufrufen.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public class LocationBriefResponseDto {
    public String id;
    public String locationKey;
    public String externalLocationId;
    public String city;
    public String title;
    public Instant createdAt;
    public Instant updatedAt;
    public String schemaVersion;
    public String sourceFingerprint;
    public String profileKey;
    public String deterministicSummary;
    public double confidence;
    public String dataQuality;
    public String politicalReadiness;
    public boolean aiUsed;

    public Map<String, String> versioning;
    public Map<String, String> aiMetadata;

    public List<Map<String, Object>> conflictPatterns;
    public List<Map<String, Object>> candidateMeasures;
    public List<Map<String, Object>> profileScores;
    public List<Map<String, Object>> politicalReferences;

    public static LocationBriefResponseDto fromEntity(LocationActionBriefEntity e) {
        LocationBriefResponseDto d = new LocationBriefResponseDto();
        d.id = e.getId();
        d.locationKey = e.getLocationKey();
        d.externalLocationId = e.getExternalLocationId();
        d.city = e.getCity();
        d.title = e.getTitle();
        d.createdAt = e.getCreatedAt();
        d.updatedAt = e.getUpdatedAt();
        d.schemaVersion = e.getSchemaVersion();
        d.sourceFingerprint = e.getSourceFingerprint();
        d.profileKey = e.getProfileKey();
        d.deterministicSummary = e.getDeterministicSummary();
        d.confidence = e.getConfidence();
        d.dataQuality = e.getDataQuality() != null ? e.getDataQuality().toLower() : null;
        d.politicalReadiness = e.getPoliticalReadiness() != null ? e.getPoliticalReadiness().toLower() : null;
        d.aiUsed = e.isAiUsed();

        if (e.getVersioning() != null) {
            d.versioning = Map.of(
                "rulesVersion",   nullToEmpty(e.getVersioning().getRulesVersion()),
                "scoringVersion", nullToEmpty(e.getVersioning().getScoringVersion()),
                "profileVersion", nullToEmpty(e.getVersioning().getProfileVersion()),
                "generatedAt",    e.getVersioning().getGeneratedAt() != null
                                    ? e.getVersioning().getGeneratedAt().toString()
                                    : ""
            );
        }
        if (e.isAiUsed() && e.getAiMetadata() != null) {
            d.aiMetadata = Map.of(
                "aiModel",            nullToEmpty(e.getAiMetadata().getAiModel()),
                "aiPromptVersion",    nullToEmpty(e.getAiMetadata().getAiPromptVersion()),
                "aiInputFingerprint", nullToEmpty(e.getAiMetadata().getAiInputFingerprint()),
                "aiSource",           nullToEmpty(e.getAiMetadata().getAiSource())
            );
        }

        d.conflictPatterns = e.getConflictPatterns().stream().map(p -> Map.<String, Object>of(
            "patternId",      nullToEmpty(p.getPatternId()),
            "aliasId",        nullToEmpty(p.getAliasId()),
            "label",          nullToEmpty(p.getLabel()),
            "classification", p.getClassification() != null ? p.getClassification().name() : "",
            "confidence",     p.getConfidence() != null ? p.getConfidence().toLower() : "",
            "rationale",      nullToEmpty(p.getRationale())
        )).collect(Collectors.toList());

        d.candidateMeasures = e.getCandidateMeasures().stream()
            .sorted((a, b) -> Integer.compare(a.getPosition(), b.getPosition()))
            .map(m -> Map.<String, Object>of(
                "measureId",            nullToEmpty(m.getMeasureId()),
                "title",                nullToEmpty(m.getTitle()),
                "category",             nullToEmpty(m.getCategory()),
                "fitScore",             m.getFitScore(),
                "quickWinPotential",    m.getQuickWinPotential(),
                "implementationEffort", nullToEmpty(m.getImplementationEffort()),
                "costBand",             nullToEmpty(m.getCostBand()),
                "whyPreselected",       nullToEmpty(m.getWhyPreselected()),
                "position",             m.getPosition()
            )).collect(Collectors.toList());

        d.profileScores = e.getProfileScores().stream().map(s -> Map.<String, Object>of(
            "profileKey", nullToEmpty(s.getProfileKey()),
            "total",      s.getTotal(),
            "subScores", Map.ofEntries(
                Map.entry("safetyImpactScore",              s.getSafetyImpactScore()),
                Map.entry("severeAccidentReductionScore",   s.getSevereAccidentReductionScore()),
                Map.entry("bicycleSafetyScore",             s.getBicycleSafetyScore()),
                Map.entry("quickWinScore",                  s.getQuickWinScore()),
                Map.entry("implementationFeasibilityScore", s.getImplementationFeasibilityScore()),
                Map.entry("policyReadinessScore",           s.getPolicyReadinessScore()),
                Map.entry("costEfficiencyScore",            s.getCostEfficiencyScore()),
                Map.entry("dataConfidenceScore",            s.getDataConfidenceScore())
            )
        )).collect(Collectors.toList());

        d.politicalReferences = e.getPoliticalReferences().stream().map(r -> Map.<String, Object>of(
            "title",     nullToEmpty(r.getTitle()),
            "url",       nullToEmpty(r.getUrl()),
            "type",      nullToEmpty(r.getType()),
            "topic",     nullToEmpty(r.getTopic()),
            "relevance", r.getRelevance()
        )).collect(Collectors.toList());

        return d;
    }

    private static String nullToEmpty(String s) { return s == null ? "" : s; }
}
