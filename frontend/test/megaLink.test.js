import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createPinia, setActivePinia } from 'pinia';
import { compileTemplate, parse } from '@vue/compiler-sfc';
import { api } from '../src/services/api.js';
import { looksLikeMegaFileLink } from '../src/utils/megaLink.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function installBrowserStubs() {
	globalThis.window = {
		localStorage: { getItem: () => null, setItem: () => {} },
		confirm: () => true,
	};
	if (!globalThis.navigator) globalThis.navigator = { language: 'en' };
	globalThis.URL.createObjectURL = () => 'blob:mega';
	globalThis.URL.revokeObjectURL = () => {};
	globalThis.document = {
		documentElement: { setAttribute: () => {} },
		body: { appendChild: () => {} },
		createElement: () => ({ click: () => {}, remove: () => {} }),
	};
}

test('recognizes modern and legacy MEGA file links', () => {
	assert.equal(looksLikeMegaFileLink('https://mega.nz/file/abc#key'), true);
	assert.equal(looksLikeMegaFileLink('https://mega.nz/#!abc!key'), true);
	assert.equal(looksLikeMegaFileLink('https://www.mega.co.nz/file/abc#key'), true);
});

test('rejects folders, HTTP, credentials, and deceptive hosts', () => {
	assert.equal(looksLikeMegaFileLink('https://mega.nz/folder/abc#key'), false);
	assert.equal(looksLikeMegaFileLink('http://mega.nz/file/abc#key'), false);
	assert.equal(looksLikeMegaFileLink('https://user:pass@mega.nz/file/abc#key'), false);
	assert.equal(looksLikeMegaFileLink('https://mega.nz.evil.test/file/abc#key'), false);
	assert.equal(looksLikeMegaFileLink('https://mega.nz/file/abc'), false);
});

test('trims user input but rejects malformed values', () => {
	assert.equal(looksLikeMegaFileLink('  https://mega.nz/file/abc#key  '), true);
	assert.equal(looksLikeMegaFileLink('not a URL'), false);
	assert.equal(looksLikeMegaFileLink(''), false);
});

test('MEGA link API methods use authenticated JSON requests and preserve the download stream', async () => {
	const originalFetch = globalThis.fetch;
	const calls = [];
	globalThis.fetch = async (url, options) => {
		calls.push({ url, options });
		if (url.endsWith('/download')) {
			return new Response('download-body', { status: 200 });
		}
		if (options.method === 'DELETE') return new Response(null, { status: 204 });
		return Response.json({ data: { upload_id: 'upload-1' } }, { status: url.endsWith('/import') ? 202 : 200 });
	};

	try {
		await api.inspectMegaLink('https://mega.nz/file/id#key');
		const response = await api.downloadMegaLink('https://mega.nz/file/id#key');
		assert.equal(await response.text(), 'download-body');
		await api.importMegaLink('https://mega.nz/file/id#key', '/nested/');
		await api.cancelMegaLinkImport('upload-1');
	} finally {
		globalThis.fetch = originalFetch;
	}

	assert.equal(calls.length, 4);
	assert.equal(calls[0].options.credentials, 'include');
	assert.deepEqual(JSON.parse(calls[0].options.body), { link: 'https://mega.nz/file/id#key' });
	assert.equal(calls[1].options.credentials, 'include');
	assert.deepEqual(JSON.parse(calls[1].options.body), { link: 'https://mega.nz/file/id#key' });
	assert.deepEqual(JSON.parse(calls[2].options.body), {
		link: 'https://mega.nz/file/id#key',
		virtual_path: '/nested/',
	});
	assert.equal(calls[3].options.method, 'DELETE');
});

test('direct MEGA downloads return after acceptance and finish through the tracked queue', async () => {
	installBrowserStubs();
	const { useUploadQueueStore } = await import('../src/stores/uploadQueue.js');
	setActivePinia(createPinia());
	const store = useUploadQueueStore();
	const originals = {
		inspectMegaLink: api.inspectMegaLink,
		downloadMegaLink: api.downloadMegaLink,
	};
	let closeBody;
	const body = new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode('abc'));
			closeBody = () => controller.close();
		},
	});
	api.inspectMegaLink = async () => ({ data: { file_name: 'fixture.bin', size: 3 } });
	api.downloadMegaLink = async () => new Response(body, {
		status: 200,
		headers: { 'Content-Length': '3' },
	});

	try {
		await store.downloadMegaLink('https://mega.nz/file/id#key');
		assert.equal(store.uploads[0].name, 'fixture.bin');
		assert.equal(store.uploads[0].status, 'downloading');
		closeBody();
		await tick();
		assert.equal(store.uploads[0].status, 'completed');
		assert.equal(store.uploads[0].progress_percentage, 100);
	} finally {
		Object.assign(api, originals);
	}
});

test('MEGA imports reconcile replayed events and own remote cancellation', async () => {
	installBrowserStubs();
	const { useUploadQueueStore } = await import('../src/stores/uploadQueue.js');
	setActivePinia(createPinia());
	const store = useUploadQueueStore();
	const originals = {
		importMegaLink: api.importMegaLink,
		createUploadSocket: api.createUploadSocket,
		cancelMegaLinkImport: api.cancelMegaLinkImport,
	};
	const sockets = [];
	const cancelled = [];
	api.importMegaLink = async () => ({ data: { upload_id: `remote-${sockets.length + 1}`, file_name: 'fixture.bin', size: 36 } });
	api.createUploadSocket = () => {
		const socket = { closeCalled: false, close() { this.closeCalled = true; } };
		sockets.push(socket);
		return socket;
	};
	api.cancelMegaLinkImport = async (uploadId) => { cancelled.push(uploadId); };
	let completed = 0;

	try {
		await store.importMegaLink('https://mega.nz/file/id#key', '/current/', () => { completed += 1; });
		assert.equal(store.uploads[0].remoteUploadId, 'remote-1');
		assert.equal(store.uploads[0].status, 'uploading');

		sockets[0].onmessage({ data: JSON.stringify({ type: 'upload:started', percent: 0, status: 'uploading' }) });
		sockets[0].onmessage({ data: JSON.stringify({ type: 'upload:progress', percent: 67, status: 'uploading' }) });
		assert.equal(store.uploads[0].progress_percentage, 67);
		sockets[0].onmessage({ data: JSON.stringify({ type: 'upload:complete', percent: 100, status: 'completed' }) });
		assert.equal(store.uploads[0].status, 'completed');
		assert.equal(completed, 1);

		await store.importMegaLink('https://mega.nz/file/id#key', '/current/');
		const cancellable = store.uploads[0];
		store.closeOperation(cancellable.id);
		await tick();
		assert.deepEqual(cancelled, ['remote-2']);
		assert.equal(store.uploads.find((item) => item.id === cancellable.id).status, 'cancelled');
		assert.equal(sockets[1].closeCalled, true);

		await store.importMegaLink('https://mega.nz/file/id#key', '/current/');
		sockets[2].onmessage({ data: JSON.stringify({ type: 'upload:error', status: 'failed', message: 'provider failed' }) });
		assert.equal(store.uploads[0].status, 'failed');
		assert.equal(store.uploads[0].error, 'provider failed');

		await store.importMegaLink('https://mega.nz/file/id#key', '/current/');
		store.clearOperations();
		await tick();
		assert.deepEqual(cancelled, ['remote-2', 'remote-4']);
		assert.equal(sockets[3].closeCalled, true);
		assert.equal(store.uploads.length, 0);
	} finally {
		Object.assign(api, originals);
	}
});

test('MEGA link modal compiles with an accessible labelled dialog and both actions', async () => {
	const filename = new URL('../src/components/MegaLinkModal.vue', import.meta.url);
	const source = await readFile(filename, 'utf8');
	const { descriptor, errors } = parse(source, { filename: filename.pathname });
	assert.deepEqual(errors, []);
	const compiled = compileTemplate({
		id: 'mega-link-modal',
		filename: filename.pathname,
		source: descriptor.template.content,
	});
	assert.deepEqual(compiled.errors, []);
	assert.match(descriptor.template.content, /role="dialog"/);
	assert.match(descriptor.template.content, /aria-modal="true"/);
	assert.match(descriptor.template.content, /<label[^>]+for="mega-link-url"/);
	assert.match(descriptor.template.content, /@click="submit\('download'\)"/);
	assert.match(descriptor.template.content, /@click="submit\('import'\)"/);
});
