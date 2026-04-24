package de.unfallatlas.analysis.api.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

import java.util.List;

@JsonInclude(JsonInclude.Include.NON_NULL)
public class ConflictPatternDto {
    @NotBlank @Size(max = 80) public String id;
    @Size(max = 80)            public String aliasId;
    @NotBlank @Size(max = 200) public String label;
    /** "primary" | "secondary" */
    @Size(max = 12) public String classification;
    /** "low" | "medium" | "high" */
    @Size(max = 10) public String confidence;
    @Size(max = 1000) public String rationale;
    public List<String> evidence;
    public List<String> requiresOnSiteCheck;
}
