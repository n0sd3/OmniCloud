import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const taskRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'omnicloud-dav-test-'));
process.env.DATABASE_PATH = path.join(taskRoot, 'omnicloud.db');
process.env.FILE_CACHE_PATH = path.join(taskRoot, 'files');
process.env.APP_MODE = 'local';

const { createApp } = await import('../src/app.js');
const { db, LOCAL_USER_ID } = await import('../src/config/database.js');
const { createLocalFileStore } = await import('../src/services/localFileStore.js');
const { BaseCloudAdapter } = await import('../src/adapters/BaseCloudAdapter.js');
const { setSmbCredentials, getSmbCredential } = await import(
	'../src/services/smbCredentialService.js'
);

const cacheStore = createLocalFileStore({ rootDir: process.env.FILE_CACHE_PATH });
const originalGetDownloadStream = BaseCloudAdapter.prototype.getDownloadStream;
let adapterBody = 'remote-v1-12';
let adapterCalls = 0;
const backgroundDownload = { pending: false, release: null };

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

db.prepare(`
  INSERT INTO cloud_accounts (id, user_id, email, provider, encrypted_credentials, total_space, used_space, status)
  VALUES ('acc-1', ?, 'a@b.c', 'base', 'x', 1000, 0, 'active')
`).run(LOCAL_USER_ID);

db.prepare(`
  INSERT INTO file_metadata (id, user_id, virtual_path, file_name, is_folder, size, mime_type, cloud_account_id, remote_file_id, remote_modified_time)
  VALUES ('f-1', ?, '/', 'Fotos', 1, 0, NULL, 'acc-1', 'r-1', '2026-08-02T10:00:00.000Z')
`).run(LOCAL_USER_ID);

db.prepare(`
  INSERT INTO file_metadata (id, user_id, virtual_path, file_name, is_folder, size, mime_type, cloud_account_id, remote_file_id, remote_modified_time)
  VALUES ('f-2', ?, '/Fotos/', 'a.txt', 0, 12, 'text/plain', 'acc-1', 'r-2', NULL)
`).run(LOCAL_USER_ID);

db.prepare(`
  INSERT INTO file_metadata (id, user_id, virtual_path, file_name, is_folder, size, mime_type, cloud_account_id, remote_file_id, remote_modified_time)
  VALUES ('f-3', ?, '/Fotos/', 'cached.txt', 0, 12, 'text/plain', 'acc-1', 'r-3', '2026-08-02T11:00:00.000Z')
`).run(LOCAL_USER_ID);

setSmbCredentials(LOCAL_USER_ID, 'senha-forte-123');
const credential = getSmbCredential(LOCAL_USER_ID);
const auth = `Basic ${Buffer.from(`${credential.username}:${credential.webdavToken}`).toString('base64')}`;

const app = createApp();
let server;
let baseUrl;

BaseCloudAdapter.prototype.getDownloadStream = async function getDownloadStream() {
	return Readable.from(['remote-v1-12']);
};

test.before(async () => {
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

test('WebDAV exige autenticação', async () => {
	const response = await fetch(`${baseUrl}/webdav/`, { method: 'PROPFIND' });
	assert.equal(response.status, 401);
	assert.match(response.headers.get('www-authenticate'), /^Basic/);
});

test('WebDAV recusa token errado', async () => {
	const response = await fetch(`${baseUrl}/webdav/`, {
		method: 'PROPFIND',
		headers: { Authorization: `Basic ${Buffer.from(`${credential.username}:errado`).toString('base64')}` },
	});
	assert.equal(response.status, 401);
});

test('OPTIONS anuncia DAV 1', async () => {
	const response = await fetch(`${baseUrl}/webdav/`, {
		method: 'OPTIONS',
		headers: { Authorization: auth },
	});

	assert.equal(response.status, 200);
	assert.equal(response.headers.get('dav'), '1');
	assert.match(response.headers.get('allow'), /PROPFIND/);
});

test('PROPFIND Depth 1 na raiz lista os filhos', async () => {
	const response = await fetch(`${baseUrl}/webdav/`, {
		method: 'PROPFIND',
		headers: { Authorization: auth, Depth: '1' },
	});
	const xml = await response.text();

	assert.equal(response.status, 207);
	assert.match(response.headers.get('content-type'), /application\/xml/);
	assert.match(xml, /<D:href>\/webdav\/<\/D:href>/);
	assert.match(xml, /<D:href>\/webdav\/Fotos\/<\/D:href>/);
});

test('PROPFIND Depth 0 devolve só o próprio recurso', async () => {
	const response = await fetch(`${baseUrl}/webdav/`, {
		method: 'PROPFIND',
		headers: { Authorization: auth, Depth: '0' },
	});
	const xml = await response.text();

	assert.equal(response.status, 207);
	assert.equal(xml.match(/<D:response>/g).length, 1);
});

test('PROPFIND em arquivo devolve tamanho', async () => {
	const response = await fetch(`${baseUrl}/webdav/Fotos/a.txt`, {
		method: 'PROPFIND',
		headers: { Authorization: auth, Depth: '0' },
	});
	const xml = await response.text();

	assert.equal(response.status, 207);
	assert.match(xml, /<D:getcontentlength>12<\/D:getcontentlength>/);
});

test('PROPFIND em caminho inexistente devolve 404', async () => {
	const response = await fetch(`${baseUrl}/webdav/nao-existe.txt`, {
		method: 'PROPFIND',
		headers: { Authorization: auth, Depth: '0' },
	});

	assert.equal(response.status, 404);
});

test('HEAD devolve tamanho sem corpo', async () => {
	const response = await fetch(`${baseUrl}/webdav/Fotos/a.txt`, {
		method: 'HEAD',
		headers: { Authorization: auth },
	});

	assert.equal(response.status, 200);
	assert.equal(response.headers.get('content-length'), '12');
	assert.equal(response.headers.get('accept-ranges'), 'bytes');
});

test('GET devolve o conteúdo do adapter', async () => {
	const response = await fetch(`${baseUrl}/webdav/Fotos/a.txt`, {
		headers: { Authorization: auth },
	});
	const body = await response.text();

	assert.equal(response.status, 200);
	assert.equal(body, 'remote-v1-12');
});

test('GET com Range em adapter sem suporte devolve 200 inteiro', async () => {
	const response = await fetch(`${baseUrl}/webdav/Fotos/a.txt`, {
		headers: { Authorization: auth, Range: 'bytes=0-3' },
	});

	// O adapter base declara supportsRange: false, então a resposta é o corpo completo.
	assert.equal(response.status, 200);
	assert.equal(response.headers.get('content-range'), null);
});

test('GET serves a cached WebDAV Range without calling the adapter', async () => {
	const file = db.prepare('SELECT * FROM file_metadata WHERE id = ?').get('f-3');
	await cacheStore.writeFromStream(file, Readable.from(['remote-v1-12']));
	BaseCloudAdapter.prototype.getDownloadStream = async function getDownloadStream() {
		adapterCalls += 1;
		return Readable.from([adapterBody]);
	};

	const response = await fetch(`${baseUrl}/webdav/Fotos/cached.txt`, {
		headers: { Authorization: auth, Range: 'bytes=2-5' },
	});

	assert.equal(response.status, 206);
	assert.equal(response.headers.get('content-range'), 'bytes 2-5/12');
	assert.equal(await response.text(), 'mote');
	assert.equal(adapterCalls, 0);
});

test('GET starts a remote Range response while the complete cache warmer runs', async () => {
	const file = db.prepare('SELECT * FROM file_metadata WHERE id = ?').get('f-3');
	await cacheStore.invalidate(file);
	adapterCalls = 0;
	BaseCloudAdapter.prototype.getDownloadStream = async function getDownloadStream(_file, range = {}) {
		adapterCalls += 1;
		if (adapterCalls === 2) {
			backgroundDownload.pending = true;
			await new Promise((resolve) => { backgroundDownload.release = resolve; });
		}
		return Readable.from([adapterBody]);
	};

	const response = await fetch(`${baseUrl}/webdav/Fotos/cached.txt`, {
		headers: { Authorization: auth, Range: 'bytes=0-3' },
	});

	assert.equal(response.status, 200);
	assert.equal(await response.text(), 'remote-v1-12');
	await waitForBackgroundDownload();
	assert.equal(adapterCalls, 2);
	backgroundDownload.release();
	await waitForCache(file);
});
