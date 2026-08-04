package com.tonikelope.megabasterd;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import javax.crypto.Cipher;

public final class HeadlessServerTest {

    private static final String SECRET = "test-secret";
    private static final String LINK = "https://mega.nz/file/id#public-key";
    private static final String QUOTA_LINK = "https://mega.nz/file/quota-id#public-key";
    private static final String DOWNLOAD_URL = "https://signed.example.test/download";
    private static final String FILE_KEY = eightWordKey();
    private static final byte[] CONTENT = "0123456789abcdefghijklmnopqrstuvwxyz".getBytes(StandardCharsets.UTF_8);

    public static void main(String[] args) throws Exception {
        HttpServer content = contentServer(CONTENT);
        HttpServer server = HeadlessServer.create(0, SECRET, transfer(url(content)));
        server.start();
        try {
            assertStatus(401, request(server, "GET", "/health", null, null));
            assertStatus(200, request(server, "GET", "/health", "Bearer " + SECRET, null));
            assertJson(200, request(server, "POST", "/inspect", "Bearer " + SECRET, "{\"link\":\"" + LINK + "\"}"),
                    "{\"file_name\":\"fixture.bin\",\"size\":36,\"mime_type\":\"application/octet-stream\"}");
            Response ranged = request(server, "POST", "/stream", "Bearer " + SECRET, resolvedRangeJson(url(content)));
            assertBody(206, ranged, "789abcdef");
            assertHeaders(ranged, "fixture.bin", "9", "bytes 7-15/36");
            Response empty = request(server, "POST", "/stream", "Bearer " + SECRET, emptyResolvedJson());
            assertBody(200, empty, "");
            assertHeaders(empty, "empty.bin", "0", null);
            if (empty.transferEncoding != null) {
                throw new AssertionError("empty stream must not be chunked: " + empty.transferEncoding);
            }
            assertError(400, request(server, "POST", "/inspect", "Bearer " + SECRET, "{"), "INVALID_INPUT");
            assertError(400, request(server, "POST", "/inspect", "Bearer " + SECRET, "{\"link\":\"" + LINK + "\"} true"), "INVALID_INPUT");
            assertError(400, request(server, "POST", "/stream", "Bearer " + SECRET,
                    "{\"source\":\"resolved\",\"download_url\":\"" + DOWNLOAD_URL + "\",\"file_key\":\"" + FILE_KEY
                            + "\",\"file_name\":\"fixture.bin\",\"size\":36.5,\"range\":null}"), "INVALID_INPUT");
            assertError(400, request(server, "POST", "/stream", "Bearer " + SECRET,
                    "{\"source\":\"resolved\",\"download_url\":\"" + DOWNLOAD_URL + "\",\"file_key\":\"" + FILE_KEY
                            + "\",\"file_name\":\"fixture.bin\",\"size\":18446744073709551616,\"range\":null}"), "INVALID_INPUT");
            assertError(400, request(server, "POST", "/stream", "Bearer " + SECRET,
                    "{\"source\":\"resolved\",\"download_url\":\"" + DOWNLOAD_URL + "\",\"file_key\":\"" + FILE_KEY
                            + "\",\"file_name\":\"fixture.bin\",\"size\":36,\"range\":{\"start\":7.5,\"end\":15}}"), "INVALID_INPUT");
            assertError(400, request(server, "POST", "/stream", "Bearer " + SECRET,
                    "{\"source\":\"resolved\",\"download_url\":\"" + DOWNLOAD_URL + "\",\"file_key\":\"" + FILE_KEY
                            + "\",\"file_name\":\"fixture.bin\",\"size\":36,\"range\":{\"start\":18446744073709551616,\"end\":15}}"), "INVALID_INPUT");
            assertError(400, request(server, "POST", "/stream", "Bearer " + SECRET,
                    "{\"source\":\"resolved\",\"download_url\":\"" + DOWNLOAD_URL + "\",\"file_key\":\"" + FILE_KEY
                            + "\",\"file_name\":\"fixture.bin\",\"size\":36,\"range\":{\"start\":7,\"end\":15.5}}"), "INVALID_INPUT");
            assertError(400, request(server, "POST", "/stream", "Bearer " + SECRET,
                    "{\"source\":\"resolved\",\"download_url\":\"" + DOWNLOAD_URL + "\",\"file_key\":\"" + FILE_KEY
                            + "\",\"file_name\":\"fixture.bin\",\"size\":36,\"range\":{\"start\":0,\"end\":18446744073709551616}}"), "INVALID_INPUT");
            assertError(400, request(server, "POST", "/stream", "Bearer " + SECRET,
                    "{\"source\":\"resolved\",\"download_url\":\"" + DOWNLOAD_URL + "\",\"file_key\":\"" + FILE_KEY
                            + "\",\"file_name\":\"fixture.bin\",\"size\":36,\"range\":{\"start\":-1,\"end\":0}}"), "INVALID_INPUT");
            assertError(400, request(server, "POST", "/stream", "Bearer " + SECRET,
                    "{\"source\":\"resolved\",\"download_url\":\"" + DOWNLOAD_URL + "\",\"file_key\":\"" + FILE_KEY
                            + "\",\"file_name\":\"empty.bin\",\"size\":0,\"range\":{\"start\":0,\"end\":0}}"), "INVALID_INPUT");
            assertError(429, request(server, "POST", "/stream", "Bearer " + SECRET,
                    "{\"source\":\"public\",\"link\":\"" + QUOTA_LINK + "\",\"range\":{\"start\":0,\"end\":9}}"), "QUOTA");
        } finally {
            server.stop(0);
            content.stop(0);
        }
        assertNoExecutorThreads();
        System.out.println("HeadlessServerTest OK");
    }

    private static HeadlessTransfer transfer(String fixtureUrl) {
        return new HeadlessTransfer(() -> new FakeMegaApi(fixtureUrl));
    }

    private static String resolvedRangeJson(String downloadUrl) {
        return "{\"source\":\"resolved\",\"download_url\":\"" + downloadUrl + "\",\"file_key\":\"" + FILE_KEY
                + "\",\"file_name\":\"fixture.bin\",\"size\":36,\"range\":{\"start\":7,\"end\":15}}";
    }

    private static String emptyResolvedJson() {
        return "{\"source\":\"resolved\",\"download_url\":\"" + DOWNLOAD_URL + "\",\"file_key\":\"" + FILE_KEY
                + "\",\"file_name\":\"empty.bin\",\"size\":0,\"range\":null}";
    }

    private static Response request(HttpServer server, String method, String path, String authorization, String body) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL("http://127.0.0.1:" + server.getAddress().getPort() + path).openConnection();
        connection.setRequestMethod(method);
        connection.setConnectTimeout(2_000);
        connection.setReadTimeout(2_000);
        if (authorization != null) {
            connection.setRequestProperty("Authorization", authorization);
        }
        if (body != null) {
            connection.setDoOutput(true);
            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(bytes.length);
            try (OutputStream output = connection.getOutputStream()) {
                output.write(bytes);
            }
        }
        int status = connection.getResponseCode();
        try (java.io.InputStream input = status >= 400 ? connection.getErrorStream() : connection.getInputStream()) {
            return new Response(status, input == null ? "" : new String(readAll(input), StandardCharsets.UTF_8), connection);
        } finally {
            connection.disconnect();
        }
    }

    private static HttpServer contentServer(byte[] plaintext) throws Exception {
        String key = eightWordKey();
        byte[] ciphertext = CryptTools.genCrypter("AES", "AES/CTR/NoPadding", CryptTools.initMEGALinkKey(key), CryptTools.initMEGALinkKeyIV(key)).doFinal(plaintext);
        return server(exchange -> write(exchange, 200, ciphertext));
    }

    private static HttpServer server(ExchangeHandler handler) throws IOException {
        HttpServer server = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0);
        server.createContext("/", exchange -> handler.handle(exchange));
        server.start();
        return server;
    }

    private static String url(HttpServer server) {
        return "http://127.0.0.1:" + server.getAddress().getPort();
    }

    private static void write(HttpExchange exchange, int status, byte[] body) throws IOException {
        exchange.sendResponseHeaders(status, body.length);
        try (OutputStream output = exchange.getResponseBody()) {
            output.write(body);
        }
    }

    private static byte[] readAll(java.io.InputStream input) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[256];
        for (int read; (read = input.read(buffer)) >= 0;) {
            output.write(buffer, 0, read);
        }
        return output.toByteArray();
    }

    private static String eightWordKey() {
        byte[] words = new byte[32];
        for (int index = 0; index < words.length; index++) {
            words[index] = (byte) (index + 1);
        }
        return Base64.getUrlEncoder().withoutPadding().encodeToString(words);
    }

    private static void assertStatus(int expected, Response response) {
        if (response.status != expected) {
            throw new AssertionError("expected status " + expected + " but got " + response.status + ": " + response.body);
        }
    }

    private static void assertJson(int expectedStatus, Response response, String expectedBody) {
        assertStatus(expectedStatus, response);
        if (!expectedBody.equals(response.body)) {
            throw new AssertionError("expected " + expectedBody + " but got " + response.body);
        }
    }

    private static void assertBody(int expectedStatus, Response response, String expectedBody) {
        assertStatus(expectedStatus, response);
        if (!expectedBody.equals(response.body)) {
            throw new AssertionError("expected " + expectedBody + " but got " + response.body);
        }
    }

    private static void assertHeaders(Response response, String fileName, String contentLength, String contentRange) {
        assertEquals("attachment; filename=\"" + fileName + "\"", response.contentDisposition);
        assertEquals("application/octet-stream", response.contentType);
        assertEquals("bytes", response.acceptRanges);
        assertEquals(contentLength, response.contentLength);
        assertEquals(contentRange, response.contentRange);
    }

    private static void assertEquals(String expected, String actual) {
        if (expected == null ? actual != null : !expected.equals(actual)) {
            throw new AssertionError("expected " + expected + " but got " + actual);
        }
    }

    private static void assertNoExecutorThreads() {
        for (Thread thread : Thread.getAllStackTraces().keySet()) {
            if (thread.isAlive() && thread.getName().startsWith("megabasterd-headless")) {
                throw new AssertionError("executor thread remains alive: " + thread.getName());
            }
        }
    }

    private static void assertError(int expectedStatus, Response response, String code) {
        assertStatus(expectedStatus, response);
        if (!response.body.contains("\"code\":\"" + code + "\"")) {
            throw new AssertionError("expected error code " + code + " but got " + response.body);
        }
        if (response.body.contains(LINK) || response.body.contains(QUOTA_LINK) || response.body.contains(DOWNLOAD_URL) || response.body.contains(FILE_KEY)) {
            throw new AssertionError("error leaked request secret: " + response.body);
        }
    }

    private interface ExchangeHandler {
        void handle(HttpExchange exchange) throws IOException;
    }

    private static final class Response {
        private final int status;
        private final String body;
        private final String contentDisposition;
        private final String contentType;
        private final String acceptRanges;
        private final String contentLength;
        private final String contentRange;
        private final String transferEncoding;

        private Response(int status, String body, HttpURLConnection connection) {
            this.status = status;
            this.body = body;
            this.contentDisposition = connection.getHeaderField("Content-Disposition");
            this.contentType = connection.getHeaderField("Content-Type");
            this.acceptRanges = connection.getHeaderField("Accept-Ranges");
            this.contentLength = connection.getHeaderField("Content-Length");
            this.contentRange = connection.getHeaderField("Content-Range");
            this.transferEncoding = connection.getHeaderField("Transfer-Encoding");
        }
    }

    private static final class FakeMegaApi extends MegaAPI {
        private final String fixtureUrl;

        private FakeMegaApi(String fixtureUrl) {
            this.fixtureUrl = fixtureUrl;
        }

        @Override
        public String[] getMegaFileMetadata(String link) throws MegaAPIException {
            if (link.contains("quota-id")) {
                throw new MegaAPIException(-17);
            }
            return new String[]{"fixture.bin", "36", eightWordKey()};
        }

        @Override
        public String getMegaFileDownloadUrl(String link) {
            return fixtureUrl;
        }
    }
}
