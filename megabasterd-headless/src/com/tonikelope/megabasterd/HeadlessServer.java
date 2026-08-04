package com.tonikelope.megabasterd;

import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpContext;
import com.sun.net.httpserver.HttpHandler;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.Executor;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

public final class HeadlessServer {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String MIME_TYPE = "application/octet-stream";

    private HeadlessServer() {
    }

    public static HttpServer create(int port, String secret, HeadlessTransfer transfer) throws IOException {
        if (secret == null || secret.trim().isEmpty()) {
            throw new IllegalArgumentException("MEGABASTERD_INTERNAL_SECRET is required");
        }
        if (transfer == null) {
            throw new IllegalArgumentException("transfer is required");
        }

        HttpServer server = HttpServer.create(new InetSocketAddress(port), 0);
        ThreadPoolExecutor executor = new ThreadPoolExecutor(4, 4, 0L, TimeUnit.MILLISECONDS, new ArrayBlockingQueue<Runnable>(32), daemonThreads(), new ThreadPoolExecutor.AbortPolicy());
        server.setExecutor(executor);
        server.createContext("/health", exchange -> health(exchange, secret));
        server.createContext("/inspect", exchange -> inspect(exchange, secret, transfer));
        server.createContext("/stream", exchange -> stream(exchange, secret, transfer));
        return new ManagedServer(server, executor);
    }

    public static void main(String[] args) throws Exception {
        String secret = System.getenv("MEGABASTERD_INTERNAL_SECRET");
        int port = port(System.getenv("PORT"));
        HttpServer server = create(port, secret, new HeadlessTransfer(MegaAPI::new));
        server.start();
    }

    private static void health(HttpExchange exchange, String secret) throws IOException {
        if (!authorized(exchange, secret)) {
            error(exchange, 401, "UNAUTHORIZED");
            return;
        }
        if (!"GET".equals(exchange.getRequestMethod())) {
            error(exchange, 405, "METHOD_NOT_ALLOWED");
            return;
        }
        write(exchange, 200, JSON.createObjectNode().put("status", "ok").put("service", "megabasterd-headless"));
    }

    private static void inspect(HttpExchange exchange, String secret, HeadlessTransfer transfer) throws IOException {
        if (!authorized(exchange, secret)) {
            error(exchange, 401, "UNAUTHORIZED");
            return;
        }
        if (!"POST".equals(exchange.getRequestMethod())) {
            error(exchange, 405, "METHOD_NOT_ALLOWED");
            return;
        }
        try {
            String link = requiredText(request(exchange), "link");
            HeadlessTransfer.PublicMetadata metadata = transfer.inspectPublic(link);
            write(exchange, 200, JSON.createObjectNode().put("file_name", metadata.fileName).put("size", metadata.size).put("mime_type", MIME_TYPE));
        } catch (HeadlessTransferException error) {
            error(exchange, status(error), error.getCode().name());
        } catch (Exception error) {
            error(exchange, 400, "INVALID_INPUT");
        }
    }

    private static void stream(HttpExchange exchange, String secret, HeadlessTransfer transfer) throws IOException {
        if (!authorized(exchange, secret)) {
            error(exchange, 401, "UNAUTHORIZED");
            return;
        }
        if (!"POST".equals(exchange.getRequestMethod())) {
            error(exchange, 405, "METHOD_NOT_ALLOWED");
            return;
        }
        try {
            StreamRequest request = streamRequest(request(exchange), transfer);
            if (request.transfer.size == 0) {
                if (request.range != null) {
                    throw new IllegalArgumentException("invalid range");
                }
                emptyStream(exchange, request.transfer.fileName);
                return;
            }
            long start = request.range == null ? 0 : request.range.start;
            long end = request.range == null ? request.transfer.size - 1 : request.range.end == null ? request.transfer.size - 1 : request.range.end;
            if (start < 0 || end < start || end >= request.transfer.size) {
                throw new IllegalArgumentException("invalid range");
            }
            long length = end - start + 1;
            exchange.getResponseHeaders().set("Content-Disposition", "attachment; filename=\"" + headerFileName(request.transfer.fileName) + "\"");
            exchange.getResponseHeaders().set("Content-Type", MIME_TYPE);
            exchange.getResponseHeaders().set("Accept-Ranges", "bytes");
            exchange.getResponseHeaders().set("Content-Length", String.valueOf(length));
            if (request.range != null) {
                exchange.getResponseHeaders().set("Content-Range", "bytes " + start + "-" + end + "/" + request.transfer.size);
            }
            exchange.sendResponseHeaders(request.range == null ? 200 : 206, length);
            try {
                transfer.streamResolved(request.transfer, request.range, exchange.getResponseBody());
            } catch (HeadlessTransferException ignored) {
                // Headers may already be on the wire; closing is the only safe response.
            } finally {
                exchange.close();
            }
        } catch (HeadlessTransferException error) {
            error(exchange, status(error), error.getCode().name());
        } catch (Exception error) {
            error(exchange, 400, "INVALID_INPUT");
        }
    }

    private static StreamRequest streamRequest(JsonNode request, HeadlessTransfer transfer) throws Exception {
        String source = requiredText(request, "source");
        HeadlessTransfer.ByteRange range = range(request.get("range"));
        if ("public".equals(source)) {
            HeadlessTransfer.PublicMetadata metadata = transfer.inspectPublic(requiredText(request, "link"));
            return new StreamRequest(new HeadlessTransfer.ResolvedTransfer(metadata.downloadUrl, metadata.fileKey, metadata.fileName, metadata.size), range);
        }
        if ("resolved".equals(source)) {
            return new StreamRequest(new HeadlessTransfer.ResolvedTransfer(requiredText(request, "download_url"), requiredText(request, "file_key"), requiredText(request, "file_name"), requiredLong(request, "size")), range);
        }
        throw new IllegalArgumentException("invalid source");
    }

    private static HeadlessTransfer.ByteRange range(JsonNode range) {
        if (range == null || range.isNull()) {
            return null;
        }
        if (!range.isObject() || !range.has("start") || !range.get("start").isIntegralNumber()) {
            throw new IllegalArgumentException("invalid range");
        }
        JsonNode end = range.get("end");
        if (end != null && !end.isNull() && !end.isIntegralNumber()) {
            throw new IllegalArgumentException("invalid range");
        }
        return new HeadlessTransfer.ByteRange(range.get("start").longValue(), end == null || end.isNull() ? null : end.longValue());
    }

    private static JsonNode request(HttpExchange exchange) throws IOException {
        try (JsonParser parser = JSON.getFactory().createParser(exchange.getRequestBody())) {
            JsonNode request = JSON.readTree(parser);
            if (request == null || !request.isObject() || parser.nextToken() != null) {
                throw new IllegalArgumentException("JSON object is required");
            }
            return request;
        }
    }

    private static String requiredText(JsonNode object, String field) {
        JsonNode value = object.get(field);
        if (value == null || !value.isTextual() || value.textValue().trim().isEmpty()) {
            throw new IllegalArgumentException(field + " is required");
        }
        return value.textValue();
    }

    private static long requiredLong(JsonNode object, String field) {
        JsonNode value = object.get(field);
        if (value == null || !value.isIntegralNumber() || value.longValue() < 0) {
            throw new IllegalArgumentException(field + " is required");
        }
        return value.longValue();
    }

    private static boolean authorized(HttpExchange exchange, String secret) {
        byte[] expected = ("Bearer " + secret).getBytes(StandardCharsets.UTF_8);
        byte[] supplied = String.valueOf(exchange.getRequestHeaders().getFirst("Authorization")).getBytes(StandardCharsets.UTF_8);
        return MessageDigest.isEqual(expected, supplied);
    }

    private static void write(HttpExchange exchange, int status, ObjectNode body) throws IOException {
        byte[] bytes = JSON.writeValueAsBytes(body);
        exchange.getResponseHeaders().set("Content-Type", "application/json");
        exchange.sendResponseHeaders(status, bytes.length);
        exchange.getResponseBody().write(bytes);
        exchange.close();
    }

    private static void error(HttpExchange exchange, int status, String code) throws IOException {
        write(exchange, status, JSON.createObjectNode().put("code", code));
    }

    private static void emptyStream(HttpExchange exchange, String fileName) throws IOException {
        exchange.getResponseHeaders().set("Content-Disposition", "attachment; filename=\"" + headerFileName(fileName) + "\"");
        exchange.getResponseHeaders().set("Content-Type", MIME_TYPE);
        exchange.getResponseHeaders().set("Accept-Ranges", "bytes");
        exchange.getResponseHeaders().set("Content-Length", "0");
        exchange.sendResponseHeaders(200, -1);
        exchange.close();
    }

    private static int status(HeadlessTransferException error) {
        switch (error.getCode()) {
            case INVALID_INPUT:
                return 400;
            case NOT_FOUND:
                return 404;
            case QUOTA:
                return 429;
            default:
                return 502;
        }
    }

    private static String headerFileName(String fileName) {
        return fileName.replace('"', '_').replace('\r', '_').replace('\n', '_');
    }

    private static int port(String value) {
        if (value == null || value.trim().isEmpty()) {
            return 8788;
        }
        try {
            int port = Integer.parseInt(value);
            if (port < 1 || port > 65535) {
                throw new NumberFormatException();
            }
            return port;
        } catch (NumberFormatException error) {
            throw new IllegalArgumentException("PORT must be a valid TCP port");
        }
    }

    private static ThreadFactory daemonThreads() {
        return runnable -> {
            Thread thread = new Thread(runnable, "megabasterd-headless");
            thread.setDaemon(true);
            return thread;
        };
    }

    private static final class StreamRequest {
        private final HeadlessTransfer.ResolvedTransfer transfer;
        private final HeadlessTransfer.ByteRange range;

        private StreamRequest(HeadlessTransfer.ResolvedTransfer transfer, HeadlessTransfer.ByteRange range) {
            this.transfer = transfer;
            this.range = range;
        }
    }

    private static final class ManagedServer extends HttpServer {
        private final HttpServer server;
        private final ThreadPoolExecutor executor;

        private ManagedServer(HttpServer server, ThreadPoolExecutor executor) {
            this.server = server;
            this.executor = executor;
        }

        @Override
        public void bind(InetSocketAddress address, int backlog) throws IOException {
            server.bind(address, backlog);
        }

        @Override
        public void start() {
            server.start();
        }

        @Override
        public void setExecutor(Executor executor) {
            server.setExecutor(executor);
        }

        @Override
        public Executor getExecutor() {
            return server.getExecutor();
        }

        @Override
        public void stop(int delay) {
            server.stop(delay);
            executor.shutdownNow();
            try {
                executor.awaitTermination(2, TimeUnit.SECONDS);
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
            }
        }

        @Override
        public HttpContext createContext(String path, HttpHandler handler) {
            return server.createContext(path, handler);
        }

        @Override
        public HttpContext createContext(String path) {
            return server.createContext(path);
        }

        @Override
        public void removeContext(String path) throws IllegalArgumentException {
            server.removeContext(path);
        }

        @Override
        public void removeContext(HttpContext context) {
            server.removeContext(context);
        }

        @Override
        public InetSocketAddress getAddress() {
            return server.getAddress();
        }
    }
}
