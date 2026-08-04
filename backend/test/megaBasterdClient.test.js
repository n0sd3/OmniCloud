import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import express from 'express';

import { createMegaBasterdClient, MegaBasterdError } from '../src/services/megaBasterdClient.js';
import healthRoutes, { createHealthRouter } from '../src/routes/healthRoutes.js';

async function startServer(handler) {
	const server = http.createServer(handler);
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	return {
		server,
		baseUrl: `http://127.0.0.1:${server.address().port}`,
	};
}

async function readBody(request) {
	const chunks = [];
	for await (const chunk of request) chunks.push(chunk);
	return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function read(stream) {
	const chunks = [];
	for await (const chunk of stream) chunks.push(chunk);
	return Buffer.concat(chunks).toString('utf8');
}

async function healthResponse(router = healthRoutes) {
	const app = express();
	app.use('/api', router);
	const server = app.listen(0, '127.0.0.1');
	await once(server, 'listening');
	try {
		return await fetch(`http://127.0.0.1:${server.address().port}/api/health`);
	} finally {
		server.close();
	}
}

test('MEGA download health reports an unconfigured sidecar without transfer data', async () => {
	const response = await healthResponse(createHealthRouter({ secret: '   ' }));
	const body = await response.json();

	assert.equal(response.status, 200);
	assert.deepEqual(body.mega_download, {
		sidecar: 'unconfigured',
		fallback_enabled: true,
	});
	assert.doesNotMatch(JSON.stringify(body), /https:\/\/signed\.example|test-secret/);
});

test('MEGA download health reports a configured reachable sidecar without its response data', async () => {
	const response = await healthResponse(createHealthRouter({
		secret: 'test-secret',
		client: { health: async () => ({ status: 'ok', download_url: 'https://signed.example/file' }) },
	}));
	const body = await response.json();

	assert.equal(response.status, 200);
	assert.deepEqual(body.mega_download, {
		sidecar: 'available',
		fallback_enabled: true,
	});
	assert.doesNotMatch(JSON.stringify(body), /https:\/\/signed\.example|test-secret/);
});

test('MEGA download health keeps the API healthy when a configured sidecar is unavailable', async () => {
	const response = await healthResponse(createHealthRouter({
		secret: 'test-secret',
		fallbackEnabled: false,
		client: { health: async () => { throw new Error('https://signed.example/file'); } },
	}));
	const body = await response.json();

	assert.equal(response.status, 200);
	assert.deepEqual(body.mega_download, {
		sidecar: 'unavailable',
		fallback_enabled: false,
	});
	assert.doesNotMatch(JSON.stringify(body), /https:\/\/signed\.example|test-secret/);
});

test('MegaBasterd client authenticates inspect requests and parses metadata', async (t) => {
	const fixture = await startServer(async (request, response) => {
		assert.equal(request.headers.authorization, 'Bearer test-secret');
		assert.equal(request.headers['content-type'], 'application/json');
		assert.equal(request.url, '/inspect');
		assert.deepEqual(await readBody(request), { link: 'https://mega.nz/file/id#key' });
		response.writeHead(200, { 'Content-Type': 'application/json' });
		response.end(JSON.stringify({ file_name: 'fixture.txt', size: 7, mime_type: 'text/plain' }));
	});
	t.after(() => fixture.server.close());
	const client = createMegaBasterdClient({ baseUrl: fixture.baseUrl, secret: 'test-secret', timeoutMs: 1000 });

	assert.deepEqual(await client.inspectPublic('https://mega.nz/file/id#key'), {
		file_name: 'fixture.txt',
		size: 7,
		mime_type: 'text/plain',
	});
});

test('MegaBasterd client sends resolved range JSON and returns a Node readable', async (t) => {
	const fixture = await startServer(async (request, response) => {
		assert.equal(request.headers.authorization, 'Bearer test-secret');
		assert.equal(request.url, '/stream');
		assert.deepEqual(await readBody(request), {
			source: 'resolved',
			download_url: 'https://signed.example/file',
			file_key: 'private-key',
			file_name: 'fixture.bin',
			size: 36,
			range: { start: 7, end: 15 },
		});
		response.writeHead(206, { 'Content-Type': 'application/octet-stream' });
		response.end('789abcdef');
	});
	t.after(() => fixture.server.close());
	const client = createMegaBasterdClient({ baseUrl: fixture.baseUrl, secret: 'test-secret', timeoutMs: 1000 });

	const stream = await client.streamResolved({
		downloadUrl: 'https://signed.example/file',
		fileKey: 'private-key',
		fileName: 'fixture.bin',
		size: 36,
	}, { range: { start: 7, end: 15 } });

	assert.equal(await read(stream), '789abcdef');
});

test('MegaBasterd client timeout stops after stream headers arrive', async (t) => {
	const fixture = await startServer((_request, response) => {
		response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
		response.write('first-');
		setTimeout(() => response.end('last'), 80);
	});
	t.after(() => fixture.server.close());
	const client = createMegaBasterdClient({ baseUrl: fixture.baseUrl, secret: 'test-secret', timeoutMs: 30 });

	assert.equal(await read(await client.streamPublic('https://mega.nz/file/id#key')), 'first-last');
});

test('MegaBasterd client caller abort remains active after stream headers arrive', async (t) => {
	const fixture = await startServer((_request, response) => {
		response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
		response.write('first-');
		setTimeout(() => response.end('last'), 200);
	});
	t.after(() => {
		fixture.server.closeAllConnections();
		fixture.server.close();
	});
	const client = createMegaBasterdClient({ baseUrl: fixture.baseUrl, secret: 'test-secret', timeoutMs: 1000 });
	const controller = new AbortController();
	const stream = await client.streamPublic('https://mega.nz/file/id#key', { signal: controller.signal });
	controller.abort();

	await assert.rejects(read(stream), (error) => error.name === 'AbortError');
});

test('MegaBasterd client sends canonical public links to the stream endpoint', async (t) => {
	const fixture = await startServer(async (request, response) => {
		assert.deepEqual(await readBody(request), {
			source: 'public',
			link: 'https://mega.nz/file/id#key',
			range: null,
		});
		response.end('public');
	});
	t.after(() => fixture.server.close());
	const client = createMegaBasterdClient({ baseUrl: fixture.baseUrl, secret: 'test-secret', timeoutMs: 1000 });

	assert.equal(await read(await client.streamPublic('https://mega.nz/file/id#key')), 'public');
});

test('MegaBasterd client maps quota to a terminal safe error', async (t) => {
	const fixture = await startServer((_request, response) => {
		response.writeHead(429, { 'Content-Type': 'application/json' });
		response.end('{"code":"QUOTA"}');
	});
	t.after(() => fixture.server.close());
	const client = createMegaBasterdClient({ baseUrl: fixture.baseUrl, secret: 'test-secret', timeoutMs: 1000 });

	await assert.rejects(client.inspectPublic('https://mega.nz/file/id#secret-key'), (error) => {
		assert.ok(error instanceof MegaBasterdError);
		assert.equal(error.code, 'QUOTA');
		assert.equal(error.fallbackEligible, false);
		assert.doesNotMatch(error.message, /secret-key/);
		return true;
	});
});

test('MegaBasterd client keeps a recognized terminal code terminal on sidecar 5xx', async (t) => {
	const fixture = await startServer((_request, response) => {
		response.writeHead(500, { 'Content-Type': 'application/json' });
		response.end('{"code":"QUOTA"}');
	});
	t.after(() => fixture.server.close());
	const client = createMegaBasterdClient({ baseUrl: fixture.baseUrl, secret: 'test-secret', timeoutMs: 1000 });

	await assert.rejects(client.inspectPublic('https://mega.nz/file/id#secret'), (error) => {
		assert.equal(error.code, 'QUOTA');
		assert.equal(error.fallbackEligible, false);
		return true;
	});
});

test('MegaBasterd client classifies malformed successful JSON as eligible upstream failure', async (t) => {
	const fixture = await startServer((_request, response) => {
		response.writeHead(200, { 'Content-Type': 'application/json' });
		response.end('{"file_name":');
	});
	t.after(() => fixture.server.close());
	const client = createMegaBasterdClient({ baseUrl: fixture.baseUrl, secret: 'test-secret', timeoutMs: 1000 });

	await assert.rejects(client.inspectPublic('https://mega.nz/file/id#secret'), (error) => {
		assert.ok(error instanceof MegaBasterdError);
		assert.equal(error.code, 'UPSTREAM');
		assert.equal(error.fallbackEligible, true);
		return true;
	});
});

test('MegaBasterd client treats sidecar 5xx and timeout as fallback eligible', async (t) => {
	const fixture = await startServer((_request, response) => {
		setTimeout(() => {
			if (!response.destroyed) response.end('{"code":"UPSTREAM"}');
		}, 100);
	});
	t.after(() => fixture.server.close());
	const client = createMegaBasterdClient({ baseUrl: fixture.baseUrl, secret: 'test-secret', timeoutMs: 20 });

	await assert.rejects(client.health(), (error) => {
		assert.ok(error instanceof MegaBasterdError);
		assert.equal(error.code, 'TIMEOUT');
		assert.equal(error.fallbackEligible, true);
		return true;
	});
});

test('MegaBasterd client preserves caller abort as terminal', async (t) => {
	const fixture = await startServer(() => {});
	t.after(() => fixture.server.close());
	const client = createMegaBasterdClient({ baseUrl: fixture.baseUrl, secret: 'test-secret', timeoutMs: 1000 });
	const controller = new AbortController();
	const pending = client.health({ signal: controller.signal });
	controller.abort();

	await assert.rejects(pending, (error) => {
		assert.ok(error instanceof MegaBasterdError);
		assert.equal(error.code, 'CANCELLED');
		assert.equal(error.fallbackEligible, false);
		return true;
	});
});

test('MegaBasterd client fails closed before fetch when its secret is blank', async () => {
	let fetchCalls = 0;
	const client = createMegaBasterdClient({
		baseUrl: 'http://127.0.0.1:1',
		secret: '',
		fetchImpl: async () => { fetchCalls += 1; },
	});

	await assert.rejects(client.health(), (error) => {
		assert.equal(error.code, 'UNAVAILABLE');
		assert.equal(error.fallbackEligible, true);
		return true;
	});
	assert.equal(fetchCalls, 0);
});

test('MegaBasterd client treats a whitespace-only secret as missing', async () => {
	let fetchCalls = 0;
	const client = createMegaBasterdClient({
		baseUrl: 'http://127.0.0.1:1',
		secret: '   ',
		fetchImpl: async () => { fetchCalls += 1; },
	});

	await assert.rejects(client.health(), (error) => error.code === 'UNAVAILABLE');
	assert.equal(fetchCalls, 0);
});
