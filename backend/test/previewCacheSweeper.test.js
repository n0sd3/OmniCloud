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

// server.js chama sweepPreviewCache duas vezes, uma pra previewCacheDir e
// outra pra thumbnailCacheDir (que cresce igual, sem nunca ter sido varrido).
// Nao ha sweeper dedicado: prova que a mesma funcao cobre os dois diretorios
// de forma independente.
test('sweepPreviewCache sweeps the thumbnail cache dir independently of the preview cache dir', async (t) => {
	const previewDir = await createCacheDir(t);
	const thumbnailDir = await createCacheDir(t);
	const oldPreview = path.join(previewDir, 'old.jpg');
	const oldThumbnail = path.join(thumbnailDir, 'old.jpg');
	await fs.writeFile(oldPreview, 'old');
	await fs.writeFile(oldThumbnail, 'old');

	const oldTime = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
	await fs.utimes(oldPreview, oldTime, oldTime);
	await fs.utimes(oldThumbnail, oldTime, oldTime);

	const removedPreview = await sweepPreviewCache(previewDir, { maxAgeMs: 7 * 24 * 60 * 60 * 1000 });
	const removedThumbnail = await sweepPreviewCache(thumbnailDir, { maxAgeMs: 7 * 24 * 60 * 60 * 1000 });

	assert.equal(removedPreview, 1);
	assert.equal(removedThumbnail, 1);
	await assert.rejects(fs.access(oldPreview));
	await assert.rejects(fs.access(oldThumbnail));
});

test('sweepPreviewCache leaves temp directories alone and tolerates a missing cache dir', async (t) => {
	const cacheDir = await createCacheDir(t);
	await fs.mkdir(path.join(cacheDir, '.tmp-archive-abc'));

	const removed = await sweepPreviewCache(cacheDir, { maxAgeMs: 0 });
	assert.equal(removed, 0);

	const removedMissing = await sweepPreviewCache(path.join(cacheDir, 'does-not-exist'));
	assert.equal(removedMissing, 0);
});
