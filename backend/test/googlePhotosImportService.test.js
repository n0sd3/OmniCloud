import assert from 'node:assert/strict';
import { PassThrough, Readable } from 'node:stream';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';

process.env.GOOGLE_CLIENT_ID = 'google-client-id-for-test';
process.env.GOOGLE_CLIENT_SECRET = 'google-client-secret-for-test';
process.env.GOOGLE_REDIRECT_URI = 'http://localhost:8787/api/accounts/google/callback';
process.env.DATABASE_PATH = path.join(os.tmpdir(), `omnicloud-google-photos-${process.pid}.db`);
process.env.APP_MODE = 'local';

const { createGoogleAuthorizationRequest } = await import('../src/services/googleOAuthService.js');
const { GoogleDriveAdapter } = await import('../src/adapters/GoogleDriveAdapter.js');
const {
	buildGooglePhotosImportPath,
	allocateDuplicateNames,
	createGooglePhotosImportService,
} = await import('../src/services/googlePhotosImportService.js');

function createTestService({
	request,
	runImport,
	adapter,
	emitEvent,
	sync,
	markStatus,
	setTimer,
	terminalJobTtlMs,
	now = () => 0,
	account = {
		id: 'drive-1',
		user_id: 'u1',
		provider: 'google_drive',
		status: 'active',
		email: 'usuario@gmail.com',
		credentials: {
			scope: 'https://www.googleapis.com/auth/photospicker.mediaitems.readonly',
		},
	},
} = {}) {
	return createGooglePhotosImportService({
		getAccount: () => account,
		createAdapter: () => adapter || ({ createOAuthClient: () => ({ request }) }),
		runImport,
		emitEvent,
		sync,
		markStatus,
		setTimer,
		terminalJobTtlMs,
		now,
	});
}

function mediaItem(id, filename, mimeType, type = 'PHOTO') {
	return {
		id,
		type,
		mediaFile: {
			baseUrl: `https://lh3.googleusercontent.com/${id}`,
			filename,
			mimeType,
			mediaFileMetadata: { width: 100, height: 100 },
		},
	};
}

function readyPickerRequest(items, download) {
	return (options) => {
		if (options.method === 'POST') return Promise.resolve({ data: {
			id: 'picker-1', pickerUri: 'https://photos.google.com/picker/abc',
			pollingConfig: { pollInterval: '3s', timeoutIn: '180s' },
		} });
		if (options.method === 'DELETE') return Promise.resolve({ data: {} });
		if (options.url.endsWith('/sessions/picker-1')) return Promise.resolve({ data: { mediaItemsSet: true } });
		if (options.url.endsWith('/mediaItems')) return Promise.resolve({ data: { mediaItems: items } });
		return download(options);
	};
}

async function waitForJob(service, importId, predicate = (job) => job.status !== 'importing') {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const job = await service.get('u1', importId);
		if (predicate(job)) return job;
		await new Promise((resolve) => setImmediate(resolve));
	}
	throw new Error('Timed out waiting for Google Photos import');
}

async function waitTurns(count = 5) {
	for (let turn = 0; turn < count; turn += 1) {
		await new Promise((resolve) => setImmediate(resolve));
	}
}

async function settleWithin(promise, timeoutMs = 250) {
	let timer;
	try {
		return await Promise.race([
			promise,
			new Promise((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error('Timed out waiting for promise settlement')), timeoutMs);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

test('Google authorization asks for Picker access together with Drive access', () => {
	const { authorizationUrl } = createGoogleAuthorizationRequest('user-1');
	const scope = new URL(authorizationUrl).searchParams.get('scope').split(' ');

	assert.ok(scope.includes('https://www.googleapis.com/auth/drive'));
	assert.ok(scope.includes('https://www.googleapis.com/auth/photospicker.mediaitems.readonly'));
});

test('Drive adapter returns every name across destination-folder pages', async () => {
	const adapter = Object.create(GoogleDriveAdapter.prototype);
	const pageTokens = [];
	adapter.getDriveClient = async () => ({
		files: { list: async ({ pageToken }) => {
			pageTokens.push(pageToken);
			return pageToken
				? { data: { files: [{ name: 'video.mp4' }] } }
				: { data: { files: [{ name: 'foto.jpg' }], nextPageToken: 'page-2' } };
		} },
	});

	assert.deepEqual(await adapter.listFileNames('folder-1'), ['foto.jpg', 'video.mp4']);
	assert.deepEqual(pageTokens, [undefined, 'page-2']);
});

test('Drive adapter forwards an abort signal to the active upload request', async () => {
	const adapter = Object.create(GoogleDriveAdapter.prototype);
	let requestOptions;
	adapter.getDriveClient = async () => ({
		files: { create: async (_request, options) => {
			requestOptions = options;
			return { data: { id: 'uploaded-1', parents: ['folder-1'] } };
		} },
	});
	const controller = new AbortController();

	await adapter.uploadStream({
		stream: Readable.from(['bytes']),
		fileName: 'photo.jpg',
		mimeType: 'image/jpeg',
		remoteParentId: 'folder-1',
		onProgress: () => {},
		signal: controller.signal,
	});

	assert.equal(requestOptions.signal, controller.signal);
});

test('Drive adapter rejects promptly and tears down both streams when the source fails mid-upload', async () => {
	const adapter = Object.create(GoogleDriveAdapter.prototype);
	let uploadBody;
	adapter.getDriveClient = async () => ({
		files: { create: async ({ media }) => {
			uploadBody = media.body;
			for await (const _chunk of uploadBody) { /* consume the real upload body */ }
			return { data: { id: 'must-not-complete' } };
		} },
	});
	let emitted = false;
	const source = new Readable({
		read() {
			if (emitted) return;
			emitted = true;
			this.push('partial bytes');
			queueMicrotask(() => this.destroy(new Error('Photos source failed')));
		},
	});
	// A bare pipe does not forward source errors and would otherwise make this an uncaught exception.
	source.on('error', () => {});

	await assert.rejects(
		settleWithin(adapter.uploadStream({
			stream: source,
			fileName: 'photo.jpg',
			mimeType: 'image/jpeg',
			remoteParentId: 'folder-1',
			onProgress: () => {},
		})),
		/Photos source failed/,
	);
	assert.equal(source.destroyed, true);
	assert.equal(uploadBody.destroyed, true);
});

test('Drive adapter tears down the source and body when Drive rejects an upload', async () => {
	const adapter = Object.create(GoogleDriveAdapter.prototype);
	let uploadBody;
	adapter.getDriveClient = async () => ({
		files: { create: async ({ media }) => {
			uploadBody = media.body;
			throw new Error('Drive upload failed');
		} },
	});
	const source = new PassThrough();
	source.on('error', () => {});
	source.write('partial bytes');

	await assert.rejects(adapter.uploadStream({
		stream: source,
		fileName: 'photo.jpg',
		mimeType: 'image/jpeg',
		remoteParentId: 'folder-1',
		onProgress: () => {},
	}), /Drive upload failed/);
	assert.equal(source.destroyed, true);
	assert.equal(uploadBody.destroyed, true);
});

test('builds the fixed folder from the email local part', () => {
	assert.equal(buildGooglePhotosImportPath('usuario@gmail.com'), '/OmniCloud/Google Fotos/usuario/');
});

test('allocates extension-aware names for existing and batch duplicates', () => {
	assert.deepEqual(
		allocateDuplicateNames(['foto.jpg', 'foto.jpg', 'arquivo'], ['foto.jpg', 'arquivo']),
		['foto (2).jpg', 'foto (3).jpg', 'arquivo (2)'],
	);
});

test('start rejects another provider before contacting Google', async () => {
	const service = createGooglePhotosImportService({
		getAccount: () => ({ id: 'a1', user_id: 'u1', provider: 'dropbox' }),
		createAdapter: () => { throw new Error('must not run'); },
	});

	await assert.rejects(service.start('u1', 'a1'), /Google Drive account is required/);
});

test('start rejects an inactive Google Drive account before contacting Google', async () => {
	const service = createTestService({
		account: {
			id: 'drive-1', user_id: 'u1', provider: 'google_drive', status: 'invalid_token',
			credentials: { scope: 'https://www.googleapis.com/auth/photospicker.mediaitems.readonly' },
		},
		request: () => { throw new Error('must not run'); },
	});

	await assert.rejects(service.start('u1', 'drive-1'), /must be active/);
});

test('start rejects a scope that only contains the Picker scope as a substring', async () => {
	const service = createTestService({
		account: {
			id: 'drive-1', user_id: 'u1', provider: 'google_drive', status: 'active',
			credentials: { scope: 'https://www.googleapis.com/auth/photospicker.mediaitems.readonly.extra' },
		},
		request: () => { throw new Error('must not run'); },
	});

	await assert.rejects(service.start('u1', 'drive-1'), /requires reconnecting/);
});

test('start creates a sanitized waiting job from the Picker session', async () => {
	const request = async () => ({ data: {
		id: 'picker-1', pickerUri: 'https://photos.google.com/picker/abc',
		pollingConfig: { pollInterval: '3s', timeoutIn: '180s' },
	} });
	const service = createTestService({ request });
	const job = await service.start('u1', 'drive-1');

	assert.deepEqual(job, {
		id: job.id, accountId: 'drive-1', status: 'waiting_for_selection',
		pickerUri: 'https://photos.google.com/picker/abc', pollIntervalMs: 3000,
		total: 0, completed: 0, failed: 0, errors: [],
	});
});

test('start replaces URL and token-bearing Google errors with a controlled message', async () => {
	const marked = [];
	const service = createTestService({
		request: async () => {
			throw { response: { data: { error: {
				message: 'GET https://photos.example/picker?access_token=secret-token',
			} } } };
		},
		markStatus: (...args) => marked.push(args),
	});

	await assert.rejects(
		service.start('u1', 'drive-1'),
		(error) => error.message === 'Google Photos Picker request failed',
	);
	assert.deepEqual(marked, []);
});

test('start marks the account invalid for a sanitized Picker OAuth failure', async () => {
	const marked = [];
	const service = createTestService({
		request: async () => {
			throw Object.assign(new Error('access_token secret-token'), { status: 401 });
		},
		markStatus: (...args) => marked.push(args),
	});

	await assert.rejects(
		service.start('u1', 'drive-1'),
		(error) => error.message === 'Google Photos Picker request failed',
	);
	assert.deepEqual(marked, [['u1', 'drive-1', 'invalid_token']]);
});

test('refresh lists every Picker page before marking the job importing', async () => {
	const requests = [];
	const operations = [];
	const request = async (options) => {
		requests.push(options);
		if (options.method === 'POST') return { data: {
			id: 'picker-1', pickerUri: 'https://photos.google.com/picker/abc',
			pollingConfig: { pollInterval: '3s', timeoutIn: '180s' },
		} };
		if (options.url.endsWith('/sessions/picker-1')) return { data: { mediaItemsSet: true } };
		if (!options.params.pageToken) {
			operations.push('page one');
			return { data: { mediaItems: [{ id: 'one' }], nextPageToken: 'next' } };
		}
		operations.push('page two');
		return { data: { mediaItems: [{ id: 'two' }] } };
	};
	const service = createTestService({ request, runImport: async () => operations.push('import') });
	const job = await service.start('u1', 'drive-1');
	const refreshed = await service.refresh('u1', job.id);

	assert.equal(refreshed.status, 'importing');
	assert.equal(refreshed.total, 2);
	assert.deepEqual(requests.slice(-2).map((options) => options.params.pageToken || null), [null, 'next']);
	assert.deepEqual(operations, ['page one', 'page two', 'import']);
});

test('page-two failure returns a sanitized terminal job, cleans up, and expires it', async () => {
	const uploaded = [];
	const marked = [];
	const requests = [];
	let evict;
	let evictionDelay;
	const request = async (options) => {
		requests.push(options);
		if (options.method === 'POST') return { data: {
			id: 'picker-1', pickerUri: 'https://photos.google.com/picker/abc',
			pollingConfig: { pollInterval: '3s', timeoutIn: '180s' },
		} };
		if (options.method === 'DELETE') return { data: {} };
		if (options.url.endsWith('/sessions/picker-1')) return { data: { mediaItemsSet: true } };
		if (!options.params.pageToken) return { data: { mediaItems: [{ id: 'one' }], nextPageToken: 'next' } };
		throw new Error('second page unavailable at https://photos.example/media?access_token=secret');
	};
	const service = createTestService({
		request,
		runImport: async () => uploaded.push('file'),
		markStatus: (...args) => marked.push(args),
		terminalJobTtlMs: 4321,
		setTimer: (callback, delay) => {
			evict = callback;
			evictionDelay = delay;
			return { unref() {} };
		},
	});
	const job = await service.start('u1', 'drive-1');

	const failed = await service.refresh('u1', job.id);
	assert.deepEqual(uploaded, []);
	assert.equal(failed.status, 'failed');
	assert.equal(failed.pickerUri, null);
	assert.equal(failed.total, 0);
	assert.deepEqual(failed.errors, ['Google Photos Picker request failed']);
	assert.deepEqual(marked, []);
	assert.equal(requests.filter((options) => options.method === 'DELETE').length, 1);
	assert.equal(evictionDelay, 4321);
	assert.deepEqual(await service.get('u1', job.id), failed);

	evict();
	await assert.rejects(service.get('u1', job.id), /not found/);
});

test('refresh returns a terminal job and marks invalid_token on Picker 401', async () => {
	const marked = [];
	const requests = [];
	const request = async (options) => {
		requests.push(options);
		if (options.method === 'POST') return { data: {
			id: 'picker-1', pickerUri: 'https://photos.google.com/picker/abc',
			pollingConfig: { pollInterval: '3s', timeoutIn: '180s' },
		} };
		if (options.method === 'DELETE') return { data: {} };
		throw Object.assign(new Error('invalid access_token secret'), { status: 401 });
	};
	const service = createTestService({
		request,
		markStatus: (...args) => marked.push(args),
	});
	const job = await service.start('u1', 'drive-1');

	const failed = await service.refresh('u1', job.id);

	assert.equal(failed.status, 'failed');
	assert.deepEqual(failed.errors, ['Google Photos Picker request failed']);
	assert.deepEqual(marked, [['u1', 'drive-1', 'invalid_token']]);
	assert.equal(requests.filter((options) => options.method === 'DELETE').length, 1);
});

test('refresh adopts updated Picker polling interval and timeout', async () => {
	const requests = [];
	let currentTime = 0;
	const request = async (options) => {
		requests.push(options);
		if (options.method === 'POST') return { data: {
			id: 'picker-1', pickerUri: 'https://photos.google.com/picker/abc',
			pollingConfig: { pollInterval: '1s', timeoutIn: '60s' },
		} };
		if (options.method === 'DELETE') return { data: {} };
		return { data: {
			mediaItemsSet: false,
			pollingConfig: { pollInterval: '7s', timeoutIn: '2s' },
		} };
	};
	const service = createTestService({ request, now: () => currentTime });
	const job = await service.start('u1', 'drive-1');
	currentTime = 5000;

	const refreshed = await service.refresh('u1', job.id);
	assert.equal(refreshed.pollIntervalMs, 7000);

	currentTime = 7001;
	assert.equal((await service.refresh('u1', job.id)).status, 'cancelled');
	assert.equal(requests.filter((options) => options.url?.endsWith('/sessions/picker-1') && !options.method).length, 1);
});

test('concurrent refreshes invoke the import callback only once', async () => {
	let imports = 0;
	const request = async (options) => {
		if (options.method === 'POST') return { data: {
			id: 'picker-1', pickerUri: 'https://photos.google.com/picker/abc',
			pollingConfig: { pollInterval: '3s', timeoutIn: '180s' },
		} };
		if (options.url.endsWith('/sessions/picker-1')) return { data: { mediaItemsSet: true } };
		return { data: { mediaItems: [{ id: 'one' }] } };
	};
	const service = createTestService({ request, runImport: async () => { imports += 1; } });
	const job = await service.start('u1', 'drive-1');

	await Promise.all([service.refresh('u1', job.id), service.refresh('u1', job.id)]);
	assert.equal(imports, 1);
});

test('cancel wins over a refresh already waiting on Picker', async () => {
	let releaseSession;
	const sessionResponse = new Promise((resolve) => { releaseSession = resolve; });
	let imports = 0;
	const request = async (options) => {
		if (options.method === 'POST') return { data: {
			id: 'picker-1', pickerUri: 'https://photos.google.com/picker/abc',
			pollingConfig: { pollInterval: '3s', timeoutIn: '180s' },
		} };
		if (options.method === 'DELETE') return { data: {} };
		if (options.url.endsWith('/sessions/picker-1')) return sessionResponse;
		return { data: { mediaItems: [{ id: 'one' }] } };
	};
	const service = createTestService({ request, runImport: async () => { imports += 1; } });
	const job = await service.start('u1', 'drive-1');
	const refresh = service.refresh('u1', job.id);
	await Promise.resolve();
	await service.cancel('u1', job.id);
	releaseSession({ data: { mediaItemsSet: true } });

	assert.equal((await refresh).status, 'cancelled');
	assert.equal(imports, 0);
});

test('cancel during Picker pagination returns cancelled without requesting a later page', async () => {
	let releaseFirstPage;
	let firstPageStarted;
	const firstPage = new Promise((resolve) => { releaseFirstPage = resolve; });
	const pageStarted = new Promise((resolve) => { firstPageStarted = resolve; });
	let pageRequests = 0;
	const request = async (options) => {
		if (options.method === 'POST') return { data: {
			id: 'picker-1', pickerUri: 'https://photos.google.com/picker/abc',
			pollingConfig: { pollInterval: '3s', timeoutIn: '180s' },
		} };
		if (options.method === 'DELETE') return { data: {} };
		if (options.url.endsWith('/sessions/picker-1')) return { data: { mediaItemsSet: true } };
		pageRequests += 1;
		firstPageStarted();
		return firstPage;
	};
	const service = createTestService({ request, runImport: async () => { throw new Error('must not import'); } });
	const started = await service.start('u1', 'drive-1');
	const refresh = service.refresh('u1', started.id);
	await pageStarted;

	await service.cancel('u1', started.id);
	releaseFirstPage({ data: { mediaItems: [{ id: 'one' }], nextPageToken: 'next' } });

	assert.equal((await refresh).status, 'cancelled');
	assert.equal(pageRequests, 1);
});

test('timeout cancels the Picker session', async () => {
	const requests = [];
	let currentTime = 0;
	const request = async (options) => {
		requests.push(options);
		if (options.method === 'POST') return { data: {
			id: 'picker-1', pickerUri: 'https://photos.google.com/picker/abc',
			pollingConfig: { pollInterval: '3s', timeoutIn: '3s' },
		} };
		return { data: { mediaItemsSet: false } };
	};
	const service = createTestService({ request, now: () => currentTime });
	const job = await service.start('u1', 'drive-1');
	currentTime = 3001;

	assert.equal((await service.refresh('u1', job.id)).status, 'cancelled');
	assert.deepEqual(requests.at(-1), {
		method: 'DELETE', url: 'https://photospicker.googleapis.com/v1/sessions/picker-1',
	});
});

test('cancel deletes the Picker session once and returns cancelled', async () => {
	const requests = [];
	const request = async (options) => {
		requests.push(options);
		if (options.method === 'POST') return { data: {
			id: 'picker-1', pickerUri: 'https://photos.google.com/picker/abc',
			pollingConfig: { pollInterval: '3s', timeoutIn: '180s' },
		} };
		return { data: {} };
	};
	const service = createTestService({ request });
	const job = await service.start('u1', 'drive-1');

	assert.equal((await service.cancel('u1', job.id)).status, 'cancelled');
	await service.cancel('u1', job.id);
	assert.equal(requests.filter((options) => options.method === 'DELETE').length, 1);
});

test('cancel exposes a controlled error when Picker deletion returns a token-bearing URL', async () => {
	const request = async (options) => {
		if (options.method === 'POST') return { data: {
			id: 'picker-1', pickerUri: 'https://photos.google.com/picker/abc',
			pollingConfig: { pollInterval: '3s', timeoutIn: '180s' },
		} };
		throw { response: { data: { error: {
			message: 'DELETE https://photos.example/session?token=secret-token',
		} } } };
	};
	const service = createTestService({ request });
	const job = await service.start('u1', 'drive-1');

	assert.deepEqual((await service.cancel('u1', job.id)).errors, ['Google Photos Picker request failed']);
});

test('imports best available Picker image and video renditions with no more than two active transfers', async () => {
	const items = [
		mediaItem('photo-one', 'photo.jpg', 'image/jpeg'),
		mediaItem('video-one', 'clip.mp4', 'video/mp4', 'VIDEO'),
		mediaItem('photo-two', 'photo.jpg', 'image/jpeg'),
	];
	const downloadRequests = [];
	const uploads = [];
	const releases = [];
	let active = 0;
	let maxActive = 0;
	let syncs = 0;
	const request = readyPickerRequest(items, async (options) => {
		downloadRequests.push(options);
		return { data: Readable.from([Buffer.from(options.url)]) };
	});
	const adapter = {
		createOAuthClient: () => ({ request }),
		ensureRemotePath: async () => 'folder-1',
		listFileNames: async () => ['photo.jpg'],
		uploadStream: async (options) => {
			active += 1;
			maxActive = Math.max(maxActive, active);
			let bytes = 0;
			for await (const chunk of options.stream) bytes += chunk.length;
			uploads.push({ ...options, stream: undefined });
			await new Promise((resolve) => releases.push(resolve));
			active -= 1;
			return { size: bytes };
		},
	};
	const service = createTestService({ adapter, sync: async () => { syncs += 1; } });
	const started = await service.start('u1', 'drive-1');

	assert.equal((await service.refresh('u1', started.id)).status, 'importing');
	await waitForJob(service, started.id, () => uploads.length === 2);
	assert.equal(maxActive, 2);
	assert.equal(uploads.length, 2);

	releases.shift()();
	await waitForJob(service, started.id, () => uploads.length === 3);
	for (const release of releases.splice(0)) release();
	const completed = await waitForJob(service, started.id);

	assert.equal(completed.status, 'completed');
	assert.equal(completed.completed, 3);
	assert.equal(completed.failed, 0);
	assert.equal(maxActive, 2);
	assert.equal(syncs, 1);
	assert.deepEqual(downloadRequests.map(({ url, responseType }) => ({ url, responseType })), [
		{ url: 'https://lh3.googleusercontent.com/photo-one=d', responseType: 'stream' },
		{ url: 'https://lh3.googleusercontent.com/video-one=dv', responseType: 'stream' },
		{ url: 'https://lh3.googleusercontent.com/photo-two=d', responseType: 'stream' },
	]);
	assert.deepEqual(uploads.map(({ fileName, mimeType, virtualPath, remoteParentId }) => ({
		fileName, mimeType, virtualPath, remoteParentId,
	})), [
		{
			fileName: 'photo (2).jpg', mimeType: 'image/jpeg',
			virtualPath: '/OmniCloud/Google Fotos/usuario/', remoteParentId: 'folder-1',
		},
		{
			fileName: 'clip.mp4', mimeType: 'video/mp4',
			virtualPath: '/OmniCloud/Google Fotos/usuario/', remoteParentId: 'folder-1',
		},
		{
			fileName: 'photo (3).jpg', mimeType: 'image/jpeg',
			virtualPath: '/OmniCloud/Google Fotos/usuario/', remoteParentId: 'folder-1',
		},
	]);
});

test('the service-wide scheduler caps concurrent transfers at two across jobs', async () => {
	const accounts = new Map(['drive-a', 'drive-b'].map((id) => [id, {
		id,
		user_id: 'u1',
		provider: 'google_drive',
		status: 'active',
		email: `${id}@gmail.com`,
		credentials: { scope: 'https://www.googleapis.com/auth/photospicker.mediaitems.readonly' },
	}]));
	const releases = [];
	let active = 0;
	let maxActive = 0;
	let uploads = 0;
	const service = createGooglePhotosImportService({
		getAccount: (_userId, accountId) => accounts.get(accountId),
		createAdapter: (account) => {
			const pickerId = `${account.id}-picker`;
			const items = [
				mediaItem(`${account.id}-one`, `${account.id}-one.jpg`, 'image/jpeg'),
				mediaItem(`${account.id}-two`, `${account.id}-two.jpg`, 'image/jpeg'),
			];
			const request = async (options) => {
				if (options.method === 'POST') return { data: {
					id: pickerId,
					pickerUri: `https://photos.google.com/picker/${account.id}`,
					pollingConfig: { pollInterval: '1s', timeoutIn: '60s' },
				} };
				if (options.method === 'DELETE') return { data: {} };
				if (options.url.endsWith(`/sessions/${pickerId}`)) return { data: { mediaItemsSet: true } };
				if (options.url.endsWith('/mediaItems')) return { data: { mediaItems: items } };
				return { data: Readable.from(['bytes']) };
			};
			return {
				createOAuthClient: () => ({ request }),
				ensureRemotePath: async () => `${account.id}-folder`,
				listFileNames: async () => [],
				uploadStream: async ({ stream }) => {
					for await (const _chunk of stream) { /* consume the real stream */ }
					active += 1;
					uploads += 1;
					maxActive = Math.max(maxActive, active);
					await new Promise((resolve) => releases.push(resolve));
					active -= 1;
					return { size: 5 };
				},
			};
		},
		sync: async () => {},
	});
	const [first, second] = await Promise.all([
		service.start('u1', 'drive-a'),
		service.start('u1', 'drive-b'),
	]);

	await Promise.all([service.refresh('u1', first.id), service.refresh('u1', second.id)]);
	await waitForJob(service, first.id, () => uploads >= 2);
	for (const release of releases.splice(0)) release();
	await waitForJob(service, first.id, () => uploads === 4);
	for (const release of releases.splice(0)) release();
	await Promise.all([
		waitForJob(service, first.id),
		waitForJob(service, second.id),
	]);

	assert.equal(maxActive, 2);
});

test('same-account jobs serialize duplicate-name allocation', async () => {
	const storedNames = new Set();
	const uploads = [];
	let listCalls = 0;
	let uploadCalls = 0;
	let releaseFirstUpload;
	let firstUploadStarted;
	const firstStarted = new Promise((resolve) => { firstUploadStarted = resolve; });
	let pickerNumber = 0;
	const request = async (options) => {
		if (options.method === 'POST') {
			pickerNumber += 1;
			return { data: {
				id: `picker-${pickerNumber}`,
				pickerUri: `https://photos.google.com/picker/${pickerNumber}`,
				pollingConfig: { pollInterval: '1s', timeoutIn: '60s' },
			} };
		}
		if (options.method === 'DELETE') return { data: {} };
		if (options.url.includes('/sessions/')) return { data: { mediaItemsSet: true } };
		if (options.url.endsWith('/mediaItems')) {
			return { data: { mediaItems: [mediaItem('same-photo', 'foto.jpg', 'image/jpeg')] } };
		}
		return { data: Readable.from(['bytes']) };
	};
	const adapter = {
		createOAuthClient: () => ({ request }),
		ensureRemotePath: async () => 'folder-1',
		listFileNames: async () => {
			listCalls += 1;
			return [...storedNames];
		},
		uploadStream: async ({ fileName, stream }) => {
			for await (const _chunk of stream) { /* consume the real stream */ }
			uploadCalls += 1;
			uploads.push(fileName);
			if (uploadCalls === 1) {
				firstUploadStarted();
				await new Promise((resolve) => { releaseFirstUpload = resolve; });
			}
			storedNames.add(fileName);
			return { size: 5 };
		},
	};
	const service = createTestService({ adapter, sync: async () => {} });
	const [first, second] = await Promise.all([
		service.start('u1', 'drive-1'),
		service.start('u1', 'drive-1'),
	]);
	await service.refresh('u1', first.id);
	await firstStarted;
	await service.refresh('u1', second.id);
	await waitTurns();
	const callsBeforeFirstCompleted = listCalls;

	releaseFirstUpload();
	await Promise.all([
		waitForJob(service, first.id),
		waitForJob(service, second.id),
	]);

	assert.equal(callsBeforeFirstCompleted, 1);
	assert.deepEqual(uploads, ['foto.jpg', 'foto (2).jpg']);
});

test('cancelling a job queued behind the same account settles without waiting for the active job', async () => {
	let pickerNumber = 0;
	let uploadCalls = 0;
	let releaseFirstUpload;
	let firstUploadStarted;
	const firstStarted = new Promise((resolve) => { firstUploadStarted = resolve; });
	const request = async (options) => {
		if (options.method === 'POST') {
			pickerNumber += 1;
			return { data: {
				id: `picker-${pickerNumber}`,
				pickerUri: `https://photos.google.com/picker/${pickerNumber}`,
				pollingConfig: { pollInterval: '1s', timeoutIn: '60s' },
			} };
		}
		if (options.method === 'DELETE') return { data: {} };
		if (options.url.includes('/sessions/')) return { data: { mediaItemsSet: true } };
		if (options.url.endsWith('/mediaItems')) {
			return { data: { mediaItems: [mediaItem('queued-photo', 'foto.jpg', 'image/jpeg')] } };
		}
		return { data: Readable.from(['bytes']) };
	};
	const adapter = {
		createOAuthClient: () => ({ request }),
		ensureRemotePath: async () => 'folder-1',
		listFileNames: async () => [],
		uploadStream: async ({ stream }) => {
			for await (const _chunk of stream) { /* consume the real stream */ }
			uploadCalls += 1;
			if (uploadCalls === 1) {
				firstUploadStarted();
				await new Promise((resolve) => { releaseFirstUpload = resolve; });
				return { size: 5 };
			}
			return new Promise(() => {});
		},
	};
	const service = createTestService({ adapter, sync: async () => {} });
	const [first, second] = await Promise.all([
		service.start('u1', 'drive-1'),
		service.start('u1', 'drive-1'),
	]);
	await service.refresh('u1', first.id);
	await firstStarted;
	await service.refresh('u1', second.id);

	let cancellation;
	let cancellationError;
	try {
		cancellation = await settleWithin(service.cancel('u1', second.id));
	} catch (error) {
		cancellationError = error;
	}
	releaseFirstUpload();
	await waitForJob(service, first.id);
	if (cancellationError) throw cancellationError;

	assert.equal(cancellation.status, 'cancelled');
	assert.equal(uploadCalls, 1);
});

test('keeps successful files when one media transfer fails', async () => {
	const items = [
		mediaItem('broken', 'broken.jpg', 'image/jpeg'),
		mediaItem('good', 'good.jpg', 'image/jpeg'),
	];
	const request = readyPickerRequest(items, async (options) => {
		if (options.url.includes('/broken=')) throw new Error('media unavailable');
		return { data: Readable.from(['good']) };
	});
	const adapter = {
		createOAuthClient: () => ({ request }),
		ensureRemotePath: async () => 'folder-1',
		listFileNames: async () => [],
		uploadStream: async ({ stream }) => {
			for await (const _chunk of stream) { /* consume the real stream */ }
			return { size: 4 };
		},
	};
	const service = createTestService({ adapter, sync: async () => {} });
	const started = await service.start('u1', 'drive-1');

	await service.refresh('u1', started.id);
	const completed = await waitForJob(service, started.id);

	assert.equal(completed.status, 'completed_with_errors');
	assert.equal(completed.completed, 1);
	assert.equal(completed.failed, 1);
	assert.deepEqual(completed.errors, [{ fileName: 'broken.jpg', message: 'media unavailable' }]);
});

test('Drive quota and rate-limit 403s remain item failures without invalidating the account', async () => {
	const items = [
		mediaItem('quota', 'quota.jpg', 'image/jpeg'),
		mediaItem('rate', 'rate.jpg', 'image/jpeg'),
		mediaItem('good-after-403', 'good.jpg', 'image/jpeg'),
	];
	const marked = [];
	const request = readyPickerRequest(items, async () => ({ data: Readable.from(['bytes']) }));
	const adapter = {
		createOAuthClient: () => ({ request }),
		ensureRemotePath: async () => 'folder-1',
		listFileNames: async () => [],
		uploadStream: async ({ fileName, stream }) => {
			for await (const _chunk of stream) { /* consume the real stream */ }
			if (fileName === 'quota.jpg') {
				throw { response: { status: 403, data: { error: {
					message: "The user's Drive storage quota has been exceeded.",
					errors: [{ reason: 'storageQuotaExceeded' }],
				} } } };
			}
			if (fileName === 'rate.jpg') {
				throw { response: { status: 403, data: { error: {
					message: 'User rate limit exceeded.',
					errors: [{ reason: 'userRateLimitExceeded' }],
				} } } };
			}
			return { size: 5 };
		},
	};
	const service = createTestService({
		adapter,
		markStatus: (...args) => marked.push(args),
		sync: async () => {},
	});
	const started = await service.start('u1', 'drive-1');

	await service.refresh('u1', started.id);
	const completed = await waitForJob(service, started.id);

	assert.equal(completed.status, 'completed_with_errors');
	assert.equal(completed.completed, 1);
	assert.equal(completed.failed, 2);
	assert.deepEqual(marked, []);
	assert.deepEqual(completed.errors, [
		{ fileName: 'quota.jpg', message: "The user's Drive storage quota has been exceeded." },
		{ fileName: 'rate.jpg', message: 'User rate limit exceeded.' },
	]);
});

test('an auth-specific Drive 403 stops the import and marks invalid_token', async () => {
	const items = [mediaItem('permission', 'permission.jpg', 'image/jpeg')];
	const marked = [];
	const request = readyPickerRequest(items, async () => ({ data: Readable.from(['bytes']) }));
	const adapter = {
		createOAuthClient: () => ({ request }),
		ensureRemotePath: async () => 'folder-1',
		listFileNames: async () => [],
		uploadStream: async ({ stream }) => {
			for await (const _chunk of stream) { /* consume the real stream */ }
			throw { response: { status: 403, data: { error: {
				message: 'Request had insufficient authentication scopes.',
				errors: [{ reason: 'insufficientPermissions' }],
			} } } };
		},
	};
	const service = createTestService({
		adapter,
		markStatus: (...args) => marked.push(args),
		sync: async () => {},
	});
	const started = await service.start('u1', 'drive-1');

	await service.refresh('u1', started.id);
	const failed = await waitForJob(service, started.id);

	assert.equal(failed.status, 'failed');
	assert.equal(failed.failed, 1);
	assert.deepEqual(marked, [['u1', 'drive-1', 'invalid_token']]);
});

test('auth failure marks the account invalid and starts no later items', async () => {
	const items = [
		mediaItem('expired', 'expired.jpg', 'image/jpeg'),
		mediaItem('later-one', 'later-one.jpg', 'image/jpeg'),
		mediaItem('later-two', 'later-two.jpg', 'image/jpeg'),
	];
	let uploadCount = 0;
	let syncs = 0;
	const marked = [];
	const request = readyPickerRequest(items, (options) => {
		if (options.url.includes('/expired=')) throw Object.assign(new Error('access_token secret'), { status: 401 });
		return Promise.resolve({ data: Readable.from(['later']) });
	});
	const adapter = {
		createOAuthClient: () => ({ request }),
		ensureRemotePath: async () => 'folder-1',
		listFileNames: async () => [],
		uploadStream: async () => { uploadCount += 1; },
	};
	const service = createTestService({
		adapter,
		markStatus: (...args) => marked.push(args),
		sync: async () => { syncs += 1; },
	});
	const started = await service.start('u1', 'drive-1');

	await service.refresh('u1', started.id);
	const failed = await waitForJob(service, started.id);

	assert.equal(failed.status, 'failed');
	assert.equal(failed.completed, 0);
	assert.equal(failed.failed, 1);
	assert.equal(uploadCount, 0);
	assert.equal(syncs, 0);
	assert.deepEqual(marked, [['u1', 'drive-1', 'invalid_token']]);
	assert.deepEqual(failed.errors, [{
		fileName: 'expired.jpg', message: 'Google Photos Picker request failed',
	}]);
});

test('cancelling an active import aborts transfers before returning and skips sync', async () => {
	const items = [mediaItem('active', 'active.jpg', 'image/jpeg')];
	let downloadSignal;
	let uploadSignal;
	let releaseUpload;
	let uploadSettled = false;
	let filesCreated = 0;
	let syncs = 0;
	let uploadStarted;
	const startedUpload = new Promise((resolve) => { uploadStarted = resolve; });
	const request = readyPickerRequest(items, async (options) => {
		downloadSignal = options.signal;
		return { data: Readable.from(['active-bytes']) };
	});
	const adapter = {
		createOAuthClient: () => ({ request }),
		ensureRemotePath: async () => 'folder-1',
		listFileNames: async () => [],
		uploadStream: ({ signal }) => new Promise((resolve, reject) => {
			uploadSignal = signal;
			uploadStarted();
			const abort = () => {
				if (uploadSettled) return;
				uploadSettled = true;
				reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
			};
			signal?.addEventListener('abort', abort, { once: true });
			releaseUpload = () => {
				if (uploadSettled) return;
				uploadSettled = true;
				filesCreated += 1;
				resolve({ size: 12 });
			};
		}),
	};
	const service = createTestService({ adapter, sync: async () => { syncs += 1; } });
	const started = await service.start('u1', 'drive-1');
	await service.refresh('u1', started.id);
	await startedUpload;

	const cancelled = await service.cancel('u1', started.id);
	const uploadSettledBeforeReturn = uploadSettled;
	releaseUpload();
	await waitTurns();

	assert.equal(cancelled.status, 'cancelled');
	assert.equal(downloadSignal?.aborted, true);
	assert.equal(uploadSignal?.aborted, true);
	assert.equal(uploadSettledBeforeReturn, true);
	assert.equal(filesCreated, 0);
	assert.equal(syncs, 0);
	assert.equal((await service.get('u1', started.id)).completed, 0);
});

test('concurrent cancellations share active transfer settlement and Picker cleanup', async () => {
	const items = [mediaItem('cancel-twice', 'cancel-twice.jpg', 'image/jpeg')];
	let releaseCleanup;
	const cleanup = new Promise((resolve) => { releaseCleanup = resolve; });
	let cleanupStarted;
	const startedCleanup = new Promise((resolve) => { cleanupStarted = resolve; });
	let cleanupCalls = 0;
	let uploadStarted;
	const startedUpload = new Promise((resolve) => { uploadStarted = resolve; });
	const pickerRequest = readyPickerRequest(items, async () => ({ data: Readable.from(['bytes']) }));
	const request = (options) => {
		if (options.method === 'DELETE') {
			cleanupCalls += 1;
			cleanupStarted();
			return cleanup;
		}
		return pickerRequest(options);
	};
	const adapter = {
		createOAuthClient: () => ({ request }),
		ensureRemotePath: async () => 'folder-1',
		listFileNames: async () => [],
		uploadStream: ({ signal }) => new Promise((_resolve, reject) => {
			uploadStarted();
			signal.addEventListener('abort', () => {
				reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
			}, { once: true });
		}),
	};
	const service = createTestService({ adapter, sync: async () => { throw new Error('must not sync'); } });
	const started = await service.start('u1', 'drive-1');
	await service.refresh('u1', started.id);
	await startedUpload;

	let firstResolved = false;
	let secondResolved = false;
	const firstCancel = service.cancel('u1', started.id).then((job) => {
		firstResolved = true;
		return job;
	});
	await startedCleanup;
	const secondCancel = service.cancel('u1', started.id).then((job) => {
		secondResolved = true;
		return job;
	});
	await waitTurns();

	assert.equal(firstResolved, false);
	assert.equal(secondResolved, false);
	assert.equal(cleanupCalls, 1);

	releaseCleanup({ data: {} });
	const [first, second] = await Promise.all([firstCancel, secondCancel]);
	assert.deepEqual(second, first);
	assert.equal(first.status, 'cancelled');
	assert.equal(cleanupCalls, 1);
});

test('delayed auth failure destroys a second worker response stream before stopping', async () => {
	const items = [
		mediaItem('expired-delayed', 'expired.jpg', 'image/jpeg'),
		mediaItem('headers-ready', 'headers.jpg', 'image/jpeg'),
	];
	let rejectExpired;
	const expired = new Promise((_resolve, reject) => { rejectExpired = reject; });
	const receivedStream = Readable.from(['unconsumed-response']);
	let uploadSignal;
	let releaseUpload;
	let uploadStarted;
	let syncs = 0;
	const startedUpload = new Promise((resolve) => { uploadStarted = resolve; });
	const request = readyPickerRequest(items, (options) => {
		if (options.url.includes('/expired-delayed=')) return expired;
		return Promise.resolve({ data: receivedStream });
	});
	const adapter = {
		createOAuthClient: () => ({ request }),
		ensureRemotePath: async () => 'folder-1',
		listFileNames: async () => [],
		uploadStream: ({ signal }) => new Promise((resolve, reject) => {
			uploadSignal = signal;
			uploadStarted();
			let settled = false;
			signal?.addEventListener('abort', () => {
				if (settled) return;
				settled = true;
				reject(Object.assign(new Error('stopped'), { name: 'AbortError' }));
			}, { once: true });
			releaseUpload = () => {
				if (settled) return;
				settled = true;
				resolve({ size: 19 });
			};
		}),
	};
	const marked = [];
	const service = createTestService({
		adapter,
		markStatus: (...args) => marked.push(args),
		sync: async () => { syncs += 1; },
	});
	const started = await service.start('u1', 'drive-1');
	await service.refresh('u1', started.id);
	await startedUpload;

	rejectExpired(Object.assign(new Error('expired token'), { status: 401 }));
	await waitTurns();
	const destroyedAfterAuthStop = receivedStream.destroyed;
	const uploadAbortedAfterAuthStop = uploadSignal?.aborted;
	releaseUpload();
	const failed = await waitForJob(service, started.id);

	assert.equal(destroyedAfterAuthStop, true);
	assert.equal(uploadAbortedAfterAuthStop, true);
	assert.equal(failed.status, 'failed');
	assert.equal(failed.completed, 0);
	assert.equal(failed.failed, 1);
	assert.equal(syncs, 0);
	assert.deepEqual(marked, [['u1', 'drive-1', 'invalid_token']]);
});

test('item and final WebSocket emit failures do not change a successful import', async () => {
	const items = [mediaItem('emit-safe', 'emit-safe.jpg', 'image/jpeg')];
	const request = readyPickerRequest(items, async () => ({ data: Readable.from(['bytes']) }));
	const adapter = {
		createOAuthClient: () => ({ request }),
		ensureRemotePath: async () => 'folder-1',
		listFileNames: async () => [],
		uploadStream: async ({ stream }) => {
			for await (const _chunk of stream) { /* consume stream */ }
			return { size: 5 };
		},
	};
	const service = createTestService({
		adapter,
		emitEvent: (_id, event) => {
			if (event.type === 'photos-import:item-complete' || event.type === 'photos-import:complete') {
				throw new Error('socket write failed');
			}
		},
		sync: async () => {},
	});
	const started = await service.start('u1', 'drive-1');

	await service.refresh('u1', started.id);
	const completed = await waitForJob(service, started.id);
	await waitTurns();

	assert.equal(completed.status, 'completed');
	assert.equal(completed.completed, 1);
	assert.equal(completed.failed, 0);
});

test('terminal jobs remain sanitized until their bounded TTL expires', async () => {
	let evict;
	let evictionDelay;
	const request = readyPickerRequest([], async () => { throw new Error('must not download'); });
	const service = createTestService({
		request,
		terminalJobTtlMs: 1234,
		setTimer: (callback, delay) => {
			evict = callback;
			evictionDelay = delay;
			return { unref() {} };
		},
	});
	const started = await service.start('u1', 'drive-1');

	const completed = await service.refresh('u1', started.id);
	assert.equal(completed.status, 'completed');
	assert.equal((await service.get('u1', started.id)).id, started.id);
	assert.equal(evictionDelay, 1234);

	evict();
	await assert.rejects(service.get('u1', started.id), /not found/);
});

test('successful import deletes its Picker session exactly once', async () => {
	const requests = [];
	const items = [mediaItem('cleanup-ok', 'cleanup.jpg', 'image/jpeg')];
	const request = readyPickerRequest(items, async (options) => {
		requests.push(options);
		return { data: Readable.from(['bytes']) };
	});
	const adapter = {
		createOAuthClient: () => ({ request: (options) => {
			requests.push(options);
			return request(options);
		} }),
		ensureRemotePath: async () => 'folder-1',
		listFileNames: async () => [],
		uploadStream: async ({ stream }) => {
			for await (const _chunk of stream) { /* consume stream */ }
			return { size: 5 };
		},
	};
	const service = createTestService({ adapter, sync: async () => {} });
	const started = await service.start('u1', 'drive-1');
	await service.refresh('u1', started.id);
	const completed = await waitForJob(service, started.id);

	assert.equal(completed.status, 'completed');
	assert.equal(requests.filter((options) => options.method === 'DELETE').length, 1);
});

test('cleanup failure preserves successful imported-file outcomes', async () => {
	const items = [mediaItem('cleanup-fails', 'cleanup.jpg', 'image/jpeg')];
	const request = readyPickerRequest(items, async () => ({ data: Readable.from(['bytes']) }));
	const adapter = {
		createOAuthClient: () => ({ request: async (options) => {
			if (options.method === 'DELETE') {
				throw new Error('DELETE https://photos.example/session?access_token=secret');
			}
			return request(options);
		} }),
		ensureRemotePath: async () => 'folder-1',
		listFileNames: async () => [],
		uploadStream: async ({ stream }) => {
			for await (const _chunk of stream) { /* consume stream */ }
			return { size: 5 };
		},
	};
	const service = createTestService({ adapter, sync: async () => {} });
	const started = await service.start('u1', 'drive-1');
	await service.refresh('u1', started.id);
	const completed = await waitForJob(service, started.id);

	assert.equal(completed.status, 'completed');
	assert.equal(completed.completed, 1);
	assert.equal(completed.failed, 0);
	assert.deepEqual(completed.errors, ['Google Photos Picker request failed']);
});

test('Photos import route starts, reads, and cancels only a local owned Google account', async (t) => {
	t.mock.method(console, 'error', () => {});
	const [{ createApp }, { upsertCloudAccount }, { LOCAL_USER_ID }, { createUser }] = await Promise.all([
		import('../src/app.js'),
		import('../src/services/accountService.js'),
		import('../src/config/database.js'),
		import('../src/services/userService.js'),
	]);
	const googleAccount = {
		id: `photos-route-${process.pid}`,
		userId: LOCAL_USER_ID,
		email: 'route-owner@gmail.com',
		provider: 'google_drive',
		credentials: {
			clientId: 'route-client',
			clientSecret: 'route-secret',
			accessToken: 'route-access-token',
			scope: 'https://www.googleapis.com/auth/photospicker.mediaitems.readonly',
		},
		total_space: 1000,
		used_space: 100,
		status: 'active',
	};
	upsertCloudAccount(googleAccount);
	const pickerRequests = [];
	t.mock.method(GoogleDriveAdapter.prototype, 'createOAuthClient', function createOAuthClient() {
		return { request: async (options) => {
			pickerRequests.push(options);
			if (options.method === 'POST') return { data: {
				id: 'route-picker', pickerUri: 'https://photos.google.com/picker/route',
				pollingConfig: { pollInterval: '3s', timeoutIn: '180s' },
			} };
			if (options.method === 'DELETE') return { data: {} };
			return { data: { mediaItemsSet: false } };
		} };
	});

	const server = createApp().listen(0);
	await new Promise((resolve) => server.once('listening', resolve));
	t.after(() => server.close());
	const baseUrl = `http://127.0.0.1:${server.address().port}`;

	const startResponse = await fetch(`${baseUrl}/api/accounts/google/${googleAccount.id}/photos/imports`, {
		method: 'POST',
	});
	assert.equal(startResponse.status, 201);
	const startPayload = await startResponse.json();
	assert.equal(startPayload.data.accountId, googleAccount.id);
	assert.equal(JSON.stringify(startPayload).includes('route-access-token'), false);

	const statusResponse = await fetch(
		`${baseUrl}/api/accounts/google/photos/imports/${startPayload.data.id}`,
	);
	assert.equal((await statusResponse.json()).data.id, startPayload.data.id);

	const cancelResponse = await fetch(
		`${baseUrl}/api/accounts/google/photos/imports/${startPayload.data.id}`,
		{ method: 'DELETE' },
	);
	assert.equal(cancelResponse.status, 200);
	assert.equal(pickerRequests.filter((options) => options.method === 'DELETE').length, 1);

	const unknownResponse = await fetch(`${baseUrl}/api/accounts/google/missing/photos/imports`, {
		method: 'POST',
	});
	const unknownPayload = await unknownResponse.json();
	assert.equal(unknownResponse.status, 400);
	assert.equal(JSON.stringify(unknownPayload).includes('route-access-token'), false);
	assert.equal(JSON.stringify(unknownPayload).includes('route-secret'), false);

	const otherUser = createUser({
		id: `photos-route-other-user-${process.pid}`,
		email: `photos-route-other-${process.pid}@example.com`,
		passwordHash: 'unused',
	});
	const otherAccount = {
		...googleAccount,
		id: `photos-route-other-account-${process.pid}`,
		userId: otherUser.id,
		email: 'other-owner@gmail.com',
		credentials: { ...googleAccount.credentials, accessToken: 'other-owner-secret-token' },
	};
	upsertCloudAccount(otherAccount);
	const nonOwnedResponse = await fetch(
		`${baseUrl}/api/accounts/google/${otherAccount.id}/photos/imports`,
		{ method: 'POST' },
	);
	const nonOwnedPayload = await nonOwnedResponse.json();
	assert.equal(nonOwnedResponse.status, 400);
	assert.equal(JSON.stringify(nonOwnedPayload).includes('other-owner-secret-token'), false);
});
