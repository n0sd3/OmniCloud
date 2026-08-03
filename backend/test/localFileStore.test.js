import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { afterEach, beforeEach } from 'node:test';
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
