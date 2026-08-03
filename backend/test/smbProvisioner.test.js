import assert from 'node:assert/strict';
import test from 'node:test';

const { ensureMount, removeMount } = await import('../../smb/provisioner.js');

function createSystem() {
	const calls = [];
	return { calls, system: {
		run: async (command, args) => { calls.push([command, ...args]); },
		mkdir: () => {},
		exists: () => true,
		log: () => {},
		error: () => {},
	} };
}

test('remonta quando o token WebDAV muda', async () => {
	const { calls, system } = createSystem();
	const first = { userId: 'user-1', username: 'user', webdavToken: 'token-a' };
	const rotated = { ...first, webdavToken: 'token-b' };

	await ensureMount(first, system);
	await ensureMount(first, system);
	await ensureMount(rotated, system);

	assert.equal(calls.filter(([command]) => command === 'rclone').length, 2);
	assert.equal(calls.filter(([command]) => command === 'fusermount3').length, 1);
	await removeMount(rotated.userId, rotated.username, system);
});

test('monta novamente depois de desabilitar e reabilitar', async () => {
	const { calls, system } = createSystem();
	const user = { userId: 'user-2', username: 'user2', webdavToken: 'token' };

	await ensureMount(user, system);
	await removeMount(user.userId, user.username, system);
	await ensureMount(user, system);

	assert.equal(calls.filter(([command]) => command === 'rclone').length, 2);
	assert.equal(calls.filter(([command]) => command === 'fusermount3').length, 1);
	assert.equal(calls.filter(([command]) => command === 'smbpasswd').length, 1);
	await removeMount(user.userId, user.username, system);
});
