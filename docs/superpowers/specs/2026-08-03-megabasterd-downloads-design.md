# MegaBasterd downloads design

## Goal

Route every MEGA download through a headless MegaBasterd service while keeping `megajs` as a one-attempt fallback. Support both files from connected private MEGA accounts and public `mega.nz` links. Public links can either be downloaded by the browser or imported into the currently open OmniCloud folder.

## Scope

This change covers the MEGA download data path, public-link UI, direct public-link downloads, public-link imports, cache warming, previews, and WebDAV reads. Existing MEGA browsing, account connection, uploads, rename, delete, and synchronization remain on `megajs`.

Proxy rotation, VPN automation, CAPTCHA handling, and attempts to bypass MEGA limits are out of scope. The integration must respect MEGA's terms of use.

## Architecture

Add a `megabasterd` Docker service that runs without a graphical environment and exposes a small HTTP API only to the Compose network. It is derived from MegaBasterd and kept as a separately built GPL-3.0 component. The first implementation is pinned to upstream commit `3b204d226515a6f4ecb6630371e19722077b03fc` (MegaBasterd 8.57) so builds remain reproducible.

The Express backend remains the sole public entry point. A new `megaDownloadService` requests streams from the sidecar and falls back once to `megajs` when the sidecar fails before returning a successful response. The existing file cache, preview, WebDAV, and browser-download flows continue to consume a Node readable stream and do not need provider-specific branches.

The sidecar and backend authenticate with a required shared secret. The sidecar publishes no host port, stores no OmniCloud user data, and does not log signed transfer URLs, file keys, or complete MEGA links. This process boundary is intended to keep the derived GPL component separate from the MIT application, but it is not a legal determination about distribution obligations.

## Headless service contract

The internal service provides:

- `GET /health`: reports readiness without exposing configuration or credentials.
- `POST /inspect`: accepts a public MEGA link and returns normalized `file_name`, `size`, and `mime_type` metadata.
- `POST /stream`: accepts either a public link or a private resolved-transfer request and returns the decrypted file body. It honors a normalized byte range when one is supplied.

For a private file, `megajs` uses the connected account session only to resolve the node into MEGA's short-lived signed transfer URL and its file key; it does not transfer file bytes on the primary path. The backend passes that URL, key, size, and safe filename to the sidecar. Values live in memory for the request lifetime and are discarded afterward. This avoids sending account passwords or stale one-time 2FA codes to the sidecar. Public requests accept only canonical MEGA file links; folder links are rejected in the first version because OmniCloud's direct-download endpoint represents one file.

The service stops active work when the HTTP client disconnects. It returns structured error codes for invalid input, authentication failure, missing files, invalid MEGA credentials, quota exhaustion, unsupported links, and internal failures.

## Backend components

### MegaBasterd client

A small Node client owns internal authentication, timeouts, request cancellation, response metadata, and conversion of the HTTP body to a Node readable stream. It never retries by itself.

### MEGA download service

`megaDownloadService` is the single policy boundary for MegaBasterd-first behavior. It has operations to inspect a public link, stream a public link, and stream a private file. Each operation:

1. calls the sidecar;
2. uses `megajs` once if the sidecar is unavailable, times out before response headers, returns an unsupported-operation response, or otherwise fails before a byte is exposed;
3. returns the selected stream and normalized metadata.

Client cancellation, invalid input, invalid credentials, missing files, and MEGA quota errors are terminal and do not trigger fallback. Once a successful stream has begun, later failure ends that stream; the implementation must never append bytes from the fallback to a partial response.

### Private files

`MegaAdapter.getDownloadStream(file, range)` delegates to `megaDownloadService`. The adapter resolves its existing `megajs` file object into a signed ciphertext URL and file key, then supplies those values to the sidecar. The fallback reuses that file object's existing `megajs` download stream and supports the requested range.

This changes the byte source only. File listing and mutation methods stay unchanged.

### Public-link routes

Add authenticated routes under `/api/mega-links`:

- `POST /inspect` validates and inspects a link.
- `POST /download` streams one link as an attachment.
- `POST /import` validates the link, creates an upload session for the current user and destination, and returns `202` with the upload ID while work continues.

All routes parse the submitted value as a URL and allow only canonical HTTPS MEGA hosts and supported file-link shapes before contacting either downloader. Redirects to non-MEGA hosts are not followed. Request bodies and errors must not echo complete links or embedded keys.

### Public-link import

Import metadata is resolved before allocation. The route uses the existing `selectBestAccount`, upload-session, `runUpload`, file-cache capture, provider fallback, synchronization, and WebSocket progress behavior. The download stream is piped directly into the selected provider upload; no additional temporary file is introduced.

The destination is the virtual path currently open in the explorer. Existing allocation settings select the target account. On success, the standard upload completion event includes the new file metadata. On failure, the upload session is marked failed and partial upload/cache state follows the existing cleanup path.

## Frontend

Add a `Link do MEGA` action to the file explorer's existing action area. It opens a compact modal containing one URL field and two actions:

- `Baixar`: calls the direct-download route and registers the transfer in the existing tracked download queue and progress toast.
- `Importar nesta pasta`: submits the current virtual path, then tracks the returned upload ID through the existing upload queue and WebSocket events.

The modal validates that a value looks like an HTTPS MEGA link for immediate feedback, while the backend remains authoritative. Completion of an import refreshes the current folder. English and Indonesian locale files receive matching strings; Portuguese text is not added unless the application adds a Portuguese locale separately.

## Error handling and observability

- Sidecar startup failure leaves the API healthy in fallback mode and is visible in health output.
- Initial sidecar timeout or supported transient failure produces one `megajs` attempt.
- HTTP 509/quota exhaustion, invalid credentials, removed links, and malformed links produce specific user-facing errors and no loop.
- Mid-stream failure destroys the response or upload stream and records the operation as failed.
- User cancellation aborts both the internal HTTP request and its MegaBasterd work.
- Health output reports sidecar availability and whether fallback is enabled, without secrets.
- Logs record the mechanism, operation type, timing, fallback decision, and safe error code. They exclude signed transfer URLs, keys, credentials, and full public links.

## Deployment and licensing

`docker-compose.yml` gains the internal `megabasterd` service, a health check, and API dependency wiring. The API waits for the sidecar container to start but does not require it to become healthy, preserving fallback-only startup. The service uses a multi-stage Java build and a pinned upstream revision. It has no host port and runs as a non-root user.

`MEGABASTERD_INTERNAL_SECRET` is required by the API and sidecar. Backend environment documentation describes the variable without supplying an insecure production default.

The derived service directory contains its GPL-3.0 license, upstream attribution, pinned revision, source/build instructions, and a clear notice of OmniCloud modifications. OmniCloud's existing MIT license remains attached to the existing application code. Distribution requirements must be reviewed before publishing packaged images.

## Verification

Automated checks cover:

- Node client authentication, timeout, cancellation, redaction, and response mapping;
- MegaBasterd-first selection, one-attempt fallback, terminal errors, and the no-mid-stream-fallback rule;
- private `MegaAdapter` downloads and byte ranges;
- route authentication, canonical-link validation, SSRF rejection, direct streaming, and import initiation;
- import destination, allocation selection, upload progress, completion, and failure cleanup;
- Java service authentication, `/inspect`, `/stream`, ranges, structured errors, and disconnect cancellation;
- Docker image builds, service health checks, and API fallback when the sidecar is unavailable.

Tests use fakes or local fixtures and contain no real MEGA credentials. A documented manual smoke test uses one private account file and one public file link to verify both direct download and import after automated checks pass.

## Success criteria

- Private MEGA file bytes come from MegaBasterd when the sidecar is healthy.
- The same private download succeeds through `megajs` when the sidecar is unavailable before streaming starts.
- A valid public file link can be downloaded directly or imported into the open folder.
- Imports honor existing allocation, cache, progress, and explorer-refresh behavior.
- Cache warming, previews, and WebDAV continue to work for MEGA files.
- Cancellation does not leave active sidecar work, upload sessions, or partial cache artifacts.
- Secrets and complete MEGA links do not appear in application logs.
