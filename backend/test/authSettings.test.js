import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';

process.env.DATABASE_PATH = path.join(os.tmpdir(), `omnicloud-auth-settings-${process.pid}.db`);
process.env.APP_MODE = 'hosted';

const [{ createApp }, { setAppSetting }] = await Promise.all([
	import('../src/app.js'),
	import('../src/services/appSettingsService.js'),
]);

const app = createApp();
let server;
let baseUrl;

test.before(async () => {
	server = app.listen(0);
	await new Promise((resolve) => server.once('listening', resolve));
	baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server.close());

test('auth summary exposes the current registration state', async () => {
	const enabled = await fetch(`${baseUrl}/api/auth/me`).then((response) => response.json());
	assert.equal(enabled.data.registrationEnabled, true);

	setAppSetting('registration_enabled', 'false');

	const disabled = await fetch(`${baseUrl}/api/auth/me`).then((response) => response.json());
	assert.equal(disabled.data.registrationEnabled, false);
});

test('registration remains rejected by the server when disabled', async (t) => {
	t.mock.method(console, 'error', () => {});
	setAppSetting('registration_enabled', 'false');

	const response = await fetch(`${baseUrl}/api/auth/register`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ email: 'new@example.com', password: 'password123' }),
	});
	const payload = await response.json();

	assert.equal(response.status, 400);
	assert.equal(payload.error, 'Registration is not available on this instance');
});
