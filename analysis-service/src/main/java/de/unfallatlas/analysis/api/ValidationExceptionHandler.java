package de.unfallatlas.analysis.api;

import jakarta.validation.ConstraintViolationException;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.validation.FieldError;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

import java.time.Instant;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

/**
 * Vereinheitlichter Validation-Error-Envelope.  Spiegelt grob die
 * Fehlerstruktur aus {@code server/lib/errors.js} der Node-Anwendung,
 * sodass Clients beide APIs gleich behandeln können.
 */
@RestControllerAdvice
public class ValidationExceptionHandler {

    @ExceptionHandler(MethodArgumentNotValidException.class)
    public ResponseEntity<Map<String, Object>> onArgumentNotValid(MethodArgumentNotValidException ex) {
        Map<String, Object> body = baseEnvelope("validation",
            "Ungültige Eingabedaten – Pflichtfelder oder Wertebereiche prüfen.");
        List<Map<String, String>> details = ex.getBindingResult().getFieldErrors().stream()
            .map(this::toDetail)
            .collect(Collectors.toList());
        body.put("details", details);
        return ResponseEntity.status(HttpStatus.BAD_REQUEST).body(body);
    }

    @ExceptionHandler(ConstraintViolationException.class)
    public ResponseEntity<Map<String, Object>> onConstraintViolation(ConstraintViolationException ex) {
        Map<String, Object> body = baseEnvelope("validation",
            "Ungültige Parameter.");
        List<Map<String, String>> details = ex.getConstraintViolations().stream()
            .map(v -> {
                Map<String, String> d = new HashMap<>();
                d.put("field",   v.getPropertyPath().toString());
                d.put("message", v.getMessage());
                return d;
            })
            .collect(Collectors.toList());
        body.put("details", details);
        return ResponseEntity.status(HttpStatus.BAD_REQUEST).body(body);
    }

    @ExceptionHandler(IllegalArgumentException.class)
    public ResponseEntity<Map<String, Object>> onIllegalArgument(IllegalArgumentException ex) {
        return ResponseEntity.status(HttpStatus.BAD_REQUEST)
            .body(baseEnvelope("validation", ex.getMessage()));
    }

    private Map<String, Object> baseEnvelope(String category, String message) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("error",     true);
        body.put("category",  category);
        body.put("message",   message);
        body.put("timestamp", Instant.now().toString());
        return body;
    }

    private Map<String, String> toDetail(FieldError fe) {
        Map<String, String> d = new HashMap<>();
        d.put("field",   fe.getField());
        d.put("message", fe.getDefaultMessage());
        return d;
    }
}
