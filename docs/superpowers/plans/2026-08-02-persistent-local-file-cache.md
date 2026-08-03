# Persistent Local File Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist complete cloud files in a local Docker volume, warm direct folder children in the background, and serve later reads locally without delaying first access.

**Architecture:** A filesystem store owns hashed paths, atomic content/sidecar publication, validation, Range reads, upload capture, and invalidation. A process-local coordinator owns the one-hour folder markers, a three-worker queue, and per-version in-flight download deduplication. SQLite remains the metadata source and cloud providers remain authoritative.

**Tech Stack:** Node.js 22 ESM, Express 5, native `node:fs`, `node:stream`, `node:crypto`, `node:test`, SQLite via existing `better-sqlite3`, Docker Compose.

## Global Constraints

- Do not add Redis, BullMQ, a worker process, or any npm dependency.
- Persist complete content indefinitely; do not add a size limit, LRU, or automatic eviction.
- Warm only non-folder files directly inside the opened folder; never recurse.
- Folder listing must return before warming finishes.
- A cache miss must stream from the provider immediately while one complete background download warms the volume.
- Provider and SQLite remain authoritative; never watch or upload direct changes made inside the cache volume.
- Cache failures must preserve the existing provider-backed behavior.
- Preserve all pre-existing worktree changes. Stage and commit only the paths named by the current task.

---

## File Structure

- Create `backend/src/services/localFileStore.js`: hashed paths, sidecars, validation, local Range streams, atomic writes, upload capture, invalidation, reconciliation, stale-temp cleanup.
- Create `backend/src/services/fileCacheService.js`: folder TTL, bounded queue, in-flight deduplication, read-through behavior, singleton wiring.
- Create `backend/test/localFileStore.test.js`: durable filesystem contract.
- Create `backend/test/fileCacheService.test.js`: queue, TTL, deduplication, and read-through contract.
- Create `backend/test/fileCacheRoutes.test.js`: HTTP download/preview warming and later local reads.
- Create `backend/test/fileCacheSync.test.js`: snapshot reconciliation and cache-preserving rename behavior.
- Create `backend/test/uploadFileCache.test.js`: upload stream capture and promotion behavior.
- Modify `backend/src/config/env.js`: cache path, warm TTL, and concurrency settings.
- Modify `backend/.env.example`: document cache settings.
- Modify `.gitignore`: exclude `backend/.cache/`.
- Modify `backend/src/routes/fileRoutes.js`: background folder warming, cached download/preview/thumbnail reads, mutation coordination.
- Modify `backend/src/routes/webdavRoutes.js`: cached GET and local Range reads.
- Modify `backend/src/services/syncService.js`: reconcile old/new snapshots and permit known content-preserving mutations.
- Modify `backend/src/services/uploadService.js`: capture the incoming upload once and publish it after provider success.
- Modify `backend/src/server.js`: remove abandoned temp files at startup.
- Modify `backend/Dockerfile`: create the cache mount directory without disturbing existing thumbnail dependencies.
- Modify `docker-compose.yml`: mount `omnicloud_file_cache` at `/app/cache/files`.
- Modify `README.md`: document durable byte caching and its unbounded growth.

---

### Task 1: Durable filesystem store

**Files:**
- Create: `backend/src/services/localFileStore.js`
- Create: `backend/test/localFileStore.test.js`
- Modify: `backend/src/config/env.js`
- Modify: `backend/.env.example`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `createLocalFileStore({ rootDir, logger })`.
- Produces store methods:
  - `getValidPath(file): Promise<string|null>`
  - `openReadStream(file, range = {}): Promise<Readable|null>`
  - `writeFromStream(file, stream): Promise<void>`
  - `captureUpload(stream, uploadId): { stream: Transform, completed: Promise<object>, discard(): Promise<void> }`
  - `commitCapture(capture, file): Promise<boolean>`
  - `invalidate(file): Promise<void>`
  - `rebind(file): Promise<boolean>`
  - `reconcile(previousFiles, nextFiles, { preserveRemoteIds = [] } = {}): Promise<void>`
  - `cleanupTemps(): Promise<void>`
- File records consume `user_id`, `cloud_account_id`, `remote_file_id`, `size`, and `remote_modified_time` or `modifiedTime`.

- [ ] **Step 1: Write failing store tests**

Create tests using `fs.mkdtemp(path.join(os.tmpdir(), 'omnicloud-file-store-'))` and `Readable.from(...)`. Cover:

```js
test('publishes content and sidecar, then opens a valid Range', async () => {
	await store.writeFromStream(file, Readable.from(['abcdef']));
	assert.equal(await read(await store.openReadStream(file, { start: 1, end: 3 })), 'bcd');
});

test('same size with a newer remote timestamp is invalid', async () => {
	await store.writeFromStream(file, Readable.from(['abcdef']));
	assert.equal(await store.getValidPath({ ...file, remote_modified_time: '2026-08-03T00:00:00Z' }), null);
});

test('conservatively invalidates records without a remote version', async () => {
	await store.writeFromStream({ ...file, remote_modified_time: null }, Readable.from(['abcdef']));
	await store.reconcile([{ ...file, remote_modified_time: null }], [{ ...file, remote_modified_time: null }]);
	assert.equal(await store.getValidPath({ ...file, remote_modified_time: null }), null);
});

test('capture keeps provider stream flowing when the local write fails', async () => {
	const capture = brokenStore.captureUpload(Readable.from(['payload']), 'upload-1');
	assert.equal(await read(capture.stream), 'payload');
	assert.equal(await capture.completed, null);
});
```

Also assert that raw user/account/remote IDs never occur in the resulting pathname, an incomplete temp is not a hit, invalid JSON is a miss, `invalidate` removes both files, `rebind` updates a sidecar without rewriting content, and `cleanupTemps` removes only `*.tmp`.

- [ ] **Step 2: Run the new test and verify failure**

Run: `cd backend && node --test test/localFileStore.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `localFileStore.js`.

- [ ] **Step 3: Add configuration and the minimum store implementation**

Add to `env`:

```js
fileCachePath: process.env.FILE_CACHE_PATH || path.resolve(process.cwd(), '.cache/files'),
fileCacheWarmTtlMs: Number(process.env.FILE_CACHE_WARM_TTL_MS || 60 * 60 * 1000),
fileCacheConcurrency: Math.max(1, Number(process.env.FILE_CACHE_CONCURRENCY || 3)),
```

Add matching values to `backend/.env.example` and add `backend/.cache/` to `.gitignore`.

Implement a store that hashes `JSON.stringify([user_id, cloud_account_id, remote_file_id])` with SHA-256. Sidecars contain exactly:

```js
{
	userId: file.user_id,
	accountId: file.cloud_account_id,
	remoteId: String(file.remote_file_id),
	size: Number(file.size || 0),
	remoteModifiedTime: file.remote_modified_time || file.modifiedTime || null,
	completedAt: new Date().toISOString(),
}
```

Write `.data.tmp` and `.json.tmp` equivalents with UUID suffixes, validate byte count before publication, rename data before sidecar, and treat any parse/stat error as a miss. `captureUpload` must use a `Transform` that always forwards chunks even after its private file handle fails.

- [ ] **Step 4: Run the focused tests**

Run: `cd backend && node --test test/localFileStore.test.js`

Expected: PASS.

- [ ] **Step 5: Commit the scoped store change**

```bash
git add .gitignore backend/.env.example backend/src/config/env.js backend/src/services/localFileStore.js backend/test/localFileStore.test.js
git commit -m "feat: add durable local file store"
```

---

### Task 2: In-memory warming coordinator

**Files:**
- Create: `backend/src/services/fileCacheService.js`
- Create: `backend/test/fileCacheService.test.js`

**Interfaces:**
- Consumes: `createLocalFileStore()` from Task 1.
- Produces: `createFileCacheService({ store, warmTtlMs, concurrency, now, logger })` and singleton `fileCacheService`.
- Produces coordinator methods:
  - `warmFile({ userId, file, adapter }): Promise<void>`
  - `warmFolder({ userId, virtualPath, files, adapterFor }): boolean`
  - `openFile({ userId, file, adapter, range = {} }): Promise<{ stream: Readable, cached: boolean }>`
  - `invalidate(file): Promise<void>`
  - `rebind(file): Promise<boolean>`
  - `reconcileAccount(previousFiles, nextFiles, options): Promise<void>`
  - `captureUpload(stream, uploadId)` and `commitCapture(capture, file)` pass through to the store.
  - `cleanupTemps(): Promise<void>`

- [ ] **Step 1: Write failing coordinator tests**

Use fake stores and adapters. Cover these exact behaviors:

```js
test('two warm requests for one version share one provider download', async () => {
	await Promise.all([
		cache.warmFile({ userId: 'u1', file, adapter }),
		cache.warmFile({ userId: 'u1', file, adapter }),
	]);
	assert.equal(adapter.downloadCalls, 1);
});

test('folder warming returns immediately and ignores folders and descendants', () => {
	assert.equal(cache.warmFolder({ userId: 'u1', virtualPath: '/Fotos/', files, adapterFor }), true);
	assert.deepEqual(scheduledNames, ['direct.jpg']);
});

test('folder marker expires after one hour', () => {
	cache.warmFolder(input);
	now += 3_600_001;
	assert.equal(cache.warmFolder(input), true);
});

test('cache miss returns remote stream without waiting for background warming', async () => {
	const opened = await cache.openFile({ userId: 'u1', file, adapter });
	assert.equal(opened.cached, false);
	assert.equal(await read(opened.stream), 'remote-now');
});
```

Also prove cache hit never calls the adapter, the queue never exceeds the configured concurrency, failures are logged without an unhandled rejection, and reconciliation clears warmed-folder markers.

- [ ] **Step 2: Run the new test and verify failure**

Run: `cd backend && node --test test/fileCacheService.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `fileCacheService.js`.

- [ ] **Step 3: Implement the coordinator**

Use one FIFO array, an integer active count, `Map<string, number>` for folder expiry, and `Map<string, Promise>` for in-flight downloads. The in-flight key must include identity, size, and remote modification time. Do not use timers: compare `now()` when a folder opens and delete stale entries lazily.

`openFile` must perform only this decision:

```js
const local = await store.openReadStream(file, range);
if (local) return { stream: local, cached: true };
void warmFile({ userId, file, adapter }).catch((error) => logger.error('File cache warm failed:', error));
return { stream: await adapter.getDownloadStream(file, range), cached: false };
```

- [ ] **Step 4: Run focused tests**

Run: `cd backend && node --test test/localFileStore.test.js test/fileCacheService.test.js`

Expected: PASS.

- [ ] **Step 5: Commit the scoped coordinator change**

```bash
git add backend/src/services/fileCacheService.js backend/test/fileCacheService.test.js
git commit -m "feat: coordinate background file warming"
```

---

### Task 3: Folder warming and read-through HTTP/WebDAV

**Files:**
- Modify: `backend/src/routes/fileRoutes.js`
- Modify: `backend/src/routes/webdavRoutes.js`
- Create: `backend/test/fileCacheRoutes.test.js`
- Modify: `backend/test/webdavRoutes.test.js`

**Interfaces:**
- Consumes: `fileCacheService.warmFolder()` and `fileCacheService.openFile()` from Task 2.
- Existing `getFileContext()` remains the source of `{ file, account, adapter }`.

- [ ] **Step 1: Write failing route tests**

Set `FILE_CACHE_PATH` to a unique temp directory before importing the app. Add tests proving:

```js
test('folder listing responds before background file download completes', async () => {
	const response = await fetch(`${baseUrl}/api/files?path=%2FFotos%2F`, { headers: appAuth });
	assert.equal(response.status, 200);
	assert.equal(backgroundDownload.pending, true);
});

test('first download is remote and the next download is local', async () => {
	assert.equal(await (await fetch(downloadUrl, { headers: appAuth })).text(), 'remote-v1');
	await waitForCache(file);
	adapterBody = 'remote-v2';
	assert.equal(await (await fetch(downloadUrl, { headers: appAuth })).text(), 'remote-v1');
});
```

Extend WebDAV coverage so a valid local file serves a byte Range with `206`, correct `Content-Range`, and no adapter call. Add a miss test showing remote Range response starts while the complete background warmer is active.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `cd backend && node --test test/fileCacheRoutes.test.js test/webdavRoutes.test.js`

Expected: FAIL because routes still call adapters directly and do not warm folders.

- [ ] **Step 3: Integrate folder warming**

In regular path listing, call `res.json({ data: files })` first, then call `fileCacheService.warmFolder` with the same normalized requested path, list, and an `adapterFor(file)` callback that resolves the already-scoped account with `getAccountById(req.user.id, file.cloud_account_id)`.

For `/files/:id/shared-children`, map items once, respond, then warm that direct list with the context adapter. Search, recent, starred, and the top-level “shared with me” aggregate are not folder openings and must not trigger bulk warming.

- [ ] **Step 4: Integrate content reads**

Replace direct adapter stream calls in download and preview with:

```js
const { stream } = await fileCacheService.openFile({
	userId: req.user.id,
	file: context.file,
	adapter: context.adapter,
});
```

Use the same callback for thumbnail input so thumbnail generation benefits from an existing local copy and warms a miss.

In WebDAV, parse the requested Range before opening and obtain the body through
`openFile`. A cached stream supports Range even if the provider adapter does not. Set
`206` only when the cache handled the Range or the provider declares Range support:

```js
const requestedRange = parseRangeHeader(req.headers.range, size);
const opened = await fileCacheService.openFile({
	userId: req.webdavUserId,
	file,
	adapter,
	range: requestedRange || {},
});
const honoredRange = requestedRange
	&& (opened.cached || adapter.getCapabilities?.().supportsRange);
const range = honoredRange ? requestedRange : null;
```

Use `range` for the `206`, `Content-Range`, and partial `Content-Length` response. On a
miss against an adapter without Range support, retain the existing full `200` response.

- [ ] **Step 5: Run focused and backend suites**

Run: `cd backend && node --test test/fileCacheRoutes.test.js test/webdavRoutes.test.js test/thumbnailRoutes.test.js`

Expected: PASS.

Run: `cd backend && npm test`

Expected: PASS.

- [ ] **Step 6: Commit only the route integration**

```bash
git add backend/src/routes/fileRoutes.js backend/src/routes/webdavRoutes.js backend/test/fileCacheRoutes.test.js backend/test/webdavRoutes.test.js
git commit -m "feat: serve and warm files through local cache"
```

---

### Task 4: Snapshot reconciliation and content-preserving mutations

**Files:**
- Modify: `backend/src/services/syncService.js`
- Modify: `backend/src/services/fileService.js`
- Modify: `backend/src/routes/fileRoutes.js`
- Create: `backend/test/fileCacheSync.test.js`

**Interfaces:**
- Consumes: `fileCacheService.reconcileAccount(previousFiles, nextFiles, { preserveRemoteIds })` and `fileCacheService.rebind(file)`.
- Changes: `syncAccount(userId, account, options = {})`, where `options.preserveCacheRemoteIds` is an array of remote IDs known not to have changed bytes.
- Produces: `listFilesForAccount(userId, cloudAccountId)` in `fileService.js`.

- [ ] **Step 1: Write failing synchronization tests**

Cover pure and service behavior:

```js
test('external same-id modification invalidates the old local version', async () => {
	await syncAccount(userId, account);
	assert.equal(await store.getValidPath(oldFile), null);
});

test('removed remote file removes local content and sidecar', async () => {
	await syncAccount(userId, account);
	assert.equal(await store.getValidPath(removedFile), null);
});

test('known rename preserves bytes and rebinds the sidecar', async () => {
	await syncAccount(userId, account, { preserveCacheRemoteIds: [file.remote_file_id] });
	assert.ok(await store.getValidPath(renamedSnapshotFile));
});
```

Use a fake adapter snapshot and temp store. Also cover records without a reliable remote modification time, which must invalidate on every snapshot.

- [ ] **Step 2: Run the new test and verify failure**

Run: `cd backend && node --test test/fileCacheSync.test.js`

Expected: FAIL because `syncAccount` does not reconcile cache state or accept options.

- [ ] **Step 3: Add account-scoped snapshot access and reconciliation**

Add:

```js
export function listFilesForAccount(userId, cloudAccountId) {
	return db.prepare(
		'SELECT * FROM file_metadata WHERE user_id = ? AND cloud_account_id = ?'
	).all(userId, cloudAccountId);
}
```

In both `syncAccount` and each account iteration in `runDeltaSync`, capture `previousFiles`, replace SQLite metadata, then call cache reconciliation with `remoteFiles` normalized to include `user_id` and `cloud_account_id`. Cache reconciliation errors are logged and do not roll back the SQLite update.

- [ ] **Step 4: Preserve known content-only mutations**

After successful provider rename, call:

```js
await syncAccount(req.user.id, context.account, {
	preserveCacheRemoteIds: [context.file.remote_file_id],
});
```

The reconciliation path rebinds the sidecar to the new metadata rather than deleting data. Use the same preservation for provider-side starring because it changes metadata but not bytes. Delete and bulk delete use normal reconciliation, which removes missing entries including folder descendants.

- [ ] **Step 5: Run synchronization and route tests**

Run: `cd backend && node --test test/fileCacheSync.test.js test/fileCacheRoutes.test.js test/webdavRoutes.test.js`

Expected: PASS.

- [ ] **Step 6: Commit the scoped synchronization change**

```bash
git add backend/src/services/syncService.js backend/src/services/fileService.js backend/src/routes/fileRoutes.js backend/test/fileCacheSync.test.js
git commit -m "feat: reconcile local cache after cloud changes"
```

---

### Task 5: Capture successful uploads into the volume

**Files:**
- Modify: `backend/src/services/uploadService.js`
- Create: `backend/test/uploadFileCache.test.js`
- Modify: `backend/test/uploadChunks.test.js`

**Interfaces:**
- Consumes: `fileCacheService.captureUpload(stream, uploadId)` and `fileCacheService.commitCapture(capture, metadata)`.
- Existing upload response, progress events, chunk order, provider fallback, and session cleanup contracts remain unchanged.

- [ ] **Step 1: Write failing upload-cache tests**

Test the existing normal and chunked upload entry points with a collecting upload adapter. Assert:

```js
test('successful upload publishes the exact incoming bytes locally', async () => {
	await uploadRequest('alpha-beta');
	assert.equal(await read(await store.openReadStream(savedMetadata)), 'alpha-beta');
});

test('provider failure leaves no complete local entry', async () => {
	await assert.rejects(uploadRequest('payload', { failProvider: true }));
	assert.equal(await store.getValidPath(expectedMetadata), null);
});

test('local capture failure does not fail a successful provider upload', async () => {
	const response = await uploadRequest('payload', { failCache: true });
	assert.equal(response.status, 'completed');
});
```

Retain and extend `uploadChunks.test.js` so sequential chunks still produce one exact stream after capture is inserted.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `cd backend && node --test test/uploadFileCache.test.js test/uploadChunks.test.js`

Expected: FAIL because upload bytes are not captured or committed.

- [ ] **Step 3: Capture once before the adapter consumes the stream**

At the start of `runUpload`, create one capture from the incoming stream and pass `capture.stream` to the selected adapter. Do not pipe the original stream separately. After `syncAccount` resolves and final metadata is loaded, call `commitCapture(capture, metadata)`. In `catch` and `finally`, discard an unpublished capture without masking the provider error.

The capture Transform must forward every chunk while writing locally and must turn local write failure into a `null` completed capture rather than an upload-stream error.

- [ ] **Step 4: Run upload and backend tests**

Run: `cd backend && node --test test/uploadFileCache.test.js test/uploadChunks.test.js`

Expected: PASS.

Run: `cd backend && npm test`

Expected: PASS.

- [ ] **Step 5: Commit the scoped upload change**

```bash
git add backend/src/services/uploadService.js backend/test/uploadFileCache.test.js backend/test/uploadChunks.test.js
git commit -m "feat: retain successful uploads in local cache"
```

---

### Task 6: Persistent deployment wiring and final verification

**Files:**
- Modify: `backend/src/server.js`
- Modify: `backend/Dockerfile`
- Modify: `docker-compose.yml`
- Modify: `README.md`

**Interfaces:**
- Consumes: `fileCacheService.cleanupTemps()` from Task 2.
- Produces Docker volume `omnicloud_file_cache` mounted at `/app/cache/files`.

- [ ] **Step 1: Add startup cleanup**

Before initial sync scheduling, call:

```js
fileCacheService.cleanupTemps().catch((error) => {
	console.error('File cache temp cleanup failed:', error);
});
```

The server must still start when cleanup fails.

- [ ] **Step 2: Wire the persistent volume**

Keep the existing Dockerfile packages and add `/app/cache/files` to the existing mkdir command. In Compose add:

```yaml
environment:
  FILE_CACHE_PATH: /app/cache/files
volumes:
  - omnicloud_api_data:/app/data
  - omnicloud_file_cache:/app/cache/files

volumes:
  omnicloud_api_data:
  omnicloud_file_cache:
```

- [ ] **Step 3: Document behavior and operational ceiling**

In README persistence documentation, state that complete warmed files survive container recreation, cache growth is intentionally unbounded, direct edits to the volume are ignored, and `docker compose down -v` deletes both SQLite and cached files.

- [ ] **Step 4: Run all verification**

Run: `cd backend && npm test`

Expected: PASS with all backend tests.

Run: `docker compose config`

Expected: exit 0 and show `omnicloud_file_cache` mounted at `/app/cache/files`.

Run: `git diff --check`

Expected: exit 0.

- [ ] **Step 5: Commit deployment wiring**

```bash
git add backend/src/server.js backend/Dockerfile docker-compose.yml README.md
git commit -m "chore: persist warmed cloud files"
```

---

## Final Runtime Check

- Start the stack with `docker compose up --build`.
- Open a folder containing at least two direct files and one subfolder; confirm the API response returns before the direct files finish downloading and that no descendant is fetched.
- Open a missing file; confirm bytes begin immediately from the provider and a `.data` plus `.json` entry appears afterward.
- Open the same file again with the provider temporarily unavailable; confirm the complete response comes from the volume.
- Request a WebDAV Range from the cached file and confirm `206`, `Content-Range`, and exact bytes.
- Modify the file directly in the provider, run sync, and confirm the old local entry is invalidated and refetched on the next folder open.
- Upload, rename, and delete a file through OmniCloud and confirm provider, SQLite, and volume converge after each operation.
