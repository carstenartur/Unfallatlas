package de.unfallatlas.analysis.api;

import de.unfallatlas.analysis.api.dto.LocationBriefIngestDto;
import de.unfallatlas.analysis.api.dto.LocationBriefResponseDto;
import de.unfallatlas.analysis.domain.LocationActionBriefEntity;
import de.unfallatlas.analysis.mapping.LocationBriefMapper;
import de.unfallatlas.analysis.persistence.LocationActionBriefRepository;
import org.springframework.data.domain.PageRequest;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.Optional;

/**
 * Anwendungsservice für persistierte Maßnahmen-Steckbriefe.  Kapselt
 * Mapping + Idempotenz und liegt zwischen Controller und Repository.
 */
@Service
public class LocationBriefService {

    private final LocationActionBriefRepository repo;
    private final LocationBriefMapper mapper;

    public LocationBriefService(LocationActionBriefRepository repo, LocationBriefMapper mapper) {
        this.repo = repo;
        this.mapper = mapper;
    }

    /**
     * Speichert einen vollständigen Brief (idempotent über
     * {@code locationKey + profileKey + sourceFingerprint}).
     */
    @Transactional
    public LocationActionBriefEntity ingest(LocationBriefIngestDto dto) {
        LocationActionBriefEntity prepared = mapper.toEntity(dto);
        Optional<LocationActionBriefEntity> existing =
            repo.findFirstByLocationKeyAndProfileKeyAndSourceFingerprint(
                prepared.getLocationKey(),
                prepared.getProfileKey(),
                prepared.getSourceFingerprint());
        return existing.orElseGet(() -> repo.save(prepared));
    }

    @Transactional(readOnly = true)
    public Optional<LocationActionBriefEntity> findById(String id) {
        return repo.findById(id);
    }

    @Transactional(readOnly = true)
    public List<LocationActionBriefEntity> findByLocationKey(String locationKey) {
        return repo.findByLocationKeyOrderByCreatedAtDesc(locationKey);
    }

    @Transactional(readOnly = true)
    public List<LocationActionBriefEntity> findByCity(String city, String profileKey, int page, int size) {
        var pageable = PageRequest.of(Math.max(0, page), Math.min(Math.max(1, size), 100));
        if (profileKey == null || profileKey.isBlank()) {
            return repo.findByCityOrderByCreatedAtDesc(city, pageable).getContent();
        }
        return repo.findByCityAndProfileKeyOrderByCreatedAtDesc(city, profileKey, pageable).getContent();
    }

    @Transactional(readOnly = true)
    public List<LocationActionBriefEntity> findTopByCityAndProfile(String city, String profileKey, int limit) {
        int safeLimit = Math.min(Math.max(1, limit), 100);
        return repo.findTopByCityAndProfile(city, profileKey, safeLimit);
    }

    @Transactional(readOnly = true)
    public List<LocationActionBriefEntity> findWithPoliticalReadiness(String city) {
        return repo.findWithPoliticalReadinessByCity(city);
    }

    public static LocationBriefResponseDto toResponse(LocationActionBriefEntity e) {
        return LocationBriefResponseDto.fromEntity(e);
    }
}
