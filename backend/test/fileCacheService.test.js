import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';

const { createFileCacheService } = await import('../src/services/fileCacheService.js');

const file = {
	user_id: 'u1',
	cloud_account_id: 'account-1',
	remote_file_id: 'remote-1',
	file_name: 'direct.jpg',
	virtual_path: '/Fotos/',
	size: 10,
	remote_modified_time: '2026-08-02T00:00:00Z',
};

async function read(stream) {
	const chunks = [];
	for await (const chunk of stream) chunks.push(chunk);
	return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString();
}

async function waitFor(predicate) {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		if (predicate()) return;
		await new Promise((resolve) => setImmediate(resolve));
	}
	assert.fail('timed out waiting for background work');
}

function createStore({ cached = false, write } = {}) {
	return {
		async getValidPath() { return cached ? '/cache/file' : null; },
		async openReadStream() { return cached ? Readable.from(['cached']) : null; },
		async writeFromStream(currentFile, stream) {
			await read(stream);
			await write?.(currentFile);
		},
		async invalidate() {},
		async rebind() { return true; },
		async reconcile() {},
		captureUpload(stream, uploadId) { return { stream, uploadId }; },
		async commitCapture() { return true; },
		async cleanupTemps() {},
	};
}

function createAdapter({ body = 'remote-now', getStream } = {}) {
	return {
		downloadCalls: 0,
		async getDownloadStream(currentFile, range) {
			this.downloadCalls += 1;
			return getStream ? getStream(currentFile, range) : Readable.from([body]);
		},
	};
}

test('two warm requests for one version share one provider download', async () => {
	const adapter = createAdapter();
	const cache = createFileCacheService({ store: createStore(), concurrency: 1 });

	await Promise.all([
		cache.warmFile({ userId: 'u1', file, adapter }),
		cache.warmFile({ userId: 'u1', file, adapter }),
	]);

	assert.equal(adapter.downloadCalls, 1);
});

test('folder warming returns immediately and ignores folders and descendants', () => {
	const scheduledNames = [];
	const files = [
		file,
		{ ...file, file_name: 'folder', is_folder: 1 },
		{ ...file, file_name: 'nested.jpg', virtual_path: '/Fotos/sub/' },
	];
	const cache = createFileCacheService({ store: createStore() });
	const adapterFor = (currentFile) => {
		scheduledNames.push(currentFile.file_name);
		return createAdapter();
	};

	assert.equal(cache.warmFolder({ userId: 'u1', virtualPath: '/Fotos/', files, adapterFor }), true);
	assert.deepEqual(scheduledNames, ['direct.jpg']);
});

test('files without binary content are never downloaded', async () => {
	const adapter = createAdapter({ getStream: () => { throw new Error('provider called for google doc'); } });
	const cache = createFileCacheService({ store: createStore() });

	await cache.warmFile({
		userId: 'u1',
		file: { ...file, size: 0, mime_type: 'application/vnd.google-apps.document' },
		adapter,
	});

	assert.equal(adapter.downloadCalls, 0);
});

test('folder marker expires after one hour', () => {
	let now = 0;
	const input = {
		userId: 'u1',
		virtualPath: '/Fotos/',
		files: [],
		adapterFor: () => createAdapter(),
	};
	const cache = createFileCacheService({ store: createStore(), now: () => now, warmTtlMs: 3_600_000 });

	assert.equal(cache.warmFolder(input), true);
	assert.equal(cache.warmFolder(input), false);
	now += 3_600_001;
	assert.equal(cache.warmFolder(input), true);
});

test('shared folders use independent markers and trust their returned direct children', () => {
	const scheduled = [];
	const cache = createFileCacheService({ store: createStore() });
	const input = (folderScope, remoteId) => ({
		userId: 'u1',
		folderScope,
		directChildren: true,
		files: [{ ...file, virtual_path: undefined, remote_file_id: remoteId }],
		adapterFor(currentFile) {
			scheduled.push(currentFile.remote_file_id);
			return createAdapter();
		},
	});

	assert.equal(cache.warmFolder(input('shared:folder-1', 'child-1')), true);
	assert.equal(cache.warmFolder(input('shared:folder-1', 'child-1')), false);
	assert.equal(cache.warmFolder(input('shared:folder-2', 'child-2')), true);
	assert.deepEqual(scheduled, ['child-1', 'child-2']);
});

test('cache miss returns remote stream without waiting for background warming', async () => {
	let releaseWarm;
	const adapter = createAdapter({
		getStream: () => Readable.from(['remote-now']),
	});
	const store = createStore({
		write: () => new Promise((resolve) => { releaseWarm = resolve; }),
	});
	const cache = createFileCacheService({ store });

	const opened = await cache.openFile({ userId: 'u1', file, adapter });
	assert.equal(opened.cached, false);
	assert.equal(await read(opened.stream), 'remote-now');
	releaseWarm();
});

test('cache hit never calls the adapter', async () => {
	const adapter = createAdapter({ getStream: () => { throw new Error('cache hit opened provider'); } });
	const cache = createFileCacheService({ store: createStore({ cached: true }) });

	const opened = await cache.openFile({ userId: 'u1', file, adapter });
	assert.equal(opened.cached, true);
	assert.equal(await read(opened.stream), 'cached');
	assert.equal(adapter.downloadCalls, 0);
});

test('queue never exceeds configured concurrency', async () => {
	let active = 0;
	let maximum = 0;
	const releases = [];
	const cache = createFileCacheService({
		concurrency: 2,
		store: createStore({
			write: () => new Promise((resolve) => {
				active += 1;
				maximum = Math.max(maximum, active);
				releases.push(() => { active -= 1; resolve(); });
			}),
		}),
	});

	const warming = [0, 1, 2].map((index) => cache.warmFile({
		userId: 'u1',
		file: { ...file, remote_file_id: `remote-${index}` },
		adapter: createAdapter(),
	}));
	await waitFor(() => releases.length === 2);
	assert.equal(maximum, 2);
	releases.shift()();
	await waitFor(() => releases.length === 2);
	releases.splice(0).forEach((release) => release());
	await Promise.all(warming);
	assert.equal(maximum, 2);
});

test('background warming logs failures without an unhandled rejection', async () => {
	const errors = [];
	const unhandled = [];
	const onUnhandled = (reason) => unhandled.push(reason);
	process.on('unhandledRejection', onUnhandled);
	try {
		const cache = createFileCacheService({
			store: createStore(),
			logger: { error(...args) { errors.push(args); } },
		});
		cache.warmFolder({ userId: 'u1', virtualPath: '/Fotos/', files: [file], adapterFor: () => createAdapter({
			getStream: () => { throw new Error('provider failed'); },
		}) });

		await waitFor(() => errors.length === 1);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(errors[0][0], 'File cache warm failed:');
		assert.equal(unhandled.length, 0);
	} finally {
		process.off('unhandledRejection', onUnhandled);
	}
});

test('reconciliation clears warmed-folder markers', async () => {
	const cache = createFileCacheService({ store: createStore() });
	const input = { userId: 'u1', virtualPath: '/Fotos/', files: [], adapterFor: () => createAdapter() };

	assert.equal(cache.warmFolder(input), true);
	assert.equal(cache.warmFolder(input), false);
	await cache.reconcileAccount([file], [file]);
	assert.equal(cache.warmFolder(input), true);
});
