package de.unfallatlas.analysis.api.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

import java.util.List;

@JsonInclude(JsonInclude.Include.NON_NULL)
public class IngestMetaDto {
    @NotBlank @Size(max = 60) public String schemaVersion;
    @NotBlank @Size(max = 60) public String profile;
    public List<String> availableProfiles;
    public List<String> requiredConflictPatternIds;
    public boolean generatedWithAi;
    @NotBlank @Size(max = 100) public String city;
    @Size(max = 200) public String areaName;

    /** Optionale Versionierungs-Hinweise des aufrufenden Systems. */
    @Size(max = 60) public String rulesVersion;
    @Size(max = 60) public String scoringVersion;
    @Size(max = 60) public String profileVersion;

    /**
     * Optional vorgegebener Source-Fingerprint.  Wenn nicht gesetzt,
     * berechnet der Service ihn deterministisch aus dem Ingest-DTO.
     */
    @Size(max = 128) public String sourceFingerprint;
}
