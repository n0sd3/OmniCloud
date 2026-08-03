import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const taskRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'omnicloud-file-cache-routes-'));
process.env.DATABASE_PATH = path.join(taskRoot, 'omnicloud.db');
process.env.FILE_CACHE_PATH = path.join(taskRoot, 'files');
process.env.APP_MODE = 'local';

const [
	{ createApp },
	{ db, LOCAL_USER_ID },
	{ createFileMetadata },
	{ createLocalFileStore },
	{ BaseCloudAdapter },
] = await Promise.all([
	import('../src/app.js'),
	import('../src/config/database.js'),
	import('../src/services/fileService.js'),
	import('../src/services/localFileStore.js'),
	import('../src/adapters/BaseCloudAdapter.js'),
]);

const cacheStore = createLocalFileStore({ rootDir: process.env.FILE_CACHE_PATH });
const originalGetDownloadStream = BaseCloudAdapter.prototype.getDownloadStream;
const backgroundDownload = { pending: false, release: null };
let adapterBody = 'remote-v1';
let backgroundFile;
let downloadFile;
let server;
let baseUrl;

async function waitForCache(file) {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (await cacheStore.getValidPath(file)) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.fail(`timed out waiting for ${file.file_name} to enter the cache`);
}

async function waitForBackgroundDownload() {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (backgroundDownload.pending) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.fail('timed out waiting for the background download to start');
}

test.before(async () => {
	db.prepare(`
		INSERT INTO cloud_accounts (
			id, user_id, email, provider, encrypted_credentials,
			total_space, used_space, status
		) VALUES (?, ?, ?, 'base', '', 1000, 0, 'active')
	`).run('account-1', LOCAL_USER_ID, 'local@example.com');

	backgroundFile = createFileMetadata({
		user_id: LOCAL_USER_ID,
		virtual_path: '/Fotos/',
		file_name: 'background.txt',
		is_folder: false,
		size: 9,
		mime_type: 'text/plain',
		cloud_account_id: 'account-1',
		remote_file_id: 'background-remote',
		remote_modified_time: '2026-08-02T12:00:00.000Z',
	});
	downloadFile = createFileMetadata({
		user_id: LOCAL_USER_ID,
		virtual_path: '/Downloads/',
		file_name: 'download.txt',
		is_folder: false,
		size: 9,
		mime_type: 'text/plain',
		cloud_account_id: 'account-1',
		remote_file_id: 'download-remote',
		remote_modified_time: '2026-08-02T12:00:00.000Z',
	});

	BaseCloudAdapter.prototype.getDownloadStream = async function getDownloadStream(file) {
		if (file.id === backgroundFile.id) {
			backgroundDownload.pending = true;
			await new Promise((resolve) => { backgroundDownload.release = resolve; });
		}
		return Readable.from([adapterBody]);
	};

	const app = createApp();
	server = app.listen(0);
	await new Promise((resolve) => server.once('listening', resolve));
	baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
	backgroundDownload.release?.();
	BaseCloudAdapter.prototype.getDownloadStream = originalGetDownloadStream;
	server.close();
	db.close();
	await fs.rm(taskRoot, { recursive: true, force: true });
});

test('folder listing responds before background file download completes', async () => {
	const response = await fetch(`${baseUrl}/api/files?path=%2FFotos%2F`);

	assert.equal(response.status, 200);
	await waitForBackgroundDownload();
	backgroundDownload.release();
	await waitForCache(backgroundFile);
});

test('first download is remote and the next download is local', async () => {
	const downloadUrl = `${baseUrl}/api/files/${downloadFile.id}/download`;

	assert.equal(await (await fetch(downloadUrl)).text(), 'remote-v1');
	await waitForCache(downloadFile);
	adapterBody = 'remote-v2';
	assert.equal(await (await fetch(downloadUrl)).text(), 'remote-v1');
});
