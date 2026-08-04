# Google Photos Picker to Drive Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user select images and videos with Google Photos Picker and stream copies into `/OmniCloud/Google Fotos/<Google account local-part>/` on that same account's Google Drive.

**Architecture:** Extend the existing Google Drive OAuth grant with the Picker scope, then add a focused in-memory import service that owns Picker sessions, pagination, bounded transfers, duplicate naming, and cleanup. Reuse `GoogleDriveAdapter`, account encryption, sync, auth-error handling, and upload WebSocket events; expose start/status/cancel routes and a per-account action in `QuotaView`.

**Tech Stack:** Node.js 22+, Express 5, `googleapis` 173, Node streams, SQLite metadata mirror, Vue 3, Vue I18n, native `node:test`.

## Global Constraints

- Request exactly `https://www.googleapis.com/auth/photospicker.mediaitems.readonly`; do not use the removed `photoslibrary` scope.
- Source and destination must use the same stored `google_drive` OAuth account.
- Import the best image/video rendition made available by Picker without buffering
  complete files. Picker image downloads can omit location metadata, and video
  downloads can be transcoded; byte-identical originals are not promised.
- Destination is `/OmniCloud/Google Fotos/<part before first @>/`.
- Existing names create extension-aware copies: `foto.jpg`, `foto (2).jpg`, `foto (3).jpg`.
- List every Picker page before uploading anything.
- Run at most two media transfers concurrently across the whole import service.
- Serialize same-account job admission through name allocation and transfer completion.
- One media failure must not cancel independent items; only 401 or an auth-specific Google reason/message stops new transfers and marks the account `invalid_token`.
- Picker tokens, bearer headers, and temporary media URLs must never be persisted or returned in errors.
- Keep import jobs in memory and add no dependency or Google Photos storage provider.

---

## File Structure

- Create `backend/src/services/googlePhotosImportService.js`: Picker API boundary, job lifecycle, path/name helpers, bounded import pipeline, cleanup, and singleton exports.
- Create `backend/test/googlePhotosImportService.test.js`: behavior tests for helpers, API pagination, validation, concurrency, partial failure, auth failure, and cleanup.
- Modify `backend/src/services/googleOAuthService.js`: add the Picker scope to new Google Drive grants.
- Modify `backend/src/adapters/GoogleDriveAdapter.js`: list names in one resolved Drive folder so duplicate allocation stays outside raw API details.
- Modify `backend/src/routes/accountRoutes.js`: authenticated start/status/cancel endpoints.
- Modify `frontend/src/services/api.js`: client methods for those endpoints.
- Modify `frontend/src/views/QuotaView.vue`: per-Google-account action, Picker popup, polling, WebSocket progress, cancel-on-close, and result summary.
- Modify `frontend/src/locales/en.json` and `frontend/src/locales/id.json`: user-visible Picker/import strings.
- Modify `docs/provider-setup.md`: Picker API, OAuth scope, reconnect, and redirect prerequisites.

---

### Task 1: OAuth Scope and Drive Folder Name Boundary

**Files:**
- Modify: `backend/src/services/googleOAuthService.js`
- Modify: `backend/src/adapters/GoogleDriveAdapter.js`
- Create: `backend/test/googlePhotosImportService.test.js`

**Interfaces:**
- Produces: `GOOGLE_PHOTOS_PICKER_SCOPE: string` exported by `googlePhotosImportService.js` in Task 2; until then the OAuth test expects the literal scope through the generated URL.
- Produces: `GoogleDriveAdapter.listFileNames(remoteParentId): Promise<string[]>` for Task 3.

- [ ] **Step 1: Write failing OAuth and adapter tests**

Add tests that exercise consumer-visible behavior rather than source text:

```js
test('Google authorization asks for Picker access together with Drive access', () => {
	const { authorizationUrl } = createGoogleAuthorizationRequest('user-1');
	const scope = new URL(authorizationUrl).searchParams.get('scope').split(' ');
	assert.ok(scope.includes('https://www.googleapis.com/auth/drive'));
	assert.ok(scope.includes('https://www.googleapis.com/auth/photospicker.mediaitems.readonly'));
});

test('Drive adapter returns every name in the resolved destination folder', async () => {
	const adapter = Object.create(GoogleDriveAdapter.prototype);
	adapter.getDriveClient = async () => ({
		files: { list: async () => ({ data: { files: [{ name: 'foto.jpg' }, { name: 'video.mp4' }] } }) },
	});
	assert.deepEqual(await adapter.listFileNames('folder-1'), ['foto.jpg', 'video.mp4']);
});
```

Set test-only Google OAuth environment variables before the dynamic service imports, matching the existing `node:test` ESM pattern.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm --prefix backend test -- --test-name-pattern='Google authorization|Drive adapter returns'`

Expected: OAuth assertion fails because the Picker scope is absent; adapter test fails because `listFileNames` does not exist.

- [ ] **Step 3: Add the Picker scope and folder-name query**

In `createGoogleAuthorizationRequest`, append:

```js
'https://www.googleapis.com/auth/photospicker.mediaitems.readonly',
```

In `GoogleDriveAdapter`, add the smallest provider-specific boundary:

```js
async listFileNames(remoteParentId) {
	const drive = await this.getDriveClient();
	const names = [];
	let pageToken;
	do {
		const response = await drive.files.list({
			q: `'${escapeDriveQueryValue(remoteParentId)}' in parents and trashed = false`,
			fields: 'nextPageToken, files(name)',
			pageSize: 1000,
			pageToken,
		});
		names.push(...(response.data.files || []).map((file) => file.name));
		pageToken = response.data.nextPageToken || undefined;
	} while (pageToken);
	return names;
}
```

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `npm --prefix backend test -- --test-name-pattern='Google authorization|Drive adapter returns'`

Expected: both tests pass with no warnings.

- [ ] **Step 5: Commit Task 1**

```bash
git add backend/src/services/googleOAuthService.js backend/src/adapters/GoogleDriveAdapter.js backend/test/googlePhotosImportService.test.js
git commit -m "feat: authorize Google Photos Picker imports"
```

---

### Task 2: Picker Client, Validation, Paths, and Duplicate Names

**Files:**
- Create: `backend/src/services/googlePhotosImportService.js`
- Modify: `backend/test/googlePhotosImportService.test.js`

**Interfaces:**
- Consumes: `GoogleDriveAdapter.createOAuthClient()` for authenticated Google requests.
- Produces: `createGooglePhotosImportService(dependencies)` returning `{ start, refresh, get, cancel }`.
- Produces: singleton route functions `startGooglePhotosImport(userId, accountId)`, `refreshGooglePhotosImport(userId, importId)`, `getGooglePhotosImport(userId, importId)`, and `cancelGooglePhotosImport(userId, importId)`.
- Produces: pure helpers `buildGooglePhotosImportPath(email)` and `allocateDuplicateNames(fileNames, existingNames)`.

- [ ] **Step 1: Write failing helper and start-session tests**

Cover literal, hand-derived outcomes:

```js
test('builds the fixed folder from the email local part', () => {
	assert.equal(buildGooglePhotosImportPath('usuario@gmail.com'), '/OmniCloud/Google Fotos/usuario/');
});

test('allocates extension-aware names for existing and batch duplicates', () => {
	assert.deepEqual(
		allocateDuplicateNames(['foto.jpg', 'foto.jpg', 'arquivo'], ['foto.jpg', 'arquivo']),
		['foto (2).jpg', 'foto (3).jpg', 'arquivo (2)'],
	);
});

test('start rejects another provider before contacting Google', async () => {
	const service = createGooglePhotosImportService({
		getAccount: () => ({ id: 'a1', user_id: 'u1', provider: 'dropbox' }),
		createAdapter: () => { throw new Error('must not run'); },
	});
	await assert.rejects(service.start('u1', 'a1'), /Google Drive account is required/);
});

test('start creates a sanitized waiting job from the Picker session', async () => {
	const request = async () => ({ data: {
		id: 'picker-1', pickerUri: 'https://photos.google.com/picker/abc',
		pollingConfig: { pollInterval: '3s', timeoutIn: '180s' },
	} });
	const service = createTestService({ request });
	const job = await service.start('u1', 'drive-1');
	assert.deepEqual(job, {
		id: job.id, accountId: 'drive-1', status: 'waiting_for_selection',
		pickerUri: 'https://photos.google.com/picker/abc', pollIntervalMs: 3000,
		total: 0, completed: 0, failed: 0, errors: [],
	});
});
```

- [ ] **Step 2: Run helper/start tests and verify RED**

Run: `npm --prefix backend test -- --test-name-pattern='fixed folder|extension-aware|start rejects|start creates'`

Expected: module import or named exports fail because the service does not exist.

- [ ] **Step 3: Implement the service shell and Picker request boundary**

Use the existing injectable-service pattern from `fileCacheService.js`:

```js
export const GOOGLE_PHOTOS_PICKER_SCOPE =
	'https://www.googleapis.com/auth/photospicker.mediaitems.readonly';
const PICKER_API = 'https://photospicker.googleapis.com/v1';

export function buildGooglePhotosImportPath(email) {
	const local = String(email || '').split('@')[0].replace(/[\\/\0]/g, '_').trim() || 'conta';
	return `/OmniCloud/Google Fotos/${local}/`;
}

export function createGooglePhotosImportService({
	getAccount = getAccountById,
	createAdapter,
	emitEvent = emitUploadEvent,
	sync = syncAccount,
	markStatus = markAccountStatus,
	now = Date.now,
} = {}) {
	const jobs = new Map();
	// start/get/refresh/cancel close over jobs; responses pass through sanitizeJob.
	return { start, get, refresh, cancel };
}
```

`start` validates ownership through `getAccount(userId, accountId)`, requires an active `google_drive` account, checks `credentials.scope` for `GOOGLE_PHOTOS_PICKER_SCOPE`, obtains `adapter.createOAuthClient()`, and calls:

```js
oauthClient.request({ method: 'POST', url: `${PICKER_API}/sessions`, data: {} });
```

Convert Google durations such as `3s` to integer milliseconds. Store the OAuth client and Picker session ID only in the private job; return only the sanitized fields asserted above.

- [ ] **Step 4: Run helper/start tests and verify GREEN**

Run: `npm --prefix backend test -- --test-name-pattern='fixed folder|extension-aware|start rejects|start creates'`

Expected: all focused tests pass.

- [ ] **Step 5: Write failing pagination, timeout, and cancel tests**

Add tests where `refresh` receives `mediaItemsSet: true`, then lists two pages before any upload callback runs; a page-two failure must leave `uploaded.length === 0`. Add a waiting session whose injected clock exceeds `timeoutIn`, and assert `cancel`/timeout both issue `DELETE /sessions/picker-1` and return `cancelled`.

- [ ] **Step 6: Run pagination/lifecycle tests and verify RED**

Run: `npm --prefix backend test -- --test-name-pattern='lists every Picker page|page failure|timeout|cancel'`

Expected: failures show missing `refresh`/`cancel` lifecycle behavior.

- [ ] **Step 7: Implement lifecycle and complete-list gate**

`refresh` must:

```js
if (job.status !== 'waiting_for_selection') return sanitizeJob(job);
const { data } = await oauthClient.request({ url: `${PICKER_API}/sessions/${job.pickerSessionId}` });
if (!data.mediaItemsSet) return sanitizeJob(job);
const items = await listAllPickedItems(job); // finish every page or throw
job.total = items.length;
job.status = items.length ? 'importing' : 'completed';
if (items.length) job.promise = runImport(job, items);
return sanitizeJob(job);
```

`listAllPickedItems` follows `nextPageToken` on `GET /mediaItems?sessionId=...&pageSize=100&pageToken=...`. `cancel` and terminal cleanup call Picker `sessions.delete` once. Sanitize Google errors to their message without request config, headers, token, or URL.

- [ ] **Step 8: Run the service tests and verify GREEN**

Run: `npm --prefix backend test -- --test-name-pattern='Google Photos|Picker|fixed folder|extension-aware|start |timeout|cancel|page failure'`

Expected: all service tests pass.

- [ ] **Step 9: Commit Task 2**

```bash
git add backend/src/services/googlePhotosImportService.js backend/test/googlePhotosImportService.test.js
git commit -m "feat: manage Google Photos Picker sessions"
```

---

### Task 3: Bounded Stream Import, Partial Results, and Routes

**Files:**
- Modify: `backend/src/services/googlePhotosImportService.js`
- Modify: `backend/test/googlePhotosImportService.test.js`
- Modify: `backend/src/routes/accountRoutes.js`

**Interfaces:**
- Consumes: `adapter.ensureRemotePath(path)`, `adapter.listFileNames(parentId)`, `adapter.uploadStream({ stream, fileName, mimeType, virtualPath, remoteParentId, onProgress })`.
- Produces: `POST /api/accounts/google/:accountId/photos/imports`, `GET /api/accounts/google/photos/imports/:importId`, and `DELETE /api/accounts/google/photos/imports/:importId`.
- Route response shape: `{ data: SanitizedImportJob }`; POST returns HTTP 201.

- [ ] **Step 1: Write failing streaming/concurrency/error tests**

Use real Node `Readable.from()` streams and fakes only at Google/Drive network boundaries. Assert outcomes, not mock existence:

```js
test('imports images and videos with no more than two active transfers', async () => {
	// Three deferred uploadStream calls track active/maxActive and return sizes.
	// Assert maxActive === 2, completed === 3, failed === 0.
});

test('keeps successful files when one media transfer fails', async () => {
	// One oauthClient.request({ responseType: 'stream' }) rejects, one succeeds.
	// Assert status === 'completed_with_errors', completed === 1, failed === 1.
});

test('auth failure marks the account invalid and starts no later items', async () => {
	// First transfer throws an error with status 401.
	// Assert terminal status failed, markStatus receives invalid_token, later upload count is zero.
});
```

Also assert image download uses Picker's `=d` URL and video uses `=dv`, each request sets `responseType: 'stream'`, and allocated names are passed to `uploadStream` with the one resolved parent ID. These URLs provide Picker's best available rendition, not guaranteed byte-identical originals.

- [ ] **Step 2: Run import tests and verify RED**

Run: `npm --prefix backend test -- --test-name-pattern='no more than two|successful files|auth failure|best available'`

Expected: tests fail because `runImport` has no transfer implementation.

- [ ] **Step 3: Implement the bounded import pipeline**

Before workers start:

```js
const virtualPath = buildGooglePhotosImportPath(account.email);
const remoteParentId = await adapter.ensureRemotePath(virtualPath);
const existingNames = await adapter.listFileNames(remoteParentId);
const allocatedNames = allocateDuplicateNames(items.map(itemFileName), existingNames);
```

Use two native async workers sharing a synchronous index; no queue dependency. Each worker requests the media as a Node stream through `oauthClient.request({ url, responseType: 'stream' })`, then calls `adapter.uploadStream`. Increment counters and emit sanitized `photos-import:*` events under the import ID. On non-auth failure, append `{ fileName, message }` and continue. On auth failure, set a stop flag, mark the account `invalid_token`, and do not claim unstarted items as completed.

After workers settle, call `syncAccount(userId, account)` once if at least one upload succeeded. Always attempt Picker-session deletion in `finally`; cleanup failure adds a sanitized job error without changing imported-file outcomes.

- [ ] **Step 4: Run all service tests and verify GREEN**

Run: `npm --prefix backend test -- --test-name-pattern='Google Photos|Picker|fixed folder|extension-aware|start |timeout|cancel|page failure|no more than two|successful files|auth failure|best available'`

Expected: all focused tests pass.

- [ ] **Step 5: Write failing route authorization tests**

Start a real Express app on an ephemeral port using the established `authSettings.test.js` pattern. Create a local Google Drive account fixture, replace only the external Picker request boundary, and assert:

```js
assert.equal(startResponse.status, 201);
assert.equal(startPayload.data.accountId, googleAccount.id);
assert.equal((await statusResponse.json()).data.id, startPayload.data.id);
assert.equal(cancelResponse.status, 200);
```

Also assert an unknown/non-owned account returns 400 without exposing credentials.

- [ ] **Step 6: Run route tests and verify RED**

Run: `npm --prefix backend test -- --test-name-pattern='Photos import route'`

Expected: 404 because routes are absent.

- [ ] **Step 7: Add authenticated account routes**

In `accountRoutes.js`, add handlers:

```js
router.post('/accounts/google/:accountId/photos/imports', async (req, res, next) => {
	try {
		res.status(201).json({ data: await startGooglePhotosImport(req.user.id, req.params.accountId) });
	} catch (error) { next(error); }
});

router.get('/accounts/google/photos/imports/:importId', async (req, res, next) => {
	try {
		res.json({ data: await refreshGooglePhotosImport(req.user.id, req.params.importId) });
	} catch (error) { next(error); }
});

router.delete('/accounts/google/photos/imports/:importId', async (req, res, next) => {
	try {
		res.json({ data: await cancelGooglePhotosImport(req.user.id, req.params.importId) });
	} catch (error) { next(error); }
});
```

The service lookup enforces job ownership; the existing router middleware enforces app authentication.

- [ ] **Step 8: Run backend suite and verify GREEN**

Run: `npm --prefix backend test`

Expected: zero failing tests and no unhandled rejection.

- [ ] **Step 9: Commit Task 3**

```bash
git add backend/src/services/googlePhotosImportService.js backend/src/routes/accountRoutes.js backend/test/googlePhotosImportService.test.js
git commit -m "feat: import picked Google media into Drive"
```

---

### Task 4: Storage UI, Progress, Translations, and Setup Guide

**Files:**
- Modify: `frontend/src/services/api.js`
- Modify: `frontend/src/views/QuotaView.vue`
- Modify: `frontend/src/locales/en.json`
- Modify: `frontend/src/locales/id.json`
- Modify: `docs/provider-setup.md`

**Interfaces:**
- Consumes: Task 3 REST endpoints and the existing `api.createUploadSocket(importId)` channel.
- Produces: per-account `startGooglePhotosImport(account)` UI flow and a progress/result panel on each active Google Drive card.

- [ ] **Step 1: Add API client methods**

Add these thin native-fetch wrappers; they need no isolated test because `request` and HTTP semantics are already the boundary:

```js
startGooglePhotosImport(accountId) {
	return request(`/accounts/google/${encodeURIComponent(accountId)}/photos/imports`, { method: 'POST' });
},
getGooglePhotosImport(importId) {
	return request(`/accounts/google/photos/imports/${encodeURIComponent(importId)}`);
},
cancelGooglePhotosImport(importId) {
	return request(`/accounts/google/photos/imports/${encodeURIComponent(importId)}`, { method: 'DELETE' });
},
```

- [ ] **Step 2: Implement the account-card Picker flow**

In `QuotaView.vue`, keep state keyed by account ID. Open a blank popup synchronously so browser popup blocking cannot race the POST:

```js
async function startGooglePhotosImport(account) {
	const pickerWindow = window.open('', '_blank');
	try {
		const { data } = await api.startGooglePhotosImport(account.id);
		pickerWindow.location.replace(`${data.pickerUri}/autoclose`);
		photoImports.value[account.id] = data;
		watchPhotoImport(account, data.id, pickerWindow);
	} catch (error) {
		pickerWindow?.close();
		actionError.value = error.message;
	}
}
```

`watchPhotoImport` opens `api.createUploadSocket(importId)` for progress events and polls `getGooglePhotosImport` using the newest returned `pollIntervalMs`. If `pickerWindow.closed`, cancel only after a second consecutive backend refresh still reports `waiting_for_selection`; one stale waiting response after `/autoclose` is not enough. Stop timers/socket on `completed`, `completed_with_errors`, `failed`, or `cancelled`; reload accounts after any successful upload so quota and metadata are current.

Add an **Import from Google Photos** button only for active `google_drive` cards. While active, show selected/complete/failed counts and the terminal summary. Existing invalid-token cards keep the reconnect action.

- [ ] **Step 3: Add English and Indonesian strings**

Under `storage`, add exact keys in both locale files:

```json
"importGooglePhotos": "Import from Google Photos",
"waitingGooglePhotos": "Waiting for your Google Photos selection...",
"importingGooglePhotos": "Importing {completed} of {total}...",
"googlePhotosImportComplete": "Imported {count} item(s).",
"googlePhotosImportPartial": "Imported {completed}; {failed} failed.",
"googlePhotosReconnect": "Reconnect this Google Drive account to authorize Google Photos Picker.",
"googlePhotosCancelled": "Google Photos import cancelled."
```

Provide natural Indonesian equivalents in `id.json`; do not add a third locale.

- [ ] **Step 4: Document Google Console setup**

Extend `docs/provider-setup.md` Google section with:

- enable **Google Photos Picker API** in addition to Google Drive API;
- add `.../auth/photospicker.mediaitems.readonly` to the OAuth consent screen;
- keep the existing Google redirect URI unchanged;
- reconnect existing OmniCloud Google Drive accounts once;
- explain that Picker imports only user-selected items and does not expose the whole Photos library.

- [ ] **Step 5: Run frontend tests and build**

Run: `npm --prefix frontend test`

Expected: zero failing tests.

Run: `npm --prefix frontend run build`

Expected: Vite exits 0 with no unresolved imports or template errors.

- [ ] **Step 6: Manual browser smoke test**

With the Picker API enabled and an authorized test account:

1. Reconnect the Google Drive account and verify the Picker consent appears.
2. Click **Import from Google Photos**, select one image and one video, and finish.
3. Verify live counts and the terminal summary.
4. Verify the best Picker-provided renditions under `/OmniCloud/Google Fotos/<local-part>/` on that same Drive, allowing stripped image location metadata and transcoded video.
5. Repeat the selection and verify `(2)` names.
6. Close a new Picker without choosing and verify cancellation creates no files.

- [ ] **Step 7: Run full verification**

Run: `npm --prefix backend test && npm --prefix frontend test && npm --prefix frontend run build && git diff --check`

Expected: every command exits 0; all tests pass; build succeeds; diff check is empty.

- [ ] **Step 8: Commit Task 4**

```bash
git add frontend/src/services/api.js frontend/src/views/QuotaView.vue frontend/src/locales/en.json frontend/src/locales/id.json docs/provider-setup.md
git commit -m "feat: add Google Photos import flow"
```

---

## Final Requirements Audit

- Re-read `docs/superpowers/specs/2026-08-03-google-photos-picker-drive-import-design.md` line by line.
- Confirm each global constraint has an implementation or test named above.
- Inspect `git status --short` and preserve unrelated user changes.
- Run the full verification command again immediately before claiming completion.
- Report any manual Google Console/account verification that could not be performed locally.
