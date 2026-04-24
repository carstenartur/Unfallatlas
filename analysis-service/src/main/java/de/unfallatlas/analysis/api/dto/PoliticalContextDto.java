package de.unfallatlas.analysis.api.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Size;

import java.util.List;

@JsonInclude(JsonInclude.Include.NON_NULL)
public class PoliticalContextDto {
    @Size(max = 12) public String previousPoliticalAttention; // none|some|frequent
    @Size(max = 10) public String policyReadiness;            // low|medium|high
    @Valid public List<RelatedReferenceDto> relatedReferences;
    @Valid public List<RecurringRequestDto> recurringRequests;
    public List<String> administrativeMomentumHints;

    public static class RelatedReferenceDto {
        @Size(max = 250) public String title;
        @Size(max = 500) public String url;
        @Size(max = 60)  public String type;
        public double relevance;
    }

    public static class RecurringRequestDto {
        @Size(max = 60) public String topic;
        public int count;
    }
}
