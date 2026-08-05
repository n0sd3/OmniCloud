import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { listArchiveEntries, parse7zList, parseUnzipList } from '../src/services/archiveService.js';

async function createCacheDir(t) {
	const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'omnicloud-archive-'));
	t.after(() => fs.rm(cacheDir, { recursive: true, force: true }));
	return cacheDir;
}

function fakeOpenStream() {
	return async () => Readable.from(['fake bytes']);
}

const UNZIP_OUTPUT = `Archive:  sample.zip
  Length      Date    Time    Name
---------  ---------- -----   ----
      612  2026-07-01 10:12   readme.md
        0  2026-07-01 10:12   docs/
    10240  2026-07-01 10:13   docs/manual with spaces.pdf
---------                     -------
    10852                     3 files`;

test('parseUnzipList reads name and size, keeping spaces in names', () => {
	const entries = parseUnzipList(UNZIP_OUTPUT);

	assert.deepEqual(entries, [
		{ name: 'readme.md', size: 612 },
		{ name: 'docs/', size: 0 },
		{ name: 'docs/manual with spaces.pdf', size: 10240 },
	]);
});

test('parseUnzipList returns nothing for output without a table', () => {
	assert.deepEqual(parseUnzipList('cannot find zipfile directory'), []);
});

const SEVEN_ZIP_OUTPUT = `2026-07-01 10:12:00 ....A          612          600  readme.md
2026-07-01 10:12:00 D....            0            0  docs
2026-07-01 10:13:00 ....A        10240        10100  docs/manual with spaces.pdf`;

test('parse7zList reads name and size from a realistic "7z l -ba" sample, keeping spaces', () => {
	const entries = parse7zList(SEVEN_ZIP_OUTPUT);

	assert.deepEqual(entries, [
		{ name: 'readme.md', size: 612 },
		{ name: 'docs', size: 0 },
		{ name: 'docs/manual with spaces.pdf', size: 10240 },
	]);
});

test('listArchiveEntries rejects an unsupported extension with statusCode 415', async () => {
	await assert.rejects(
		listArchiveEntries({
			userId: 'user-1',
			file: { file_name: 'notes.txt', size: 10 },
			// nao deve nem chegar a abrir o stream: a checagem de extensao vem antes.
			openStream: async () => { throw new Error('should not be called'); },
		}),
		(error) => {
			assert.equal(error.statusCode, 415);
			return true;
		},
	);
});

test('listArchiveEntries rejects with statusCode 422 when the tool fails, and cleans up its temp dir', async (t) => {
	const cacheDir = await createCacheDir(t);

	await assert.rejects(
		listArchiveEntries({
			userId: 'user-1',
			file: { file_name: 'sample.zip', size: 10 },
			openStream: fakeOpenStream(),
			cacheDir,
			execute: async () => { throw new Error('unzip: not a valid archive'); },
		}),
		(error) => {
			assert.equal(error.statusCode, 422);
			return true;
		},
	);

	const remaining = await fs.readdir(cacheDir);
	assert.deepEqual(remaining.filter((name) => name.startsWith('.tmp-archive-')), []);
});

test('listArchiveEntries truncates at maxEntries and reports truncated', async (t) => {
	const cacheDir = await createCacheDir(t);
	const stdout = `Archive:  many.zip
  Length      Date    Time    Name
---------  ---------- -----   ----
        1  2026-07-01 10:12   a.txt
        1  2026-07-01 10:12   b.txt
        1  2026-07-01 10:12   c.txt
---------                     -------
        3                     3 files`;

	const result = await listArchiveEntries({
		userId: 'user-1',
		file: { file_name: 'many.zip', size: 10 },
		openStream: fakeOpenStream(),
		cacheDir,
		execute: async () => ({ stdout }),
		maxEntries: 2,
	});

	assert.equal(result.entries.length, 2);
	assert.equal(result.truncated, true);
});

test('listArchiveEntries caches the listing and serves the second call without invoking the tool', async (t) => {
	const cacheDir = await createCacheDir(t);
	const stdout = `Archive:  sample.zip
  Length      Date    Time    Name
---------  ---------- -----   ----
      612  2026-07-01 10:12   readme.md
---------                     -------
      612                     1 file`;

	let calls = 0;
	const execute = async () => {
		calls += 1;
		return { stdout };
	};
	const file = { file_name: 'sample.zip', size: 10 };

	const first = await listArchiveEntries({
		userId: 'user-1',
		file,
		openStream: fakeOpenStream(),
		cacheDir,
		execute,
	});
	assert.equal(calls, 1);
	assert.deepEqual(first.entries, [{ name: 'readme.md', size: 612 }]);

	const second = await listArchiveEntries({
		userId: 'user-1',
		file,
		openStream: async () => { throw new Error('should not open the file on a cache hit'); },
		cacheDir,
		execute: async () => { throw new Error('should not invoke the tool on a cache hit'); },
	});
	assert.equal(calls, 1, 'the tool was not invoked again');
	assert.deepEqual(second, first);
});
