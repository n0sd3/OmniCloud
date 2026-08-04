import assert from 'node:assert/strict';
import test from 'node:test';
import { createGooglePhotosImportLifecycle, getGooglePhotosImportSummary } from '../src/composables/useGooglePhotosImportLifecycle.js';

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((nextResolve, nextReject) => {
		resolve = nextResolve;
		reject = nextReject;
	});
	return { promise, resolve, reject };
}

function importJob(overrides = {}) {
	return {
		id: 'import-1',
		status: 'waiting_for_selection',
		pollIntervalMs: 25,
		total: 0,
		completed: 0,
		failed: 0,
		errors: [],
		pickerUri: 'https://picker.example/session',
		...overrides,
	};
}

function setup({ popup = true, popupNavigationError = false, start = Promise.resolve({ data: importJob() }), get = Promise.resolve({ data: importJob() }) } = {}) {
	const updates = [];
	const errors = [];
	const refreshes = [];
	const cancellations = [];
	const timers = new Map();
	const sockets = [];
	let nextTimer = 1;
	const windows = [];
	const browser = {
		open() {
			if (!popup) return null;
			const next = {
				closed: false,
				close() { this.closed = true; },
				location: {
					replace(uri) {
						if (popupNavigationError) throw new Error('Picker navigation failed');
						next.uri = uri;
					},
				},
			};
			windows.push(next);
			return next;
		},
		setTimeout(callback) {
			const id = nextTimer++;
			timers.set(id, callback);
			return id;
		},
		clearTimeout(id) {
			timers.delete(id);
		},
	};
	const api = {
		startGooglePhotosImport: () => start,
		getGooglePhotosImport: () => get,
		cancelGooglePhotosImport: async (id) => {
			cancellations.push(id);
			return { data: importJob({ id, status: 'cancelled' }) };
		},
		createUploadSocket() {
			const socket = { closeCalls: 0, close() { this.closeCalls += 1; } };
			sockets.push(socket);
			return socket;
		},
	};
	const lifecycle = createGooglePhotosImportLifecycle({
		api,
		browser,
		onUpdate: (accountId, value) => updates.push({ accountId, value }),
		onError: (accountId, value) => errors.push({ accountId, value }),
		onRefresh: (accountId) => refreshes.push(accountId),
	});

	return {
		lifecycle,
		updates,
		errors,
		refreshes,
		cancellations,
		timers,
		sockets,
		windows,
		runTimer: async () => {
			const [id, callback] = timers.entries().next().value || [];
			if (id) timers.delete(id);
			await callback?.();
		},
	};
}

const ACCOUNT = { id: 'account-1' };

test('rapid starts keep one pending Picker request and popup', async () => {
	const pending = deferred();
	const fixture = setup({ start: pending.promise });

	const first = fixture.lifecycle.start(ACCOUNT);
	const second = fixture.lifecycle.start(ACCOUNT);
	pending.resolve({ data: importJob() });
	await Promise.all([first, second]);

	assert.equal(fixture.windows.length, 1);
	assert.equal(fixture.sockets.length, 1);
	assert.equal(fixture.updates.filter(({ value }) => value.status === 'starting').length, 1);
});

test('dispose during Picker POST cancels a late import without opening resources', async () => {
	const pending = deferred();
	const fixture = setup({ start: pending.promise });
	const started = fixture.lifecycle.start(ACCOUNT);
	fixture.lifecycle.dispose();
	pending.resolve({ data: importJob() });
	await started;

	assert.deepEqual(fixture.cancellations, ['import-1']);
	assert.equal(fixture.windows[0].closed, true);
	assert.equal(fixture.sockets.length, 0);
	assert.equal(fixture.timers.size, 0);
	assert.equal(fixture.windows[0].uri, undefined);
});

test('a permanent poll failure becomes a failed terminal state and cleans up', async () => {
	const failure = Object.assign(new Error('Import not found'), { status: 404 });
	const fixture = setup({ get: Promise.reject(failure) });
	await fixture.lifecycle.start(ACCOUNT);
	await fixture.runTimer();

	const terminal = fixture.updates.at(-1).value;
	assert.equal(terminal.status, 'failed');
	assert.deepEqual(terminal.errors, ['Import not found']);
	assert.equal(fixture.sockets[0].closeCalls, 1);
	assert.equal(fixture.windows[0].closed, true);
	assert.equal(fixture.timers.size, 0);
});

test('a failed job preserves its sanitized error and refreshes the account', async () => {
	const fixture = setup({ get: Promise.resolve({ data: importJob({ status: 'failed', errors: ['Google authorization was revoked'] }) }) });
	await fixture.lifecycle.start(ACCOUNT);
	await fixture.runTimer();

	const terminal = fixture.updates.at(-1).value;
	assert.deepEqual(terminal.errors, ['Google authorization was revoked']);
	assert.equal(getGooglePhotosImportSummary(terminal, { failed: () => 'Import failed' }), 'Google authorization was revoked');
	assert.deepEqual(fixture.refreshes, ['account-1']);
});

test('a blocked popup reports an error without creating a backend import', async () => {
	const fixture = setup({ popup: false });
	await fixture.lifecycle.start(ACCOUNT);

	assert.deepEqual(fixture.errors, [{ accountId: 'account-1', value: 'popup-blocked' }]);
	assert.equal(fixture.updates.length, 0);
});

test('a rejected initial POST clears the starting state and closes the popup', async () => {
	const fixture = setup({ start: Promise.reject(new Error('Google Photos Picker access requires reconnecting the account')) });
	await fixture.lifecycle.start(ACCOUNT);

	assert.equal(fixture.updates.at(-1).value.status, 'failed');
	assert.equal(fixture.windows[0].closed, true);
	assert.equal(fixture.timers.size, 0);
});

test('a terminal WebSocket event fetches the sanitized failed-job error before cleanup', async () => {
	const fixture = setup({ get: Promise.resolve({ data: importJob({ status: 'failed', errors: ['Google authorization was revoked'] }) }) });
	await fixture.lifecycle.start(ACCOUNT);
	fixture.sockets[0].onmessage({ data: JSON.stringify({ type: 'photos-import:complete', status: 'failed', total: 0, completed: 0, failed: 0 }) });
	await Promise.resolve();
	await Promise.resolve();

	assert.deepEqual(fixture.updates.at(-1).value.errors, ['Google authorization was revoked']);
	assert.equal(fixture.sockets[0].closeCalls, 1);
});

test('a post-creation Picker setup failure cancels the backend session', async () => {
	const fixture = setup({ popupNavigationError: true });
	await fixture.lifecycle.start(ACCOUNT);

	assert.deepEqual(fixture.cancellations, ['import-1']);
	assert.equal(fixture.windows[0].closed, true);
	assert.equal(fixture.sockets.length, 0);
});
