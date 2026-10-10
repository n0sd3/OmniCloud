import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { SignatureV4 } from '@smithy/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import { Readable } from 'node:stream';
const dir = await mkdtemp(path.join(os.tmpdir(), 's3-security-'));
process.env.OMNICLOUD_SECRET_HALF = 'isolated-s3-test-encryption-secret-32-bytes';
process.env.DATABASE_PATH = path.join(dir, 'db');
process.env.S3_GATEWAY_ENABLED = 'true';
process.env.S3_MULTIPART_PATH = path.join(dir, 'parts');
const { db, LOCAL_USER_ID } = await import('../src/config/database.js');
const { createCredential, setEnabled, revokeCredential, listCredentials } = await import(
	'../src/s3/credentials.js'
);
const { authenticate } = await import('../src/s3/signature.js');
const { xml, mapKey } = await import('../src/s3/response.js');
const multipart = await import('../src/s3/multipart.js');
const { withFilesystemLock } = await import('../src/services/filesystemCoordinator.js');
setEnabled(LOCAL_USER_ID, true);
const credential = createCredential(LOCAL_USER_ID);
const signer = new SignatureV4({
	credentials: credential,
	region: 'auto',
	service: 's3',
	sha256: Sha256,
	uriEscapePath: false,
});
const input = {
	method: 'GET',
	path: '/omnicloud/a%20b',
	query: {},
	headers: { host: 'localhost' },
};
const request = (signed) => ({
	method: signed.method,
	headers: signed.headers,
	url:
		signed.path + (Object.keys(signed.query).length ? '?' + new URLSearchParams(signed.query) : ''),
});
const rejects = (fn, code) => assert.rejects(fn, (e) => e.s3Code === code);
test.after(async () => {
	db.close();
	await rm(dir, { force: true, recursive: true });
});
test('valid access key, encrypted secret, last-used, no secret in list', async () => {
	const signed = await signer.sign(input);
	assert.equal((await authenticate(request(signed))).userId, LOCAL_USER_ID);
	const stored = db
		.prepare('SELECT * FROM s3_gateway_credentials WHERE access_key_id=?')
		.get(credential.accessKeyId);
	assert.ok(stored.last_used_at);
	assert.ok(!stored.secret_enc.includes(credential.secretAccessKey));
	assert.equal(listCredentials(LOCAL_USER_ID)[0].secret_enc, undefined);
});
test('invalid key, wrong secret, altered signature, date skew and disabled user/key', async () => {
	const unknown = new SignatureV4({
		credentials: { ...credential, accessKeyId: 'OCINVALID' },
		region: 'auto',
		service: 's3',
		sha256: Sha256,
		uriEscapePath: false,
	});
	await rejects(async () => authenticate(request(await unknown.sign(input))), 'InvalidAccessKeyId');
	const wrong = new SignatureV4({
		credentials: { ...credential, secretAccessKey: 'wrong' },
		region: 'auto',
		service: 's3',
		sha256: Sha256,
		uriEscapePath: false,
	});
	await rejects(
		async () => authenticate(request(await wrong.sign(input))),
		'SignatureDoesNotMatch',
	);
	const altered = request(await signer.sign(input));
	altered.url = '/omnicloud/other';
	await rejects(() => authenticate(altered), 'SignatureDoesNotMatch');
	await rejects(
		async () => authenticate(request(await signer.sign(input, { signingDate: new Date(0) }))),
		'RequestTimeTooSkewed',
	);
	setEnabled(LOCAL_USER_ID, false);
	await rejects(async () => authenticate(request(await signer.sign(input))), 'AccessDenied');
	setEnabled(LOCAL_USER_ID, true);
	const revoked = createCredential(LOCAL_USER_ID);
	revokeCredential(LOCAL_USER_ID, revoked.accessKeyId);
	const revSigner = new SignatureV4({
		credentials: revoked,
		region: 'auto',
		service: 's3',
		sha256: Sha256,
		uriEscapePath: false,
	});
	await rejects(
		async () => authenticate(request(await revSigner.sign(input))),
		'InvalidAccessKeyId',
	);
});
test('presigned GET and PUT, tampering and expiration', async () => {
	for (const method of ['GET', 'PUT']) {
		const signed = await signer.presign(
			{
				...input,
				method,
				headers: { host: 'localhost', 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' },
			},
			{ expiresIn: 60 },
		);
		assert.equal((await authenticate(request(signed))).userId, LOCAL_USER_ID);
		await rejects(
			() => authenticate({ ...request(signed), url: request(signed).url + '&prefix=x' }),
			'SignatureDoesNotMatch',
		);
		await rejects(() => authenticate(request(signed), Date.now() + 120000), 'AccessDenied');
	}
});
test('traversal, double encoding, long keys, safe URL decoding and XML escaping', () => {
	for (const key of [
		'../secret',
		'%2e%2e/secret',
		'%252e%252e/secret',
		'a//b',
		'a/%2f/b',
		'a\\b',
		'a/%00',
		'x'.repeat(1025),
	])
		assert.throws(
			() => mapKey(key),
			(e) => e.s3Code === 'InvalidArgument',
		);
	assert.equal(mapKey('dir/a%20%26%20%C3%A9.txt').key, 'dir/a & é.txt');
	assert.equal(xml('<script>&"\'\u0000'), '&lt;script&gt;&amp;&quot;&apos;');
});
test('payload alteration, Content-MD5 mismatch and cleanup after aborted body', async () => {
	const hash = createHash('sha256').update('correct').digest('hex');
	await rejects(
		() => multipart.stageBody(Readable.from(['wrong']), { payloadHash: hash }),
		'SignatureDoesNotMatch',
	);
	await rejects(
		() => multipart.stageBody(Readable.from(['wrong']), { contentMd5: 'bad' }),
		'BadDigest',
	);
});
test('multipart session persists, wrong user/id, ordering, incomplete part and TTL', async () => {
	const id = multipart.createMultipart(LOCAL_USER_ID, 'a', 'text/plain');
	const upload = multipart.findMultipart(LOCAL_USER_ID, 'a', id);
	assert.throws(
		() => multipart.findMultipart('other', 'a', id),
		(e) => e.s3Code === 'NoSuchUpload',
	);
	const staged = await multipart.stageBody(Readable.from(['abc']));
	await multipart.storePart(upload, 1, staged);
	assert.equal(multipart.listParts(id)[0].size, 3);
	assert.throws(() => multipart.completionParts('<!DOCTYPE x><CompleteMultipartUpload/>', id));
	assert.throws(
		() =>
			multipart.completionParts(
				'<CompleteMultipartUpload><Part><PartNumber>2</PartNumber><ETag>x</ETag></Part></CompleteMultipartUpload>',
				id,
			),
		(e) => e.s3Code === 'InvalidPart',
	);
	db.prepare('UPDATE s3_multipart_uploads SET touched_at=0 WHERE id=?').run(id);
	assert.equal(await multipart.cleanupMultipart(), 1);
	assert.equal(db.prepare('SELECT count(*) n FROM s3_multipart_parts').get().n, 0);
});
test('user lock serializes mutations and permits nested sync', async () => {
	const order = [];
	await Promise.all([
		withFilesystemLock('alice', async () => {
			order.push(1);
			await withFilesystemLock('alice', () => order.push(2));
			await new Promise((r) => setTimeout(r, 5));
			order.push(3);
		}),
		withFilesystemLock('alice', () => order.push(4)),
	]);
	assert.deepEqual(order, [1, 2, 3, 4]);
});
test('persistent multipart part survives process restart and startup removes only orphan staging files', async () => {
	const { spawnSync } = await import('node:child_process');
	const { writeFile, access } = await import('node:fs/promises');
	const id = multipart.createMultipart(LOCAL_USER_ID, 'restart', 'text/plain');
	const part = await multipart.stageBody(Readable.from(['persistent']));
	await multipart.storePart(multipart.findMultipart(LOCAL_USER_ID, 'restart', id), 1, part);
	const child = spawnSync(
		process.execPath,
		[
			'--input-type=module',
			'-e',
			`import {db} from './backend/src/config/database.js';if(db.prepare('SELECT size FROM s3_multipart_parts WHERE upload_id=?').get(${JSON.stringify(id)}).size!==10)process.exit(1);db.close();`,
		],
		{ env: process.env, encoding: 'utf8' },
	);
	assert.equal(child.status, 0, child.stderr);
	const orphan = path.join(
		process.env.S3_MULTIPART_PATH,
		'12345678-1234-1234-1234-123456789012.tmp',
	);
	await writeFile(orphan, 'orphan');
	await multipart.cleanupMultipart(undefined, { startup: true });
	await assert.rejects(access(orphan));
	assert.equal(multipart.listParts(id)[0].size, 10);
	await multipart.removeMultipart(id);
});
test('multipart completion decodes XML numeric quote entities emitted by Go S3 clients', async () => {
	const id = multipart.createMultipart(LOCAL_USER_ID, 'numeric', 'text/plain');
	const staged = await multipart.stageBody(Readable.from(['abc']));
	await multipart.storePart(multipart.findMultipart(LOCAL_USER_ID, 'numeric', id), 1, staged);
	const digest = staged.md5;
	for (const quote of ['&#34;', '&#x22;', '&quot;']) {
		const body = `<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>${quote}${digest}${quote}</ETag></Part></CompleteMultipartUpload>`;
		assert.equal(multipart.completionParts(body, id).parts[0].md5, digest);
	}
	await multipart.removeMultipart(id);
});
test('staging quota rejects excess bytes and releases reservation after failure', async () => {
	const { env } = await import('../src/config/env.js');
	const previous = env.s3StagingMaxBytes;
	env.s3StagingMaxBytes = 2;
	await rejects(() => multipart.stageBody(Readable.from(['abc'])), 'EntityTooLarge');
	const small = await multipart.stageBody(Readable.from(['ab']));
	assert.equal(small.size, 2);
	await small.dispose();
	env.s3StagingMaxBytes = previous;
});
test('SDK payload checksums reject altered content independently of UNSIGNED-PAYLOAD', async () => {
	await rejects(
		() =>
			multipart.stageBody(Readable.from(['abc']), {
				checksums: { 'x-amz-checksum-crc32': 'AAAAAA==' },
			}),
		'BadDigest',
	);
	const correct = await multipart.stageBody(Readable.from(['abc']), {
		checksums: { 'x-amz-checksum-crc32': 'NSRBwg==' },
	});
	await correct.dispose();
});
test('enabling the gateway refuses the known development encryption key', async () => {
	const { spawnSync } = await import('node:child_process');
	const child = spawnSync(
		process.execPath,
		['--input-type=module', '-e', "await import('./backend/src/app.js');"],
		{
			env: { ...process.env, OMNICLOUD_SECRET_HALF: 'omnicloud-dev-secret-half' },
			encoding: 'utf8',
		},
	);
	assert.notEqual(child.status, 0);
	assert.match(child.stderr, /OMNICLOUD_SECRET_HALF/);
});
