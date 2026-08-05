import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const {
	getPreviewKind,
	getPreviewCacheKey,
	effectivePreviewSource,
	renderOfficePdf,
} = await import('../src/services/previewService.js');

async function createCache(t) {
	const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'omnicloud-previews-'));
	t.after(() => fs.rm(cacheDir, { recursive: true, force: true }));
	return cacheDir;
}

test('getPreviewKind classifies by effective mime type', () => {
	const cases = [
		[{ file_name: 'photo.jpg', mime_type: 'image/jpeg' }, 'image'],
		[{ file_name: 'photo.heic', mime_type: 'application/octet-stream' }, 'image'],
		[{ file_name: 'clip.mp4', mime_type: 'video/mp4' }, 'video'],
		[{ file_name: 'clip.mkv', mime_type: 'application/octet-stream' }, 'video'],
		[{ file_name: 'song.mp3', mime_type: 'audio/mpeg' }, 'audio'],
		[{ file_name: 'report.pdf', mime_type: 'application/pdf' }, 'pdf'],
		[{ file_name: 'report.pdf', mime_type: 'application/octet-stream' }, 'pdf'],
		[{ file_name: 'letter.docx', mime_type: 'application/octet-stream' }, 'office'],
		[{ file_name: 'sheet.ods', mime_type: 'application/vnd.oasis.opendocument.spreadsheet' }, 'office'],
		[{ file_name: 'notes.txt', mime_type: 'text/plain' }, 'text'],
		[{ file_name: 'data.json', mime_type: 'application/json' }, 'text'],
		[{ file_name: 'table.csv', mime_type: 'application/octet-stream' }, 'text'],
		[{ file_name: 'archive.zip', mime_type: 'application/zip' }, 'archive'],
		[{ file_name: 'setup.exe', mime_type: 'application/x-msdownload' }, null],
		[{ file_name: 'folder', is_folder: true }, null],
	];

	for (const [file, expected] of cases) {
		assert.equal(getPreviewKind(file), expected, file.file_name);
	}
});

test('getPreviewKind resolves google native files through their export target', () => {
	const cases = [
		['application/vnd.google-apps.document', 'pdf'],
		['application/vnd.google-apps.spreadsheet', 'office'],
		['application/vnd.google-apps.presentation', 'office'],
		['application/vnd.google-apps.drawing', 'image'],
		['application/vnd.google-apps.script', 'text'],
	];

	for (const [mimeType, expected] of cases) {
		assert.equal(getPreviewKind({ file_name: 'native doc', mime_type: mimeType, size: 0 }), expected, mimeType);
	}
});

test('effectivePreviewSource exposes the export extension for google files', () => {
	assert.deepEqual(
		effectivePreviewSource({ file_name: 'Budget', mime_type: 'application/vnd.google-apps.spreadsheet' }),
		{ mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', extension: '.xlsx' },
	);
	assert.deepEqual(
		effectivePreviewSource({ file_name: 'Photo.JPG', mime_type: 'image/jpeg' }),
		{ mimeType: 'image/jpeg', extension: '.jpg' },
	);
});

test('getPreviewCacheKey isolates users and file revisions', () => {
	const file = { id: 'file-1', remote_modified_time: '2026-08-02T12:00:00.000Z', size: 42 };
	const baseline = getPreviewCacheKey('user-1', file);

	assert.match(baseline, /^[a-f0-9]{64}$/);
	assert.notEqual(getPreviewCacheKey('user-2', file), baseline);
	assert.notEqual(getPreviewCacheKey('user-1', { ...file, id: 'file-2' }), baseline);
	assert.notEqual(getPreviewCacheKey('user-1', { ...file, remote_modified_time: '2026-08-03T12:00:00.000Z' }), baseline);
	assert.notEqual(getPreviewCacheKey('user-1', { ...file, size: 43 }), baseline);
});

test('renderOfficePdf converts once and reuses the cached pdf', async (t) => {
	const cacheDir = await createCache(t);
	const file = { id: 'doc-1', file_name: 'report.docx', mime_type: 'application/octet-stream', size: 8 };
	let conversions = 0;
	const execute = async (program, args) => {
		assert.equal(program, 'libreoffice');
		conversions += 1;
		const outDir = args[args.indexOf('--outdir') + 1];
		const input = args.at(-1);
		assert.equal(path.extname(input), '.docx');
		await fs.writeFile(path.join(outDir, `${path.basename(input, '.docx')}.pdf`), 'converted-pdf');
	};

	const first = await renderOfficePdf({
		userId: 'user-1',
		file,
		cacheDir,
		execute,
		openStream: async () => Readable.from(['document']),
	});
	assert.equal(await fs.readFile(first, 'utf8'), 'converted-pdf');

	const cached = await renderOfficePdf({
		userId: 'user-1',
		file,
		cacheDir,
		execute: async () => { throw new Error('cache reran the converter'); },
		openStream: async () => { throw new Error('cache opened the provider'); },
	});
	assert.equal(cached, first);
	assert.equal(conversions, 1);
});

test('renderOfficePdf uses the google export extension as libreoffice input', async (t) => {
	const cacheDir = await createCache(t);
	const file = { id: 'sheet-1', file_name: 'Budget', mime_type: 'application/vnd.google-apps.spreadsheet', size: 0 };
	const execute = async (program, args) => {
		const outDir = args[args.indexOf('--outdir') + 1];
		const input = args.at(-1);
		assert.equal(path.extname(input), '.xlsx');
		await fs.writeFile(path.join(outDir, `${path.basename(input, '.xlsx')}.pdf`), 'sheet-pdf');
	};

	const pdfPath = await renderOfficePdf({
		userId: 'user-1',
		file,
		cacheDir,
		execute,
		openStream: async () => Readable.from(['xlsx']),
	});
	assert.equal(await fs.readFile(pdfPath, 'utf8'), 'sheet-pdf');
});

test('renderOfficePdf rejects wrong kinds, oversized files and converter failures', async (t) => {
	const cacheDir = await createCache(t);

	await assert.rejects(
		renderOfficePdf({
			userId: 'user-1',
			cacheDir,
			file: { id: 'img', file_name: 'photo.jpg', mime_type: 'image/jpeg', size: 1 },
			openStream: async () => { throw new Error('provider should stay closed'); },
		}),
		(error) => error.statusCode === 415,
	);

	await assert.rejects(
		renderOfficePdf({
			userId: 'user-1',
			cacheDir,
			maxBytes: 10,
			file: { id: 'big', file_name: 'big.docx', mime_type: 'application/octet-stream', size: 11 },
			openStream: async () => { throw new Error('provider should stay closed'); },
		}),
		(error) => error.statusCode === 415,
	);

	await assert.rejects(
		renderOfficePdf({
			userId: 'user-1',
			cacheDir,
			file: { id: 'broken', file_name: 'broken.docx', mime_type: 'application/octet-stream', size: 3 },
			openStream: async () => Readable.from(['doc']),
			execute: async () => { throw new Error('libreoffice crashed'); },
		}),
		(error) => error.statusCode === 422,
	);

	const leftovers = (await fs.readdir(cacheDir)).filter((entry) => entry.startsWith('.tmp-'));
	assert.deepEqual(leftovers, []);
});
