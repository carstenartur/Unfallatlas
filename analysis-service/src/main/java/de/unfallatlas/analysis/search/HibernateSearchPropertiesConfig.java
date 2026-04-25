package de.unfallatlas.analysis.search;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.hibernate.autoconfigure.HibernatePropertiesCustomizer;
import org.springframework.context.annotation.Configuration;

import java.util.Map;

/**
 * Routet die Hibernate-Search-Properties direkt in das von Spring Boot
 * gebaute {@code SessionFactory}/{@code EntityManagerFactory}.
 *
 * <p>Hintergrund: In Spring Boot 4 werden {@code spring.jpa.properties.*}
 * zwar an die {@code EntityManagerFactory} weitergereicht, aber Hibernate
 * Search bezieht seine Konfiguration aus dem {@code Properties}-Bag, das
 * den {@code SessionFactoryBuilder} initialisiert.  Die Hibernate-Search-
 * Bootstrap-Sequenz läuft bereits, bevor JPA das EMF mit den Properties
 * fertig befüllt – die {@code spring.jpa.properties.hibernate.search.*}-
 * Werte greifen daher nicht mehr.</p>
 *
 * <p>Die saubere Lösung ist ein {@link HibernatePropertiesCustomizer}:
 * dieser greift in die Hibernate-Bootstrap-Properties ein, bevor die
 * SessionFactory gebaut wird, und stellt damit sicher, dass Hibernate
 * Search beim Start unsere Lucene-Backend-Konfiguration sieht.</p>
 *
 * <p>Werte stammen aus {@code application.properties} bzw. den
 * profilspezifischen Overlays.  Der Analyse-Configurer wird per
 * {@code bean:}-Lookup referenziert, damit er als regulärer Spring-Bean
 * wartbar bleibt (siehe {@link UnfallatlasLuceneAnalysisConfigurer}).</p>
 */
@Configuration
public class HibernateSearchPropertiesConfig implements HibernatePropertiesCustomizer {

    private static final Logger LOG = LoggerFactory.getLogger(HibernateSearchPropertiesConfig.class);

    private final String backendType;
    private final String directoryType;
    private final String directoryRoot;
    private final String luceneVersion;
    private final String schemaStrategy;
    private final boolean indexingListenersEnabled;
    private final String analysisConfigurerBean;

    public HibernateSearchPropertiesConfig(
            @Value("${analysis.search.backend.type:lucene}") String backendType,
            @Value("${analysis.search.backend.directory.type:local-filesystem}") String directoryType,
            @Value("${analysis.search.backend.directory.root:${java.io.tmpdir}/unfallatlas-search}") String directoryRoot,
            @Value("${analysis.search.backend.lucene-version:LATEST}") String luceneVersion,
            @Value("${analysis.search.schema-management.strategy:create-or-update}") String schemaStrategy,
            @Value("${analysis.search.indexing.listeners-enabled:true}") boolean indexingListenersEnabled,
            @Value("${analysis.search.analysis.configurer-bean:unfallatlasLuceneAnalysisConfigurer}") String analysisConfigurerBean) {
        this.backendType = backendType;
        this.directoryType = directoryType;
        this.directoryRoot = directoryRoot;
        this.luceneVersion = luceneVersion;
        this.schemaStrategy = schemaStrategy;
        this.indexingListenersEnabled = indexingListenersEnabled;
        this.analysisConfigurerBean = analysisConfigurerBean;
    }

    @Override
    public void customize(Map<String, Object> hibernateProperties) {
        // Hibernate Search Backend-Konfiguration
        hibernateProperties.put("hibernate.search.backend.type", backendType);
        hibernateProperties.put("hibernate.search.backend.directory.type", directoryType);
        // root-Pfad nur für Filesystem-Backends setzen – `local-heap` lehnt
        // einen "directory.root" als unbekannte Property ab.
        if ("local-filesystem".equals(directoryType)) {
            hibernateProperties.put("hibernate.search.backend.directory.root", directoryRoot);
        }
        hibernateProperties.put("hibernate.search.backend.lucene_version", luceneVersion);
        hibernateProperties.put("hibernate.search.schema_management.strategy", schemaStrategy);
        hibernateProperties.put("hibernate.search.indexing.listeners.enabled", String.valueOf(indexingListenersEnabled));

        // Analyzer-/Normalizer-Configurer als Spring-Bean referenzieren.
        // bean:NAME nutzt Spring Boots BeanContainer-Integration für
        // Hibernate Search, sodass die Klasse als Spring-Bean gemanagt
        // bleibt und z. B. in Tests austauschbar ist.
        hibernateProperties.put(
            "hibernate.search.backend.analysis.configurer",
            "bean:" + analysisConfigurerBean);

        LOG.info("[search] Hibernate Search aktiviert: backend={} dir={} root={} schemaStrategy={} configurerBean={}",
            backendType, directoryType, directoryRoot, schemaStrategy, analysisConfigurerBean);
    }
}
