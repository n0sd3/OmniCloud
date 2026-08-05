import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parsePageCount, renderPdfPage } from '../src/services/pdfPageService.js';

const PDF_FILE = { id: 'f1', file_name: 'report.pdf', mime_type: 'application/pdf', size: 2048 };

test('parsePageCount reads the Pages line from pdfinfo', () => {
	const stdout = 'Title:          Report\nPages:          12\nEncrypted:      no\n';
	assert.equal(parsePageCount(stdout), 12);
	assert.equal(parsePageCount('no pages here'), 0);
});

test('renderPdfPage rejects a page outside the document', async () => {
	const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'omnicloud-pdf-page-'));
	await assert.rejects(
		() => renderPdfPage({
			userId: 'u1',
			file: PDF_FILE,
			page: 0,
			openStream: async () => { throw new Error('should not be called'); },
			cacheDir,
		}),
		(error) => error.statusCode === 404,
	);
});

test('renderPdfPage caches the rendered page and skips the converter on the second call', async () => {
	const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'omnicloud-pdf-page-'));
	let conversions = 0;

	const execute = async (program, args) => {
		if (program === 'pdfinfo') return { stdout: 'Pages:          3\n' };
		conversions += 1;
		// pdftoppm escreve <prefixo>.jpg quando recebe -singlefile.
		const prefix = args.at(-1);
		await fs.writeFile(`${prefix}.jpg`, 'jpeg-bytes');
		return { stdout: '' };
	};

	const options = {
		userId: 'u1',
		file: PDF_FILE,
		page: 2,
		openStream: async () => (async function* () { yield Buffer.from('%PDF-1.4'); })(),
		cacheDir,
		execute,
	};

	const first = await renderPdfPage(options);
	assert.equal(await fs.readFile(first, 'utf8'), 'jpeg-bytes');
	assert.equal(conversions, 1);

	const second = await renderPdfPage(options);
	assert.equal(second, first);
	assert.equal(conversions, 1, 'second call is served from cache');
});
