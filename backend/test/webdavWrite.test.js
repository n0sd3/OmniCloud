import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';

process.env.DATABASE_PATH = path.join(os.tmpdir(), `omnicloud-davwrite-test-${process.pid}.db`);
process.env.APP_MODE = 'local';

const { createApp } = await import('../src/app.js');
const { db, LOCAL_USER_ID } = await import('../src/config/database.js');
const { setSmbCredentials, getSmbCredential } = await import(
	'../src/services/smbCredentialService.js'
);
const { listFilesByPath } = await import('../src/services/fileService.js');
const { BaseCloudAdapter } = await import('../src/adapters/BaseCloudAdapter.js');

// ponytail: o provider 'base' é um adapter simulado sem armazenamento remoto
// de verdade (só existe para testes). Sem isso, fetchStructure() volta [] e o
// syncAccount() disparado pelos handlers de escrita apagaria toda a
// file_metadata da conta a cada PUT/DELETE/MOVE. Espelha o próprio
// file_metadata como se fosse a estrutura remota, e deleteFile/renameFile
// como operações que "acontecem" nesse espelho.
BaseCloudAdapter.prototype.fetchStructure = async function fetchStructure() {
	return db
		.prepare('SELECT * FROM file_metadata WHERE user_id = ? AND cloud_account_id = ?')
		.all(this.account.user_id, this.account.id);
};
BaseCloudAdapter.prototype.deleteFile = async function deleteFile() {};
BaseCloudAdapter.prototype.renameFile = async function renameFile(fileRecord, nextName) {
	db.prepare('UPDATE file_metadata SET file_name = ? WHERE id = ?').run(nextName, fileRecord.id);
};

db.prepare(`
  INSERT INTO cloud_accounts (id, user_id, email, provider, encrypted_credentials, total_space, used_space, status)
  VALUES ('acc-1', ?, 'a@b.c', 'base', 'x', 1000000, 0, 'active')
`).run(LOCAL_USER_ID);

db.prepare(`
  INSERT INTO file_metadata (id, user_id, virtual_path, file_name, is_folder, size, mime_type, cloud_account_id, remote_file_id)
  VALUES ('f-1', ?, '/', 'antigo.txt', 0, 5, 'text/plain', 'acc-1', 'r-1')
`).run(LOCAL_USER_ID);

setSmbCredentials(LOCAL_USER_ID, 'senha-forte-123');
const credential = getSmbCredential(LOCAL_USER_ID);
const auth = `Basic ${Buffer.from(`${credential.username}:${credential.webdavToken}`).toString('base64')}`;

const app = createApp();
let server;
let baseUrl;

test.before(async () => {
	server = app.listen(0);
	await new Promise((resolve) => server.once('listening', resolve));
	baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server.close());

test('MKCOL cria pasta na árvore virtual', async () => {
	const response = await fetch(`${baseUrl}/webdav/NovaPasta`, {
		method: 'MKCOL',
		headers: { Authorization: auth },
	});

	assert.equal(response.status, 201);
	const created = listFilesByPath(LOCAL_USER_ID, '/').find((item) => item.file_name === 'NovaPasta');
	assert.ok(created);
	assert.equal(created.is_folder, 1);
});

test('MKCOL em pasta existente devolve 405', async () => {
	const response = await fetch(`${baseUrl}/webdav/NovaPasta`, {
		method: 'MKCOL',
		headers: { Authorization: auth },
	});

	assert.equal(response.status, 405);
});

test('PUT cria arquivo novo', async () => {
	const response = await fetch(`${baseUrl}/webdav/novo.txt`, {
		method: 'PUT',
		headers: { Authorization: auth, 'Content-Length': '11', 'Content-Type': 'text/plain' },
		body: 'ola do smb!',
	});

	assert.equal(response.status, 201);
	const created = listFilesByPath(LOCAL_USER_ID, '/').find((item) => item.file_name === 'novo.txt');
	assert.ok(created);
	assert.equal(Number(created.size), 11);
});

test('PUT sobre arquivo existente devolve 204', async () => {
	const response = await fetch(`${baseUrl}/webdav/novo.txt`, {
		method: 'PUT',
		headers: { Authorization: auth, 'Content-Length': '3', 'Content-Type': 'text/plain' },
		body: 'abc',
	});

	assert.equal(response.status, 204);
	const files = listFilesByPath(LOCAL_USER_ID, '/').filter((item) => item.file_name === 'novo.txt');
	assert.equal(files.length, 1, 'não pode duplicar o registro ao sobrescrever');
});

test('MOVE renomeia dentro da mesma pasta', async () => {
	const response = await fetch(`${baseUrl}/webdav/antigo.txt`, {
		method: 'MOVE',
		headers: { Authorization: auth, Destination: `${baseUrl}/webdav/renomeado.txt` },
	});

	assert.equal(response.status, 204);
	const names = listFilesByPath(LOCAL_USER_ID, '/').map((item) => item.file_name);
	assert.ok(names.includes('renomeado.txt'));
	assert.ok(!names.includes('antigo.txt'));
});

test('MOVE entre pastas diferentes devolve 502', async () => {
	const response = await fetch(`${baseUrl}/webdav/renomeado.txt`, {
		method: 'MOVE',
		headers: { Authorization: auth, Destination: `${baseUrl}/webdav/NovaPasta/renomeado.txt` },
	});

	assert.equal(response.status, 502);
});

test('DELETE remove o arquivo', async () => {
	const response = await fetch(`${baseUrl}/webdav/renomeado.txt`, {
		method: 'DELETE',
		headers: { Authorization: auth },
	});

	assert.equal(response.status, 204);
	const names = listFilesByPath(LOCAL_USER_ID, '/').map((item) => item.file_name);
	assert.ok(!names.includes('renomeado.txt'));
});

test('COPY responde 501 para o rclone cair no fallback', async () => {
	const response = await fetch(`${baseUrl}/webdav/novo.txt`, {
		method: 'COPY',
		headers: { Authorization: auth, Destination: `${baseUrl}/webdav/copia.txt` },
	});

	assert.equal(response.status, 501);
});

test('DELETE em caminho inexistente devolve 404', async () => {
	const response = await fetch(`${baseUrl}/webdav/fantasma.txt`, {
		method: 'DELETE',
		headers: { Authorization: auth },
	});

	assert.equal(response.status, 404);
});
