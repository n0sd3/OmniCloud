# MegaBasterd Downloads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route private-account and public-link MEGA downloads through a reproducible headless MegaBasterd sidecar, retain one `megajs` fallback attempt, and let users download or import public links from My Drive.

**Architecture:** Build the upstream MegaBasterd 8.57 source at pinned commit `3b204d226515a6f4ecb6630371e19722077b03fc`, overlay a small Java 8 HTTP server that reuses `MegaAPI`, `CryptTools`, and the streaming approach in `KissVideoStreamServer`, and expose it only inside Docker Compose. The Node backend owns authentication, validation, fallback policy, private-node resolution, import sessions, and public routes; Vue adds one modal and reuses the current transfer queue and upload WebSocket.

**Tech Stack:** Java 8-compatible source on Eclipse Temurin 17, Maven, JDK `HttpServer`, MegaBasterd 8.57, Node.js 22, Express 5, `megajs` 1.3, Node streams/fetch, Vue 3, Pinia, Vue I18n, Docker Compose, native `node:test`.

## Global Constraints

- Primary MEGA file bytes must flow through MegaBasterd; `megajs` may resolve a private node's short-lived signed URL and key but must not transfer primary-path bytes.
- Try `megajs` exactly once only when the sidecar fails before exposing response bytes; never join a fallback stream to a partial primary stream.
- Client cancellation, malformed links, missing files, invalid credentials, and MEGA quota errors are terminal and do not trigger fallback.
- Accept one canonical HTTPS MEGA file link per request; reject folder links and every non-MEGA host before network access.
- Do not persist or log credentials, signed transfer URLs, file keys, or complete public links.
- Bind the sidecar to the Compose network only, require `MEGABASTERD_INTERNAL_SECRET`, and run the final image as a non-root user.
- Pin MegaBasterd to commit `3b204d226515a6f4ecb6630371e19722077b03fc`; do not fetch a floating release at runtime.
- Keep the derived sidecar and its source/build notices under GPL-3.0; keep existing OmniCloud application code under its current MIT license.
- Public imports use the currently open virtual path and the existing allocation, upload fallback, cache capture, sync, and WebSocket progress flows.
- Add no Java web framework, Node HTTP client, retry package, queue package, or frontend component library.
- Preserve the user's unrelated changes in `backend/test/googlePhotosImportService.test.js` and exclude that file from task commits unless this plan genuinely modifies it.

---

## File Structure

- Create `megabasterd-headless/Dockerfile`: clone the pinned upstream source, overlay/compile the headless classes, run Java self-tests, and produce the non-root runtime image.
- Create `megabasterd-headless/src/com/tonikelope/megabasterd/HeadlessTransfer.java`: public-link inspection, resolved-transfer AES-CTR streaming, range alignment, and safe error codes using MegaBasterd primitives.
- Create `megabasterd-headless/src/com/tonikelope/megabasterd/HeadlessServer.java`: internal authentication, JSON contracts, `/health`, `/inspect`, and `/stream`.
- Create `megabasterd-headless/src/com/tonikelope/megabasterd/HeadlessHealthcheck.java`: authenticated loopback health probe for the minimal JRE image.
- Create `megabasterd-headless/test/com/tonikelope/megabasterd/HeadlessTransferTest.java`: deterministic encrypted fixture, ranges, metadata, and cancellation self-checks.
- Create `megabasterd-headless/test/com/tonikelope/megabasterd/HeadlessServerTest.java`: HTTP authentication and contract self-checks.
- Create `megabasterd-headless/LICENSE` and `megabasterd-headless/NOTICE.md`: GPL-3.0 text, upstream URL/revision, modifications, build, and source availability.
- Create `backend/src/services/megaBasterdClient.js`: authenticated sidecar fetches, timeout/cancellation, health, and Web-to-Node stream conversion.
- Create `backend/src/services/megaDownloadService.js`: canonical public-link validation, public `megajs` fallback, sidecar-first policy, and safe error classification.
- Create `backend/src/services/megaLinkImportService.js`: background import lifecycle and cancellation through the existing upload pipeline.
- Create `backend/src/routes/megaLinkRoutes.js`: authenticated inspect, direct download, import, and import-cancel routes.
- Create `backend/test/megaBasterdClient.test.js`: client headers, timeouts, stream conversion, and redaction.
- Create `backend/test/megaDownloadService.test.js`: validation, public fallback policy, terminal errors, and no mid-stream fallback.
- Create `backend/test/megaAdapterDownload.test.js`: private resolved transfer, range forwarding, and `megajs` fallback.
- Create `backend/test/megaLinkRoutes.test.js`: auth, SSRF rejection, download headers, import destination, progress, and cancel.
- Modify `backend/src/adapters/MegaAdapter.js`: resolve private transfer metadata and delegate downloads.
- Modify `backend/src/services/uploadService.js`: export the existing upload-start transition for server-originated imports.
- Modify `backend/src/config/env.js`, `backend/.env.example`: sidecar URL, required secret, timeout, and redacted status.
- Modify `backend/src/routes/healthRoutes.js`, `backend/src/app.js`: report sidecar/fallback health and mount public-link routes.
- Modify `docker-compose.yml`: add the internal sidecar and API wiring without making API startup depend on sidecar health.
- Create `frontend/src/components/MegaLinkModal.vue`: accessible link entry with Download and Import actions.
- Create `frontend/src/utils/megaLink.js` and `frontend/test/megaLink.test.js`: immediate client-side MEGA file-link recognition.
- Modify `frontend/src/components/DriveShell.vue`, `frontend/src/views/MyDriveView.vue`: expose and host the modal in both responsive create menus.
- Modify `frontend/src/services/api.js`, `frontend/src/stores/uploadQueue.js`: public-link API calls, tracked direct downloads, import WebSocket, and remote cancellation.
- Modify `frontend/src/locales/en.json`, `frontend/src/locales/id.json`: all new visible copy.
- Modify `README.md`, `docs/provider-setup.md`: deployment, licensing boundary, API routes, fallback behavior, and manual smoke test.

---

### Task 1: Headless MegaBasterd Transfer Core

**Files:**
- Create: `megabasterd-headless/src/com/tonikelope/megabasterd/HeadlessTransfer.java`
- Create: `megabasterd-headless/test/com/tonikelope/megabasterd/HeadlessTransferTest.java`

**Interfaces:**
- Produces: `HeadlessTransfer.ByteRange(long start, Long end)` with validated inclusive bounds.
- Produces: `HeadlessTransfer.ResolvedTransfer(String downloadUrl, String fileKey, String fileName, long size)`.
- Produces: `HeadlessTransfer(MegaApiFactory megaApiFactory)` for deterministic public-link tests.
- Produces: `HeadlessTransfer.PublicMetadata inspectPublic(String link)`.
- Produces: `void streamPublic(String link, ByteRange range, OutputStream output)` and `void streamResolved(ResolvedTransfer transfer, ByteRange range, OutputStream output)`.
- Produces: `HeadlessTransferException` with stable codes `INVALID_INPUT`, `NOT_FOUND`, `QUOTA`, `UPSTREAM`, and `CANCELLED`.

- [ ] **Step 1: Write a deterministic failing Java self-test**

Create a `main`-based test with no test dependency. Generate a fixed eight-word MEGA file key, encrypt `0123456789abcdefghijklmnopqrstuvwxyz` using MegaBasterd's own `CryptTools.initMEGALinkKey`, `initMEGALinkKeyIV`, and `genCrypter`, and serve ciphertext from a loopback `HttpServer`. Assert full and unaligned ranged plaintext:

```java
byte[] plaintext = "0123456789abcdefghijklmnopqrstuvwxyz".getBytes(StandardCharsets.UTF_8);
String fileKey = makeEightWordFileKey();
byte[] ciphertext = encrypt(plaintext, fileKey);
HttpServer fixture = encryptedFixture(ciphertext);
HeadlessTransfer transfer = new HeadlessTransfer(() -> new FakeMegaAPI(fixtureUrl, fileKey, plaintext.length));

assertBytes(plaintext, streamResolved(transfer, resolved(fixtureUrl, fileKey, plaintext.length), null));
assertBytes("789abcdef".getBytes(StandardCharsets.UTF_8),
	streamResolved(transfer, resolved(fixtureUrl, fileKey, plaintext.length), new ByteRange(7, 15L)));
```

Also assert that a fake `MegaAPI.getMegaFileMetadata()` response becomes `PublicMetadata`, that a source `509` becomes code `QUOTA`, and that an `OutputStream` throwing `IOException` stops the copy as `CANCELLED`.

- [ ] **Step 2: Compile the test against the pinned upstream jar and verify RED**

Run inside a temporary pinned upstream checkout:

```bash
mvn -q -DskipTests package
javac -cp target/MegaBasterd-8.57-jar-with-dependencies.jar -d /tmp/mb-test-classes \
  megabasterd-headless/src/com/tonikelope/megabasterd/HeadlessTransfer.java \
  megabasterd-headless/test/com/tonikelope/megabasterd/HeadlessTransferTest.java
```

Expected: compilation fails because `HeadlessTransfer` and its value classes do not exist.

- [ ] **Step 3: Implement the minimal transfer core using MegaBasterd primitives**

Normalize public links with `MiscTools.newMegaLinks2Legacy(link).trim()`. For public metadata and signed URLs, call:

```java
String[] metadata = megaApi.getMegaFileMetadata(legacyLink);
String downloadUrl = megaApi.getMegaFileDownloadUrl(legacyLink);
```

For resolved streaming, align the first encrypted byte to the AES block and apply the same IV forwarding used by `KissVideoStreamServer`:

```java
long requestedStart = range == null ? 0 : range.start;
long requestedEnd = range == null || range.end == null ? transfer.size - 1 : range.end;
long alignedStart = requestedStart - (requestedStart % 16);
int skip = (int) (requestedStart - alignedStart);
URL source = new URL(transfer.downloadUrl + "/" + alignedStart + "-" + requestedEnd);
Cipher cipher = CryptTools.genDecrypter(
	"AES", "AES/CTR/NoPadding",
	CryptTools.initMEGALinkKey(transfer.fileKey),
	alignedStart == 0
		? CryptTools.initMEGALinkKeyIV(transfer.fileKey)
		: CryptTools.forwardMEGALinkKeyIV(CryptTools.initMEGALinkKeyIV(transfer.fileKey), alignedStart)
);
```

Require source status `200`; translate `509` to `QUOTA`; use fixed connect/read timeouts; skip exactly `skip` decrypted bytes; copy exactly `requestedEnd - requestedStart + 1`; close the upstream connection in `finally`. Do not buffer a complete file or implement proxy rotation.

- [ ] **Step 4: Run the self-test and verify GREEN**

Run the compile command from Step 2 followed by:

```bash
java -ea -cp /tmp/mb-test-classes:target/MegaBasterd-8.57-jar-with-dependencies.jar \
  com.tonikelope.megabasterd.HeadlessTransferTest
```

Expected: exit 0 and `HeadlessTransferTest OK`.

- [ ] **Step 5: Commit Task 1**

```bash
git add megabasterd-headless/src/com/tonikelope/megabasterd/HeadlessTransfer.java \
  megabasterd-headless/test/com/tonikelope/megabasterd/HeadlessTransferTest.java
git commit -m "feat: add headless MegaBasterd transfer core"
```

---

### Task 2: Authenticated Sidecar HTTP Service and Image

**Files:**
- Create: `megabasterd-headless/src/com/tonikelope/megabasterd/HeadlessServer.java`
- Create: `megabasterd-headless/src/com/tonikelope/megabasterd/HeadlessHealthcheck.java`
- Create: `megabasterd-headless/test/com/tonikelope/megabasterd/HeadlessServerTest.java`
- Create: `megabasterd-headless/Dockerfile`
- Create: `megabasterd-headless/LICENSE`
- Create: `megabasterd-headless/NOTICE.md`

**Interfaces:**
- Consumes: all Task 1 `HeadlessTransfer` interfaces.
- Produces: `HeadlessServer.create(int port, String secret, HeadlessTransfer transfer): HttpServer` for tests.
- Produces: `HeadlessHealthcheck.main(String[])`, which exits nonzero unless authenticated loopback health returns HTTP 200.
- Produces: `GET /health`, `POST /inspect`, and `POST /stream` on port `8788`.
- JSON inspect response: `{"file_name":"name.bin","size":123,"mime_type":"application/octet-stream"}`.
- JSON stream request: either `{"source":"public","link":"...","range":{"start":0,"end":9}}` or `{"source":"resolved","download_url":"...","file_key":"...","file_name":"name.bin","size":123,"range":null}`.

- [ ] **Step 1: Write failing HTTP contract self-tests**

Start `HeadlessServer.create(0, "test-secret", fakeTransfer)` and use `HttpURLConnection` to assert:

```java
assertStatus(401, request("GET", "/health", null, null));
assertStatus(200, request("GET", "/health", "Bearer test-secret", null));
assertJson(200, request("POST", "/inspect", "Bearer test-secret", "{\"link\":\"https://mega.nz/file/id#key\"}"),
	"{\"file_name\":\"fixture.bin\",\"size\":36,\"mime_type\":\"application/octet-stream\"}");
assertBody(206, request("POST", "/stream", "Bearer test-secret", resolvedRangeJson()), "789abcdef");
```

Assert malformed JSON returns `400/INVALID_INPUT`, fake quota returns `429/QUOTA`, and exception messages never contain the submitted link, signed URL, or key.

- [ ] **Step 2: Compile and verify RED**

Run the Task 1 compile command with `HeadlessServer.java` and `HeadlessServerTest.java` added.

Expected: compilation fails because `HeadlessServer.create` is missing.

- [ ] **Step 3: Implement the server with JDK and bundled Jackson only**

Use `com.sun.net.httpserver.HttpServer`, `ObjectMapper`, constant-time UTF-8 bearer comparison with `MessageDigest.isEqual`, a bounded fixed thread pool, and one route handler per path. Bind `main` to `0.0.0.0`, read `MEGABASTERD_INTERNAL_SECRET`, reject a blank secret, and default `PORT` to `8788`.

For stream responses, set `Content-Disposition`, `Content-Type`, `Accept-Ranges`, `Content-Length`, and `Content-Range` before calling the transfer. Once headers are sent, close the exchange on failure rather than attempting a JSON error body.

Implement `HeadlessHealthcheck` with `HttpURLConnection`, an `Authorization` header built from the `MEGABASTERD_INTERNAL_SECRET` environment value, 2-second connect/read timeouts, and `System.exit(1)` for a missing secret, exception, or non-200 response.

- [ ] **Step 4: Run both Java self-tests and verify GREEN**

Expected: both print `OK`, leave no executor thread alive, and exit 0.

- [ ] **Step 5: Add the reproducible image and license boundary**

The Docker build must use the exact revision and overlay local source before Maven packaging:

```dockerfile
FROM maven:3.9-eclipse-temurin-17 AS build
ARG MEGABASTERD_COMMIT=3b204d226515a6f4ecb6630371e19722077b03fc
RUN git clone https://github.com/tonikelope/megabasterd.git /src \
 && cd /src && git checkout "$MEGABASTERD_COMMIT"
COPY src/ /src/src/main/java/
COPY test/ /src/headless-test/
RUN cd /src && mvn -q -DskipTests package \
 && javac -cp target/MegaBasterd-8.57-jar-with-dependencies.jar -d target/test-classes $(find headless-test -name '*.java') \
 && java -ea -cp target/test-classes:target/MegaBasterd-8.57-jar-with-dependencies.jar com.tonikelope.megabasterd.HeadlessTransferTest \
 && java -ea -cp target/test-classes:target/MegaBasterd-8.57-jar-with-dependencies.jar com.tonikelope.megabasterd.HeadlessServerTest

FROM eclipse-temurin:17-jre
RUN useradd --system --uid 10001 megabasterd
COPY --from=build /src/target/MegaBasterd-8.57-jar-with-dependencies.jar /app/megabasterd.jar
USER 10001
EXPOSE 8788
ENTRYPOINT ["java", "-Djava.awt.headless=true", "-cp", "/app/megabasterd.jar", "com.tonikelope.megabasterd.HeadlessServer"]
```

Ensure Maven actually packages the overlaid classes. Put the unmodified upstream GPL-3.0 license in `LICENSE`. `NOTICE.md` must name the repository, pinned commit, overlaid files, build command, and state that the full corresponding source is the pinned upstream source plus this directory.

- [ ] **Step 6: Build and smoke-test the image**

Run:

```bash
docker build -t omnicloud-megabasterd:test megabasterd-headless
docker run --rm -d --name omnicloud-megabasterd-test -e MEGABASTERD_INTERNAL_SECRET=test-secret -p 127.0.0.1:18788:8788 omnicloud-megabasterd:test
curl -fsS -H 'Authorization: Bearer test-secret' http://127.0.0.1:18788/health
docker stop omnicloud-megabasterd-test
```

Expected health body: `{"status":"ok","service":"megabasterd-headless"}`.

- [ ] **Step 7: Commit Task 2**

```bash
git add megabasterd-headless
git commit -m "feat: serve MegaBasterd downloads headlessly"
```

---

### Task 3: Node Sidecar Client, Fallback Policy, and Private Adapter

**Files:**
- Create: `backend/src/services/megaBasterdClient.js`
- Create: `backend/src/services/megaDownloadService.js`
- Create: `backend/test/megaBasterdClient.test.js`
- Create: `backend/test/megaDownloadService.test.js`
- Create: `backend/test/megaAdapterDownload.test.js`
- Modify: `backend/src/adapters/MegaAdapter.js`
- Modify: `backend/src/config/env.js`
- Modify: `backend/.env.example`

**Interfaces:**
- Produces: `createMegaBasterdClient({ baseUrl, secret, timeoutMs, fetchImpl })` with `health`, `inspectPublic`, `streamPublic`, and `streamResolved`.
- Produces: `MegaBasterdError(code, message, { fallbackEligible })`.
- Produces: `normalizeMegaFileLink(value): string`.
- Produces: `createMegaDownloadService({ client, MegaFile, logger, fallbackEnabled })` with `inspectPublic(link, options)`, `streamPublic(link, options)`, and `streamResolved(transfer, { range, fallback, signal })`.
- Produces: `MegaAdapter.resolvePrivateTransfer(fileRecord): Promise<{ downloadUrl, fileKey, fileName, size }>`.

- [ ] **Step 1: Write failing client and policy tests**

Use a loopback Node HTTP server, not request-shape-only mocks. Assert the bearer header, JSON body, `Readable` bytes, and abort behavior. Cover fallback decisions explicitly:

```js
test('sidecar unavailability falls back exactly once', async () => {
	let fallbackCalls = 0;
	const service = createMegaDownloadService({ client: unavailableClient(), MegaFile: FakeMegaFile, fallbackEnabled: true });
	const stream = await service.streamResolved(resolved, {
		fallback: async () => { fallbackCalls += 1; return Readable.from(['fallback']); },
	});
	assert.equal(await read(stream), 'fallback');
	assert.equal(fallbackCalls, 1);
});

test('quota is terminal', async () => {
	const service = createMegaDownloadService({ client: quotaClient(), MegaFile: FakeMegaFile });
	await assert.rejects(service.streamResolved(resolved, { fallback: mustNotRun }), /quota/i);
});

test('a primary stream error after return never opens fallback', async () => {
	const stream = await service.streamResolved(resolved, { fallback: mustNotRun });
	stream.resume();
	const [error] = await once(stream, 'error');
	assert.match(error.message, /mid-stream/);
});
```

Validate accepted modern and legacy file links plus rejected `http`, credentials-in-URL, deceptive suffix hosts, folder links, and non-MEGA URLs.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
npm --prefix backend test -- --test-name-pattern='MegaBasterd|MEGA file link|sidecar|quota|fallback'
```

Expected: module or export-not-found failures.

- [ ] **Step 3: Implement client and service policy**

Use native fetch, `AbortSignal.any([callerSignal, AbortSignal.timeout(timeoutMs)].filter(Boolean))`, and `Readable.fromWeb(response.body)`. Parse JSON only for non-stream and non-success responses. Map connection/timeout/sidecar `5xx`/`UNSUPPORTED` to `fallbackEligible: true`; map `INVALID_INPUT`, `NOT_FOUND`, `QUOTA`, caller abort, and all errors after a stream has been returned to `false`.

When `fallbackEnabled` is false, propagate even fallback-eligible initial errors without calling `megajs`. After public inspection, normalize `mime_type` with `guessMimeType(file_name) || 'application/octet-stream'` so imports do not rely on the sidecar's generic content type.

Canonical validation must be structural:

```js
const url = new URL(String(value || '').trim());
if (url.protocol !== 'https:' || url.username || url.password) throw invalid();
if (!['mega.nz', 'www.mega.nz', 'mega.co.nz', 'www.mega.co.nz'].includes(url.hostname.toLowerCase())) throw invalid();
if (!(/^\/file\/[^/]+$/.test(url.pathname) && url.hash.length > 1) && !/^#![^!]+![^!]+$/.test(url.hash)) throw invalid();
url.hostname = 'mega.nz';
return url.toString();
```

For public fallback use `MegaFile.fromURL(canonical)`, await `loadAttributes()`, then return its `download({ start, end })` stream. Keep fallback in one helper that catches only errors thrown before returning the primary stream.

- [ ] **Step 4: Write failing private adapter tests**

Build a `MegaAdapter(account, fakeDownloadService)` with an injected fake file whose `api.request` returns `{ g: 'https://signed.example/file', s: 36 }` and whose `key` is a Buffer. Assert `resolvePrivateTransfer` returns base64url key material and that `getDownloadStream(file, { start: 7, end: 15 })` passes the same range to the service. Make the service throw an eligible initial error and assert `file.download({ start: 7, end: 15 })` runs once.

- [ ] **Step 5: Implement private resolution and adapter delegation**

Inside `resolvePrivateTransfer`, reuse `findByRecord`, then call the authenticated `megajs` API only for a signed URL:

```js
const file = await this.findByRecord(fileRecord);
const response = await file.api.request({ a: 'g', g: 1, ssl: 2, n: file.nodeId });
return {
	downloadUrl: response.g,
	fileKey: Buffer.from(file.key).toString('base64url'),
	fileName: file.name || fileRecord.file_name,
	size: Number(response.s || file.size || fileRecord.size || 0),
};
```

Reject directories, missing keys, and non-HTTPS signed URLs. `getDownloadStream` calls `streamResolved` and supplies `fallback: () => file.download(range)`. Do not alter listing, upload, rename, or delete.

Add an optional second constructor parameter defaulting to the production singleton: `constructor(account, downloads = megaDownloadService)`. This keeps `adapterRegistry` unchanged and makes the private path testable without module mutation.

- [ ] **Step 6: Add exact environment configuration**

Add:

```js
megaBasterdUrl: process.env.MEGABASTERD_URL || 'http://megabasterd:8788',
megaBasterdSecret: process.env.MEGABASTERD_INTERNAL_SECRET || '',
megaBasterdTimeoutMs: Math.max(1000, Number(process.env.MEGABASTERD_TIMEOUT_MS || 15000)),
megaBasterdFallbackEnabled: process.env.MEGABASTERD_FALLBACK_ENABLED !== 'false',
```

The client must fail closed when the secret is blank; direct `megajs` fallback remains usable. Redaction exposes URL, timeout, enabled/disabled fallback, and configured/missing secret only.

- [ ] **Step 7: Run focused and full backend tests**

Run:

```bash
npm --prefix backend test -- --test-name-pattern='MegaBasterd|MEGA file link|sidecar|quota|fallback|private MEGA'
npm --prefix backend test
```

Expected: focused and full suites pass.

- [ ] **Step 8: Commit Task 3**

```bash
git add backend/src/services/megaBasterdClient.js backend/src/services/megaDownloadService.js \
  backend/src/adapters/MegaAdapter.js backend/src/config/env.js backend/.env.example \
  backend/test/megaBasterdClient.test.js backend/test/megaDownloadService.test.js backend/test/megaAdapterDownload.test.js
git commit -m "feat: route MEGA downloads through MegaBasterd"
```

---

### Task 4: Public-Link Routes and Streaming Import

**Files:**
- Create: `backend/src/services/megaLinkImportService.js`
- Create: `backend/src/routes/megaLinkRoutes.js`
- Create: `backend/test/megaLinkRoutes.test.js`
- Modify: `backend/src/services/uploadService.js`
- Modify: `backend/src/app.js`

**Interfaces:**
- Consumes: Task 3 `megaDownloadService`, `selectBestAccount`, `createUploadSession`, `runUpload`, and `emitUploadEvent`.
- Produces: exported `startUpload(uploadId)` from `uploadService.js` without changing existing upload behavior.
- Produces: `createMegaLinkImportService(dependencies)` returning `start(userId, { link, virtualPath })` and `cancel(userId, uploadId)`.
- Produces: `POST /api/mega-links/inspect`, `POST /api/mega-links/download`, `POST /api/mega-links/import`, and `DELETE /api/mega-links/import/:uploadId`.

- [ ] **Step 1: Write failing route and import lifecycle tests**

Follow existing dynamic-import test setup with a temporary database. Cover:

```js
test('public MEGA routes require the app user', async () => { /* hosted mode -> 401 */ });
test('inspect rejects a deceptive host before the downloader runs', async () => { /* mega.nz.evil.test */ });
test('download returns safe attachment metadata and exact bytes', async () => { /* POST body link */ });
test('import uses the submitted current path and allocation result', async () => { /* returns 202/upload_id */ });
test('import streams progress and completion through the existing upload event', async () => { /* no full buffer */ });
test('cancel aborts source work and removes the active job', async () => { /* DELETE ownership-scoped */ });
```

Assert the downloader receives only canonical links and that responses/errors do not echo a complete link or key.

- [ ] **Step 2: Run the route tests and verify RED**

Run: `node --test backend/test/megaLinkRoutes.test.js`

Expected: missing route/service exports or HTTP 404.

- [ ] **Step 3: Expose the existing upload-start transition**

Change only the declaration:

```js
export function startUpload(uploadId) {
	updateUploadSession(uploadId, { status: 'uploading' });
	emitUploadEvent(uploadId, { type: 'upload:started', uploadId, percent: 0, status: 'uploading' });
}
```

Existing `handleUpload` and `handleChunk` keep calling it exactly as before.

- [ ] **Step 4: Implement import service with an in-memory cancellation map**

`start` must inspect before allocation, create a normal upload session, create an `AbortController`, and store `{ userId, controller, stream }` by upload ID. Schedule background work without awaiting it and return the public job descriptor:

```js
const metadata = await downloads.inspectPublic(link);
const allocation = selectBestAccount(userId, metadata.size);
const session = createUploadSession({
	user_id: userId,
	file_name: metadata.file_name,
	size: metadata.size,
	mime_type: metadata.mime_type,
	virtual_path: normalizePath(virtualPath),
	remote_parent_id: null,
	cloud_account_id: allocation.selected.id,
	fallback_chain: allocation.fallbackChain.map(({ id }) => id),
});
startUpload(session.id);
void run(session, link, metadata).finally(() => jobs.delete(session.id));
return { upload_id: session.id, file_name: metadata.file_name, size: metadata.size };
```

`run` obtains `downloads.streamPublic(link, { signal })`, stores the stream for cancellation, and awaits `runUpload`. Cancellation checks ownership, aborts the controller, destroys the source stream with an `AbortError`, and returns `true`; a missing/foreign job returns `false`.

- [ ] **Step 5: Implement authenticated routes and disconnect handling**

For direct download, attach an `AbortController` to `res.close`, inspect metadata before headers, then pipe the stream. Use RFC-safe `filename*` plus a sanitized ASCII fallback. `/import` returns `202`; cancel returns `204` or `404`. Mount the router after `attachAuthContext` at `/api`.

- [ ] **Step 6: Run route, upload, cache, and full backend tests**

Run:

```bash
node --test backend/test/megaLinkRoutes.test.js backend/test/uploadFileCache.test.js backend/test/fileCacheRoutes.test.js
npm --prefix backend test
```

Expected: all pass; no open-handle warning remains.

- [ ] **Step 7: Commit Task 4**

```bash
git add backend/src/services/megaLinkImportService.js backend/src/routes/megaLinkRoutes.js \
  backend/src/services/uploadService.js backend/src/app.js backend/test/megaLinkRoutes.test.js
git commit -m "feat: download and import public MEGA links"
```

---

### Task 5: Health, Compose, and Deployment Documentation

**Files:**
- Modify: `backend/src/routes/healthRoutes.js`
- Modify: `docker-compose.yml`
- Modify: `README.md`
- Modify: `docs/provider-setup.md`

**Interfaces:**
- Consumes: Task 3 `megaBasterdClient.health()` and environment values.
- Produces: `GET /api/health` field `mega_download: { sidecar: 'available'|'unavailable'|'unconfigured', fallback_enabled: boolean }`.
- Produces: Compose service DNS `http://megabasterd:8788`.

- [ ] **Step 1: Write a failing health behavior test**

Add the health cases to `backend/test/megaBasterdClient.test.js`: configured/healthy, configured/unavailable, and blank-secret/unconfigured. Assert `/api/health` remains HTTP 200 in every case and contains no secret or signed URL.

- [ ] **Step 2: Run the focused health test and verify RED**

Run: `npm --prefix backend test -- --test-name-pattern='MEGA download health'`

Expected: `mega_download` is absent.

- [ ] **Step 3: Add bounded health reporting**

Make the health route async and call `megaBasterdClient.health` with a short signal. Convert all failures to `unavailable`; never pass health errors to Express's error handler. Preserve existing `status: 'ok'`, auth, sync, and config fields.

- [ ] **Step 4: Wire Compose without blocking fallback startup**

Add:

```yaml
  megabasterd:
    build:
      context: ./megabasterd-headless
    environment:
      MEGABASTERD_INTERNAL_SECRET: ${MEGABASTERD_INTERNAL_SECRET:?defina MEGABASTERD_INTERNAL_SECRET no .env}
    healthcheck:
      test: ["CMD", "java", "-cp", "/app/megabasterd.jar", "com.tonikelope.megabasterd.HeadlessHealthcheck"]
      interval: 15s
      timeout: 5s
      retries: 3
    restart: unless-stopped
```

Add API environment `MEGABASTERD_URL`, secret, timeout, and fallback. Use ordinary `depends_on: [megabasterd]`; do not use `condition: service_healthy`.

- [ ] **Step 5: Document operation and legal boundary**

Document the required secret generation, pinned revision, GPL sidecar source location, fallback semantics, public routes, supported file links, no-folder limitation, and these manual checks:

```bash
docker compose build megabasterd api web
docker compose up -d
docker compose ps
curl -fsS http://localhost:8080/api/health
```

State that distributing images requires reviewing GPL source obligations and that the feature must not be used to bypass MEGA limits or terms.

- [ ] **Step 6: Validate Compose and tests**

Run:

```bash
docker compose config
npm --prefix backend test -- --test-name-pattern='MEGA download health'
```

Expected: Compose config is valid and health cases pass.

- [ ] **Step 7: Commit Task 5**

```bash
git add backend/src/routes/healthRoutes.js backend/test/megaBasterdClient.test.js docker-compose.yml README.md docs/provider-setup.md
git commit -m "chore: deploy the MegaBasterd sidecar"
```

---

### Task 6: Public MEGA Link Modal and Tracked Transfers

**Files:**
- Create: `frontend/src/components/MegaLinkModal.vue`
- Create: `frontend/src/utils/megaLink.js`
- Create: `frontend/test/megaLink.test.js`
- Modify: `frontend/src/components/DriveShell.vue`
- Modify: `frontend/src/views/MyDriveView.vue`
- Modify: `frontend/src/services/api.js`
- Modify: `frontend/src/stores/uploadQueue.js`
- Modify: `frontend/src/locales/en.json`
- Modify: `frontend/src/locales/id.json`

**Interfaces:**
- Produces: `looksLikeMegaFileLink(value): boolean` for immediate feedback only.
- Produces: `<MegaLinkModal :open :busy @close @download @import>`.
- Produces: API methods `inspectMegaLink`, `downloadMegaLink`, `importMegaLink`, and `cancelMegaLinkImport`.
- Produces: store actions `downloadMegaLink(link)` and `importMegaLink(link, currentPath, onCompleted)`.

- [ ] **Step 1: Write failing URL recognition tests**

```js
test('recognizes modern and legacy MEGA file links', () => {
	assert.equal(looksLikeMegaFileLink('https://mega.nz/file/abc#key'), true);
	assert.equal(looksLikeMegaFileLink('https://mega.nz/#!abc!key'), true);
});

test('rejects folders, HTTP, and deceptive hosts', () => {
	assert.equal(looksLikeMegaFileLink('https://mega.nz/folder/abc#key'), false);
	assert.equal(looksLikeMegaFileLink('http://mega.nz/file/abc#key'), false);
	assert.equal(looksLikeMegaFileLink('https://mega.nz.evil.test/file/abc#key'), false);
});
```

- [ ] **Step 2: Run frontend test and verify RED**

Run: `node --test frontend/test/megaLink.test.js`

Expected: missing module/export.

- [ ] **Step 3: Implement the pure helper and API methods**

The helper mirrors backend shape checks but does not canonicalize or grant trust. `downloadMegaLink(link, { signal })` uses a raw authenticated fetch because the response is a body stream; the other methods use the existing JSON `request` helper.

- [ ] **Step 4: Refactor one shared browser-download consumer and add link actions**

Extract the body-reading/blob-click portion already in `downloadFiles` into a local store function:

```js
async function saveDownloadResponse({ response, queueItem, fileName, size, update }) {
	// Read response.body, update percent, create Blob URL, click, revoke URL.
}
```

Both ordinary file downloads and `downloadMegaLink` call it. The link action first inspects for name/size, registers a normal `type: 'download'` item, then POSTs the link stream with its abort signal.

`importMegaLink` registers `type: 'upload'`, POSTs `{ link, virtual_path: currentPath }`, stores `remoteUploadId`, opens `api.createUploadSocket(upload_id)`, and maps the existing progress/complete/error messages exactly like `uploadFiles`. Store `cancelRemote: () => api.cancelMegaLinkImport(upload_id)`; `closeOperation` and `clearOperations` invoke `cancelRemote` best-effort before marking cancellation.

- [ ] **Step 5: Implement the accessible modal and menu entry**

Add `mega-link` to `DriveShell` emits and add `Link do MEGA` to both mobile and desktop create menus. `MyDriveView` owns modal state and passes `currentPath`. The modal:

- focuses the URL input when opened;
- has a real label, inline validation message, disabled busy actions, and Escape/backdrop close when idle;
- emits the trimmed link through `download` or `import`;
- closes after a transfer is accepted, not after the full transfer completes.

Use `t('megaLink.*')` for every visible string and add semantically equivalent English and Indonesian translations.

- [ ] **Step 6: Run frontend tests and production build**

Run:

```bash
npm --prefix frontend test
npm --prefix frontend run build
```

Expected: tests pass and Vite builds without missing translations/imports.

- [ ] **Step 7: Commit Task 6**

```bash
git add frontend/src/components/MegaLinkModal.vue frontend/src/utils/megaLink.js frontend/test/megaLink.test.js \
  frontend/src/components/DriveShell.vue frontend/src/views/MyDriveView.vue frontend/src/services/api.js \
  frontend/src/stores/uploadQueue.js frontend/src/locales/en.json frontend/src/locales/id.json
git commit -m "feat: add public MEGA link actions"
```

---

### Task 7: End-to-End Verification and Manual Smoke Test

**Files:**
- Modify only if verification exposes a defect: files owned by Tasks 1-6.
- Do not modify: `backend/test/googlePhotosImportService.test.js` unless a failing pre-existing test proves the new work caused the failure.

**Interfaces:**
- Consumes: the complete sidecar, backend, Compose, and frontend feature.
- Produces: verified private primary path, private fallback, public download, public import, cancellation, range, cache, preview, and WebDAV behavior.

- [ ] **Step 1: Run every automated suite and build**

```bash
npm --prefix backend test
npm --prefix frontend test
npm --prefix frontend run build
docker build -t omnicloud-megabasterd:test megabasterd-headless
docker compose config
docker compose build api web megabasterd
```

Expected: every command exits 0.

- [ ] **Step 2: Start the stack and verify healthy primary mode**

Set a strong `MEGABASTERD_INTERNAL_SECRET`, then run:

```bash
docker compose up -d
docker compose ps
curl -fsS http://localhost:8080/api/health
```

Expected: all services are running and `mega_download.sidecar` is `available`.

- [ ] **Step 3: Perform the real-account smoke matrix without recording secrets**

Using the browser and one connected MEGA account:

1. Download a private text/binary file and compare its SHA-256 with the original.
2. Preview a range-capable MEGA media file and read it through WebDAV.
3. Download one public MEGA file link and compare SHA-256.
4. Import the same link into a nested open folder; verify progress, final location, metadata, cache read, and provider content hash.
5. Cancel one direct download and one import; verify the queue says cancelled and sidecar activity stops.

Do not paste credentials, keys, full public links, or signed URLs into commits, test output, or issue text.

- [ ] **Step 4: Verify fallback-only mode**

Stop only the sidecar:

```bash
docker compose stop megabasterd
curl -fsS http://localhost:8080/api/health
```

Expected: API stays healthy, reports `sidecar: unavailable`, and one private plus one public download succeed through `megajs`. Restart the service afterward.

- [ ] **Step 5: Inspect logs for secret leakage and repeated retries**

```bash
docker compose logs --no-color api megabasterd
```

Expected: mechanism/timing/safe codes are visible; account passwords, full links, keys, signed URLs, and retry loops are absent.

- [ ] **Step 6: Commit only verification fixes, if any**

If fixes were required, rerun the smallest failing check and then the complete suite before committing:

```bash
git add megabasterd-headless backend/src backend/test frontend/src frontend/test README.md docs/provider-setup.md docker-compose.yml
git commit -m "fix: harden MegaBasterd download integration"
```

If no fixes were required, create no empty commit.
