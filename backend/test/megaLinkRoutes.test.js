import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

const taskRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'omnicloud-mega-links-'));
process.env.DATABASE_PATH = path.join(taskRoot, 'omnicloud.db');
process.env.FILE_CACHE_PATH = path.join(taskRoot, 'files');
process.env.APP_MODE = 'hosted';

const [
	{ default: express },
	{ attachAuthContext },
	{ createMegaLinkRouter },
	{ createMegaLinkImportService },
	{ emitUploadEvent, registerUploadSocket, unregisterUploadSocket },
	{ db, LOCAL_USER_ID },
	{ BaseCloudAdapter },
	{ createUploadSession, getUploadSession },
	{ runUpload },
] = await Promise.all([
	import('express'),
	import('../src/middleware/authMiddleware.js'),
	import('../src/routes/megaLinkRoutes.js'),
	import('../src/services/megaLinkImportService.js'),
	import('../src/services/websocketHub.js'),
	import('../src/config/database.js'),
	import('../src/adapters/BaseCloudAdapter.js'),
	import('../src/services/uploadSessionService.js'),
	import('../src/services/uploadService.js'),
]);

const LINK = 'https://www.mega.co.nz/file/file_id#secret-key';
const CANONICAL_LINK = 'https://mega.nz/file/file_id#secret-key';

function testImports(overrides = {}) {
	return {
		start: async () => ({ upload_id: 'upload-1', file_name: 'notes.txt', size: 5 }),
		cancel: async () => false,
		...overrides,
	};
}

function testDownloads(overrides = {}) {
	return {
		inspectPublic: async () => ({ file_name: 'notes.txt', size: 5, mime_type: 'text/plain' }),
		streamPublic: async () => Readable.from(['hello']),
		...overrides,
	};
}

async function startServer(router, { hostedAuth = false } = {}) {
	const app = express();
	app.use(express.json());
	if (hostedAuth) {
		app.use(attachAuthContext);
	} else {
		app.use((req, _res, next) => {
			const userId = req.headers['x-test-user'] || 'u1';
			req.user = { id: userId };
			next();
		});
	}
	app.use('/api', router);
	const server = app.listen(0);
	await new Promise((resolve) => server.once('listening', resolve));
	return {
		baseUrl: `http://127.0.0.1:${server.address().port}`,
		close: () => new Promise((resolve) => server.close(resolve)),
	};
}

async function post(baseUrl, endpoint, body, headers = {}) {
	return fetch(`${baseUrl}${endpoint}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', ...headers },
		body: JSON.stringify(body),
	});
}

async function waitFor(predicate) {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (predicate()) return;
		await new Promise((resolve) => setImmediate(resolve));
	}
	throw new Error('Timed out waiting for MEGA link job');
}

test.after(async () => {
	await fs.rm(taskRoot, { recursive: true, force: true });
});

test('public MEGA routes require the app user', async () => {
	const router = createMegaLinkRouter({ downloads: testDownloads(), imports: testImports() });
	const server = await startServer(router, { hostedAuth: true });
	try {
		for (const [method, endpoint] of [
			['POST', '/api/mega-links/inspect'],
			['POST', '/api/mega-links/download'],
			['POST', '/api/mega-links/import'],
			['DELETE', '/api/mega-links/import/upload-1'],
		]) {
			const response = await fetch(`${server.baseUrl}${endpoint}`, {
				method,
				headers: { 'Content-Type': 'application/json' },
				body: method === 'POST' ? JSON.stringify({ link: LINK }) : undefined,
			});
			assert.equal(response.status, 401, `${method} ${endpoint}`);
		}
	} finally {
		await server.close();
	}
});

test('inspect rejects a deceptive host before the downloader runs', async () => {
	let calls = 0;
	const downloads = testDownloads({ inspectPublic: async () => { calls += 1; } });
	const server = await startServer(createMegaLinkRouter({ downloads, imports: testImports() }));
	try {
		const link = 'https://mega.nz.evil.test/file/id#secret-key';
		const response = await post(server.baseUrl, '/api/mega-links/inspect', { link });
		const body = await response.text();
		assert.equal(response.status, 400);
		assert.equal(calls, 0);
		assert.doesNotMatch(body, /evil\.test|secret-key/);
	} finally {
		await server.close();
	}
});

test('download returns safe attachment metadata and exact ranged bytes', async () => {
	const calls = [];
	const body = Buffer.from('hello');
	const downloads = testDownloads({
		inspectPublic: async (link) => {
			calls.push(['inspect', link]);
			return { file_name: '../résumé".txt', size: body.length, mime_type: 'text/plain' };
		},
		streamPublic: async (link, options) => {
			calls.push(['stream', link, options.range]);
			return Readable.from([body.subarray(options.range.start, options.range.end + 1)]);
		},
	});
	const server = await startServer(createMegaLinkRouter({ downloads, imports: testImports() }));
	try {
		const response = await post(server.baseUrl, '/api/mega-links/download', { link: LINK }, {
			Range: 'bytes=1-3',
		});
		assert.equal(response.status, 206);
		assert.equal(await response.text(), 'ell');
		assert.equal(response.headers.get('content-type'), 'text/plain');
		assert.equal(response.headers.get('content-length'), '3');
		assert.equal(response.headers.get('content-range'), 'bytes 1-3/5');
		assert.equal(response.headers.get('accept-ranges'), 'bytes');
		assert.match(response.headers.get('content-disposition'), /^attachment; filename="r_sum__\.txt"; filename\*=UTF-8''r%C3%A9sum%C3%A9%22\.txt$/);
		assert.deepEqual(calls.map((call) => call.slice(0, 2)), [
			['inspect', CANONICAL_LINK],
			['stream', CANONICAL_LINK],
		]);
		assert.deepEqual(calls[1][2], { start: 1, end: 3 });
	} finally {
		await server.close();
	}
});

test('import uses the submitted current path and allocation result', async () => {
	let sessionPayload;
	let streamLink;
	const service = createMegaLinkImportService({
		downloads: {
			inspectPublic: async (link) => {
				assert.equal(link, CANONICAL_LINK);
				return { file_name: 'notes.txt', size: 5, mime_type: 'text/plain' };
			},
			streamPublic: async (link) => {
				streamLink = link;
				return Readable.from(['hello']);
			},
		},
		selectAccount: (userId, size) => {
			assert.equal(userId, 'u1');
			assert.equal(size, 5);
			return { selected: { id: 'account-2' }, fallbackChain: [{ id: 'account-3' }] };
		},
		createSession: (payload) => {
			sessionPayload = payload;
			return { id: 'upload-allocation', ...payload };
		},
		beginUpload: () => {},
		upload: async ({ stream }) => { for await (const _chunk of stream) { /* consume */ } },
	});
	const server = await startServer(createMegaLinkRouter({ downloads: testDownloads(), imports: service }));
	try {
		const response = await post(server.baseUrl, '/api/mega-links/import', {
			link: LINK,
			virtualPath: '/current/folder',
		});
		assert.equal(response.status, 202);
		assert.deepEqual(await response.json(), { data: {
			upload_id: 'upload-allocation', file_name: 'notes.txt', size: 5,
		} });
		assert.deepEqual(sessionPayload, {
			user_id: 'u1',
			file_name: 'notes.txt',
			size: 5,
			mime_type: 'text/plain',
			virtual_path: '/current/folder/',
			remote_parent_id: null,
			cloud_account_id: 'account-2',
			fallback_chain: ['account-3'],
		});
		await waitFor(() => streamLink === CANONICAL_LINK);
	} finally {
		await server.close();
	}
});

test('import streams progress and completion through the existing upload event', async () => {
	const events = [];
	const socket = { readyState: 1, send: (message) => events.push(JSON.parse(message)) };
	registerUploadSocket('upload-progress', socket);
	let source;
	const service = createMegaLinkImportService({
		downloads: {
			inspectPublic: async () => ({ file_name: 'video.bin', size: 6, mime_type: 'application/octet-stream' }),
			streamPublic: async () => {
				source = Readable.from([Buffer.from('ab'), Buffer.from('cd'), Buffer.from('ef')]);
				return source;
			},
		},
		selectAccount: () => ({ selected: { id: 'account-1' }, fallbackChain: [] }),
		createSession: (payload) => ({ id: 'upload-progress', ...payload }),
		beginUpload: (uploadId) => emitUploadEvent(uploadId, {
			type: 'upload:started', uploadId, percent: 0, status: 'uploading',
		}),
		upload: async ({ session, stream }) => {
			assert.equal(stream, source);
			let bytes = 0;
			for await (const chunk of stream) {
				bytes += chunk.length;
				emitUploadEvent(session.id, { type: 'upload:progress', uploadId: session.id, bytes });
			}
			emitUploadEvent(session.id, { type: 'upload:complete', uploadId: session.id });
		},
	});
	try {
		const job = await service.start('u1', { link: LINK, virtualPath: '/' });
		assert.equal(job.upload_id, 'upload-progress');
		assert.deepEqual(events.map((event) => event.type), ['upload:started']);
		await waitFor(() => events.some((event) => event.type === 'upload:complete'));
		assert.deepEqual(events.map((event) => event.type), [
			'upload:started', 'upload:progress', 'upload:progress', 'upload:progress', 'upload:complete',
		]);
		assert.deepEqual(events.filter((event) => event.type === 'upload:progress').map((event) => event.bytes), [2, 4, 6]);
	} finally {
		unregisterUploadSocket('upload-progress', socket);
	}
});

test('cancel aborts source work and removes the ownership-scoped active job', async () => {
	let source;
	let signal;
	const service = createMegaLinkImportService({
		downloads: {
			inspectPublic: async () => ({ file_name: 'large.bin', size: 100, mime_type: 'application/octet-stream' }),
			streamPublic: async (_link, options) => {
				signal = options.signal;
				source = new Readable({ read() {} });
				return source;
			},
		},
		selectAccount: () => ({ selected: { id: 'account-1' }, fallbackChain: [] }),
		createSession: (payload) => ({ id: 'upload-cancel', ...payload }),
		beginUpload: () => {},
		upload: async ({ stream }) => new Promise((resolve) => {
			stream.once('close', resolve);
			stream.once('error', resolve);
			stream.resume();
		}),
	});
	await service.start('u1', { link: LINK, virtualPath: '/' });
	await waitFor(() => Boolean(source));

	const server = await startServer(createMegaLinkRouter({ downloads: testDownloads(), imports: service }));
	try {
		const foreign = await fetch(`${server.baseUrl}/api/mega-links/import/upload-cancel`, {
			method: 'DELETE', headers: { 'X-Test-User': 'u2' },
		});
		assert.equal(foreign.status, 404);
		assert.equal(signal.aborted, false);

		const owner = await fetch(`${server.baseUrl}/api/mega-links/import/upload-cancel`, {
			method: 'DELETE', headers: { 'X-Test-User': 'u1' },
		});
		assert.equal(owner.status, 204);
		assert.equal(signal.aborted, true);
		assert.equal(source.destroyed, true);
		assert.equal(await service.cancel('u1', 'upload-cancel'), false);
	} finally {
		await server.close();
	}
});

test('quota errors map to 429 without echoing the submitted link', async () => {
	const downloads = testDownloads({
		inspectPublic: async () => { throw Object.assign(new Error(`quota for ${LINK}`), { code: 'QUOTA' }); },
	});
	const server = await startServer(createMegaLinkRouter({ downloads, imports: testImports() }));
	try {
		const response = await post(server.baseUrl, '/api/mega-links/inspect', { link: LINK });
		const body = await response.text();
		assert.equal(response.status, 429);
		assert.match(body, /quota/i);
		assert.doesNotMatch(body, /secret-key|mega\.co\.nz/);
	} finally {
		await server.close();
	}
});

test('a failed import source rejects the upload and removes its temporary capture', async () => {
	const accountId = 'mega-link-source-error';
	db.prepare(`
		INSERT INTO cloud_accounts (
			id, user_id, email, provider, encrypted_credentials,
			total_space, used_space, status
		) VALUES (?, ?, ?, 'base', '', 1000, 0, 'active')
	`).run(accountId, LOCAL_USER_ID, 'source-error@example.com');
	const originalUpload = BaseCloudAdapter.prototype.uploadStream;
	BaseCloudAdapter.prototype.uploadStream = async ({ stream }) => {
		for await (const _chunk of stream) { /* consume */ }
		return { remoteFileId: 'must-not-complete', remoteParentId: null };
	};
	const session = createUploadSession({
		user_id: LOCAL_USER_ID,
		file_name: 'broken.bin',
		size: 6,
		mime_type: 'application/octet-stream',
		virtual_path: '/',
		remote_parent_id: null,
		cloud_account_id: accountId,
		fallback_chain: [],
	});
	const source = new Readable({ read() {} });
	const pending = runUpload({ session, stream: source, fileName: 'broken.bin', mimeType: 'application/octet-stream' });
	source.push(Buffer.from('abc'));
	await new Promise((resolve) => setImmediate(resolve));
	source.destroy(new Error('source failed safely'));
	try {
		await assert.rejects(Promise.race([
			pending,
			new Promise((_, reject) => setTimeout(() => reject(new Error('source error did not reach upload')), 100)),
		]), /source failed safely/);
		assert.equal(getUploadSession(session.id), undefined);
		const files = await fs.readdir(process.env.FILE_CACHE_PATH).catch(() => []);
		assert.deepEqual(files.filter((name) => name.endsWith('.tmp')), []);
	} finally {
		BaseCloudAdapter.prototype.uploadStream = originalUpload;
	}
});
