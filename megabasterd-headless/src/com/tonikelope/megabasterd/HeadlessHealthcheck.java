package com.tonikelope.megabasterd;

import java.net.HttpURLConnection;
import java.net.URL;

public final class HeadlessHealthcheck {

    private HeadlessHealthcheck() {
    }

    public static void main(String[] args) {
        String secret = System.getenv("MEGABASTERD_INTERNAL_SECRET");
        if (secret == null || secret.trim().isEmpty()) {
            System.exit(1);
        }
        HttpURLConnection connection = null;
        try {
            int port = port(System.getenv("PORT"));
            connection = (HttpURLConnection) new URL("http://127.0.0.1:" + port + "/health").openConnection();
            connection.setConnectTimeout(2_000);
            connection.setReadTimeout(2_000);
            connection.setRequestProperty("Authorization", "Bearer " + secret);
            if (connection.getResponseCode() != HttpURLConnection.HTTP_OK) {
                System.exit(1);
            }
        } catch (Exception error) {
            System.exit(1);
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
        }
    }

    private static int port(String value) {
        return value == null || value.trim().isEmpty() ? 8788 : Integer.parseInt(value);
    }
}
