import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';

process.env.DATABASE_PATH = path.join(os.tmpdir(), `omnicloud-smb-test-${process.pid}.db`);

const {
	deriveSmbUsername,
	setSmbCredentials,
	getSmbCredential,
	findSmbCredentialByUsername,
	listSmbCredentials,
	deleteSmbCredentials,
	verifyWebdavToken,
} = await import('../src/services/smbCredentialService.js');
const { LOCAL_USER_ID } = await import('../src/config/database.js');

test('deriveSmbUsername sanitiza o email', () => {
	assert.equal(deriveSmbUsername('Ed.Cleubert+drive@gmail.com', () => false), 'ed.cleubert');
});

test('deriveSmbUsername resolve colisão com sufixo numérico', () => {
	const taken = new Set(['edson', 'edson2']);
	assert.equal(deriveSmbUsername('edson@x.com', (name) => taken.has(name)), 'edson3');
});

test('deriveSmbUsername usa fallback quando o email não sobra nada utilizável', () => {
	assert.equal(deriveSmbUsername('!!!@x.com', () => false), 'omnicloud');
});

test('setSmbCredentials grava e getSmbCredential devolve em claro', () => {
	const created = setSmbCredentials(LOCAL_USER_ID, 'senha-forte-123');
	assert.ok(created.username);
	assert.equal(created.webdavToken.length, 64);

	const stored = getSmbCredential(LOCAL_USER_ID);
	assert.equal(stored.password, 'senha-forte-123');
	assert.equal(stored.webdavToken, created.webdavToken);
	assert.equal(stored.username, created.username);
});

test('setSmbCredentials preserva username e rotaciona token ao redefinir a senha', () => {
	const first = getSmbCredential(LOCAL_USER_ID);
	const updated = setSmbCredentials(LOCAL_USER_ID, 'outra-senha-456');

	assert.equal(updated.username, first.username);
	assert.notEqual(updated.webdavToken, first.webdavToken);
	assert.equal(getSmbCredential(LOCAL_USER_ID).password, 'outra-senha-456');
});

test('findSmbCredentialByUsername encontra pelo nome do share', () => {
	const stored = getSmbCredential(LOCAL_USER_ID);
	const found = findSmbCredentialByUsername(stored.username);
	assert.equal(found.userId, LOCAL_USER_ID);
	assert.equal(findSmbCredentialByUsername('nao-existe'), null);
});

test('verifyWebdavToken aceita token correto e recusa errado', () => {
	const stored = getSmbCredential(LOCAL_USER_ID);
	assert.equal(verifyWebdavToken(stored.username, stored.webdavToken).userId, LOCAL_USER_ID);
	assert.equal(verifyWebdavToken(stored.username, 'token-errado'), null);
	assert.equal(verifyWebdavToken('nao-existe', stored.webdavToken), null);
});

test('listSmbCredentials devolve todas as credenciais em claro', () => {
	const all = listSmbCredentials();
	assert.equal(all.length, 1);
	assert.equal(all[0].userId, LOCAL_USER_ID);
	assert.equal(all[0].password, 'outra-senha-456');
});

test('deleteSmbCredentials remove o registro', () => {
	deleteSmbCredentials(LOCAL_USER_ID);
	assert.equal(getSmbCredential(LOCAL_USER_ID), null);
	assert.deepEqual(listSmbCredentials(), []);
});
