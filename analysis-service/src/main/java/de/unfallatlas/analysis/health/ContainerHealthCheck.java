package de.unfallatlas.analysis.health;

import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.Proxy;
import java.net.URI;

/** Standalone probe for the analysis container's local Actuator endpoint. */
public final class ContainerHealthCheck {
    private ContainerHealthCheck() {}

    public static void main(String[] args) throws IOException {
        int port = Integer.parseInt(System.getenv().getOrDefault("PORT", "8081"));
        if (!isHealthy(port)) {
            System.exit(1);
        }
    }

    static boolean isHealthy(int port) throws IOException {
        var endpoint = URI.create("http://127.0.0.1:" + port + "/actuator/health");
        var connection = (HttpURLConnection) endpoint.toURL().openConnection(Proxy.NO_PROXY);
        connection.setRequestMethod("GET");
        connection.setInstanceFollowRedirects(false);
        connection.setConnectTimeout(750);
        connection.setReadTimeout(1500);
        try {
            int status = connection.getResponseCode();
            if (status >= 200 && status < 300) {
                return true;
            }
            System.err.println("Actuator health returned HTTP " + status);
            return false;
        } finally {
            connection.disconnect();
        }
    }
}
