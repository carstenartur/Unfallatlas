package de.unfallatlas.analysis.observability;

import jakarta.servlet.FilterChain;
import org.junit.jupiter.api.Test;
import org.slf4j.MDC;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Unit-Tests für {@link CorrelationIdFilter}: Whitelisting eingehender
 * IDs, MDC-Lifecycle, Antwort-Header.
 */
class CorrelationIdFilterTest {

    private final CorrelationIdFilter filter = new CorrelationIdFilter();

    @Test
    void generiertNeueIdWennHeaderFehlt() throws Exception {
        MockHttpServletRequest req = new MockHttpServletRequest();
        MockHttpServletResponse res = new MockHttpServletResponse();
        FilterChain chain = (q, s) -> {
            assertThat(MDC.get(CorrelationIdFilter.MDC_KEY))
                .as("MDC im Filter-Chain-Aufruf gesetzt")
                .matches("^[0-9a-f]{16}$");
        };
        filter.doFilter(req, res, chain);
        String header = res.getHeader(CorrelationIdFilter.HEADER_NAME);
        assertThat(header).matches("^[0-9a-f]{16}$");
        // MDC nach Filter wieder leer (try/finally)
        assertThat(MDC.get(CorrelationIdFilter.MDC_KEY)).isNull();
    }

    @Test
    void uebernimmtZulaessigeEingehendeId() throws Exception {
        MockHttpServletRequest req = new MockHttpServletRequest();
        req.addHeader(CorrelationIdFilter.HEADER_NAME, "node-req-abc.123:7");
        MockHttpServletResponse res = new MockHttpServletResponse();
        filter.doFilter(req, res, (q, s) -> {
            assertThat(MDC.get(CorrelationIdFilter.MDC_KEY)).isEqualTo("node-req-abc.123:7");
        });
        assertThat(res.getHeader(CorrelationIdFilter.HEADER_NAME)).isEqualTo("node-req-abc.123:7");
    }

    @Test
    void verwirftIdMitUnerlaubtenZeichen() throws Exception {
        MockHttpServletRequest req = new MockHttpServletRequest();
        req.addHeader(CorrelationIdFilter.HEADER_NAME, "with space\nand\tcontrols");
        MockHttpServletResponse res = new MockHttpServletResponse();
        filter.doFilter(req, res, (q, s) -> { /* noop */ });
        String header = res.getHeader(CorrelationIdFilter.HEADER_NAME);
        assertThat(header).matches("^[0-9a-f]{16}$");
    }

    @Test
    void verwirftZuKurzeId() throws Exception {
        MockHttpServletRequest req = new MockHttpServletRequest();
        req.addHeader(CorrelationIdFilter.HEADER_NAME, "ab");
        MockHttpServletResponse res = new MockHttpServletResponse();
        filter.doFilter(req, res, (q, s) -> { /* noop */ });
        assertThat(res.getHeader(CorrelationIdFilter.HEADER_NAME)).matches("^[0-9a-f]{16}$");
    }

    @Test
    void leertMdcAuchWennChainWirft() {
        MockHttpServletRequest req = new MockHttpServletRequest();
        MockHttpServletResponse res = new MockHttpServletResponse();
        FilterChain throwing = (q, s) -> { throw new RuntimeException("boom"); };
        try {
            filter.doFilter(req, res, throwing);
        } catch (Exception ignored) {
            // erwartet
        }
        assertThat(MDC.get(CorrelationIdFilter.MDC_KEY)).isNull();
    }
}
