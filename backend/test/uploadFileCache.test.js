import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const taskRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'omnicloud-upload-cache-'));
process.env.DATABASE_PATH = path.join(taskRoot, 'omnicloud.db');
process.env.FILE_CACHE_PATH = path.join(taskRoot, 'files');

const [
	{ db, LOCAL_USER_ID },
	{ BaseCloudAdapter },
	{ fileCacheService },
	{ createLocalFileStore },
	{ createUploadSession },
	{ handleUpload },
] = await Promise.all([
	import('../src/config/database.js'),
	import('../src/adapters/BaseCloudAdapter.js'),
	import('../src/services/fileCacheService.js'),
	import('../src/services/localFileStore.js'),
	import('../src/services/uploadSessionService.js'),
	import('../src/services/uploadService.js'),
]);

const account = {
	id: 'upload-account',
	user_id: LOCAL_USER_ID,
	email: 'uploads@example.com',
	provider: 'base',
	total_space: 1000,
	used_space: 0,
};
const store = createLocalFileStore({ rootDir: process.env.FILE_CACHE_PATH });
let failProvider = false;
let remoteFiles = [];

function multipartRequest(body, fileName = 'upload.txt') {
	const boundary = 'omnicloud-upload-boundary';
	const payload = Buffer.concat([
		Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: text/plain\r\n\r\n`),
		Buffer.from(body),
		Buffer.from(`\r\n--${boundary}--\r\n`),
	]);
	const req = Readable.from([payload]);
	req.user = { id: LOCAL_USER_ID };
	req.headers = {
		'content-type': `multipart/form-data; boundary=${boundary}`,
		'content-length': String(payload.length),
	};
	return req;
}

function newSession(body, fileName = 'upload.txt') {
	return createUploadSession({
		user_id: LOCAL_USER_ID,
		file_name: fileName,
		size: Buffer.byteLength(body),
		mime_type: 'text/plain',
		virtual_path: '/',
		remote_parent_id: null,
		cloud_account_id: account.id,
		fallback_chain: [],
	});
}

async function uploadRequest(body, options = {}) {
	failProvider = Boolean(options.failProvider);
	const fileName = options.fileName || 'upload.txt';
	const session = newSession(body, fileName);
	return handleUpload(multipartRequest(body, fileName), session.id);
}

async function read(stream) {
	const parts = [];
	for await (const part of stream) parts.push(part);
	return Buffer.concat(parts).toString();
}

test.before(() => {
	db.prepare(`
		INSERT INTO cloud_accounts (
			id, user_id, email, provider, encrypted_credentials,
			total_space, used_space, status
		) VALUES (?, ?, ?, 'base', '', 1000, 0, 'active')
	`).run(account.id, LOCAL_USER_ID, account.email);

	BaseCloudAdapter.prototype.uploadStream = async ({ stream, size, fileName, mimeType, virtualPath }) => {
		const body = await read(stream);
		if (failProvider) throw new Error('provider failed');
		const remoteFileId = `remote-${fileName}`;
		remoteFiles = [{
			virtual_path: virtualPath,
			file_name: fileName,
			is_folder: false,
			size,
			mime_type: mimeType,
			remote_file_id: remoteFileId,
			remote_parent_id: null,
			remote_modified_time: '2026-08-03T12:00:00.000Z',
		}];
		assert.equal(body.length, size);
		return { remoteFileId, remoteParentId: null };
	};
	BaseCloudAdapter.prototype.fetchStructure = async () => remoteFiles;
	BaseCloudAdapter.prototype.getStorageSummary = async () => ({ totalSpace: 1000, usedSpace: 100 });
});

test.after(async () => {
	db.close();
	await fs.rm(taskRoot, { recursive: true, force: true });
});

test('successful upload publishes the exact incoming bytes locally', async () => {
	const metadata = await uploadRequest('alpha-beta', { fileName: 'success.txt' });
	assert.equal(await read(await store.openReadStream(metadata)), 'alpha-beta');
});

test('provider failure leaves no complete local entry', async () => {
	const body = 'payload';
	await assert.rejects(uploadRequest(body, { failProvider: true, fileName: 'failed.txt' }), /provider failed/);
	const expectedMetadata = {
		user_id: LOCAL_USER_ID,
		cloud_account_id: account.id,
		remote_file_id: 'remote-failed.txt',
		size: body.length,
		remote_modified_time: '2026-08-03T12:00:00.000Z',
	};
	assert.equal(await store.getValidPath(expectedMetadata), null);
	assert.deepEqual((await fs.readdir(process.env.FILE_CACHE_PATH)).filter((name) => name.endsWith('.tmp')), []);
});

test('local capture failure does not fail a successful provider upload', async () => {
	const originalCapture = fileCacheService.captureUpload;
	fileCacheService.captureUpload = (stream) => ({
		stream,
		completed: Promise.resolve(null),
		discard: async () => {},
	});
	try {
		const metadata = await uploadRequest('payload', { fileName: 'cache-failed.txt' });
		assert.equal(metadata.remote_file_id, 'remote-cache-failed.txt');
	} finally {
		fileCacheService.captureUpload = originalCapture;
	}
});
