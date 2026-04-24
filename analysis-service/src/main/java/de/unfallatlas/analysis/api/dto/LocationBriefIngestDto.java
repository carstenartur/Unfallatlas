package de.unfallatlas.analysis.api.dto;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonInclude;
import jakarta.validation.Valid;
import jakarta.validation.constraints.*;

import java.util.List;
import java.util.Map;

/**
 * Versionierter Ingest-DTO für einen vollständigen
 * {@code LocationActionBrief} aus der bestehenden Node-Anwendung
 * (Schema {@code locationBriefIngest.v1}).
 *
 * <p>Die Felder sind eng an der Node-Ausgabe orientiert (siehe
 * {@code server/location-brief/briefService.js}).  Unbekannte Felder
 * werden ignoriert ({@link JsonIgnoreProperties}), damit neuere
 * Node-Versionen den Service nicht brechen.</p>
 */
@JsonIgnoreProperties(ignoreUnknown = true)
@JsonInclude(JsonInclude.Include.NON_NULL)
public class LocationBriefIngestDto {

    @NotBlank @Size(max = 60)
    public String schemaVersion;

    @Size(max = 200)
    public String locationId;       // optional, kann auch aus meta abgeleitet werden

    @Size(max = 200)
    public String externalLocationId;

    @NotBlank @Size(max = 250)
    public String title;

    @Size(max = 4000)
    public String problemSummary;

    @Valid
    public Map<String, Object> accidentProfile;

    @Valid
    public List<ConflictPatternDto> conflictPatterns;

    @Valid
    public List<MeasureDto> candidateMeasures;

    @Valid
    public List<MeasureDto> recommendedMeasures;

    @Valid
    public Map<String, Object> dataQuality;

    @Valid
    public PoliticalContextDto politicalContext;

    @Valid
    public DeterministicFindingsDto deterministicFindings;

    @Valid
    public Map<String, Object> uncertainties;

    @Valid
    public ConfidenceDto confidence;

    @Valid
    @NotNull(message = "meta is required (must contain at least city and profile)")
    public IngestMetaDto meta;

    @Valid
    public AiPolishDto aiPolish; // optional – nur wenn KI verwendet wurde
}
