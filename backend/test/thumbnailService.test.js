import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const { generateThumbnail, getThumbnailKind, getThumbnailCacheKey } = await import('../src/services/thumbnailService.js');

async function createCache(t) {
	const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'omnicloud-thumbnails-'));
	t.after(() => fs.rm(cacheDir, { recursive: true, force: true }));
	return cacheDir;
}

test('getThumbnailKind classifies only generated-cover formats', () => {
	const cases = [
		[{ file_name: 'clip.mp4', mime_type: 'video/mp4' }, 'video'],
		[{ file_name: 'report.pdf', mime_type: 'application/pdf' }, 'pdf'],
		[{ file_name: 'report.docx', mime_type: 'application/octet-stream' }, 'document'],
		[{ file_name: 'sheet.ods', mime_type: 'application/vnd.oasis.opendocument.spreadsheet' }, 'document'],
		[{ file_name: 'notes.txt', mime_type: 'text/plain' }, 'text'],
		[{ file_name: 'data.json', mime_type: 'application/json' }, 'text'],
		[{ file_name: 'photo.jpg', mime_type: 'image/jpeg' }, null],
		[{ file_name: 'song.mp3', mime_type: 'audio/mpeg' }, null],
		[{ file_name: 'archive.zip', mime_type: 'application/zip' }, null],
		[{ file_name: 'folder', is_folder: true }, null],
	];

	for (const [file, expected] of cases) {
		assert.equal(getThumbnailKind(file), expected, file.file_name);
	}
});

test('getThumbnailCacheKey isolates users and file revisions', () => {
	const file = {
		id: 'file-1',
		remote_modified_time: '2026-08-02T12:00:00.000Z',
		size: 42,
	};
	const baseline = getThumbnailCacheKey('user-1', file);

	assert.match(baseline, /^[a-f0-9]{64}$/);
	assert.notEqual(getThumbnailCacheKey('user-2', file), baseline);
	assert.notEqual(getThumbnailCacheKey('user-1', { ...file, id: 'file-2' }), baseline);
	assert.notEqual(getThumbnailCacheKey('user-1', { ...file, remote_modified_time: '2026-08-03T12:00:00.000Z' }), baseline);
	assert.notEqual(getThumbnailCacheKey('user-1', { ...file, size: 43 }), baseline);
});

test('generateThumbnail creates a video cover and reuses its cache', async (t) => {
	const cacheDir = await createCache(t);
	const file = { id: 'video-1', file_name: 'clip.mp4', mime_type: 'video/mp4', size: 5 };
	const execute = async (program, args) => {
		assert.equal(program, 'ffmpeg');
		await fs.writeFile(args.at(-1), 'video-jpeg');
	};

	const first = await generateThumbnail({
		userId: 'user-1',
		file,
		cacheDir,
		openStream: async () => Readable.from(['video']),
		execute,
	});
	assert.equal(await fs.readFile(first, 'utf8'), 'video-jpeg');

	const cached = await generateThumbnail({
		userId: 'user-1',
		file,
		cacheDir,
		openStream: async () => { throw new Error('cache opened the provider'); },
		execute: async () => { throw new Error('cache reran the converter'); },
	});
	assert.equal(cached, first);
});

test('generateThumbnail converts an office document through PDF', async (t) => {
	const cacheDir = await createCache(t);
	const file = { id: 'doc-1', file_name: 'report.docx', mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 8 };
	const execute = async (program, args) => {
		if (program === 'libreoffice') {
			const outDir = args[args.indexOf('--outdir') + 1];
			const input = args.at(-1);
			await fs.writeFile(path.join(outDir, `${path.basename(input, path.extname(input))}.pdf`), 'pdf');
			return;
		}
		assert.equal(program, 'pdftoppm');
		await fs.access(args.at(-2));
		await fs.writeFile(`${args.at(-1)}.jpg`, 'office-jpeg');
	};

	const cover = await generateThumbnail({
		userId: 'user-1',
		file,
		cacheDir,
		openStream: async () => Readable.from(['document']),
		execute,
	});
	assert.equal(await fs.readFile(cover, 'utf8'), 'office-jpeg');
});

test('generateThumbnail rejects oversized metadata before opening the provider', async (t) => {
	const cacheDir = await createCache(t);
	await assert.rejects(
		generateThumbnail({
			userId: 'user-1',
			file: { id: 'large', file_name: 'large.pdf', mime_type: 'application/pdf', size: 101 },
			cacheDir,
			maxBytes: 100,
			openStream: async () => { throw new Error('provider should stay closed'); },
		}),
		(error) => error.statusCode === 415,
	);
});

test('generateThumbnail enforces the stream limit and reports converter failures', async (t) => {
	const cacheDir = await createCache(t);
	const base = { userId: 'user-1', cacheDir, maxBytes: 4 };

	await assert.rejects(
		generateThumbnail({
			...base,
			file: { id: 'stream-large', file_name: 'large.pdf', mime_type: 'application/pdf', size: 0 },
			openStream: async () => Readable.from(['12345']),
		}),
		(error) => error.statusCode === 415,
	);

	await assert.rejects(
		generateThumbnail({
			...base,
			file: { id: 'broken', file_name: 'broken.pdf', mime_type: 'application/pdf', size: 3 },
			openStream: async () => Readable.from(['pdf']),
			execute: async () => { throw new Error('converter failed'); },
		}),
		(error) => error.statusCode === 422,
	);
});
