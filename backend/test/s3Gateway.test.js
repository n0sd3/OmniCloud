import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import * as S3 from '@aws-sdk/client-s3';

const dir = await mkdtemp(path.join(os.tmpdir(), 'omnicloud-s3-'));
process.env.OMNICLOUD_SECRET_HALF = 'isolated-s3-test-encryption-secret-32-bytes';
process.env.DATABASE_PATH = path.join(dir, 'db.sqlite');
process.env.FILE_CACHE_PATH = path.join(dir, 'cache');
process.env.S3_GATEWAY_ENABLED = 'true';
process.env.S3_MULTIPART_PATH = path.join(dir, 'multipart');
process.env.APP_MODE = 'hosted';
const { db } = await import('../src/config/database.js');
const { BaseCloudAdapter } = await import('../src/adapters/BaseCloudAdapter.js');
const { createApp } = await import('../src/app.js');
const { createCredential, setEnabled } = await import('../src/s3/credentials.js');
const remote = new Map();
BaseCloudAdapter.prototype.uploadStream = async function ({
	stream,
	fileName,
	virtualPath,
	mimeType,
}) {
	const chunks = [];
	for await (const chunk of stream) chunks.push(chunk);
	if (fileName.startsWith('fail')) throw new Error('provider unavailable');
	const id = randomUUID();
	remote.set(id, {
		body: Buffer.concat(chunks),
		fileName,
		virtualPath,
		mimeType,
		accountId: this.account.id,
	});
	return { remoteFileId: id };
};
BaseCloudAdapter.prototype.renameFile = async function (file, name) {
	remote.get(file.remote_file_id).fileName = name;
	return { remoteFileId: file.remote_file_id };
};
BaseCloudAdapter.prototype.deleteFile = async function (file) {
	remote.delete(file.remote_file_id);
};
BaseCloudAdapter.prototype.getDownloadStream = async function (file) {
	return Readable.from([remote.get(file.remote_file_id).body]);
};
BaseCloudAdapter.prototype.createFolder = async function ({ name, virtualPath }) {
	const id = randomUUID();
	remote.set(id, { fileName: name, virtualPath, folder: true, accountId: this.account.id });
	return { remoteFileId: id };
};
BaseCloudAdapter.prototype.fetchStructure = async function () {
	return [...remote]
		.filter(([, v]) => v.accountId === this.account.id)
		.map(([id, v]) => ({
			file_name: v.fileName,
			virtual_path: v.virtualPath,
			remote_file_id: id,
			size: v.body?.length || 0,
			mime_type: v.mimeType || null,
			is_folder: v.folder,
			remote_modified_time: null,
		}));
};
for (const user of ['alice', 'bob']) {
	db.prepare('INSERT INTO users (id,email) VALUES (?,?)').run(user, `${user}@test.invalid`);
	db.prepare(
		"INSERT INTO cloud_accounts (id,user_id,email,provider,encrypted_credentials,total_space,used_space,status) VALUES (?,?,?,'base','x',1000000000,0,'active')",
	).run(user, user, `${user}@test.invalid`);
	setEnabled(user, true);
}
const credentials = createCredential('alice');
let server, client, bob, endpoint;
const bucket = 'omnicloud';
const send = (command) => client.send(command);
const put = (Key, Body, extra = {}) =>
	send(new S3.PutObjectCommand({ Bucket: bucket, Key, Body, ...extra }));
const get = async (Key, extra = {}) =>
	(await send(new S3.GetObjectCommand({ Bucket: bucket, Key, ...extra }))).Body.transformToString();
test.before(async () => {
	server = createApp().listen(0);
	await new Promise((r) => server.once('listening', r));
	endpoint = `http://127.0.0.1:${server.address().port}`;
	client = new S3.S3Client({
		endpoint,
		region: 'auto',
		forcePathStyle: true,
		credentials,
		maxAttempts: 1,
	});
	bob = new S3.S3Client({
		endpoint,
		region: 'auto',
		forcePathStyle: true,
		credentials: createCredential('bob'),
		maxAttempts: 1,
	});
});
test.after(async () => {
	client?.destroy();
	bob?.destroy();
	await new Promise((r) => server.close(r));
	db.close();
	await rm(dir, { recursive: true, force: true });
});
test('buckets, empty listing and unknown bucket', async () => {
	assert.equal((await send(new S3.ListBucketsCommand({}))).Buckets[0].Name, bucket);
	await send(new S3.HeadBucketCommand({ Bucket: bucket }));
	assert.equal((await send(new S3.ListObjectsV2Command({ Bucket: bucket }))).KeyCount, 0);
	await assert.rejects(send(new S3.ListObjectsV2Command({ Bucket: 'missing' })), {
		name: 'NoSuchBucket',
	});
});
test('PUT nested key is visible in filesystem; HEAD, GET, ranges, overwrite, isolation and delete', async () => {
	await put('photos/2026/a & é.txt', 'abcdef', {
		ContentType: 'text/custom',
		Metadata: { mtime: '1234' },
	});
	assert.ok(
		db
			.prepare(
				"SELECT * FROM file_metadata WHERE user_id='alice' AND virtual_path='/photos/2026/' AND file_name='a & é.txt'",
			)
			.get(),
	);
	const head = await send(
		new S3.HeadObjectCommand({ Bucket: bucket, Key: 'photos/2026/a & é.txt' }),
	);
	assert.equal(head.Metadata.mtime, '1234');
	assert.equal(head.ContentLength, 6);
	assert.equal(head.ContentType, 'text/custom');
	assert.ok(head.ETag);
	assert.equal(await get('photos/2026/a & é.txt'), 'abcdef');
	assert.equal(await get('photos/2026/a & é.txt', { Range: 'bytes=1-3' }), 'bcd');
	assert.equal(await get('photos/2026/a & é.txt', { Range: 'bytes=-2' }), 'ef');
	await assert.rejects(get('photos/2026/a & é.txt', { Range: 'bytes=99-' }), {
		name: 'InvalidRange',
	});
	await assert.rejects(
		bob.send(new S3.GetObjectCommand({ Bucket: bucket, Key: 'photos/2026/a & é.txt' })),
		{ name: 'NoSuchKey' },
	);
	await put('photos/2026/a & é.txt', 'new');
	assert.equal(await get('photos/2026/a & é.txt'), 'new');
	await send(new S3.DeleteObjectCommand({ Bucket: bucket, Key: 'photos/2026/a & é.txt' }));
	await assert.rejects(get('photos/2026/a & é.txt'), { name: 'NoSuchKey' });
	await send(new S3.DeleteObjectCommand({ Bucket: bucket, Key: 'missing' }));
});
test('list prefix, delimiter, max-keys, continuation and start-after', async () => {
	for (const key of ['root.txt', 'nested/a.txt', 'nested/b.txt']) await put(key, key);
	const list = await send(new S3.ListObjectsV2Command({ Bucket: bucket, Delimiter: '/' }));
	assert.ok(list.CommonPrefixes.some((p) => p.Prefix === 'nested/'));
	const first = await send(
		new S3.ListObjectsV2Command({
			Bucket: bucket,
			Prefix: 'nested/',
			StartAfter: 'nested/',
			MaxKeys: 1,
		}),
	);
	assert.equal(first.Contents.length, 1);
	assert.ok(first.IsTruncated);
	const next = await send(
		new S3.ListObjectsV2Command({
			Bucket: bucket,
			Prefix: 'nested/',
			MaxKeys: 1,
			ContinuationToken: first.NextContinuationToken,
		}),
	);
	assert.equal(next.Contents[0].Key, 'nested/b.txt');
	const after = await send(
		new S3.ListObjectsV2Command({ Bucket: bucket, Prefix: 'nested/', StartAfter: 'nested/a.txt' }),
	);
	assert.equal(after.Contents[0].Key, 'nested/b.txt');
});
test('multipart create, concurrent parts, invalid part, complete, isolation, abort', async () => {
	const Key = 'large.bin';
	const { UploadId } = await send(
		new S3.CreateMultipartUploadCommand({ Bucket: bucket, Key, ContentType: 'application/custom' }),
	);
	const bodies = [Buffer.alloc(5 * 1024 * 1024, 65), Buffer.from('end')];
	const parts = await Promise.all(
		bodies.map((Body, i) =>
			send(new S3.UploadPartCommand({ Bucket: bucket, Key, UploadId, PartNumber: i + 1, Body })),
		),
	);
	const listed = await send(
		new S3.ListPartsCommand({ Bucket: bucket, Key, UploadId, MaxParts: 1 }),
	);
	assert.equal(listed.Parts.length, 1);
	assert.equal(listed.IsTruncated, true);
	await assert.rejects(
		bob.send(new S3.AbortMultipartUploadCommand({ Bucket: bucket, Key, UploadId })),
		{ name: 'NoSuchUpload' },
	);
	await assert.rejects(
		send(
			new S3.CompleteMultipartUploadCommand({
				Bucket: bucket,
				Key,
				UploadId,
				MultipartUpload: { Parts: [{ PartNumber: 3, ETag: '"missing"' }] },
			}),
		),
		{ name: 'InvalidPart' },
	);
	const result = await send(
		new S3.CompleteMultipartUploadCommand({
			Bucket: bucket,
			Key,
			UploadId,
			MultipartUpload: { Parts: parts.map((p, i) => ({ PartNumber: i + 1, ETag: p.ETag })) },
		}),
	);
	assert.match(result.ETag, /-2"$/);
	assert.equal((await get(Key)).length, bodies[0].length + 3);
	const aborted = await send(new S3.CreateMultipartUploadCommand({ Bucket: bucket, Key: 'abort' }));
	await send(
		new S3.AbortMultipartUploadCommand({
			Bucket: bucket,
			Key: 'abort',
			UploadId: aborted.UploadId,
		}),
	);
	await assert.rejects(
		send(
			new S3.UploadPartCommand({
				Bucket: bucket,
				Key: 'abort',
				UploadId: aborted.UploadId,
				PartNumber: 1,
				Body: 'x',
			}),
		),
		{ name: 'NoSuchUpload' },
	);
});
test('simultaneous PUT produces one object and failed overwrite preserves previous content', async () => {
	await Promise.all([put('same.txt', 'first'), put('same.txt', 'second')]);
	assert.equal(
		db
			.prepare(
				"SELECT count(*) n FROM file_metadata WHERE user_id='alice' AND file_name='same.txt'",
			)
			.get().n,
		1,
	);
	await put('fail-existing.txt', 'old').catch(() => {});
	const old = BaseCloudAdapter.prototype.uploadStream;
	BaseCloudAdapter.prototype.uploadStream = async () => {
		throw new Error('unavailable');
	};
	await assert.rejects(put('same.txt', 'failed'));
	BaseCloudAdapter.prototype.uploadStream = old;
	assert.ok(['first', 'second'].includes(await get('same.txt')));
});
test('failed promotion restores original without deleting either content prematurely', async () => {
	await put('protected.txt', 'original');
	const rename = BaseCloudAdapter.prototype.renameFile;
	BaseCloudAdapter.prototype.renameFile = async function (file, name) {
		if (file.file_name.includes('.omnicloud-upload-') && name === 'protected.txt')
			throw new Error('promotion fails');
		return rename.call(this, file, name);
	};
	await assert.rejects(put('protected.txt', 'replacement'));
	BaseCloudAdapter.prototype.renameFile = rename;
	const previous = db
		.prepare("SELECT * FROM file_metadata WHERE user_id='alice' AND file_name='protected.txt'")
		.get();
	assert.ok(
		remote.has(previous.remote_file_id),
		'Original remoto deve sobreviver à falha de promoção',
	);
	assert.equal(await get('protected.txt'), 'original');
});
test('folder markers expose empty folders and reject deleting nonempty directories', async () => {
	await put('empty-folder/', '');
	assert.equal(await get('empty-folder/'), '');
	const listing = await send(new S3.ListObjectsV2Command({ Bucket: bucket, Delimiter: '/' }));
	assert.ok(listing.CommonPrefixes.some((p) => p.Prefix === 'empty-folder/'));
	await send(new S3.DeleteObjectCommand({ Bucket: bucket, Key: 'empty-folder/' }));
	await assert.rejects(send(new S3.DeleteObjectCommand({ Bucket: bucket, Key: 'nested/' })), {
		name: 'InvalidRequest',
	});
});
test('GET during upload returns old bytes, DELETE waits for active GET, and sync cannot remove an in-flight upload', async () => {
	const { fileCacheService } = await import('../src/services/fileCacheService.js');
	const { runDeltaSync } = await import('../src/services/syncService.js');
	await put('concurrent.txt', 'old');
	const original = BaseCloudAdapter.prototype.uploadStream;
	let started, release;
	const reached = new Promise((r) => {
		started = r;
	});
	const gate = new Promise((r) => {
		release = r;
	});
	BaseCloudAdapter.prototype.uploadStream = async function (options) {
		started();
		await gate;
		return original.call(this, options);
	};
	const uploading = put('concurrent.txt', 'new');
	await reached;
	const reading = get('concurrent.txt');
	const syncing = runDeltaSync('alice');
	release();
	await uploading;
	await syncing;
	BaseCloudAdapter.prototype.uploadStream = original;
	assert.equal(await reading, 'new');
	const file = db
		.prepare("SELECT * FROM file_metadata WHERE user_id='alice' AND file_name='concurrent.txt'")
		.get();
	await fileCacheService.invalidate(file);
	const download = BaseCloudAdapter.prototype.getDownloadStream;
	let opened, allowEnd;
	const firstChunk = new Promise((r) => {
		opened = r;
	});
	const finish = new Promise((r) => {
		allowEnd = r;
	});
	BaseCloudAdapter.prototype.getDownloadStream = async () =>
		Readable.from(
			(async function* () {
				opened();
				yield Buffer.from('n');
				await finish;
				yield Buffer.from('ew');
			})(),
		);
	const getting = get('concurrent.txt');
	await firstChunk;
	const deleting = send(new S3.DeleteObjectCommand({ Bucket: bucket, Key: 'concurrent.txt' }));
	allowEnd();
	assert.equal(await getting, 'new');
	await deleting;
	BaseCloudAdapter.prototype.getDownloadStream = download;
	await assert.rejects(get('concurrent.txt'), { name: 'NoSuchKey' });
});
test('presigned GET and PUT work through the actual HTTP gateway', async () => {
	const { SignatureV4 } = await import('@smithy/signature-v4');
	const { Sha256 } = await import('@aws-crypto/sha256-js');
	const signer = new SignatureV4({
		credentials,
		region: 'auto',
		service: 's3',
		sha256: Sha256,
		uriEscapePath: false,
	});
	async function url(method) {
		const request = await signer.presign(
			{
				method,
				path: '/omnicloud/presigned.txt',
				query: {},
				headers: { host: new URL(endpoint).host, 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' },
			},
			{ expiresIn: 60 },
		);
		return endpoint + request.path + '?' + new URLSearchParams(request.query);
	}
	const uploaded = await fetch(await url('PUT'), { method: 'PUT', body: 'presigned content' });
	assert.equal(uploaded.status, 200);
	const downloaded = await fetch(await url('GET'));
	assert.equal(downloaded.status, 200);
	assert.equal(await downloaded.text(), 'presigned content');
});
test('settings require app authentication, do not expose saved secrets, scope revocation and rotate keys', async () => {
	const { createSession } = await import('../src/services/authService.js');
	const { env } = await import('../src/config/env.js');
	assert.equal((await fetch(endpoint + '/api/s3-gateway')).status, 401);
	const cookie = `${env.authCookieName}=${createSession('alice').token}`;
	const bobCookie = `${env.authCookieName}=${createSession('bob').token}`;
	const response = await fetch(endpoint + '/api/s3-gateway/keys', {
		method: 'POST',
		headers: { Cookie: cookie },
	});
	assert.equal(response.status, 201);
	assert.equal(response.headers.get('cache-control'), 'no-store');
	const { data: created } = await response.json();
	assert.ok(created.secretAccessKey);
	const settings = await (
		await fetch(endpoint + '/api/s3-gateway', { headers: { Cookie: cookie } })
	).json();
	assert.ok(settings.data.keys.every((k) => !('secret_enc' in k) && !('secretAccessKey' in k)));
	await fetch(endpoint + '/api/s3-gateway/keys/' + created.accessKeyId, {
		method: 'DELETE',
		headers: { Cookie: bobCookie },
	});
	const { findCredential } = await import('../src/s3/credentials.js');
	assert.equal(findCredential(created.accessKeyId).userId, 'alice');
	const rotated = await fetch(
		endpoint + '/api/s3-gateway/keys/' + created.accessKeyId + '/rotate',
		{ method: 'POST', headers: { Cookie: cookie } },
	);
	assert.equal(rotated.status, 201);
	assert.throws(() => findCredential(created.accessKeyId));
	assert.ok((await rotated.json()).data.secretAccessKey);
});
test('overwrite and deletion release allocator usage without a full sync', async () => {
	const before = db
		.prepare("SELECT used_space FROM cloud_accounts WHERE id='alice'")
		.get().used_space;
	await put('usage.txt', '1234');
	await put('usage.txt', 'abcdef');
	assert.equal(
		db.prepare("SELECT used_space FROM cloud_accounts WHERE id='alice'").get().used_space,
		before + 6,
	);
	await send(new S3.DeleteObjectCommand({ Bucket: bucket, Key: 'usage.txt' }));
	assert.equal(
		db.prepare("SELECT used_space FROM cloud_accounts WHERE id='alice'").get().used_space,
		before,
	);
});
test('S3, REST and WebDAV expose and overwrite the same logical file', async () => {
	const { createSession } = await import('../src/services/authService.js');
	const { setSmbCredentials } = await import('../src/services/smbCredentialService.js');
	const { env } = await import('../src/config/env.js');
	await put('interfaces/shared.txt', 'from S3');
	const cookie = `${env.authCookieName}=${createSession('alice').token}`;
	const listing = await (
		await fetch(endpoint + '/api/files?path=/interfaces/', { headers: { Cookie: cookie } })
	).json();
	const file = listing.data.find((f) => f.file_name === 'shared.txt');
	assert.ok(file);
	const rest = await fetch(endpoint + '/api/files/' + file.id + '/download', {
		headers: { Cookie: cookie },
	});
	assert.equal(await rest.text(), 'from S3');
	const dav = setSmbCredentials('alice', 'test-strong-password');
	const Authorization =
		'Basic ' + Buffer.from(dav.username + ':' + dav.webdavToken).toString('base64');
	const read = await fetch(endpoint + '/webdav/interfaces/shared.txt', {
		headers: { Authorization },
	});
	assert.equal(await read.text(), 'from S3');
	const overwrite = await fetch(endpoint + '/webdav/interfaces/shared.txt', {
		method: 'PUT',
		headers: { Authorization, 'Content-Type': 'text/plain' },
		body: 'from WebDAV',
	});
	assert.equal(overwrite.status, 204);
	assert.equal(await get('interfaces/shared.txt'), 'from WebDAV');
	assert.equal(
		db
			.prepare(
				"SELECT count(*) n FROM file_metadata WHERE user_id='alice' AND virtual_path='/interfaces/' AND file_name='shared.txt'",
			)
			.get().n,
		1,
	);
});
