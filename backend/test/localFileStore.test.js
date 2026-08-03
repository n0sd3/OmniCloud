import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { afterEach, beforeEach } from 'node:test';
import fsSync from 'node:fs';
import { Readable } from 'node:stream';

const { createLocalFileStore } = await import('../src/services/localFileStore.js');

let rootDir;
let store;

const file = {
	user_id: 'user/raw-id',
	cloud_account_id: 'account/raw-id',
	remote_file_id: 'remote/raw-id',
	size: 6,
	remote_modified_time: '2026-08-02T00:00:00Z',
};

async function read(stream) {
	const chunks = [];
	for await (const chunk of stream) chunks.push(chunk);
	return Buffer.concat(chunks).toString();
}

function pathsFor(record) {
	const key = crypto
		.createHash('sha256')
		.update(JSON.stringify([record.user_id, record.cloud_account_id, record.remote_file_id]))
		.digest('hex');
	return {
		data: path.join(rootDir, `${key}.data`),
		sidecar: path.join(rootDir, `${key}.json`),
	};
}

beforeEach(async () => {
	rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'omnicloud-file-store-'));
	store = createLocalFileStore({ rootDir, logger: { warn() {} } });
});

afterEach(async () => {
	await fs.rm(rootDir, { recursive: true, force: true });
});

test('publishes content and sidecar, then opens a valid Range', async () => {
	await store.writeFromStream(file, Readable.from(['abcdef']));
	assert.equal(await read(await store.openReadStream(file, { start: 1, end: 3 })), 'bcd');
});

test('same size with a newer remote timestamp is invalid', async () => {
	await store.writeFromStream(file, Readable.from(['abcdef']));
	assert.equal(await store.getValidPath({ ...file, remote_modified_time: '2026-08-03T00:00:00Z' }), null);
});

test('a sidecar publish failure invalidates same-sized replacement content', async () => {
	await store.writeFromStream(file, Readable.from(['abcdef']));
	const { data, sidecar } = pathsFor(file);
	const replacement = { ...file, remote_modified_time: '2026-08-03T00:00:00Z' };
	const rename = fs.rename;
	let dataPublished = false;

	fs.rename = async (from, to) => {
		if (to === data) dataPublished = true;
		if (to === sidecar && dataPublished) throw new Error('sidecar publication blocked');
		return rename(from, to);
	};
	try {
		await assert.rejects(store.writeFromStream(replacement, Readable.from(['ghijkl'])), /sidecar publication blocked/);
	} finally {
		fs.rename = rename;
	}

	assert.equal(await store.getValidPath(file), null);
	await assert.rejects(fs.stat(data), { code: 'ENOENT' });
	await assert.rejects(fs.stat(sidecar), { code: 'ENOENT' });
});

test('concurrent versions cannot publish mixed content and metadata', async () => {
	const newer = { ...file, remote_modified_time: '2026-08-03T00:00:00Z' };
	const { data, sidecar } = pathsFor(file);
	const rename = fs.rename;
	let releaseOlder;
	let olderSidecarReached;
	let newerDataReached;
	let dataPublishes = 0;
	const waitForOlderSidecar = new Promise((resolve) => { olderSidecarReached = resolve; });
	const waitForNewerData = new Promise((resolve) => { newerDataReached = resolve; });
	const holdOlderSidecar = new Promise((resolve) => { releaseOlder = resolve; });

	fs.rename = async (from, to) => {
		if (to === data && String(from).endsWith('.tmp') && ++dataPublishes === 2) newerDataReached();
		if (to === sidecar && JSON.parse(await fs.readFile(from, 'utf8')).remoteModifiedTime === file.remote_modified_time) {
			olderSidecarReached();
			await holdOlderSidecar;
		}
		return rename(from, to);
	};
	try {
		const olderWrite = store.writeFromStream(file, Readable.from(['abcdef']));
		await waitForOlderSidecar;
		const newerWrite = store.writeFromStream(newer, Readable.from(['ghijkl']));
		const interleaved = await Promise.race([
			waitForNewerData.then(() => true),
			new Promise((resolve) => setTimeout(() => resolve(false), 25)),
		]);
		if (interleaved) await newerWrite;
		releaseOlder();
		await Promise.all([olderWrite, newerWrite]);
	} finally {
		fs.rename = rename;
		releaseOlder();
	}

	assert.equal(await store.getValidPath(file), null);
	assert.equal(await read(await store.openReadStream(newer)), 'ghijkl');
});

test('conservatively invalidates records without a remote version', async () => {
	const unversioned = { ...file, remote_modified_time: null };
	await store.writeFromStream(unversioned, Readable.from(['abcdef']));
	await store.reconcile([unversioned], [unversioned]);
	assert.equal(await store.getValidPath(unversioned), null);
});

test('capture keeps provider stream flowing when the local write fails', async () => {
	const brokenRoot = path.join(rootDir, 'not-a-directory');
	await fs.writeFile(brokenRoot, 'blocked');
	const brokenStore = createLocalFileStore({ rootDir: brokenRoot, logger: { warn() {} } });
	const capture = brokenStore.captureUpload(Readable.from(['payload']), 'upload-1');
	assert.equal(await read(capture.stream), 'payload');
	assert.equal(await capture.completed, null);
});

test('capture waits for local drain before forwarding the next upload chunk', async () => {
	const originalWrite = fsSync.WriteStream.prototype.write;
	const originalEmit = fsSync.WriteStream.prototype.emit;
	let blockedWriter;
	let blockedOnce = false;
	let released = false;
	fsSync.WriteStream.prototype.write = function write(...args) {
		const result = originalWrite.apply(this, args);
		if (String(this.path).startsWith(rootDir) && !blockedOnce) {
			blockedOnce = true;
			blockedWriter = this;
			return false;
		}
		return result;
	};
	fsSync.WriteStream.prototype.emit = function emit(event, ...args) {
		if (this === blockedWriter && event === 'drain' && !released) return false;
		return originalEmit.call(this, event, ...args);
	};

	try {
		const capture = store.captureUpload(Readable.from(['first', 'second']), 'backpressure');
		let forwarded = '';
		capture.stream.on('data', (chunk) => { forwarded += chunk.toString(); });
		const ended = new Promise((resolve, reject) => {
			capture.stream.once('end', resolve);
			capture.stream.once('error', reject);
		});
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(forwarded, 'first');
		released = true;
		originalEmit.call(blockedWriter, 'drain');
		await ended;
		assert.equal(forwarded, 'firstsecond');
		await capture.discard();
	} finally {
		fsSync.WriteStream.prototype.write = originalWrite;
		fsSync.WriteStream.prototype.emit = originalEmit;
	}
});

test('path names hide raw identity values and incomplete temps are misses', async () => {
	await fs.writeFile(path.join(rootDir, 'incomplete.data.tmp'), 'abcdef');
	assert.equal(await store.getValidPath(file), null);

	await store.writeFromStream(file, Readable.from(['abcdef']));
	const validPath = await store.getValidPath(file);
	assert.ok(validPath);
	assert.equal(validPath.includes(file.user_id), false);
	assert.equal(validPath.includes(file.cloud_account_id), false);
	assert.equal(validPath.includes(file.remote_file_id), false);
});

test('invalid JSON sidecar is a miss', async () => {
	await store.writeFromStream(file, Readable.from(['abcdef']));
	await fs.writeFile(pathsFor(file).sidecar, '{not-json');
	assert.equal(await store.getValidPath(file), null);
});

test('invalidate removes both content and sidecar', async () => {
	await store.writeFromStream(file, Readable.from(['abcdef']));
	await store.invalidate(file);
	await assert.rejects(fs.stat(pathsFor(file).data), { code: 'ENOENT' });
	await assert.rejects(fs.stat(pathsFor(file).sidecar), { code: 'ENOENT' });
});

test('rebind updates the sidecar without rewriting content', async () => {
	await store.writeFromStream(file, Readable.from(['abcdef']));
	const { data, sidecar } = pathsFor(file);
	const before = await fs.stat(data);
	const rebound = { ...file, remote_modified_time: '2026-08-04T00:00:00Z' };

	assert.equal(await store.rebind(rebound), true);
	assert.equal(await fs.readFile(data, 'utf8'), 'abcdef');
	assert.equal((await fs.stat(data)).ino, before.ino);
	assert.equal(JSON.parse(await fs.readFile(sidecar, 'utf8')).remoteModifiedTime, rebound.remote_modified_time);
	assert.equal(await store.getValidPath(rebound), data);
});

test('cleanupTemps removes only temporary files', async () => {
	const temp = path.join(rootDir, 'leftover.data.tmp');
	const permanent = path.join(rootDir, 'keep.data');
	await fs.writeFile(temp, 'temp');
	await fs.writeFile(permanent, 'keep');

	await store.cleanupTemps();
	await assert.rejects(fs.stat(temp), { code: 'ENOENT' });
	assert.equal(await fs.readFile(permanent, 'utf8'), 'keep');
});
