package de.unfallatlas.analysis.mapping;

import de.unfallatlas.analysis.api.dto.*;
import de.unfallatlas.analysis.domain.*;
import de.unfallatlas.analysis.fingerprint.SourceFingerprintCalculator;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Mapper zwischen dem {@link LocationBriefIngestDto} (JSON-Vertrag der
 * Node-Anwendung) und der persistierbaren {@link LocationActionBriefEntity}.
 *
 * <p>Bewusst handgeschrieben (kein MapStruct), damit der PR keine zusätz-
 * lichen Code-Generatoren braucht und das Mapping leicht zu verstehen ist.</p>
 */
@Component
public class LocationBriefMapper {

    private static final String DEFAULT_RULES_VERSION    = "conflictPatterns.v1";
    private static final String DEFAULT_SCORING_VERSION  = "scoring.v1";
    private static final String DEFAULT_PROFILE_VERSION  = "profiles.v1";

    private final SourceFingerprintCalculator fingerprintCalculator;

    public LocationBriefMapper(SourceFingerprintCalculator fingerprintCalculator) {
        this.fingerprintCalculator = fingerprintCalculator;
    }

    /**
     * Wandelt ein eingehendes Ingest-DTO in eine vollständig befüllte
     * Aggregat-Entität um (inkl. Sub-Entitäten und Versioning-Block).
     *
     * <p>Ergebnis hat noch keine ID – diese wird beim Persistieren
     * generiert.</p>
     */
    public LocationActionBriefEntity toEntity(LocationBriefIngestDto in) {
        if (in == null) {
            throw new IllegalArgumentException("Ingest-DTO darf nicht null sein.");
        }
        LocationActionBriefEntity e = new LocationActionBriefEntity();

        IngestMetaDto meta = in.meta != null ? in.meta : new IngestMetaDto();
        String city = orEmpty(meta.city);
        e.setCity(city);
        e.setLocationKey(resolveLocationKey(in, meta, city));
        e.setExternalLocationId(in.externalLocationId);
        e.setTitle(orEmpty(in.title));
        e.setSchemaVersion(orDefault(in.schemaVersion, "locationActionBrief.v1"));
        e.setProfileKey(orDefault(meta.profile, "low_hanging_fruit"));
        e.setDeterministicSummary(in.problemSummary);
        e.setAiUsed(meta.generatedWithAi);

        // Confidence: bevorzugt das numerische Confidence-Feld.
        if (in.confidence != null) {
            e.setConfidence(clamp(in.confidence.numeric));
        } else if (in.deterministicFindings != null && in.deterministicFindings.locationScores != null) {
            e.setConfidence(clamp(in.deterministicFindings.locationScores.dataConfidenceScore));
        } else {
            e.setConfidence(0.0);
        }

        e.setDataQuality(deriveDataQuality(in));
        e.setPoliticalReadiness(derivePoliticalReadiness(in));

        // Versioning
        VersioningInfo v = new VersioningInfo();
        v.setRulesVersion(orDefault(meta.rulesVersion,     DEFAULT_RULES_VERSION));
        v.setScoringVersion(orDefault(meta.scoringVersion, DEFAULT_SCORING_VERSION));
        v.setProfileVersion(orDefault(meta.profileVersion, DEFAULT_PROFILE_VERSION));
        v.setGeneratedAt(Instant.now());
        e.setVersioning(v);

        // AI-Metadaten – nur wenn aiUsed
        if (meta.generatedWithAi && in.aiPolish != null) {
            e.setAiMetadata(new AiAssessmentMetadata(
                in.aiPolish.aiModel,
                in.aiPolish.aiPromptVersion,
                in.aiPolish.aiInputFingerprint,
                in.aiPolish.aiSource
            ));
        }

        // Source-Fingerprint: vom Aufrufer übernehmen oder berechnen
        String fp = orBlankToNull(meta.sourceFingerprint);
        if (fp == null) {
            // Fingerprint NICHT über das gesamte Ingest-DTO bilden, sondern
            // nur über die deterministisch reproduzierbaren Eingaben:
            // ohne Versioning-Zeitstempel, ohne KI-Metadaten.
            Map<String, Object> fpInput = Map.ofEntries(
                Map.entry("schemaVersion", e.getSchemaVersion()),
                Map.entry("locationKey",   e.getLocationKey()),
                Map.entry("profileKey",    e.getProfileKey()),
                Map.entry("city",          e.getCity()),
                Map.entry("title",         e.getTitle()),
                Map.entry("problemSummary",  orEmpty(in.problemSummary)),
                Map.entry("accidentProfile", in.accidentProfile != null ? in.accidentProfile : Map.of()),
                Map.entry("conflictPatterns", in.conflictPatterns != null ? in.conflictPatterns : List.of()),
                Map.entry("candidateMeasures", in.candidateMeasures != null ? in.candidateMeasures : List.of()),
                Map.entry("rulesVersion",   v.getRulesVersion()),
                Map.entry("scoringVersion", v.getScoringVersion()),
                Map.entry("profileVersion", v.getProfileVersion())
            );
            fp = fingerprintCalculator.fingerprintOf(fpInput);
        }
        e.setSourceFingerprint(fp);

        // Konfliktmuster
        if (in.conflictPatterns != null) {
            for (ConflictPatternDto p : in.conflictPatterns) {
                if (p == null) continue;
                ConflictPatternAssessmentEntity pe = new ConflictPatternAssessmentEntity();
                pe.setPatternId(orEmpty(p.id));
                pe.setAliasId(p.aliasId);
                pe.setLabel(orEmpty(p.label));
                pe.setClassification(parseClassification(p.classification));
                pe.setConfidence(parseQualityBand(p.confidence, QualityBand.MEDIUM));
                pe.setRationale(p.rationale);
                pe.setEvidenceJoined(joinList(p.evidence));
                pe.setRequiresOnSiteCheckJoined(joinList(p.requiresOnSiteCheck));
                e.addConflictPattern(pe);
            }
        }

        // Vorselektierte / bewertete Maßnahmen
        if (in.candidateMeasures != null) {
            int pos = 0;
            for (MeasureDto m : in.candidateMeasures) {
                if (m == null) continue;
                CandidateMeasureAssessmentEntity me = new CandidateMeasureAssessmentEntity();
                me.setMeasureId(orEmpty(m.id));
                me.setTitle(orEmpty(m.title));
                me.setCategory(m.category);
                me.setSourceCategory(m.sourceCategory);
                me.setFitScore(clamp(m.fitScore));
                me.setQuickWinPotential(clamp(m.quickWinPotential));
                me.setImplementationEffort(m.implementationEffort);
                me.setCostBand(m.costBand);
                me.setWhyPreselected(m.whyPreselected);
                me.setMatchedConflictPatternsJoined(joinList(m.matchedConflictPatterns));
                me.setMatchedRiskFactorsJoined(joinList(m.matchedRiskFactors));
                me.setExpectedTargetAccidentTypesJoined(joinList(m.expectedTargetAccidentTypes));
                me.setPosition(pos++);
                e.addCandidateMeasure(me);
            }
        }

        // Profil-Scores
        if (in.deterministicFindings != null
                && in.deterministicFindings.profileScores != null
                && in.deterministicFindings.locationScores != null) {
            DeterministicFindingsDto.LocationScoresDto ls = in.deterministicFindings.locationScores;
            for (DeterministicFindingsDto.ProfileScoreDto ps : in.deterministicFindings.profileScores) {
                if (ps == null || ps.profile == null) continue;
                PrioritizationProfileScoreEntity se = new PrioritizationProfileScoreEntity();
                se.setProfileKey(ps.profile);
                se.setTotal(clamp(ps.total));
                se.setSafetyImpactScore(clamp(ls.safetyImpactScore));
                se.setSevereAccidentReductionScore(clamp(ls.severeAccidentReductionScore));
                se.setBicycleSafetyScore(clamp(ls.bicycleSafetyScore));
                se.setQuickWinScore(clamp(ls.quickWinScore));
                se.setImplementationFeasibilityScore(clamp(ls.implementationFeasibilityScore));
                se.setPolicyReadinessScore(clamp(ls.policyReadinessScore));
                se.setCostEfficiencyScore(clamp(ls.costEfficiencyScore));
                se.setDataConfidenceScore(clamp(ls.dataConfidenceScore));
                e.addProfileScore(se);
            }
        }

        // Politische Referenzen
        if (in.politicalContext != null && in.politicalContext.relatedReferences != null) {
            for (PoliticalContextDto.RelatedReferenceDto r : in.politicalContext.relatedReferences) {
                if (r == null) continue;
                PoliticalReferenceSummaryEntity re = new PoliticalReferenceSummaryEntity();
                re.setTitle(orEmpty(r.title));
                re.setUrl(r.url);
                re.setType(r.type);
                re.setRelevance(clamp(r.relevance));
                e.addPoliticalReference(re);
            }
            // Topic via recurringRequests anreichern, falls vorhanden
            if (in.politicalContext.recurringRequests != null
                    && !in.politicalContext.recurringRequests.isEmpty()) {
                String firstTopic = in.politicalContext.recurringRequests.get(0).topic;
                if (firstTopic != null) {
                    e.getPoliticalReferences().forEach(ref -> {
                        if (ref.getTopic() == null) ref.setTopic(firstTopic);
                    });
                }
            }
        }

        return e;
    }

    // ── Helpers ─────────────────────────────────────────────────────────────

    private String resolveLocationKey(LocationBriefIngestDto in, IngestMetaDto meta, String city) {
        if (in.locationId != null && !in.locationId.isBlank()) {
            return in.locationId.trim();
        }
        String area = orEmpty(meta.areaName).trim().toLowerCase(Locale.ROOT);
        String slug = area.isBlank() ? "unknown" : area.replaceAll("[^a-z0-9]+", "_").replaceAll("(^_+|_+$)", "");
        if (slug.isBlank()) slug = "unknown";
        String cityKey = orEmpty(city).trim().toLowerCase(Locale.ROOT)
            .replaceAll("[^a-z0-9]+", "_").replaceAll("(^_+|_+$)", "");
        if (cityKey.isBlank()) cityKey = "unknown";
        return cityKey + "::" + slug;
    }

    private QualityBand deriveDataQuality(LocationBriefIngestDto in) {
        if (in.deterministicFindings != null
                && in.deterministicFindings.locationScores != null) {
            double v = in.deterministicFindings.locationScores.dataConfidenceScore;
            if (v >= 0.66) return QualityBand.HIGH;
            if (v >= 0.33) return QualityBand.MEDIUM;
            return QualityBand.LOW;
        }
        return QualityBand.LOW;
    }

    private QualityBand derivePoliticalReadiness(LocationBriefIngestDto in) {
        if (in.politicalContext == null) return QualityBand.LOW;
        QualityBand q = QualityBand.fromIgnoreCase(in.politicalContext.policyReadiness);
        return q != null ? q : QualityBand.LOW;
    }

    private ConflictPatternAssessmentEntity.Classification parseClassification(String s) {
        if (s == null) return ConflictPatternAssessmentEntity.Classification.SECONDARY;
        return "primary".equalsIgnoreCase(s.trim())
            ? ConflictPatternAssessmentEntity.Classification.PRIMARY
            : ConflictPatternAssessmentEntity.Classification.SECONDARY;
    }

    private QualityBand parseQualityBand(String s, QualityBand fallback) {
        QualityBand q = QualityBand.fromIgnoreCase(s);
        return q != null ? q : fallback;
    }

    private static String orEmpty(String s) { return s == null ? "" : s; }
    private static String orDefault(String s, String d) { return (s == null || s.isBlank()) ? d : s; }
    private static String orBlankToNull(String s) { return (s == null || s.isBlank()) ? null : s; }
    private static double clamp(double v) {
        if (Double.isNaN(v)) return 0.0;
        if (v < 0) return 0.0;
        if (v > 1) return 1.0;
        return v;
    }
    private static String joinList(List<String> list) {
        if (list == null || list.isEmpty()) return null;
        // Strip pipes from values to keep the joined column unambiguous.
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < list.size(); i++) {
            String v = list.get(i);
            if (v == null) continue;
            if (sb.length() > 0) sb.append('|');
            sb.append(v.replace('|', '/'));
        }
        return sb.length() == 0 ? null : sb.toString();
    }
}
