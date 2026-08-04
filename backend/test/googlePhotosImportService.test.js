import assert from 'node:assert/strict';
import test from 'node:test';

process.env.GOOGLE_CLIENT_ID = 'google-client-id-for-test';
process.env.GOOGLE_CLIENT_SECRET = 'google-client-secret-for-test';
process.env.GOOGLE_REDIRECT_URI = 'http://localhost:8787/api/accounts/google/callback';

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
		createAdapter: () => ({ createOAuthClient: () => ({ request }) }),
		runImport,
		now,
	});
}

test('Google authorization asks for Picker access together with Drive access', () => {
	const { authorizationUrl } = createGoogleAuthorizationRequest('user-1');
	const scope = new URL(authorizationUrl).searchParams.get('scope').split(' ');

	assert.ok(scope.includes('https://www.googleapis.com/auth/drive'));
	assert.ok(scope.includes('https://www.googleapis.com/auth/photospicker.mediaitems.readonly'));
});

test('Drive adapter returns every name in the resolved destination folder', async () => {
	const adapter = Object.create(GoogleDriveAdapter.prototype);
	adapter.getDriveClient = async () => ({
		files: { list: async () => ({ data: { files: [{ name: 'foto.jpg' }, { name: 'video.mp4' }] } }) },
	});

	assert.deepEqual(await adapter.listFileNames('folder-1'), ['foto.jpg', 'video.mp4']);
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
	const service = createTestService({
		request: async () => {
			throw { response: { data: { error: {
				message: 'GET https://photos.example/picker?access_token=secret-token',
			} } } };
		},
	});

	await assert.rejects(
		service.start('u1', 'drive-1'),
		(error) => error.message === 'Google Photos Picker request failed',
	);
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

test('refresh page failure leaves the job waiting without uploads', async () => {
	const uploaded = [];
	const request = async (options) => {
		if (options.method === 'POST') return { data: {
			id: 'picker-1', pickerUri: 'https://photos.google.com/picker/abc',
			pollingConfig: { pollInterval: '3s', timeoutIn: '180s' },
		} };
		if (options.url.endsWith('/sessions/picker-1')) return { data: { mediaItemsSet: true } };
		if (!options.params.pageToken) return { data: { mediaItems: [{ id: 'one' }], nextPageToken: 'next' } };
		throw new Error('second page unavailable');
	};
	const service = createTestService({ request, runImport: async () => uploaded.push('file') });
	const job = await service.start('u1', 'drive-1');

	await assert.rejects(service.refresh('u1', job.id), /second page unavailable/);
	assert.deepEqual(uploaded, []);
	const current = await service.get('u1', job.id);
	assert.equal(current.status, 'waiting_for_selection');
	assert.equal(current.total, 0);
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
