import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const taskRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'omnicloud-preview-routes-'));
process.env.DATABASE_PATH = path.join(taskRoot, 'omnicloud.db');
process.env.PREVIEW_CACHE_DIR = path.join(taskRoot, 'previews');
process.env.FILE_CACHE_PATH = path.join(taskRoot, 'files');
process.env.APP_MODE = 'local';

const [
	{ createApp },
	{ db, LOCAL_USER_ID },
	{ createFileMetadata },
	{ getPreviewCacheKey },
] = await Promise.all([
	import('../src/app.js'),
	import('../src/config/database.js'),
	import('../src/services/fileService.js'),
	import('../src/services/previewService.js'),
]);

const app = createApp();
let server;
let baseUrl;
let textFile;
let archiveFile;
let officeFile;

test.before(async () => {
	db.prepare(`
		INSERT INTO cloud_accounts (
			id, user_id, email, provider, encrypted_credentials,
			total_space, used_space, status
		) VALUES (?, ?, ?, 'base', '', 1000, 0, 'active')
	`).run('account-1', LOCAL_USER_ID, 'local@example.com');

	textFile = createFileMetadata({
		user_id: LOCAL_USER_ID,
		virtual_path: '/',
		file_name: 'notes.txt',
		is_folder: false,
		size: 11,
		mime_type: 'text/plain',
		cloud_account_id: 'account-1',
		remote_file_id: 'text-remote',
		remote_modified_time: '2026-08-02T12:00:00.000Z',
	});
	archiveFile = createFileMetadata({
		user_id: LOCAL_USER_ID,
		virtual_path: '/',
		file_name: 'archive.zip',
		is_folder: false,
		size: 4,
		mime_type: 'application/zip',
		cloud_account_id: 'account-1',
		remote_file_id: 'zip-remote',
	});
	officeFile = createFileMetadata({
		user_id: LOCAL_USER_ID,
		virtual_path: '/',
		file_name: 'report.docx',
		is_folder: false,
		size: 6,
		mime_type: 'application/octet-stream',
		cloud_account_id: 'account-1',
		remote_file_id: 'docx-remote',
		remote_modified_time: '2026-08-02T12:00:00.000Z',
	});

	// PDF ja convertido: a rota deve servir o cache sem chamar o LibreOffice.
	await fs.mkdir(process.env.PREVIEW_CACHE_DIR, { recursive: true });
	await fs.writeFile(
		path.join(process.env.PREVIEW_CACHE_DIR, `${getPreviewCacheKey(LOCAL_USER_ID, officeFile)}.pdf`),
		'converted-pdf',
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

test('preview rejects file types without a renderer', async () => {
	const response = await fetch(`${baseUrl}/api/files/${archiveFile.id}/preview`);
	assert.equal(response.status, 415);
});

test('preview answers 304 when the etag matches', async () => {
	const etag = `"${getPreviewCacheKey(LOCAL_USER_ID, textFile)}"`;
	const response = await fetch(`${baseUrl}/api/files/${textFile.id}/preview`, {
		headers: { 'If-None-Match': etag },
	});

	assert.equal(response.status, 304);
	assert.equal(response.headers.get('accept-ranges'), 'bytes');
	assert.equal(response.headers.get('cache-control'), 'private, max-age=3600');
});

test('preview serves converted office files as pdf with a partial range', async () => {
	const full = await fetch(`${baseUrl}/api/files/${officeFile.id}/preview`);
	assert.equal(full.status, 200);
	assert.equal(full.headers.get('content-type'), 'application/pdf');
	assert.equal(full.headers.get('accept-ranges'), 'bytes');
	assert.match(full.headers.get('etag'), /^"[a-f0-9]{64}"$/);
	assert.match(full.headers.get('content-disposition'), /^inline;/);
	assert.equal(await full.text(), 'converted-pdf');

	const partial = await fetch(`${baseUrl}/api/files/${officeFile.id}/preview`, {
		headers: { Range: 'bytes=0-8' },
	});
	assert.equal(partial.status, 206);
	assert.equal(partial.headers.get('content-range'), 'bytes 0-8/13');
	assert.equal(partial.headers.get('content-length'), '9');
	assert.equal(await partial.text(), 'converted');
});
