package com.tonikelope.megabasterd;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Base64;
import javax.crypto.Cipher;

public final class HeadlessTransferTest {

    private static final byte[] PLAINTEXT = "0123456789abcdefghijklmnopqrstuvwxyz".getBytes(StandardCharsets.UTF_8);

    public static void main(String[] args) throws Exception {
        String fileKey = makeEightWordFileKey();
        byte[] ciphertext = encrypt(PLAINTEXT, fileKey);
        HttpServer fixture = encryptedFixture(ciphertext, 200);
        HttpServer quotaFixture = encryptedFixture(new byte[0], 509);

        try {
            String fixtureUrl = url(fixture);
            HeadlessTransfer transfer = new HeadlessTransfer(() -> new FakeMegaAPI(fixtureUrl, fileKey, PLAINTEXT.length));
            HeadlessTransfer.ResolvedTransfer resolved = resolved(fixtureUrl, fileKey, PLAINTEXT.length);

            assertBytes(PLAINTEXT, streamResolved(transfer, resolved, null));
            assertBytes("789abcdef".getBytes(StandardCharsets.UTF_8),
                    streamResolved(transfer, resolved, new HeadlessTransfer.ByteRange(7, 15L)));
            assertPublicMetadata(transfer.inspectPublic(" https://mega.nz/file/public-id#public-key "));
            assertQuota(transfer, resolved(url(quotaFixture), fileKey, PLAINTEXT.length));
            assertCancelled(transfer, resolved);
            assertInvalidRanges();
        } finally {
            fixture.stop(0);
            quotaFixture.stop(0);
        }

        System.out.println("HeadlessTransferTest OK");
    }

    private static void assertPublicMetadata(HeadlessTransfer.PublicMetadata metadata) {
        assertEquals("fixture.txt", metadata.fileName);
        assertEquals(PLAINTEXT.length, metadata.size);
        assertEquals(makeEightWordFileKey(), metadata.fileKey);
        assertEquals("http://example.invalid/download", metadata.downloadUrl);
    }

    private static void assertQuota(HeadlessTransfer transfer, HeadlessTransfer.ResolvedTransfer transferToQuota) throws Exception {
        try {
            transfer.streamResolved(transferToQuota, null, new ByteArrayOutputStream());
            throw new AssertionError("expected quota error");
        } catch (HeadlessTransferException error) {
            assertEquals(HeadlessTransferException.Code.QUOTA, error.code);
        }
    }

    private static void assertCancelled(HeadlessTransfer transfer, HeadlessTransfer.ResolvedTransfer resolved) throws Exception {
        try {
            transfer.streamResolved(resolved, null, new OutputStream() {
                @Override
                public void write(int value) throws IOException {
                    throw new IOException("client disconnected");
                }
            });
            throw new AssertionError("expected cancellation error");
        } catch (HeadlessTransferException error) {
            assertEquals(HeadlessTransferException.Code.CANCELLED, error.code);
        }
    }

    private static void assertInvalidRanges() {
        assertThrows(() -> new HeadlessTransfer.ByteRange(-1, null));
        assertThrows(() -> new HeadlessTransfer.ByteRange(4, 3L));
    }

    private static byte[] streamResolved(HeadlessTransfer transfer, HeadlessTransfer.ResolvedTransfer resolved, HeadlessTransfer.ByteRange range) throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        transfer.streamResolved(resolved, range, output);
        return output.toByteArray();
    }

    private static HeadlessTransfer.ResolvedTransfer resolved(String downloadUrl, String fileKey, long size) {
        return new HeadlessTransfer.ResolvedTransfer(downloadUrl, fileKey, "fixture.txt", size);
    }

    private static String makeEightWordFileKey() {
        ByteBuffer words = ByteBuffer.allocate(32);
        for (int word = 1; word <= 8; word++) {
            words.putInt(word);
        }
        return Base64.getUrlEncoder().withoutPadding().encodeToString(words.array());
    }

    private static byte[] encrypt(byte[] plaintext, String fileKey) throws Exception {
        Cipher cipher = CryptTools.genCrypter("AES", "AES/CTR/NoPadding",
                CryptTools.initMEGALinkKey(fileKey), CryptTools.initMEGALinkKeyIV(fileKey));
        return cipher.doFinal(plaintext);
    }

    private static HttpServer encryptedFixture(byte[] body, int status) throws IOException {
        HttpServer server = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0);
        server.createContext("/", exchange -> write(exchange, status, body));
        server.start();
        return server;
    }

    private static void write(HttpExchange exchange, int status, byte[] body) throws IOException {
        exchange.sendResponseHeaders(status, body.length);
        try (OutputStream response = exchange.getResponseBody()) {
            response.write(body);
        }
    }

    private static String url(HttpServer server) {
        return "http://127.0.0.1:" + server.getAddress().getPort();
    }

    private static void assertBytes(byte[] expected, byte[] actual) {
        if (!Arrays.equals(expected, actual)) {
            throw new AssertionError("expected " + new String(expected, StandardCharsets.UTF_8)
                    + " but got " + new String(actual, StandardCharsets.UTF_8));
        }
    }

    private static void assertEquals(Object expected, Object actual) {
        if (!expected.equals(actual)) {
            throw new AssertionError("expected " + expected + " but got " + actual);
        }
    }

    private static void assertEquals(long expected, long actual) {
        if (expected != actual) {
            throw new AssertionError("expected " + expected + " but got " + actual);
        }
    }

    private static void assertThrows(ThrowingRunnable runnable) {
        try {
            runnable.run();
            throw new AssertionError("expected invalid input");
        } catch (IllegalArgumentException expected) {
            // Expected: invalid inclusive ranges are rejected at construction.
        } catch (Exception error) {
            throw new AssertionError(error);
        }
    }

    private interface ThrowingRunnable {
        void run() throws Exception;
    }

    private static final class FakeMegaAPI extends MegaAPI {
        private final String downloadUrl;
        private final String fileKey;
        private final long size;

        private FakeMegaAPI(String downloadUrl, String fileKey, long size) {
            this.downloadUrl = downloadUrl;
            this.fileKey = fileKey;
            this.size = size;
        }

        @Override
        public String[] getMegaFileMetadata(String link) {
            return new String[]{"fixture.txt", String.valueOf(size), fileKey};
        }

        @Override
        public String getMegaFileDownloadUrl(String link) {
            return "http://example.invalid/download";
        }
    }
}
