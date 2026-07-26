package de.unfallatlas.analysis.api;

import tools.jackson.databind.ObjectMapper;
import de.unfallatlas.analysis.persistence.LocationActionBriefRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

import java.util.Map;

import static org.hamcrest.Matchers.notNullValue;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * REST-Test für {@link BatchJobController}.
 *
 * <p>Validiert die in der Aufgabenstellung geforderten Endpunkte:</p>
 * <ul>
 *   <li>{@code POST /api/batch/jobs/city-prioritization}
 *       startet den Job und liefert eine {@code executionId},</li>
 *   <li>{@code GET /api/batch/jobs/{id}} liefert Status + Step-Status,</li>
 *   <li>{@code GET /api/batch/jobs} listet die jüngsten Ausführungen,</li>
 *   <li>{@code GET /api/batch/jobs/{id}/summary} liefert die fachliche
 *       Zusammenfassung,</li>
 *   <li>fehlende Pflichtparameter führen zum einheitlichen Error-Envelope
 *       mit Code {@code VALIDATION_FAILED} (400).</li>
 * </ul>
 */
@SpringBootTest
@AutoConfigureMockMvc
class BatchJobControllerTest {

    @Autowired private MockMvc mvc;
    @Autowired private LocationActionBriefRepository briefRepo;
    @Autowired private ObjectMapper json;

    @BeforeEach
    void clean() {
        briefRepo.deleteAll();
    }

    @Test
    void postStartetJobUndGetLiefertStatusUndSummary() throws Exception {
        Map<String, Object> req = Map.of(
            "city", "Hannover",
            "profile", "low_hanging_fruit",
            "recomputeExisting", false,
            "limit", 5,
            "runLabel", "smoke-1");

        MvcResult started = mvc.perform(post("/api/batch/jobs/city-prioritization")
                .contentType(MediaType.APPLICATION_JSON)
                .content(json.writeValueAsString(req)))
            .andExpect(status().isAccepted())
            .andExpect(jsonPath("$.jobName").value("city-prioritization-job"))
            .andExpect(jsonPath("$.executionId", notNullValue()))
            .andExpect(jsonPath("$.status", notNullValue()))
            .andReturn();

        @SuppressWarnings("unchecked")
        Map<String, Object> body = json.readValue(started.getResponse().getContentAsString(), Map.class);
        Number executionId = (Number) body.get("executionId");

        // GET /api/batch/jobs/{id}
        mvc.perform(get("/api/batch/jobs/{id}", executionId.longValue()))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.executionId").value(executionId.longValue()))
            .andExpect(jsonPath("$.jobName").value("city-prioritization-job"))
            .andExpect(jsonPath("$.status").value("COMPLETED"))
            .andExpect(jsonPath("$.steps[0].stepName").value("loadCandidatesStep"))
            .andExpect(jsonPath("$.steps[5].stepName").value("buildRankingArtifactsStep"));

        // GET /api/batch/jobs (Liste der jüngsten fachlichen Job-Einträge)
        mvc.perform(get("/api/batch/jobs"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$[0].executionId").value(executionId.longValue()))
            .andExpect(jsonPath("$[0].jobType").value("city-prioritization-job"));

        // GET /api/batch/jobs/{id}/summary
        mvc.perform(get("/api/batch/jobs/{id}/summary", executionId.longValue()))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.executionId").value(executionId.longValue()))
            .andExpect(jsonPath("$.runLabel").value("smoke-1"))
            .andExpect(jsonPath("$.summary").exists());
    }

    @Test
    void postOhneCityErgibtValidationError() throws Exception {
        Map<String, Object> req = Map.of(
            "profile", "low_hanging_fruit");

        mvc.perform(post("/api/batch/jobs/city-prioritization")
                .contentType(MediaType.APPLICATION_JSON)
                .content(json.writeValueAsString(req)))
            .andExpect(status().isBadRequest())
            .andExpect(jsonPath("$.error").value(true))
            .andExpect(jsonPath("$.category").value("validation"));
    }

    @Test
    void getMitUnbekannterIdGibt404() throws Exception {
        mvc.perform(get("/api/batch/jobs/{id}", 999_999_999L))
            .andExpect(status().isNotFound());
    }
}
