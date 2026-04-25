package de.unfallatlas.analysis.observability;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.MDC;
import org.springframework.core.Ordered;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.security.SecureRandom;
import java.util.HexFormat;
import java.util.regex.Pattern;

/**
 * Setzt für jede HTTP-Anfrage eine Korrelations-ID, spiegelt sie im
 * Antwort-Header wider und legt sie für die Dauer der Anfrage in MDC ab,
 * damit sie in jeder Log-Zeile (Logback `%X{correlationId}`) sichtbar
 * ist.
 *
 * <p>Das Token kann vom Aufrufer (Node-Server, UI) über den Header
 * {@code X-Correlation-Id} mitgegeben werden – wir akzeptieren es nur,
 * wenn es einem engen Whitelisting-Muster entspricht
 * ({@code [A-Za-z0-9._:-]{4,128}}).  Andernfalls wird eine neue ID
 * (16 Hex-Zeichen, {@link SecureRandom}) erzeugt.  Damit kann ein
 * Client keine beliebigen Strings in unsere Logs schmuggeln
 * (Log-Injection).</p>
 *
 * <p>Der Filter ist als {@link Ordered#HIGHEST_PRECEDENCE} eingehängt,
 * damit jede andere Middleware (CORS, Security, Auth, Controller-
 * Advice) die ID bereits im MDC vorfindet.  MDC wird in einem
 * try/finally garantiert wieder entfernt, damit Thread-Pools keine
 * IDs mit sich tragen.</p>
 */
@Component
public class CorrelationIdFilter extends OncePerRequestFilter implements Ordered {

    /** Header-Name (case-insensitive bei eingehenden Anfragen, fix bei Antworten). */
    public static final String HEADER_NAME    = "X-Correlation-Id";
    /** MDC-Key, den Logback-Pattern als {@code %X{correlationId}} referenzieren. */
    public static final String MDC_KEY        = "correlationId";

    private static final Pattern ID_PATTERN   = Pattern.compile("^[A-Za-z0-9._:-]{4,128}$");
    private static final SecureRandom RANDOM  = new SecureRandom();

    @Override
    public int getOrder() {
        return Ordered.HIGHEST_PRECEDENCE;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request,
                                    HttpServletResponse response,
                                    FilterChain chain) throws ServletException, IOException {
        String id = sanitize(request.getHeader(HEADER_NAME));
        if (id == null) id = generate();
        MDC.put(MDC_KEY, id);
        response.setHeader(HEADER_NAME, id);
        try {
            chain.doFilter(request, response);
        } finally {
            // MDC zwingend wieder leeren – andernfalls "klebt" die ID
            // an wiederverwendeten Worker-Threads.
            MDC.remove(MDC_KEY);
        }
    }

    /**
     * @return die übergebene ID, wenn sie dem Whitelisting-Muster
     *         entspricht; sonst {@code null}.
     */
    private static String sanitize(String value) {
        if (value == null) return null;
        return ID_PATTERN.matcher(value).matches() ? value : null;
    }

    /** Erzeugt eine neue 16-stellige Hex-ID aus 8 Byte SecureRandom. */
    private static String generate() {
        byte[] buf = new byte[8];
        RANDOM.nextBytes(buf);
        return HexFormat.of().formatHex(buf);
    }
}
