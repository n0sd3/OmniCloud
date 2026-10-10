# OmniCloud S3 Gateway

The inbound gateway exposes the **consolidated virtual filesystem**, with one virtual bucket per user. Connected providers are never exposed as separate buckets. Outbound `S3Adapter` credentials remain independent of gateway access keys.

```text
AWS CLI / rclone / AWS SDK v3
             ↓
Express root → SigV4 → gateway credential → OmniCloud user
             ↓
one virtual bucket → virtual path/name → shared filesystem coordinator
             ↓
fileService / uploadSessionService / runUpload / spaceAllocator / fileCacheService
             ↓
existing adapters → Google / OneDrive / MEGA / Dropbox / pCloud / Yandex / S3
```

## Enable and configure

Set these in `backend/.env`, then restart the API:

```dotenv
S3_GATEWAY_ENABLED=true
S3_GATEWAY_BUCKET=omnicloud
S3_GATEWAY_REGION=auto
S3_GATEWAY_ENDPOINT=https://s3.example.com
S3_MULTIPART_TTL_HOURS=24
S3_STAGING_MAX_BYTES=1099511627776
S3_MAX_UPLOADS_PER_USER=100
S3_MAX_CONCURRENT_REQUESTS=32
S3_REQUEST_TIMEOUT_MS=3600000
```

Use a strong `OMNICLOUD_SECRET_HALF` (at least 32 characters; enabling the gateway otherwise fails) and preserve it and the hostname across restarts. The project's AES key derives from both. Compose already fixes the API hostname to `omnicloud-api`. Changing either makes existing encrypted provider/gateway credentials unreadable; regenerate keys after any intentional key change. Back up SQLite and the persistent data volume together.

Compose sets `S3_MULTIPART_PATH=/app/data/s3-multipart`. It uses the existing `omnicloud_api_data:/app/data` volume, so another volume is unnecessary. Outside Docker, set `S3_MULTIPART_PATH` to durable local storage. The API process needs write access. Temporary files have mode `0600`, and a newly created staging directory has mode `0700`.

The staging quota is **aggregate across users**, including stored parts and concurrent simple PUT bodies. It is not a per-object limit. Disk needs room for staging, the shared file cache, and provider-specific temporary storage. Providers retain their own quota and file-size limits. Multipart allows 10,000 parts; each part can be at most 5 GiB, and all but the final part must be at least 5 MiB. Adjust disk quota and request timeout for your workload.

In **Settings → S3 Gateway**:

1. Enable access for your account. The server-wide switch must also be on.
2. Generate an access key and save the secret immediately. It is shown only in the creation response/UI, not in later lists.
3. Copy the configured endpoint and bucket name.
4. Revoke keys to disable them permanently, or replace a credential to revoke the old key and create a new one atomically.

The authenticated management API is separate from the S3 protocol:

| REST endpoint | Purpose |
|---|---|
| `GET /api/s3-gateway` | Status, configured endpoint/bucket/region, key creation/last-use dates |
| `PATCH /api/s3-gateway` | `{ "enabled": true }` for the current user |
| `POST /api/s3-gateway/keys` | Create key; return secret once |
| `DELETE /api/s3-gateway/keys/:key` | Revoke a key owned by the current user |
| `POST /api/s3-gateway/keys/:key/rotate` | Revoke and replace a current user's active key |

Responses use `Cache-Control: no-store`. Hosted mode requires an authenticated app session. Maximum ten active keys per user. Gateway credentials are never read from cloud account credentials or generic `user_settings`.

## AWS CLI

```bash
aws configure --profile omnicloud
# Access key: the OC... gateway key
# Secret: the gateway secret
# Region: auto (or the configured region)

aws configure set request_checksum_calculation when_required --profile omnicloud
aws configure set response_checksum_validation when_required --profile omnicloud
aws configure set s3.addressing_style path --profile omnicloud

aws --profile omnicloud --endpoint-url https://s3.example.com s3 ls
aws --profile omnicloud --endpoint-url https://s3.example.com s3 ls s3://omnicloud/
aws --profile omnicloud --endpoint-url https://s3.example.com s3 cp teste.txt s3://omnicloud/teste/arquivo.txt
aws --profile omnicloud --endpoint-url https://s3.example.com s3 cp s3://omnicloud/teste/arquivo.txt ./download.txt
aws --profile omnicloud --endpoint-url https://s3.example.com s3 rm s3://omnicloud/teste/arquivo.txt
aws --profile omnicloud --endpoint-url https://s3.example.com s3 cp arquivo-grande.iso s3://omnicloud/backups/
```

The uploaded key `teste/arquivo.txt` appears as `/teste/arquivo.txt` in OmniCloud. Parent folders are created through the normal adapter/metadata services. REST, WebDAV and SMB use the same logical records and cache. Tests verify a file uploaded by S3 can be downloaded by REST/WebDAV, then overwritten by WebDAV and read by S3 without duplicating its logical record.

The checksum configuration avoids `aws-chunked` streaming/trailer encodings, which this first version rejects explicitly. Ordinary SHA256 payload hashes, `UNSIGNED-PAYLOAD`, Content-MD5 and checksum headers for CRC32, CRC32C, SHA1 and SHA256 are supported. Always publish over HTTPS; unsigned payloads rely on transport security.

## rclone

```ini
[omnicloud]
type = s3
provider = Other
access_key_id = OC...
secret_access_key = ...
endpoint = https://s3.example.com
region = auto
force_path_style = true
no_check_bucket = true
```

```bash
rclone ls omnicloud:omnicloud
rclone copyto teste.txt omnicloud:omnicloud/teste/arquivo.txt
rclone copyto omnicloud:omnicloud/teste/arquivo.txt download.txt
rclone deletefile omnicloud:omnicloud/teste/arquivo.txt
```

`no_check_bucket` avoids attempts to create the fixed virtual bucket. Custom `x-amz-meta-*` headers, including rclone's modification timestamp, are limited to 2 KiB and stored alongside the uploaded object's version. Their values are safely returned by HEAD/GET while that version remains current.

## AWS SDK for JavaScript v3

```js
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';

const client = new S3Client({
  endpoint: 'https://s3.example.com',
  region: 'auto',
  forcePathStyle: true,
  credentials: { accessKeyId: process.env.OC_ACCESS_KEY, secretAccessKey: process.env.OC_SECRET_KEY },
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});

await client.send(new PutObjectCommand({
  Bucket: 'omnicloud', Key: 'teste/arquivo.txt', Body: 'example', ContentType: 'text/plain',
}));
// Use Upload for a large readable stream; it uses Create/UploadPart/Complete/Abort.
await new Upload({ client, params: { Bucket: 'omnicloud', Key: 'backups/large.bin', Body: stream } }).done();
```

Presigned GET and PUT URLs use normal S3 SigV4 query parameters, with a maximum lifetime of seven days. Keys must remain enabled and user gateway access must remain enabled; revocation also invalidates existing URLs.

## Reverse proxy

The frontend Nginx now routes hostnames matching `s3.*` to the API root. The normal hostname still serves the frontend. Path-style addresses use the dedicated endpoint `https://s3.example.com/omnicloud/key`, without `/api`.

Configure your outer TLS reverse proxy equivalently (replace host/upstream):

```nginx
server {
    listen 443 ssl;
    server_name s3.example.com;
    # Configure ssl_certificate and ssl_certificate_key for this hostname.
    client_max_body_size 0;
    location / {
        proxy_pass http://omnicloud-web:80;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header Connection "";
        proxy_request_buffering off;
        proxy_buffering off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        client_body_timeout 3600s;
    }
}
```

Preserve the **original Host including port**, request URI/query and all Authorization, Range and `x-amz-*` headers. Do not rewrite or normalize encoded paths, redirect signed requests, or place a login page in front of the endpoint. Nginx forwards PUT/POST/GET/HEAD/DELETE without a method whitelist. Upload and response buffering are disabled. `S3_REQUEST_TIMEOUT_MS` sets the backend's body-receive timeout when the gateway is enabled (default one hour); headers retain Node's standard limits/timeouts. CDN upload size/time restrictions still apply; use direct DNS/origin for large transfers.

## Architectural audit

| Area | Existing behavior and gateway reuse |
|---|---|
| Virtual file/folder | `file_metadata`: `user_id`, `virtual_path` (normalized parent path), `file_name`, `is_folder`, `size`, `mime_type`, `cloud_account_id`, `remote_file_id`, `remote_parent_id`, remote created/modified dates, local timestamps. Provider comes from `cloud_accounts`. Root is synthetic. |
| List | SQLite user/path queries; S3 enumerates active-account metadata, builds full keys and CommonPrefixes, sorts by UTF-8 bytes and paginates. Duplicate file keys across providers cause explicit `InvalidRequest`; folder prefixes consolidate in listings. |
| Upload | `reserveBestAccount` → `createUploadSession` → `runUpload` → adapter → metadata/cache. Existing strategy configuration controls account selection. Gateway bypasses upload-triggered full sync because the operation already knows its result. |
| Allocator | Most-free, least-used, round robin, weighted round robin and manual account order. Reservations are tracked per process. Gateway checks selected free space and releases its reservation on every exit. |
| Large upload | REST chunks are sequential, backed by an in-memory session/stream, and cannot recover after restart. S3 parts are durable and independently retryable. Final provider upload uses the same streaming pipeline. |
| Download/Range | `fileCacheService.openFile`, existing adapters and WebDAV's range parser. Invalid ranges return 416. For adapters without native Range, the stream is sliced with bounded RAM; earlier bytes still have to be downloaded. |
| Rename/overwrite | Existing adapter rename; shared `replaceFileService` renames old content to a backup, promotes the completed replacement, publishes metadata transactionally, then removes backup. Failed promotion restores the old name. |
| Delete | Existing adapter delete, metadata delete and shared cache invalidation; no unnecessary full sync. Folder markers cannot delete nonempty virtual folders. |
| Hosted isolation | Gateway access key resolves its owning user. Every bucket/object/session/account lookup uses that ID. App cookies do not authenticate S3 requests. Management endpoints separately use app authentication. |
| Secrets | Existing AES-256-GCM `encryptJson`/`decryptJson`, dedicated credential table. A one-way secret hash cannot validate arbitrary SigV4 HMAC scopes; recoverable encryption is necessary. |
| Cache | Existing durable file cache; no second S3 cache. Upload capture publishes to it, reads use it and overwrite/delete invalidate/rebind it. Scheduled sync can invalidate cache when remote versions change. |
| Sync | Existing full account snapshot/replacement and reconciliation. Shared per-user coordination prevents snapshots fetched before a managed write from overwriting its metadata. Reconciliation preserves existing metadata IDs by account/remote ID, preventing stale references during WebDAV overwrite and subsequent S3 lookup. Different users can sync independently. |
| Multiple interfaces | REST file handlers, WebDAV (and thus SMB), S3 object operations, upload pipeline and sync share the same per-user lock. Client disconnect does not release a mutation's lock before its handler ends. External changes made directly in provider accounts remain subject to provider/sync consistency. |

## Protocol support

| Operation | Support |
|---|---|
| ListBuckets | Yes: `GET /` |
| HeadBucket | Yes: `HEAD /:bucket` |
| GetBucketLocation | Yes |
| ListObjectsV2 | Yes: prefix, delimiter, max-keys 0–1000, continuation-token, start-after, URL encoding |
| ListObjects v1 | Basic compatibility with marker/NextMarker |
| HeadObject | Yes: length, MIME, Last-Modified, ETag, Accept-Ranges and custom metadata |
| GetObject | Streaming, single byte range, basic If-Match/If-None-Match |
| PutObject | Verified disk staging then existing pipeline; overwrite preserves original if upload/promotion fails |
| DeleteObject | Yes, idempotent for absent keys |
| CreateMultipartUpload | Yes |
| UploadPart | Yes, retry replaces a part atomically |
| CompleteMultipartUpload | Yes, ordered part/ETag/size validation and composed stream |
| AbortMultipartUpload | Yes |
| ListParts | Yes, max-parts and part-number-marker |
| Presigned GET / PUT | Yes |
| Empty folder markers | Zero-byte `key/` maps to a real virtual folder |
| ListMultipartUploads, CopyObject, DeleteObjects, arbitrary buckets | Not implemented |
| ACLs other than private, versioning, tagging, object lock, policies, STS | Not implemented |
| Virtual-host-style, SigV2/SigV4a, aws-chunked/trailers, encoded uploads, CRC64NVME | Not implemented |

Unsupported operations return S3 XML errors, rather than succeeding without performing the requested operation. Error mapping covers AccessDenied, InvalidAccessKeyId, SignatureDoesNotMatch, NoSuchBucket, NoSuchKey, InvalidArgument, EntityTooLarge, InternalError, ServiceUnavailable, SlowDown, InvalidRange and multipart-specific errors.

## SigV4 and security

The gateway reuses **Smithy's AWS-maintained `SignatureV4`** implementation already present through AWS SDK dependencies, with AWS's existing `Sha256` implementation. These packages are declared/pinned as direct dependencies instead of relying on accidental transitive availability. Their license is Apache-2.0. The existing `fast-xml-parser` (MIT) parses bounded completion XML; DOCTYPE/ENTITY declarations are rejected. AWS's existing CRC libraries validate checksum headers.

Server-side code validates credential scope (`date/region/s3/aws4_request`), signed header names/order/presence, signed request date, signature length, expiration/skew and payload hashes. Smithy supplies canonical query ordering, canonical request hashing, signing-key derivation and expected HMAC. Expected and received signatures are compared in constant time. Accepted region names come from the signed scope; the configured region is reported to clients. The small adapter uses Smithy canonicalization/signature methods, so upgrades need the independent AWS CLI/rclone tests.

References: [AWS header signing](https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html), [AWS presigned query signing](https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html), [Smithy SignatureV4 source](https://github.com/smithy-lang/smithy-typescript/blob/main/packages/signature-v4/src/SignatureV4.ts).

Paths are decoded once. Dot segments, encoded/double-encoded traversal, backslashes, control characters, empty internal segments and keys over 1024 UTF-8 bytes are rejected. XML output is escaped, response metadata headers are validated and unsafe MIME values cannot inject headers. Literal percent-escape sequences in filenames are also rejected to prevent multiple-decoding aliases.

Each request has `x-amz-request-id`. Structured logs contain request ID, method, bucket/key, user, masked access key, status and elapsed time; they omit Authorization, query strings, cookies and secrets. Object keys are consequently visible to trusted log readers. The global in-flight request limit bounds queued S3 work; multipart sessions/parts, metadata, XML bodies, headers, list sizes and disk staging are bounded. Expiration runs before server startup and at least hourly afterward; orphan temporary/part files left by a crash are removed at startup.

## Multipart, ETag and concurrency

Each successful part is renamed from a unique temporary file to a unique durable file before its SQLite record is committed. SQLite stores session owner/key/MIME/metadata, timestamps and ordered part sizes/MD5s. Restart retains referenced parts and removes orphan staging files. TTL is based on session creation/last successful part upload. Requests modifying the same multipart session are serialized; different sessions can receive bodies concurrently. Complete streams selected files sequentially into the normal allocator/upload pipeline, never into individual final provider objects. Abort/Complete/TTL remove the session and parts; interrupted remote promotion may leave a named recovery backup.

Simple PUT ETag is real MD5. Multipart ETag is `MD5(concatenated binary part MD5s)-partCount`. Existing/synced files use an **opaque version ETag**, prefixed `oc-`, based on remote ID, size and available modified-time metadata. It is not a content MD5. Gateway content ETags/custom metadata are associated with the uploaded remote version and may be replaced by opaque version metadata after sync observes a changed remote timestamp. Providers without a usable timestamp cannot reliably detect same-size external edits; ETags are not a substitute for independent integrity checks.

Concurrent PUTs on a key publish serially, so the last completed publication wins. While a request body is being staged, GET can read the previous object; once provider publication begins, GET waits for its lock and sees the new object. DELETE waits for an active coordinated GET to finish. PUT failure preserves the previous object. If both promotion and remote rollback fail, the old bytes remain under a `.omnicloud-backup-...` name for manual recovery/sync. This is recoverable promotion, not a distributed atomic transaction. A process crash during promotion can also require backup recovery.

Coordination is intentionally **per user in one API process**. Large reads/provider uploads can delay other operations for that user. Do not run multiple API replicas against the same data/provider filesystem without distributed coordination. Native Google Docs need explicit binary export first, since their quota size/MIME do not describe the exported byte stream. Provider rename limits (including outbound S3 CopyObject limits for large overwrites) remain applicable.

## Files and migrations

Created:

- `backend/src/s3/{credentials,signature,response,objects,multipart,gateway}.js`
- `backend/src/services/{filesystemCoordinator,replaceFileService}.js`
- `backend/src/routes/s3SettingsRoutes.js`
- `frontend/src/components/S3GatewaySettings.vue`
- `backend/test/{s3Gateway,s3Security}.test.js`
- `backend/test/fixtures/s3GatewayServer.js`, `backend/test/s3ClientSmoke.py`
- this guide and `docs/superpowers/plans/2026-10-09-s3-gateway.md`

Modified: backend app/server/env/database, file/upload/sync services, file/WebDAV/health routes, backend package/environment example, root lockfile/Compose, frontend API/Settings/locales and Nginx, README.

The project applies idempotent schema changes in `backend/src/config/database.js`, rather than numbered migrations. New tables: `s3_gateway_settings`, `s3_gateway_credentials`, `s3_multipart_uploads`, `s3_multipart_parts`, `s3_object_versions`; foreign keys cascade user/account/session deletion. Credential secrets are encrypted. `metadata_json` columns are added idempotently to session/version tables. Existing logical storage tables and outbound S3 credential formats are retained.

## Tests and reproducible smoke

```bash
node --test backend/test/*.test.js
npm --prefix frontend test
npm --prefix frontend run build
```

Final verification in this workspace:

| Command / client | Result |
|---|---|
| `node --test backend/test/*.test.js` | 280 passed, 0 failed |
| `npm --prefix frontend test` | 12 passed, 0 failed |
| `npm --prefix frontend run build` | Vite/PWA build succeeded |
| `docker compose config --quiet` | Passed |
| `git diff --check` | Passed |
| AWS CLI smoke | List/PUT/GET/overwrite/delete + 17 MiB multipart; SHA256 matched |
| rclone smoke | List/PUT/GET/delete + multipart; SHA256 matched |

Nginx runtime/TLS deployment and live cloud providers were not exercised. Docker configuration was validated without starting or replacing the user's stack.

Gateway tests cover valid/invalid credentials, wrong secret, altered signature, expiration, user/key disable and revoke, real presigned GET/PUT, cross-user object/session/key management isolation, XML/URL/traversal/length safety, payload hashes/checksums, staging quota release, empty/nested listings, prefix/delimiter/pagination, MIME/metadata, HEAD/GET/ranges/DELETE/overwrite, concurrent PUT/GET/DELETE/sync, failed remote promotion, multipart parts/completion/abort/TTL and persistence across a separate process restart. Existing WebDAV/cache/chunk tests are included in the full backend regression run.

Run the isolated fixture in one terminal (gateway keys go to a private file, not logs):

```bash
node backend/test/fixtures/s3GatewayServer.js /tmp/oc-smoke-credentials.json
```

In another terminal, with AWS CLI and rclone installed:

```bash
python3 backend/test/s3ClientSmoke.py /tmp/oc-smoke-credentials.json /path/to/aws
```

The smoke executes real AWS CLI and rclone clients: list buckets/objects, upload, download, compare SHA256, overwrite, verify again, delete, confirm absent, multipart upload of 17 MiB, download and compare SHA256. AWS CLI emits a three-part ETag; rclone also completes multipart and preserves modification metadata. Test data, SQLite and cache are isolated; **only the remote adapter is simulated**, so this proves protocol and OmniCloud pipeline integration, not Google/MEGA/etc. network behavior. The fixture buffers remote bytes for test simplicity; production gateway staging/download/part composition are bounded-memory streams. Stop the fixture and remove its private credential file afterward.

AWS CLI 1.46.1, rclone 1.74.3-adrive.4 and the installed AWS SDK v3 were exercised. Cyberduck, s5cmd and MinIO Client were not exercised. The system command `mc` is GNU Midnight Commander, not MinIO Client. No production account, production SQLite or provider credential was used in the smoke.

## Follow-up improvements

- Run the same smoke against each connected real provider and behind the actual TLS/CDN proxy.
- Add crash-recovery journaling for remote promotions and distributed locks before multiple API replicas.
- Add multipart remote copy/update support where provider rename imposes a large-file limit.
- Add aws-chunked/trailer decoding with checksum/chunk signature validation and client-version tests.
- Add CopyObject/DeleteObjects/ListMultipartUploads when a consuming application needs them.
- Optimize very large listings with indexed keyset queries instead of materializing user metadata.
- Decouple key encryption from hostname with an explicitly managed deployment key and rotation process.
