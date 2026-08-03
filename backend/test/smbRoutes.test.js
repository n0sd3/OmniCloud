import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';

process.env.DATABASE_PATH = path.join(os.tmpdir(), `omnicloud-smbroutes-test-${process.pid}.db`);
process.env.SMB_PROVISION_SECRET = 'segredo-de-teste';
process.env.APP_MODE = 'local';

const { createApp } = await import('../src/app.js');

const app = createApp();
let server;
let baseUrl;

test.before(async () => {
	server = app.listen(0);
	await new Promise((resolve) => server.once('listening', resolve));
	baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server.close());

test('GET /api/smb devolve desabilitado antes de configurar', async () => {
	const response = await fetch(`${baseUrl}/api/smb`);
	const payload = await response.json();

	assert.equal(response.status, 200);
	assert.equal(payload.data.enabled, false);
	assert.equal(payload.data.username, null);
});

test('PUT /api/smb cria as credenciais', async () => {
	const response = await fetch(`${baseUrl}/api/smb`, {
		method: 'PUT',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ password: 'senha-forte-123' }),
	});
	const payload = await response.json();

	assert.equal(response.status, 200);
	assert.equal(payload.data.enabled, true);
	assert.ok(payload.data.username);
	assert.ok(payload.data.sharePath.includes(payload.data.username));
});

test('PUT /api/smb recusa senha curta', async () => {
	const response = await fetch(`${baseUrl}/api/smb`, {
		method: 'PUT',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ password: 'curta' }),
	});

	assert.equal(response.status, 400);
});

test('GET /api/smb nunca devolve a senha nem o token', async () => {
	const response = await fetch(`${baseUrl}/api/smb`);
	const body = await response.text();

	assert.doesNotMatch(body, /senha-forte-123/);
	assert.doesNotMatch(body, /webdavToken/);
});

test('GET /internal/smb/users exige o segredo', async () => {
	const semSegredo = await fetch(`${baseUrl}/internal/smb/users`);
	assert.equal(semSegredo.status, 401);

	const errado = await fetch(`${baseUrl}/internal/smb/users`, {
		headers: { 'x-smb-provision-secret': 'errado' },
	});
	assert.equal(errado.status, 401);
});

test('GET /internal/smb/users devolve credenciais em claro com o segredo', async () => {
	const response = await fetch(`${baseUrl}/internal/smb/users`, {
		headers: { 'x-smb-provision-secret': 'segredo-de-teste' },
	});
	const payload = await response.json();

	assert.equal(response.status, 200);
	assert.equal(payload.data.length, 1);
	assert.equal(payload.data[0].password, 'senha-forte-123');
	assert.ok(payload.data[0].webdavToken);
});

test('DELETE /api/smb remove as credenciais', async () => {
	const response = await fetch(`${baseUrl}/api/smb`, { method: 'DELETE' });
	const payload = await response.json();

	assert.equal(response.status, 200);
	assert.equal(payload.data.enabled, false);

	const after = await fetch(`${baseUrl}/api/smb`).then((res) => res.json());
	assert.equal(after.data.enabled, false);
});
