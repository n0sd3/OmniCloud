import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createPinia, setActivePinia } from 'pinia';
import { compileTemplate, parse } from '@vue/compiler-sfc';
import { api } from '../src/services/api.js';
import { activateFocusTrap } from '../src/utils/focusTrap.js';
import { looksLikeMegaFileLink } from '../src/utils/megaLink.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function installBrowserStubs() {
	const timers = [];
	globalThis.window = {
		localStorage: { getItem: () => null, setItem: () => {} },
		confirm: () => true,
		setTimeout(callback) {
			const timer = { callback, cleared: false };
			timers.push(timer);
			return timer;
		},
		clearTimeout(timer) {
			if (timer) timer.cleared = true;
		},
	};
	if (!globalThis.navigator) globalThis.navigator = { language: 'en' };
	globalThis.URL.createObjectURL = () => 'blob:mega';
	globalThis.URL.revokeObjectURL = () => {};
	globalThis.document = {
		documentElement: { setAttribute: () => {} },
		body: { appendChild: () => {} },
		createElement: () => ({ click: () => {}, remove: () => {} }),
	};
	return timers;
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
	assert.equal(looksLikeMegaFileLink('https://mega.nz/folder/id#!abc!key'), false);
	assert.equal(looksLikeMegaFileLink('https://mega.nz/not-a-file#!abc!key'), false);
});

test('trims user input but rejects malformed values', () => {
	assert.equal(looksLikeMegaFileLink('  https://mega.nz/file/abc#key  '), true);
	assert.equal(looksLikeMegaFileLink('not a URL'), false);
	assert.equal(looksLikeMegaFileLink(''), false);
});

test('MEGA link API methods use authenticated requests and native download form submission', async () => {
	const originalFetch = globalThis.fetch;
	const calls = [];
	const appended = [];
	const submitted = [];
	const removed = [];
	const originalDocument = globalThis.document;
	const originalWindow = globalThis.window;
	globalThis.window = { setTimeout: () => 1, clearTimeout: () => {} };
	globalThis.document = {
		body: { appendChild: (element) => appended.push(element) },
		createElement(tag) {
			const element = {
				tag,
				children: [],
				appendChild(child) { this.children.push(child); },
				remove() { removed.push(this); },
				submit() { submitted.push(this); },
				setAttribute(name, value) { this[name] = value; },
			};
			return element;
		},
	};
	globalThis.fetch = async (url, options) => {
		calls.push({ url, options });
		if (options.method === 'DELETE') return new Response(null, { status: 204 });
		return Response.json({ data: { upload_id: 'upload-1' } }, { status: url.endsWith('/import') ? 202 : 200 });
	};

	try {
		await api.inspectMegaLink('https://mega.nz/file/id#key');
		api.downloadMegaLink('https://mega.nz/file/id#key');
		await api.importMegaLink('https://mega.nz/file/id#key', '/nested/');
		await api.cancelMegaLinkImport('upload-1');
	} finally {
		globalThis.fetch = originalFetch;
		globalThis.document = originalDocument;
		globalThis.window = originalWindow;
	}

	assert.equal(calls.length, 3, 'native download does not fetch or buffer the body in JavaScript');
	assert.equal(calls[0].options.credentials, 'include');
	assert.deepEqual(JSON.parse(calls[0].options.body), { link: 'https://mega.nz/file/id#key' });
	assert.deepEqual(JSON.parse(calls[1].options.body), {
		link: 'https://mega.nz/file/id#key',
		virtual_path: '/nested/',
	});
	assert.equal(calls[2].options.method, 'DELETE');
	assert.equal(submitted.length, 1);
	assert.equal(submitted[0].method, 'POST');
	assert.match(submitted[0].action, /\/api\/mega-links\/download$/);
	assert.equal(submitted[0].children[0].name, 'link');
	assert.equal(submitted[0].children[0].value, 'https://mega.nz/file/id#key');
	assert.equal(appended.some((element) => element.tag === 'iframe'), true);
	assert.equal(removed.includes(submitted[0]), true);
});

test('direct MEGA downloads are handed to the browser without Blob or chunk accumulation', async () => {
	installBrowserStubs();
	const { useUploadQueueStore } = await import('../src/stores/uploadQueue.js');
	setActivePinia(createPinia());
	const store = useUploadQueueStore();
	const originals = {
		inspectMegaLink: api.inspectMegaLink,
		downloadMegaLink: api.downloadMegaLink,
	};
	const OriginalBlob = globalThis.Blob;
	globalThis.Blob = class ForbiddenMegaDownloadBlob {
		constructor() {
			throw new Error('MEGA download must not allocate a Blob');
		}
	};
	let nativeCalls = 0;
	api.inspectMegaLink = async () => ({ data: { file_name: 'fixture.bin', size: 3 } });
	api.downloadMegaLink = () => { nativeCalls += 1; };

	try {
		await store.downloadMegaLink('https://mega.nz/file/id#key');
		assert.equal(store.uploads[0].name, 'fixture.bin');
		assert.equal(store.uploads[0].status, 'completed');
		assert.equal(store.uploads[0].progress_percentage, 100);
		assert.equal(nativeCalls, 1);
	} finally {
		Object.assign(api, originals);
		globalThis.Blob = OriginalBlob;
	}
});

test('MEGA imports reconcile replayed events and own remote cancellation', async () => {
	const timers = installBrowserStubs();
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
	let importCount = 0;
	api.importMegaLink = async () => {
		importCount += 1;
		return { data: { upload_id: `remote-${importCount}`, file_name: 'fixture.bin', size: 36 } };
	};
	api.createUploadSocket = () => {
		const socket = {
			closeCalled: false,
			close() { this.closeCalled = true; },
			fail() {
				this.onerror?.(new Event('error'));
				this.onclose?.(new CloseEvent('close'));
			},
		};
		sockets.push(socket);
		return socket;
	};
	api.cancelMegaLinkImport = async (uploadId) => { cancelled.push(uploadId); };
	let completed = 0;
	const runNextTimer = () => {
		const timer = timers.find((item) => !item.cleared && !item.ran);
		assert.ok(timer, 'expected a pending reconnect timer');
		timer.ran = true;
		timer.callback();
		return timer;
	};

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

		await store.importMegaLink('https://mega.nz/file/id#key', '/current/', () => { completed += 1; });
		sockets[4].fail();
		assert.equal(timers.filter((timer) => !timer.cleared && !timer.ran).length, 1, 'error and close schedule only one reconnect');
		runNextTimer();
		assert.equal(sockets[4].closeCalled, true, 'failed socket closes before its replacement opens');
		assert.equal(sockets.length, 6);
		sockets[5].onmessage({ data: JSON.stringify({ type: 'upload:complete', percent: 100, status: 'completed' }) });
		assert.equal(store.uploads[0].status, 'completed', 'replayed terminal event settles the queue after reconnect');
		assert.equal(completed, 2);

		await store.importMegaLink('https://mega.nz/file/id#key', '/current/');
		let activeSocket = sockets[6];
		for (let retry = 0; retry < 3; retry += 1) {
			activeSocket.fail();
			runNextTimer();
			activeSocket = sockets.at(-1);
		}
		activeSocket.fail();
		assert.equal(store.uploads[0].status, 'uploading', 'transport exhaustion does not claim the backend import failed');
		assert.match(store.uploads[0].error, /progress|progres/i);
		assert.equal(timers.filter((timer) => !timer.cleared && !timer.ran).length, 0, 'retry budget is bounded');

		store.closeOperation(store.uploads[0].id);
		await store.importMegaLink('https://mega.nz/file/id#key', '/current/');
		const socketsBeforeCancel = sockets.length;
		sockets.at(-1).fail();
		const scheduled = timers.find((timer) => !timer.cleared && !timer.ran);
		store.closeOperation(store.uploads[0].id);
		assert.equal(scheduled.cleared, true, 'cancelling clears a pending reconnect timer');
		scheduled.callback();
		assert.equal(sockets.length, socketsBeforeCancel, 'a stale timer cannot open a duplicate socket');
	} finally {
		Object.assign(api, originals);
	}
});

test('focus trap handles Tab, Escape, cleanup, and restores the trigger', () => {
	const originalDocument = globalThis.document;
	const listeners = new Map();
	const trigger = { focusCalls: 0, focus() { this.focusCalls += 1; fakeDocument.activeElement = this; } };
	const input = { disabled: false, focusCalls: 0, focus() { this.focusCalls += 1; fakeDocument.activeElement = this; } };
	const button = { disabled: false, focusCalls: 0, focus() { this.focusCalls += 1; fakeDocument.activeElement = this; } };
	const container = {
		contains: (element) => element === input || element === button,
		querySelectorAll: () => [input, button],
	};
	const fakeDocument = {
		activeElement: trigger,
		addEventListener: (type, listener) => listeners.set(type, listener),
		removeEventListener: (type, listener) => {
			if (listeners.get(type) === listener) listeners.delete(type);
		},
	};
	globalThis.document = fakeDocument;
	let escaped = 0;

	try {
		const deactivate = activateFocusTrap(container, { initialFocus: input, onEscape: () => { escaped += 1; } });
		assert.equal(input.focusCalls, 1);
		fakeDocument.activeElement = button;
		listeners.get('keydown')({ key: 'Tab', shiftKey: false, preventDefault() {} });
		assert.equal(fakeDocument.activeElement, input);
		listeners.get('keydown')({ key: 'Tab', shiftKey: true, preventDefault() {} });
		assert.equal(fakeDocument.activeElement, button);
		listeners.get('keydown')({ key: 'Escape', preventDefault() {} });
		assert.equal(escaped, 1);
		deactivate();
		assert.equal(listeners.has('keydown'), false);
		assert.equal(trigger.focusCalls, 1);
	} finally {
		globalThis.document = originalDocument;
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

test('DriveShell hides the MEGA action unless My Drive explicitly enables it', async () => {
	const shell = await readFile(new URL('../src/components/DriveShell.vue', import.meta.url), 'utf8');
	const drive = await readFile(new URL('../src/views/MyDriveView.vue', import.meta.url), 'utf8');
	assert.match(shell, /showMegaLinkAction:\s*\{\s*type:\s*Boolean,\s*default:\s*false\s*\}/);
	assert.equal((shell.match(/v-if="showMegaLinkAction"/g) || []).length, 2);
	assert.match(drive, /show-mega-link-action/);
});
