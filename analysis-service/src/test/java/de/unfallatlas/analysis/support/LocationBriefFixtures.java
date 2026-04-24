package de.unfallatlas.analysis.support;

import de.unfallatlas.analysis.api.dto.*;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Wiederverwendbarer Builder für ein realistisches
 * {@link LocationBriefIngestDto}.  Hält die Tests lesbar und stellt
 * sicher, dass bei strukturellen Änderungen am DTO nur eine Stelle
 * angepasst werden muss.
 */
public final class LocationBriefFixtures {

    private LocationBriefFixtures() {}

    public static LocationBriefIngestDto bicycleTurningConflictBrief() {
        LocationBriefIngestDto dto = new LocationBriefIngestDto();
        dto.schemaVersion = "locationActionBrief.v1";
        dto.title = "Knoten Beispielstraße / Musterweg";
        dto.problemSummary = "Häufung Rad-Unfälle, davon mehrere Abbiegekonflikte.";

        ConflictPatternDto p1 = new ConflictPatternDto();
        p1.id = "kfz_rad_abbiegekonflikt";
        p1.aliasId = "bicycle_turning_conflict";
        p1.label = "Kfz/Rad – Abbiegekonflikt";
        p1.classification = "primary";
        p1.confidence = "high";
        p1.rationale = "≥3 Rad/Kfz-Unfälle mit Abbiege-Beteiligung.";
        p1.evidence = List.of("8 Unfälle Rad/Kfz (3J)", "5 mit Abbiegen");
        p1.requiresOnSiteCheck = List.of("Sichtbeziehungen");

        ConflictPatternDto p2 = new ConflictPatternDto();
        p2.id = "rad_alleinunfall_oberflaeche";
        p2.aliasId = "bicycle_single_accident_surface";
        p2.label = "Rad-Alleinunfall (Oberfläche)";
        p2.classification = "secondary";
        p2.confidence = "medium";
        p2.rationale = "2 Rad-Alleinunfälle ohne andere Beteiligte.";

        dto.conflictPatterns = List.of(p1, p2);

        MeasureDto m1 = new MeasureDto();
        m1.id = "aufgeweitete_radaufstellung";
        m1.title = "Aufgeweitete Radaufstellung";
        m1.category = "marking";
        m1.fitScore = 0.82;
        m1.quickWinPotential = 0.75;
        m1.implementationEffort = "low";
        m1.costBand = "low";
        m1.whyPreselected = "Passt zu Abbiegekonflikt; günstige Markierungsmaßnahme.";
        m1.matchedConflictPatterns = List.of("bicycle_turning_conflict");
        m1.expectedTargetAccidentTypes = List.of("Abbiegen");

        MeasureDto m2 = new MeasureDto();
        m2.id = "gruener_pfeil_rad";
        m2.title = "Grüner Pfeil für Rad";
        m2.category = "signaling";
        m2.fitScore = 0.55;
        m2.quickWinPotential = 0.4;
        m2.implementationEffort = "low";
        m2.costBand = "low";
        m2.whyPreselected = "Niedrigschwellige Ergänzung.";

        dto.candidateMeasures = List.of(m1, m2);

        DeterministicFindingsDto df = new DeterministicFindingsDto();
        DeterministicFindingsDto.LocationScoresDto ls = new DeterministicFindingsDto.LocationScoresDto();
        ls.safetyImpactScore              = 0.7;
        ls.severeAccidentReductionScore   = 0.5;
        ls.bicycleSafetyScore             = 0.85;
        ls.quickWinScore                  = 0.65;
        ls.implementationFeasibilityScore = 0.7;
        ls.policyReadinessScore           = 0.4;
        ls.costEfficiencyScore            = 0.7;
        ls.dataConfidenceScore            = 0.6;
        df.locationScores = ls;

        df.profileScores = new ArrayList<>();
        for (String profile : List.of(
                "low_hanging_fruit", "bicycle_safety_priority",
                "severe_accident_priority", "policy_ready", "cost_effective")) {
            DeterministicFindingsDto.ProfileScoreDto ps = new DeterministicFindingsDto.ProfileScoreDto();
            ps.profile = profile;
            ps.total = "bicycle_safety_priority".equals(profile) ? 0.78 : 0.6;
            df.profileScores.add(ps);
        }
        DeterministicFindingsDto.ProfileScoreDto active = new DeterministicFindingsDto.ProfileScoreDto();
        active.profile = "bicycle_safety_priority";
        active.total = 0.78;
        df.activeProfileScore = active;
        dto.deterministicFindings = df;

        ConfidenceDto cf = new ConfidenceDto();
        cf.overall = "medium";
        cf.numeric = 0.6;
        cf.rationale = "Solide Datenbasis, Detailprüfung empfohlen.";
        dto.confidence = cf;

        PoliticalContextDto pc = new PoliticalContextDto();
        pc.previousPoliticalAttention = "frequent";
        pc.policyReadiness = "high";
        PoliticalContextDto.RelatedReferenceDto r = new PoliticalContextDto.RelatedReferenceDto();
        r.title = "Antrag zum Knotenpunkt Beispielstraße";
        r.url = "https://example.org/sim/123";
        r.type = "Antrag";
        r.relevance = 0.9;
        pc.relatedReferences = List.of(r);
        PoliticalContextDto.RecurringRequestDto rr = new PoliticalContextDto.RecurringRequestDto();
        rr.topic = "radverkehr";
        rr.count = 4;
        pc.recurringRequests = List.of(rr);
        pc.administrativeMomentumHints = List.of(
            "Es liegen 4 Vorgänge aus dem letzten Jahr vor – das Thema ist politisch aktiv.");
        dto.politicalContext = pc;

        dto.accidentProfile = Map.of(
            "totalAccidents", 27,
            "bicycleAccidents", 14,
            "severeAccidents", 2);

        IngestMetaDto meta = new IngestMetaDto();
        meta.schemaVersion = "locationBriefIngest.v1";
        meta.profile = "bicycle_safety_priority";
        meta.availableProfiles = List.of(
            "low_hanging_fruit", "bicycle_safety_priority",
            "severe_accident_priority", "policy_ready", "cost_effective");
        meta.requiredConflictPatternIds = List.of(
            "bicycle_turning_conflict", "bicycle_single_accident_surface");
        meta.generatedWithAi = false;
        meta.city = "Hannover";
        meta.areaName = "Beispielstraße / Musterweg";
        dto.meta = meta;

        return dto;
    }

    public static LocationBriefIngestDto withAiPolish() {
        LocationBriefIngestDto dto = bicycleTurningConflictBrief();
        dto.meta.generatedWithAi = true;
        AiPolishDto ai = new AiPolishDto();
        ai.aiModel = "gemini-2.0-flash";
        ai.aiPromptVersion = "exportAssessmentPrompt.v1";
        ai.aiInputFingerprint = "deadbeefcafefeed";
        ai.aiSource = "ai";
        dto.aiPolish = ai;
        return dto;
    }
}
