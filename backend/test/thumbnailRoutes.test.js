import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const taskRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'omnicloud-thumbnail-routes-'));
process.env.DATABASE_PATH = path.join(taskRoot, 'omnicloud.db');
process.env.THUMBNAIL_CACHE_DIR = path.join(taskRoot, 'thumbnails');
process.env.APP_MODE = 'local';

const [
	{ createApp },
	{ db, LOCAL_USER_ID },
	{ createFileMetadata },
	{ getThumbnailCacheKey },
] = await Promise.all([
	import('../src/app.js'),
	import('../src/config/database.js'),
	import('../src/services/fileService.js'),
	import('../src/services/thumbnailService.js'),
]);

const app = createApp();
let server;
let baseUrl;
let pdfFile;
let audioFile;

test.before(async () => {
	db.prepare(`
		INSERT INTO cloud_accounts (
			id, user_id, email, provider, encrypted_credentials,
			total_space, used_space, status
		) VALUES (?, ?, ?, 'base', '', 1000, 0, 'active')
	`).run('account-1', LOCAL_USER_ID, 'local@example.com');

	pdfFile = createFileMetadata({
		user_id: LOCAL_USER_ID,
		virtual_path: '/',
		file_name: 'cached.pdf',
		is_folder: false,
		size: 3,
		mime_type: 'application/pdf',
		cloud_account_id: 'account-1',
		remote_file_id: 'pdf-remote',
		remote_modified_time: '2026-08-02T12:00:00.000Z',
	});
	audioFile = createFileMetadata({
		user_id: LOCAL_USER_ID,
		virtual_path: '/',
		file_name: 'song.mp3',
		is_folder: false,
		size: 3,
		mime_type: 'audio/mpeg',
		cloud_account_id: 'account-1',
		remote_file_id: 'audio-remote',
	});

	await fs.mkdir(process.env.THUMBNAIL_CACHE_DIR, { recursive: true });
	await fs.writeFile(
		path.join(process.env.THUMBNAIL_CACHE_DIR, `${getThumbnailCacheKey(LOCAL_USER_ID, pdfFile)}.jpg`),
		'cached-jpeg',
	);

	server = app.listen(0);
	await new Promise((resolve) => server.once('listening', resolve));
	baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
	server.close();
	db.close();
	await fs.rm(taskRoot, { recursive: true, force: true });
});

test('thumbnail route returns 415 for unsupported files', async () => {
	const response = await fetch(`${baseUrl}/api/files/${audioFile.id}/thumbnail`);
	assert.equal(response.status, 415);
});

test('thumbnail route serves a private cached JPEG', async () => {
	const response = await fetch(`${baseUrl}/api/files/${pdfFile.id}/thumbnail`);

	assert.equal(response.status, 200);
	assert.equal(response.headers.get('content-type'), 'image/jpeg');
	assert.equal(response.headers.get('cache-control'), 'private, max-age=86400');
	assert.equal(await response.text(), 'cached-jpeg');
});
