package de.unfallatlas.analysis.api.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import jakarta.validation.constraints.Size;

@JsonInclude(JsonInclude.Include.NON_NULL)
public class AiPolishDto {
    @Size(max = 80)  public String aiModel;
    @Size(max = 80)  public String aiPromptVersion;
    @Size(max = 128) public String aiInputFingerprint;
    @Size(max = 30)  public String aiSource;
}
