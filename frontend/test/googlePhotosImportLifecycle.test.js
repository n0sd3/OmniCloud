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
	const timerDelays = [];
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
		setTimeout(callback, delay) {
			const id = nextTimer++;
			timers.set(id, callback);
			timerDelays.push(delay);
			return id;
		},
		clearTimeout(id) {
			timers.delete(id);
		},
	};
	const api = {
		startGooglePhotosImport: () => start,
		getGooglePhotosImport: () => typeof get === 'function' ? get() : get,
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
		timerDelays,
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

test('polling uses the newest backend interval for the next check', async () => {
	const fixture = setup({
		start: Promise.resolve({ data: importJob({ pollIntervalMs: 1234 }) }),
		get: Promise.resolve({ data: importJob({ pollIntervalMs: 5678 }) }),
	});
	await fixture.lifecycle.start(ACCOUNT);
	await fixture.runTimer();

	assert.deepEqual(fixture.timerDelays, [1234, 5678]);
});

test('a stale waiting poll after Picker autoclose does not cancel a selected import', async () => {
	const stale = deferred();
	let pollCount = 0;
	const fixture = setup({
		get: () => {
			pollCount += 1;
			return pollCount === 1
				? stale.promise
				: Promise.resolve({ data: importJob({ status: 'importing', total: 1 }) });
		},
	});
	await fixture.lifecycle.start(ACCOUNT);
	const firstPoll = fixture.runTimer();
	await Promise.resolve();
	fixture.windows[0].closed = true;
	stale.resolve({ data: importJob() });
	await firstPoll;

	assert.deepEqual(fixture.cancellations, []);
	await fixture.runTimer();
	assert.deepEqual(fixture.cancellations, []);
	assert.equal(fixture.updates.at(-1).value.status, 'importing');
});

test('two consecutive closed-window waiting polls cancel an abandoned Picker', async () => {
	const fixture = setup();
	await fixture.lifecycle.start(ACCOUNT);
	fixture.windows[0].closed = true;

	await fixture.runTimer();
	assert.deepEqual(fixture.cancellations, []);
	await fixture.runTimer();

	assert.deepEqual(fixture.cancellations, ['import-1']);
	assert.equal(fixture.updates.at(-1).value.status, 'cancelled');
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

test('dispose cancels waiting selection but keeps an importing job running', async () => {
	const waiting = setup();
	await waiting.lifecycle.start(ACCOUNT);
	waiting.lifecycle.dispose();
	assert.deepEqual(waiting.cancellations, ['import-1']);

	const importing = setup({ start: Promise.resolve({ data: importJob({ status: 'importing' }) }) });
	await importing.lifecycle.start(ACCOUNT);
	importing.lifecycle.dispose();
	assert.deepEqual(importing.cancellations, []);
	assert.equal(importing.sockets[0].closeCalls, 1);
	assert.equal(importing.windows[0].closed, true);
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

test('terminal summaries include every failed file name and sanitized message', () => {
	const messages = {
		partial: ({ completed, failed }) => `Imported ${completed}; ${failed} failed.`,
		failed: () => 'Import failed.',
	};
	const errors = [
		{ fileName: 'family.jpg', message: 'Storage quota exceeded' },
		{ fileName: 'holiday.mp4', message: 'Rate limit exceeded' },
	];

	assert.equal(
		getGooglePhotosImportSummary(importJob({
			status: 'completed_with_errors', completed: 1, failed: 2, errors,
		}), messages),
		'Imported 1; 2 failed.\nfamily.jpg: Storage quota exceeded\nholiday.mp4: Rate limit exceeded',
	);
	assert.equal(
		getGooglePhotosImportSummary(importJob({ status: 'failed', failed: 2, errors }), messages),
		'family.jpg: Storage quota exceeded\nholiday.mp4: Rate limit exceeded',
	);
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
