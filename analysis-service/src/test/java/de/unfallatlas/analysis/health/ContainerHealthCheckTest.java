package de.unfallatlas.analysis.health;

import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

import java.net.InetSocketAddress;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;

class ContainerHealthCheckTest {
    @ParameterizedTest
    @CsvSource({"200,true", "204,true", "302,false", "404,false", "503,false"})
    void onlySuccessfulActuatorResponsesPass(int status, boolean expected) throws Exception {
        var server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        var observedRequest = new AtomicReference<String>();
        server.createContext("/actuator/health", exchange -> {
            try (exchange) {
                observedRequest.set(exchange.getRequestMethod() + " " + exchange.getRequestURI());
                exchange.getResponseHeaders().set("Location", "/healthy");
                exchange.sendResponseHeaders(status, -1);
            }
        });
        server.createContext("/healthy", exchange -> {
            try (exchange) {
                exchange.sendResponseHeaders(200, -1);
            }
        });
        server.start();
        try {
            assertEquals(expected, ContainerHealthCheck.isHealthy(server.getAddress().getPort()));
            assertEquals("GET /actuator/health", observedRequest.get());
        } finally {
            server.stop(0);
        }
    }
}
