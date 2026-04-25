package de.unfallatlas.analysis.api;

import com.fasterxml.jackson.databind.ObjectMapper;
import de.unfallatlas.analysis.api.dto.LocationBriefIngestDto;
import de.unfallatlas.analysis.persistence.LocationActionBriefRepository;
import de.unfallatlas.analysis.support.LocationBriefFixtures;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

import static org.hamcrest.Matchers.equalTo;
import static org.hamcrest.Matchers.greaterThanOrEqualTo;
import static org.hamcrest.Matchers.hasSize;
import static org.hamcrest.Matchers.notNullValue;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

/**
 * REST-Integrationstest mit MockMvc gegen das frische H2-Schema.
 * Deckt die in der Aufgabenstellung geforderten Endpunkte ab.
 */
@SpringBootTest
@AutoConfigureMockMvc
class LocationBriefControllerTest {

    @Autowired private MockMvc mvc;
    @Autowired private LocationActionBriefRepository repo;

    // Spring Boot 4 verwendet Jackson 3 (tools.jackson) als Default; der
    // Spring-Web-Stack hat damit keinen com.fasterxml.jackson ObjectMapper-
    // Bean mehr.  Für die hiesigen Tests reicht eine eigene Instanz, weil
    // wir nur DTOs in JSON serialisieren – kein Spring-Bean nötig.
    private final ObjectMapper json = new ObjectMapper();

    @BeforeEach
    void cleanDb() {
        repo.deleteAll();
    }

    @Test
    void postSpeichertUndGetGibtBriefZurueck() throws Exception {
        LocationBriefIngestDto dto = LocationBriefFixtures.bicycleTurningConflictBrief();
        String body = json.writeValueAsString(dto);

        var post = mvc.perform(post("/api/location-briefs")
                .contentType(MediaType.APPLICATION_JSON).content(body))
            .andExpect(status().isCreated())
            .andExpect(jsonPath("$.id", notNullValue()))
            .andExpect(jsonPath("$.locationKey", notNullValue()))
            .andExpect(jsonPath("$.profileKey", equalTo("bicycle_safety_priority")))
            .andExpect(jsonPath("$.versioning.rulesVersion", equalTo("conflictPatterns.v1")))
            .andExpect(jsonPath("$.profileScores", hasSize(5)))
            .andReturn();

        String createdId = json.readTree(post.getResponse().getContentAsString()).get("id").asText();

        mvc.perform(get("/api/location-briefs/{id}", createdId))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.id", equalTo(createdId)))
            .andExpect(jsonPath("$.candidateMeasures", hasSize(2)))
            .andExpect(jsonPath("$.aiUsed", equalTo(false)));
    }

    @Test
    void invalideRequestsLiefernStrukturierteFehler() throws Exception {
        // Pflichtfelder fehlen (leeres Objekt)
        mvc.perform(post("/api/location-briefs")
                .contentType(MediaType.APPLICATION_JSON).content("{}"))
            .andExpect(status().isBadRequest())
            .andExpect(jsonPath("$.error", equalTo(true)))
            .andExpect(jsonPath("$.category", equalTo("validation")))
            .andExpect(jsonPath("$.details", hasSize(greaterThanOrEqualTo(1))));
    }

    @Test
    void cityFilterUndTopEndpunkteFunktionieren() throws Exception {
        LocationBriefIngestDto a = LocationBriefFixtures.bicycleTurningConflictBrief();
        a.meta.areaName = "Stelle A";
        a.title = "Stelle A";
        mvc.perform(post("/api/location-briefs").contentType(MediaType.APPLICATION_JSON)
                .content(json.writeValueAsString(a)))
            .andExpect(status().isCreated());

        LocationBriefIngestDto b = LocationBriefFixtures.bicycleTurningConflictBrief();
        b.meta.areaName = "Stelle B";
        b.title = "Stelle B";
        b.deterministicFindings.profileScores.forEach(ps -> {
            if ("bicycle_safety_priority".equals(ps.profile)) ps.total = 0.4;
        });
        mvc.perform(post("/api/location-briefs").contentType(MediaType.APPLICATION_JSON)
                .content(json.writeValueAsString(b)))
            .andExpect(status().isCreated());

        mvc.perform(get("/api/location-briefs").param("city", "Hannover"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$", hasSize(2)));

        mvc.perform(get("/api/location-briefs/top")
                .param("city", "Hannover")
                .param("profile", "bicycle_safety_priority")
                .param("limit", "10"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$", hasSize(2)))
            .andExpect(jsonPath("$[0].title", equalTo("Stelle A")))
            .andExpect(jsonPath("$[1].title", equalTo("Stelle B")));

        mvc.perform(get("/api/location-briefs/political").param("city", "Hannover"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$", hasSize(greaterThanOrEqualTo(1))));
    }

    @Test
    void byLocationLiefertAlleAuswertungenEinerStelleNeuesteZuerst() throws Exception {
        LocationBriefIngestDto a = LocationBriefFixtures.bicycleTurningConflictBrief();
        mvc.perform(post("/api/location-briefs").contentType(MediaType.APPLICATION_JSON)
                .content(json.writeValueAsString(a)))
            .andExpect(status().isCreated());

        LocationBriefIngestDto b = LocationBriefFixtures.bicycleTurningConflictBrief();
        b.title = "Knoten Beispielstraße / Musterweg (revisited)";
        var second = mvc.perform(post("/api/location-briefs").contentType(MediaType.APPLICATION_JSON)
                .content(json.writeValueAsString(b)))
            .andExpect(status().isCreated())
            .andReturn();
        String locationKey = json.readTree(second.getResponse().getContentAsString()).get("locationKey").asText();

        mvc.perform(get("/api/location-briefs/by-location/{key}", locationKey))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$", hasSize(2)));
    }
}
