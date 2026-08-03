# Registration and Grid Thumbnails Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hide registration entry points when instance registration is disabled and render cached content thumbnails for supported grid files.

**Architecture:** Extend the existing public auth summary rather than opening app settings. Add one thumbnail service behind the existing user-scoped file route, using OS conversion tools and filesystem caching; the shared grid card lazily requests the resulting cover and falls back to its current icon.

**Tech Stack:** Node.js 22, Express 5, SQLite, Vue 3, native Node test runner, FFmpeg, Poppler and headless LibreOffice.

## Global Constraints

- Preserve existing SMB/WebDAV working-tree changes and do not commit without explicit authorization.
- Add no npm dependency.
- Maximum conversion input is 100 MB and command timeout is 30 seconds.
- Audio, archives, folders and unknown types retain their icons.
- Use `execFile`, never a shell, for converter processes.
- Cache covers beneath `THUMBNAIL_CACHE_DIR`, defaulting to the backend data directory.

---

### Task 1: Public Registration State

**Files:**
- Create: `backend/test/authSettings.test.js`
- Modify: `backend/src/services/authService.js`
- Modify: `frontend/src/stores/auth.js`
- Modify: `frontend/src/views/auth/LoginView.vue`
- Modify: `frontend/src/router/index.js`

**Interfaces:**
- Produces: `getAuthSummary(user).registrationEnabled: boolean`
- Consumes: existing `isRegistrationEnabled()` and `/api/auth/me` bootstrap

- [ ] **Step 1: Write the failing backend contract test**

Create a hosted-mode app with a temporary database. Assert that `/api/auth/me` initially returns `registrationEnabled: true`, then call `setAppSetting('registration_enabled', 'false')` and assert that the same endpoint returns `false`. Also assert that `POST /api/auth/register` returns 400 while disabled.

- [ ] **Step 2: Verify RED**

Run `npm --prefix backend test -- authSettings.test.js` and confirm the summary assertion fails because `registrationEnabled` is absent.

- [ ] **Step 3: Implement the backend contract**

Add `registrationEnabled: isRegistrationEnabled()` to `getAuthSummary`.

- [ ] **Step 4: Verify GREEN**

Run `node --test backend/test/authSettings.test.js` and confirm all assertions pass.

- [ ] **Step 5: Connect the frontend**

Add `registrationEnabled: true` to the auth store and apply it with `summary.registrationEnabled !== false`. Hide the full login registration switch when false. In the public-route guard, redirect the disabled `register` route to `login` before rendering it.

- [ ] **Step 6: Verify the frontend contract**

Run `npm --prefix frontend run build`. Later browser verification must confirm both hidden CTA and direct-route redirect.

### Task 2: Thumbnail Classification and Cache Service

**Files:**
- Create: `backend/test/thumbnailService.test.js`
- Create: `backend/src/services/thumbnailService.js`
- Modify: `backend/src/config/env.js`

**Interfaces:**
- Produces: `getThumbnailKind(file): 'video'|'pdf'|'document'|'text'|null`
- Produces: `getThumbnailCacheKey(userId, file): string`
- Produces: `generateThumbnail({ userId, file, openStream, cacheDir?, execute? }): Promise<string>` returning a JPEG path

- [ ] **Step 1: Write failing classification and cache-key tests**

Use literal MIME/extension cases for video, PDF, Office/OpenDocument, text/JSON and unsupported audio/archive/folder. Assert the SHA-256 key changes when user ID, file ID, modification timestamp or size changes.

- [ ] **Step 2: Verify RED**

Run `node --test backend/test/thumbnailService.test.js`; it must fail because the module does not exist.

- [ ] **Step 3: Implement classification and cache identity**

Use MIME first and filename extension as fallback. Build the key from `[userId, file.id, modifiedTime || remote_modified_time || updated_at || '', Number(file.size || 0)]` serialized as JSON and hashed with SHA-256.

- [ ] **Step 4: Verify GREEN for pure functions**

Run `node --test backend/test/thumbnailService.test.js` and confirm the classification/key cases pass.

- [ ] **Step 5: Write failing observable generation tests**

With a temporary cache and a controlled `execute(program, args)` boundary, create the output files that FFmpeg, Poppler or LibreOffice would produce. Assert video returns a JPEG, Office conversion passes through a PDF, a second request returns the cache without invoking a deliberately failing `openStream`, oversized input fails with status 415 and converter failure becomes status 422.

- [ ] **Step 6: Verify RED for generation**

Run the focused test and confirm it fails because `generateThumbnail` is absent.

- [ ] **Step 7: Implement minimum generation service**

Create the cache directory, return an existing cache hit before calling `openStream`, stream input into a same-filesystem temporary directory while enforcing the 100 MB ceiling, execute fixed converter arguments with a 30-second timeout, atomically rename the resulting JPEG, and remove the temporary directory in `finally`. FFmpeg seeks to one second then retries the first frame; Poppler renders page one; LibreOffice writes a PDF that Poppler renders.

- [ ] **Step 8: Verify GREEN**

Run `node --test backend/test/thumbnailService.test.js` and confirm all service behavior passes.

### Task 3: Authenticated Thumbnail Route

**Files:**
- Modify: `backend/src/routes/fileRoutes.js`
- Create: `backend/test/thumbnailRoutes.test.js`

**Interfaces:**
- Consumes: existing `getFileContext`, `ensureFileContext`, adapter `getDownloadStream(file)` and `generateThumbnail`
- Produces: authenticated `GET /api/files/:id/thumbnail` with `image/jpeg`, HTTP 415 for unsupported/oversized input and HTTP 422 for conversion failure

- [ ] **Step 1: Write the failing route test**

Use local mode and a temporary database with a real file/account record using the existing test-only `base` adapter. Assert an unsupported file returns 415 without downloading; preseed a supported file's cache and assert the route returns its JPEG bytes and private cache headers without provider access. Authentication is already enforced by the router-wide `requireAppUser`; the hosted contract remains covered through the application's existing auth middleware tests and browser verification.

- [ ] **Step 2: Verify RED**

Run `node --test backend/test/thumbnailRoutes.test.js` and confirm the route is missing.

- [ ] **Step 3: Implement the route**

Resolve the file through the existing user-scoped context, reject folders/unsupported files before opening the stream, pass `() => context.adapter.getDownloadStream(context.file)` to the generator, set `Content-Type: image/jpeg` and `Cache-Control: private, max-age=86400`, then stream the cached JPEG. Convert service status errors into their exact HTTP responses and pass unexpected failures to Express error handling.

- [ ] **Step 4: Verify GREEN**

Run the focused route test and then the full backend suite.

### Task 4: Shared Grid Card Covers

**Files:**
- Create: `frontend/test/fileType.test.js`
- Modify: `frontend/package.json`
- Modify: `frontend/src/composables/useFileType.js`
- Modify: `frontend/src/services/api.js`
- Modify: `frontend/src/components/FileListGridCard.vue`

**Interfaces:**
- Produces: `canShowGridThumbnail(file): boolean`
- Produces: `api.thumbnailUrl(file): string` with a modification/size version query
- Consumes: existing `api.previewUrl(file.id)` for images

- [ ] **Step 1: Write the failing eligibility test**

Add a native Node test with literal file records. Images, videos, PDFs, Office/OpenDocument, text and JSON must return true; audio, archives, folders and unknown files must return false. Add `frontend` script `test: node --test "test/*.test.js"`.

- [ ] **Step 2: Verify RED**

Run `npm --prefix frontend test` and confirm the missing export fails.

- [ ] **Step 3: Implement eligibility and URL building**

Add `canShowGridThumbnail` beside existing file-category logic. Add `thumbnailUrl(file)` that uses the existing preview URL for images and `/files/:id/thumbnail` otherwise, appending a `v` query derived from modification timestamp and size.

- [ ] **Step 4: Verify GREEN for eligibility**

Run `npm --prefix frontend test`.

- [ ] **Step 5: Render the cover in the shared card**

Track one load-failure flag per component instance. For eligible files, render a lazy fixed-aspect image using `api.thumbnailUrl(item)`; on error switch permanently to the existing icon. Preserve star, selection, provider and interaction behavior.

- [ ] **Step 6: Verify frontend output**

Run `npm --prefix frontend test` and `npm --prefix frontend run build`.

### Task 5: Container Runtime and End-to-End Verification

**Files:**
- Modify: `backend/Dockerfile`

**Interfaces:**
- Provides runtime executables: `ffmpeg`, `pdftoppm`, `libreoffice`

- [ ] **Step 1: Install runtime tools**

In the backend runtime stage, install `ffmpeg`, `poppler-utils`, `libreoffice-core`, `libreoffice-writer`, `libreoffice-calc`, `libreoffice-impress` and `fonts-dejavu-core` with `--no-install-recommends`, then remove apt lists in the same Docker layer.

- [ ] **Step 2: Run all automated checks**

Run `npm --prefix backend test`, `npm --prefix frontend test` and `npm --prefix frontend run build`.

- [ ] **Step 3: Build the backend container**

Run `docker build -f backend/Dockerfile -t omnicloud-api:thumbnail-test .` and verify all three converter executables inside the resulting image.

- [ ] **Step 4: Browser verification**

Run the local stack and verify: disabled registration hides the CTA; direct `/register` redirects; image/video/PDF/Office/text cards show covers; unsupported/audio/archive/folder cards retain icons; failed cover requests do not break card interaction.

- [ ] **Step 5: Report scope**

List only files changed for this feature and separately report the pre-existing SMB/WebDAV and Graphify files. Do not stage, commit, push or deploy.
