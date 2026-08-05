import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sweepPreviewCache } from '../src/services/previewCacheSweeper.js';

async function createCacheDir(t) {
	const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'omnicloud-preview-sweep-'));
	t.after(() => fs.rm(cacheDir, { recursive: true, force: true }));
	return cacheDir;
}

test('sweepPreviewCache removes only entries older than maxAgeMs', async (t) => {
	const cacheDir = await createCacheDir(t);
	const freshPath = path.join(cacheDir, 'fresh.jpg');
	const oldPath = path.join(cacheDir, 'old.entries.json');
	await fs.writeFile(freshPath, 'fresh');
	await fs.writeFile(oldPath, 'old');

	const oldTime = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
	await fs.utimes(oldPath, oldTime, oldTime);

	const removed = await sweepPreviewCache(cacheDir, { maxAgeMs: 7 * 24 * 60 * 60 * 1000 });

	assert.equal(removed, 1);
	await assert.rejects(fs.access(oldPath));
	await assert.doesNotReject(fs.access(freshPath));
});

test('sweepPreviewCache leaves temp directories alone and tolerates a missing cache dir', async (t) => {
	const cacheDir = await createCacheDir(t);
	await fs.mkdir(path.join(cacheDir, '.tmp-archive-abc'));

	const removed = await sweepPreviewCache(cacheDir, { maxAgeMs: 0 });
	assert.equal(removed, 0);

	const removedMissing = await sweepPreviewCache(path.join(cacheDir, 'does-not-exist'));
	assert.equal(removedMissing, 0);
});
