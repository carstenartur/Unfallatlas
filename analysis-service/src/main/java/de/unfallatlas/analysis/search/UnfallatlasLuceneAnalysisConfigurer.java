package de.unfallatlas.analysis.search;

import org.apache.lucene.analysis.core.LowerCaseFilterFactory;
import org.apache.lucene.analysis.core.WhitespaceTokenizerFactory;
import org.apache.lucene.analysis.miscellaneous.ASCIIFoldingFilterFactory;
import org.apache.lucene.analysis.standard.StandardTokenizerFactory;
import org.hibernate.search.backend.lucene.analysis.LuceneAnalysisConfigurer;
import org.hibernate.search.backend.lucene.analysis.LuceneAnalysisConfigurationContext;
import org.springframework.stereotype.Component;

/**
 * Definiert die in den Entity-Annotationen referenzierten Analyzer und
 * Normalizer für den Lucene-Backend von Hibernate Search.
 *
 * <p>Aktuell sind das:</p>
 * <ul>
 *   <li><b>standard</b> – Tokenisierung über Lucenes
 *       {@link StandardTokenizerFactory}, plus Lowercase und ASCII-
 *       Folding.  Wird für Freitext-Felder wie {@code title} oder
 *       {@code deterministicSummary} verwendet.</li>
 *   <li><b>lowercase</b> (Normalizer) – wandelt KeyWord-Felder zur
 *       Suchzeit/Indexzeit auf Kleinschreibung, ohne sie zu
 *       tokenisieren.  Wird z. B. für {@code city_lc} verwendet, damit
 *       die Suche nach Stadt-Slugs case-insensitiv ist, ohne die
 *       Sortierbarkeit des originalen Felds zu verlieren.</li>
 * </ul>
 *
 * <p>Die Konfiguration wird über die Property
 * {@code spring.jpa.properties.hibernate.search.backend.analysis.configurer}
 * verdrahtet (siehe {@code application.properties}) und nutzt das
 * {@code bean:}-Lookup, damit die Klasse als Spring-Bean instanziiert
 * wird (Hibernate Search verwendet dafür die {@code SpringBeanContainer}-
 * Integration aus Spring Boot).</p>
 */
@Component("unfallatlasLuceneAnalysisConfigurer")
public class UnfallatlasLuceneAnalysisConfigurer implements LuceneAnalysisConfigurer {

    @Override
    public void configure(LuceneAnalysisConfigurationContext ctx) {
        // Standard-Analyzer für Freitext-Felder.
        ctx.analyzer("standard").custom()
            .tokenizer(StandardTokenizerFactory.class)
            .tokenFilter(LowerCaseFilterFactory.class)
            .tokenFilter(ASCIIFoldingFilterFactory.class);

        // Whitespace-Analyzer als robuste Alternative für IDs/Slugs,
        // sollte sie später benötigt werden.
        ctx.analyzer("whitespace_lower").custom()
            .tokenizer(WhitespaceTokenizerFactory.class)
            .tokenFilter(LowerCaseFilterFactory.class)
            .tokenFilter(ASCIIFoldingFilterFactory.class);

        // Normalizer „lowercase" – tokenisiert NICHT, normalisiert nur
        // den Casing.  Geeignet für KeywordField-Suchen wie city_lc.
        ctx.normalizer("lowercase").custom()
            .tokenFilter(LowerCaseFilterFactory.class)
            .tokenFilter(ASCIIFoldingFilterFactory.class);
    }
}
