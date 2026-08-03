# Registration Visibility and Grid Thumbnails

## Goal

Make the public authentication UI respect the instance-wide registration setting and show useful content thumbnails in every file grid.

## Registration visibility

`GET /api/auth/me` will include `registrationEnabled` in its existing public authentication summary. The auth store will retain that value.

The login page will show the registration switch only when registration is enabled. The router will also redirect direct visits to `/register` back to `/login` when registration is disabled. The existing server-side rejection in `registerHostedUser` remains the authority and prevents bypassing the UI.

This reuses the existing public bootstrap request instead of exposing a second public settings endpoint.

## Thumbnail endpoint

Add authenticated `GET /api/files/:id/thumbnail`. It will use the same user-scoped file lookup and provider adapter path as preview and download, so users cannot request another user's file.

Supported content:

- Images: use the existing inline preview URL directly.
- Videos: extract the frame at one second with FFmpeg, falling back to the first frame when necessary.
- PDFs: render the first page with Poppler.
- DOC, DOCX, XLS, XLSX, PPT, PPTX, ODT, ODS and ODP: convert to PDF with headless LibreOffice, then render the first page with Poppler.
- Plain text and JSON: attempt conversion through headless LibreOffice; conversion failure falls back to the existing icon.
- Audio, archives, folders and unknown types: retain the existing file icon.

Generated covers will be JPEG images. Conversion commands will use `execFile` without a shell, fixed arguments, a 30-second timeout and temporary directories created by the operating system.

## Cache and limits

The thumbnail cache will live in `/app/data/thumbnails` in Docker, configurable through `THUMBNAIL_CACHE_DIR` for local and test environments. Docker's existing `/app/data` volume preserves it across restarts. The SHA-256 cache key will include the user ID, file ID, normalized modification timestamp and size. A changed file therefore gets a new cover without explicit invalidation; old entries may remain until an operational cleanup policy is actually needed.

Files above 100 MB will not be converted. Unsupported or oversized files return HTTP 415; failed or timed-out conversions return HTTP 422. In each case the frontend falls back to the normal icon. Concurrent cache misses may duplicate conversion work, but final cache writes will be atomic; per-file locking is deferred until measurements show contention.

## Grid behavior

`FileListGridCard` is the single rendering point shared by My Drive, Recent, Starred and Shared With Me.

For supported files it will request the image or generated thumbnail lazily. The cover occupies a fixed aspect-ratio area with `object-fit: cover`. If loading fails, the card switches to the existing type icon. Folders and unsupported formats do not make thumbnail requests.

The file name, provider, owner, date, size, selection state, star and existing card interactions remain unchanged.

## Deployment

The backend image will install FFmpeg, Poppler utilities and headless LibreOffice from Debian packages. No npm dependency is added. The frontend image remains unchanged.

## Verification

- Backend contract test: `/api/auth/me` reports registration disabled and registration still rejects new accounts.
- Frontend behavior check: login hides the create-account action and `/register` redirects to `/login`.
- Thumbnail unit tests: supported-type classification, cache identity and converter command selection.
- Thumbnail route test: authentication, unsupported files, cache hit and successful JPEG response using a controlled converter fixture.
- Build and existing backend test suite.
- Browser verification of image, video, PDF, Office document and fallback cards in grid mode.

## Deliberate limits

- No thumbnails for audio, archives or folders.
- No background pre-generation queue.
- No cache database or eviction service.
- No provider-specific thumbnail APIs.

These should be added only if real usage shows that on-demand generation and filesystem caching are insufficient.
