package de.unfallatlas.analysis;

import org.junit.jupiter.api.Test;
import org.springframework.boot.context.properties.bind.Bindable;
import org.springframework.boot.context.properties.bind.Binder;
import org.springframework.boot.context.properties.source.MapConfigurationPropertySource;
import org.springframework.boot.jackson.autoconfigure.JacksonProperties;

import java.io.InputStream;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Properties;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;

/**
 * Prüft die produktive Jackson-Konfiguration gegen den tatsächlich
 * eingebundenen Spring-Boot-Stand. Die normale Test-Ressource überschreibt
 * {@code application.properties}; deshalb wird bewusst die Kopie aus
 * {@code target/classes} über den Code-Source-Pfad der Hauptklasse geladen.
 */
class ProductionConfigurationBindingTest {

    @Test
    void productionJacksonPropertiesBindAgainstCurrentSpringBootVersion() throws Exception {
        URI mainClassesUri = AnalysisServiceApplication.class
            .getProtectionDomain()
            .getCodeSource()
            .getLocation()
            .toURI();
        Path applicationProperties = Path.of(mainClassesUri).resolve("application.properties");
        assertThat(applicationProperties).isRegularFile();

        Properties properties = new Properties();
        try (InputStream input = Files.newInputStream(applicationProperties)) {
            properties.load(input);
        }

        assertThat(properties)
            .containsEntry("spring.jackson.datatype.datetime.write-dates-as-timestamps", "false")
            .doesNotContainKey("spring.jackson.serialization.write-dates-as-timestamps");

        Map<String, Object> values = new LinkedHashMap<>();
        properties.forEach((key, value) -> values.put(String.valueOf(key), value));
        Binder binder = new Binder(new MapConfigurationPropertySource(values));

        assertThatCode(() -> binder
            .bind("spring.jackson", Bindable.of(JacksonProperties.class))
            .get())
            .doesNotThrowAnyException();
    }
}
