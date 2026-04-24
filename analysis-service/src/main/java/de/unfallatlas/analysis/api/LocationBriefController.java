package de.unfallatlas.analysis.api;

import de.unfallatlas.analysis.api.dto.LocationBriefIngestDto;
import de.unfallatlas.analysis.api.dto.LocationBriefResponseDto;
import de.unfallatlas.analysis.domain.LocationActionBriefEntity;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.net.URI;
import java.util.List;
import java.util.Optional;
import java.util.stream.Collectors;

/**
 * REST-API für gespeicherte {@code LocationActionBrief}-Aggregate.
 *
 * <p>Endpunkte (siehe Aufgabenstellung):</p>
 * <ul>
 *   <li>{@code POST /api/location-briefs} – Brief speichern (Ingest).</li>
 *   <li>{@code GET  /api/location-briefs/{id}} – einzelnen Brief abrufen.</li>
 *   <li>{@code GET  /api/location-briefs/by-location/{locationKey}} – alle
 *       Auswertungen einer Stelle, neueste zuerst.</li>
 *   <li>{@code GET  /api/location-briefs?city=&profile=&page=&size=} –
 *       Auswertungen einer Stadt, optional nach Profil gefiltert.</li>
 *   <li>{@code GET  /api/location-briefs/top?city=&profile=&limit=} –
 *       Top-N nach profilspezifischem Score.</li>
 *   <li>{@code GET  /api/location-briefs/political?city=} – Auswertungen
 *       mit politischer Vorbefassung (medium/high).</li>
 *   <li>{@code POST /api/location-briefs/compute-and-store} – derzeit ein
 *       reiner Stub: nimmt das gleiche Ingest-DTO entgegen und persistiert
 *       es.  Eine echte serverseitige Berechnung wird im Folge-PR
 *       ergänzt – die Node-Anwendung bleibt vorerst Quelle der
 *       deterministischen Befunde.</li>
 * </ul>
 */
@RestController
@RequestMapping("/api/location-briefs")
public class LocationBriefController {

    private final LocationBriefService service;

    public LocationBriefController(LocationBriefService service) {
        this.service = service;
    }

    @PostMapping
    public ResponseEntity<LocationBriefResponseDto> ingest(@Valid @RequestBody LocationBriefIngestDto dto) {
        LocationActionBriefEntity saved = service.ingest(dto);
        return ResponseEntity
            .created(URI.create("/api/location-briefs/" + saved.getId()))
            .body(LocationBriefService.toResponse(saved));
    }

    @PostMapping("/compute-and-store")
    public ResponseEntity<LocationBriefResponseDto> computeAndStore(@Valid @RequestBody LocationBriefIngestDto dto) {
        // In dieser Iteration leitet "compute-and-store" den Aufruf an
        // ingest() weiter.  Die deterministische Berechnung selbst lebt
        // weiterhin in der Node-Anwendung.  Die getrennte Endpunkt-URL
        // ist absichtlich vorhanden, damit Clients später ohne Bruch
        // umstellen können, wenn die Berechnung in den Java-Service
        // wandert.
        LocationActionBriefEntity saved = service.ingest(dto);
        return ResponseEntity
            .status(HttpStatus.CREATED)
            .body(LocationBriefService.toResponse(saved));
    }

    @GetMapping("/{id}")
    public ResponseEntity<LocationBriefResponseDto> getById(@PathVariable String id) {
        Optional<LocationActionBriefEntity> e = service.findById(id);
        return e.map(value -> ResponseEntity.ok(LocationBriefService.toResponse(value)))
                .orElseGet(() -> ResponseEntity.notFound().build());
    }

    @GetMapping("/by-location/{locationKey}")
    public List<LocationBriefResponseDto> byLocation(@PathVariable String locationKey) {
        return service.findByLocationKey(locationKey).stream()
            .map(LocationBriefService::toResponse)
            .collect(Collectors.toList());
    }

    @GetMapping
    public List<LocationBriefResponseDto> list(
            @RequestParam("city") String city,
            @RequestParam(value = "profile", required = false) String profile,
            @RequestParam(value = "page", defaultValue = "0") int page,
            @RequestParam(value = "size", defaultValue = "20") int size) {
        return service.findByCity(city, profile, page, size).stream()
            .map(LocationBriefService::toResponse)
            .collect(Collectors.toList());
    }

    @GetMapping("/top")
    public List<LocationBriefResponseDto> top(
            @RequestParam("city") String city,
            @RequestParam("profile") String profile,
            @RequestParam(value = "limit", defaultValue = "10") int limit) {
        return service.findTopByCityAndProfile(city, profile, limit).stream()
            .map(LocationBriefService::toResponse)
            .collect(Collectors.toList());
    }

    @GetMapping("/political")
    public List<LocationBriefResponseDto> political(@RequestParam("city") String city) {
        return service.findWithPoliticalReadiness(city).stream()
            .map(LocationBriefService::toResponse)
            .collect(Collectors.toList());
    }
}
