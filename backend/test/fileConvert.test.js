import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const { officeToPdf, writeStreamToFile } = await import('../src/services/fileConvert.js');

async function createDir(t) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'omnicloud-convert-'));
	t.after(() => fs.rm(dir, { recursive: true, force: true }));
	return dir;
}

test('officeToPdf drives libreoffice headless and returns the pdf path', async (t) => {
	const dir = await createDir(t);
	const inputPath = path.join(dir, 'source.docx');
	await fs.writeFile(inputPath, 'docx');

	let seenArgs;
	const execute = async (program, args, options) => {
		assert.equal(program, 'libreoffice');
		assert.equal(options.timeout, 1234);
		seenArgs = args;
		const outDir = args[args.indexOf('--outdir') + 1];
		await fs.writeFile(path.join(outDir, 'source.pdf'), 'pdf');
	};

	const pdfPath = await officeToPdf({ execute, inputPath, outDir: dir, timeoutMs: 1234 });

	assert.equal(pdfPath, path.join(dir, 'source.pdf'));
	assert.equal(await fs.readFile(pdfPath, 'utf8'), 'pdf');
	assert.ok(seenArgs[0].startsWith('-env:UserInstallation=file://'));
	assert.deepEqual(seenArgs.slice(1), ['--headless', '--convert-to', 'pdf', '--outdir', dir, inputPath]);
});

test('writeStreamToFile stops at the byte limit', async (t) => {
	const dir = await createDir(t);
	const targetPath = path.join(dir, 'out.bin');

	await writeStreamToFile(Readable.from(['abc']), targetPath, 10);
	assert.equal(await fs.readFile(targetPath, 'utf8'), 'abc');

	await assert.rejects(
		writeStreamToFile(Readable.from(['123456']), targetPath, 4),
		(error) => error.statusCode === 415,
	);
});
