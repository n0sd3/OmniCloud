import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const taskRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'omnicloud-file-cache-sync-'));
process.env.DATABASE_PATH = path.join(taskRoot, 'omnicloud.db');
process.env.FILE_CACHE_PATH = path.join(taskRoot, 'files');
process.env.APP_MODE = 'local';

const [
	{ db, LOCAL_USER_ID },
	{ createFileMetadata, getFileByRemoteId },
	{ createLocalFileStore },
	{ fileCacheService },
	{ BaseCloudAdapter },
	{ syncAccount, runDeltaSync },
] = await Promise.all([
	import('../src/config/database.js'),
	import('../src/services/fileService.js'),
	import('../src/services/localFileStore.js'),
	import('../src/services/fileCacheService.js'),
	import('../src/adapters/BaseCloudAdapter.js'),
	import('../src/services/syncService.js'),
]);

const account = {
	id: 'account-1',
	user_id: LOCAL_USER_ID,
	email: 'local@example.com',
	provider: 'base',
	encrypted_credentials: '',
	status: 'active',
};
const store = createLocalFileStore({ rootDir: process.env.FILE_CACHE_PATH });
let remoteFiles = [];

function snapshot(remoteFileId, overrides = {}) {
	return {
		virtual_path: '/Docs/',
		file_name: `${remoteFileId}.txt`,
		is_folder: false,
		size: 3,
		mime_type: 'text/plain',
		remote_file_id: remoteFileId,
		remote_modified_time: '2026-08-02T12:00:00.000Z',
		...overrides,
	};
}

async function cache(record) {
	await store.writeFromStream(record, Readable.from(['abc']));
	if (record.remote_modified_time) assert.ok(await store.getValidPath(record));
}

function dataPath(record) {
	const key = crypto.createHash('sha256')
		.update(JSON.stringify([record.user_id, record.cloud_account_id, record.remote_file_id]))
		.digest('hex');
	return path.join(process.env.FILE_CACHE_PATH, `${key}.data`);
}

test.before(() => {
	db.prepare(`
		INSERT INTO cloud_accounts (
			id, user_id, email, provider, encrypted_credentials,
			total_space, used_space, status
		) VALUES (?, ?, ?, 'base', '', 1000, 0, 'active')
	`).run(account.id, LOCAL_USER_ID, account.email);
	BaseCloudAdapter.prototype.fetchStructure = async () => remoteFiles;
	BaseCloudAdapter.prototype.getStorageSummary = async () => ({ totalSpace: 1000, usedSpace: 3 });
});

test.after(async () => {
	db.close();
	await fs.rm(taskRoot, { recursive: true, force: true });
});

test('external same-id modification invalidates the old local version', async () => {
	const oldFile = createFileMetadata({
		user_id: LOCAL_USER_ID,
		cloud_account_id: account.id,
		...snapshot('modified'),
	});
	await cache(oldFile);
	remoteFiles = [snapshot('modified', { remote_modified_time: '2026-08-03T12:00:00.000Z' })];

	await syncAccount(LOCAL_USER_ID, account);

	assert.equal(await store.getValidPath(oldFile), null);
});

test('removed remote file removes local content and sidecar during delta sync', async () => {
	const removedFile = createFileMetadata({
		user_id: LOCAL_USER_ID,
		cloud_account_id: account.id,
		...snapshot('removed'),
	});
	await cache(removedFile);
	remoteFiles = [];

	await runDeltaSync(LOCAL_USER_ID);

	assert.equal(await store.getValidPath(removedFile), null);
});

test('known rename preserves bytes and rebinds the sidecar', async () => {
	const oldFile = createFileMetadata({
		user_id: LOCAL_USER_ID,
		cloud_account_id: account.id,
		...snapshot('renamed', { file_name: 'before.txt' }),
	});
	await cache(oldFile);
	remoteFiles = [snapshot('renamed', {
		file_name: 'after.txt',
		remote_modified_time: '2026-08-03T12:00:00.000Z',
	})];

	await syncAccount(LOCAL_USER_ID, account, { preserveCacheRemoteIds: ['renamed'] });

	const renamedFile = getFileByRemoteId(LOCAL_USER_ID, account.id, 'renamed');
	assert.ok(await store.getValidPath(renamedFile));
});

test('records without a remote modification time invalidate on every snapshot', async () => {
	const oldFile = createFileMetadata({
		user_id: LOCAL_USER_ID,
		cloud_account_id: account.id,
		...snapshot('unversioned', { remote_modified_time: null }),
	});
	await cache(oldFile);
	remoteFiles = [snapshot('unversioned', { remote_modified_time: null })];

	await syncAccount(LOCAL_USER_ID, account);

	await assert.rejects(fs.access(dataPath(oldFile)));
});

test('cache reconciliation failure does not roll back synchronized metadata', async () => {
	const originalReconcile = fileCacheService.reconcileAccount;
	const originalError = console.error;
	const errors = [];
	fileCacheService.reconcileAccount = async () => { throw new Error('cache unavailable'); };
	console.error = (...args) => errors.push(args);
	remoteFiles = [snapshot('metadata-survives')];
	try {
		await syncAccount(LOCAL_USER_ID, account);
	} finally {
		fileCacheService.reconcileAccount = originalReconcile;
		console.error = originalError;
	}

	assert.ok(getFileByRemoteId(LOCAL_USER_ID, account.id, 'metadata-survives'));
	assert.equal(errors[0][0], `Local cache reconciliation failed for account ${account.id}:`);
});
