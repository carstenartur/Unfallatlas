package de.unfallatlas.analysis.api.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import jakarta.validation.constraints.*;

import java.util.List;

@JsonInclude(JsonInclude.Include.NON_NULL)
public class MeasureDto {
    @NotBlank @Size(max = 80)  public String id;
    @NotBlank @Size(max = 200) public String title;
    @Size(max = 60) public String category;
    @Size(max = 60) public String sourceCategory;
    @Min(0) @Max(1) public double fitScore;
    @Min(0) @Max(1) public double quickWinPotential;
    @Size(max = 12) public String implementationEffort;
    @Size(max = 12) public String costBand;
    @Size(max = 1000) public String whyPreselected;
    public List<String> matchedConflictPatterns;
    public List<String> matchedRiskFactors;
    public List<String> expectedTargetAccidentTypes;
}
