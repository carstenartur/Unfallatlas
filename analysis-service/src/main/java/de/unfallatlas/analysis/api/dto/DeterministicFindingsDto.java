package de.unfallatlas.analysis.api.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.Max;

import java.util.List;
import java.util.Map;

@JsonInclude(JsonInclude.Include.NON_NULL)
public class DeterministicFindingsDto {

    @Valid public LocationScoresDto locationScores;
    @Valid public List<ProfileScoreDto> profileScores;
    @Valid public ProfileScoreDto activeProfileScore;
    public Map<String, Object> accidentProfile;
    public List<Map<String, Object>> dominantPatterns;
    public List<Map<String, Object>> conflictPatterns;
    public Map<String, Object> dataQuality;

    public static class LocationScoresDto {
        @Min(0) @Max(1) public double safetyImpactScore;
        @Min(0) @Max(1) public double severeAccidentReductionScore;
        @Min(0) @Max(1) public double bicycleSafetyScore;
        @Min(0) @Max(1) public double quickWinScore;
        @Min(0) @Max(1) public double implementationFeasibilityScore;
        @Min(0) @Max(1) public double policyReadinessScore;
        @Min(0) @Max(1) public double costEfficiencyScore;
        @Min(0) @Max(1) public double dataConfidenceScore;
    }

    public static class ProfileScoreDto {
        public String profile;
        @Min(0) @Max(1) public double total;
        public Map<String, Object> weights;
    }
}
