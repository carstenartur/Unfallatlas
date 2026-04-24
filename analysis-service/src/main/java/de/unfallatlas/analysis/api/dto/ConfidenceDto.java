package de.unfallatlas.analysis.api.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Size;

@JsonInclude(JsonInclude.Include.NON_NULL)
public class ConfidenceDto {
    /** "low" | "medium" | "high" */
    @Size(max = 10) public String overall;
    @Min(0) @Max(1) public double numeric;
    @Size(max = 1000) public String rationale;
}
