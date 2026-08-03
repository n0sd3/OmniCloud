import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

process.env.DATABASE_PATH = path.join(os.tmpdir(), `omnicloud-davwrite-test-${process.pid}.db`);
process.env.APP_MODE = 'local';

const { createApp } = await import('../src/app.js');
const { db, LOCAL_USER_ID } = await import('../src/config/database.js');
const { setSmbCredentials, getSmbCredential } = await import(
	'../src/services/smbCredentialService.js'
);
const { listFilesByPath } = await import('../src/services/fileService.js');
const { getAllocationConfig, setAllocationConfig } = await import(
	'../src/services/allocationService.js'
);
const { BaseCloudAdapter } = await import('../src/adapters/BaseCloudAdapter.js');

const originalUploadStream = BaseCloudAdapter.prototype.uploadStream;
const originalCreateFolder = BaseCloudAdapter.prototype.createFolder;
const originalGetDownloadStream = BaseCloudAdapter.prototype.getDownloadStream;

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
const mirrorDeleteFile = BaseCloudAdapter.prototype.deleteFile;
const mirrorRenameFile = BaseCloudAdapter.prototype.renameFile;

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

test.after(() => {
	BaseCloudAdapter.prototype.uploadStream = originalUploadStream;
	BaseCloudAdapter.prototype.createFolder = originalCreateFolder;
	BaseCloudAdapter.prototype.getDownloadStream = originalGetDownloadStream;
	server.close();
});

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

test('MKCOL não reutiliza remoteParentId de outra conta', async () => {
	db.prepare(`
		INSERT INTO cloud_accounts (id, user_id, email, provider, encrypted_credentials, total_space, used_space, status)
		VALUES ('acc-2', ?, 'second@b.c', 'base', 'x', 2000000, 0, 'active')
	`).run(LOCAL_USER_ID);
	db.prepare(`
		INSERT INTO file_metadata (id, user_id, virtual_path, file_name, is_folder, size, mime_type, cloud_account_id, remote_file_id)
		VALUES ('cross-parent', ?, '/', 'CrossParent', 1, 0, NULL, 'acc-1', 'remote-parent-acc-1')
	`).run(LOCAL_USER_ID);

	let receivedParentId;
	BaseCloudAdapter.prototype.createFolder = async function createFolder(input) {
		receivedParentId = input.remoteParentId;
		return originalCreateFolder.call(this, input);
	};

	// A estratégia padrão é round_robin, que escolheria qualquer uma das contas:
	// most_free fixa a alocação na acc-2, que é a que não tem o pai.
	const previousStrategy = getAllocationConfig(LOCAL_USER_ID).strategy;
	setAllocationConfig(LOCAL_USER_ID, { strategy: 'most_free' });

	try {
		const response = await fetch(`${baseUrl}/webdav/CrossParent/Child`, {
			method: 'MKCOL',
			headers: { Authorization: auth },
		});

		assert.equal(response.status, 201);
		assert.equal(receivedParentId, null);
	} finally {
		BaseCloudAdapter.prototype.createFolder = originalCreateFolder;
		setAllocationConfig(LOCAL_USER_ID, { strategy: previousStrategy });
		db.prepare("DELETE FROM file_metadata WHERE id = 'cross-parent' OR cloud_account_id = 'acc-2'").run();
		db.prepare("DELETE FROM cloud_accounts WHERE id = 'acc-2'").run();
	}
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

test('PUT devolve 502 quando o provider recusa o upload', async () => {
	BaseCloudAdapter.prototype.uploadStream = async function uploadStream({ stream }) {
		for await (const _chunk of stream) { /* consume o corpo antes da falha remota */ }
		throw new Error('provider upload failed');
	};

	try {
		const response = await fetch(`${baseUrl}/webdav/provider-failure.txt`, {
			method: 'PUT',
			headers: { Authorization: auth, 'Content-Length': '3', 'Content-Type': 'text/plain' },
			body: 'abc',
		});

		assert.equal(response.status, 502);
	} finally {
		BaseCloudAdapter.prototype.uploadStream = originalUploadStream;
	}
});

test('PUT falho preserva conteúdo remoto e metadado do arquivo substituído', async () => {
	const remote = new Map([['protected.txt', 'conteudo original']]);
	db.prepare(`
		INSERT INTO file_metadata (id, user_id, virtual_path, file_name, is_folder, size, mime_type, cloud_account_id, remote_file_id)
		VALUES ('protected-file', ?, '/', 'protected.txt', 0, 17, 'text/plain', 'acc-1', 'protected.txt')
	`).run(LOCAL_USER_ID);

	BaseCloudAdapter.prototype.uploadStream = async function uploadStream({ stream, fileName }) {
		for await (const _chunk of stream) {
			remote.set(fileName, 'parcial corrompido');
		}
		throw new Error('provider disconnected during upload');
	};
	BaseCloudAdapter.prototype.deleteFile = async function deleteFile(file) {
		remote.delete(file.remote_file_id);
	};
	BaseCloudAdapter.prototype.getDownloadStream = async function getDownloadStream(file) {
		if (!remote.has(file.remote_file_id)) throw new Error('remote object not found');
		return Readable.from([remote.get(file.remote_file_id)]);
	};

	try {
		await fetch(`${baseUrl}/webdav/protected.txt`, {
			method: 'PUT',
			headers: { Authorization: auth, 'Content-Length': '4', 'Content-Type': 'text/plain' },
			body: 'novo',
		});

		const metadata = db.prepare("SELECT * FROM file_metadata WHERE id = 'protected-file'").get();
		assert.equal(metadata?.remote_file_id, 'protected.txt');
		assert.equal(remote.get('protected.txt'), 'conteudo original');

		const response = await fetch(`${baseUrl}/webdav/protected.txt`, { headers: { Authorization: auth } });
		assert.equal(response.status, 200);
		assert.equal(await response.text(), 'conteudo original');
	} finally {
		BaseCloudAdapter.prototype.uploadStream = originalUploadStream;
		BaseCloudAdapter.prototype.deleteFile = mirrorDeleteFile;
		BaseCloudAdapter.prototype.getDownloadStream = originalGetDownloadStream;
		db.prepare("DELETE FROM file_metadata WHERE id = 'protected-file'").run();
	}
});

test('PUT promove chave temporária sem apagar a chave nova determinística', async () => {
	const remote = new Map([['deterministic.txt', 'antigo']]);
	const deleted = [];
	db.prepare(`
		INSERT INTO file_metadata (id, user_id, virtual_path, file_name, is_folder, size, mime_type, cloud_account_id, remote_file_id)
		VALUES ('deterministic-file', ?, '/', 'deterministic.txt', 0, 6, 'text/plain', 'acc-1', 'deterministic.txt')
	`).run(LOCAL_USER_ID);

	BaseCloudAdapter.prototype.uploadStream = async function uploadStream({ stream, fileName, size, mimeType }) {
		const chunks = [];
		for await (const chunk of stream) chunks.push(chunk);
		remote.set(fileName, Buffer.concat(chunks).toString());
		return { remoteFileId: fileName, remoteParentId: '/', size, fileName, mimeType };
	};
	BaseCloudAdapter.prototype.renameFile = async function renameFile(file, nextName) {
		remote.set(nextName, remote.get(file.remote_file_id));
		remote.delete(file.remote_file_id);
		return { remoteFileId: nextName, remoteParentId: '/' };
	};
	BaseCloudAdapter.prototype.deleteFile = async function deleteFile(file) {
		deleted.push(file.remote_file_id);
		remote.delete(file.remote_file_id);
	};

	try {
		const response = await fetch(`${baseUrl}/webdav/deterministic.txt`, {
			method: 'PUT',
			headers: { Authorization: auth, 'Content-Length': '4', 'Content-Type': 'text/plain' },
			body: 'novo',
		});

		assert.equal(response.status, 204);
		assert.equal(remote.get('deterministic.txt'), 'novo');
		assert.ok(!deleted.includes('deterministic.txt'), 'cleanup não pode apagar a chave promovida');
	} finally {
		BaseCloudAdapter.prototype.uploadStream = originalUploadStream;
		BaseCloudAdapter.prototype.renameFile = mirrorRenameFile;
		BaseCloudAdapter.prototype.deleteFile = mirrorDeleteFile;
		db.prepare("DELETE FROM file_metadata WHERE id = 'deterministic-file'").run();
	}
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

test('PUT sobre arquivo existente não deixa o GET seguinte servir o cache antigo', async () => {
	const created = await fetch(`${baseUrl}/webdav/cache-check.txt`, {
		method: 'PUT',
		headers: { Authorization: auth, 'Content-Length': '7', 'Content-Type': 'text/plain' },
		body: 'antigo!',
	});
	assert.equal(created.status, 201);

	// Esquenta o cache local lendo o arquivo pelo WebDAV.
	const warmed = await fetch(`${baseUrl}/webdav/cache-check.txt`, { headers: { Authorization: auth } });
	assert.equal(await warmed.text(), 'antigo!');

	const overwritten = await fetch(`${baseUrl}/webdav/cache-check.txt`, {
		method: 'PUT',
		headers: { Authorization: auth, 'Content-Length': '5', 'Content-Type': 'text/plain' },
		body: 'novo!',
	});
	assert.equal(overwritten.status, 204);

	const after = await fetch(`${baseUrl}/webdav/cache-check.txt`, { headers: { Authorization: auth } });
	assert.equal(await after.text(), 'novo!', 'GET depois do PUT não pode servir os bytes antigos do cache');
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
