import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { env } from '../config/env.js';
import { writeStreamToFile } from './fileConvert.js';
import { getPreviewCacheKey, getPreviewKind, renderOfficePdf } from './previewService.js';

const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_PAGES = 2000;
const execFileAsync = promisify(execFile);

function pageError(message, statusCode, cause) {
	const error = new Error(message, cause ? { cause } : undefined);
	error.statusCode = statusCode;
	return error;
}

export function parsePageCount(stdout) {
	const match = /^Pages:\s+(\d+)/m.exec(String(stdout || ''));
	return match ? Number(match[1]) : 0;
}

// Um PDF de origem por arquivo: office passa pelo LibreOffice, pdf vem direto.
async function ensureSourcePdf({ userId, file, openStream, cacheDir, execute, maxBytes, timeoutMs }) {
	const kind = getPreviewKind(file);
	if (kind === 'office') {
		return renderOfficePdf({ userId, file, openStream, cacheDir, execute, maxBytes, timeoutMs });
	}
	if (kind !== 'pdf') throw pageError('Paged preview is not supported for this file type', 415);
	if (Number(file.size || 0) > maxBytes) throw pageError('File is too large for preview', 415);

	await fs.mkdir(cacheDir, { recursive: true });
	const sourcePath = path.join(cacheDir, `${getPreviewCacheKey(userId, file)}.src.pdf`);
	try {
		await fs.access(sourcePath);
		return sourcePath;
	} catch {
	}

	const tempPath = `${sourcePath}.part`;
	await writeStreamToFile(await openStream(), tempPath, maxBytes);
	await fs.rename(tempPath, sourcePath);
	return sourcePath;
}

export async function getPdfPageCount({
	userId,
	file,
	openStream,
	cacheDir = env.previewCacheDir,
	execute = execFileAsync,
	maxBytes = DEFAULT_MAX_BYTES,
	timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
	const sourcePath = await ensureSourcePdf({ userId, file, openStream, cacheDir, execute, maxBytes, timeoutMs });
	try {
		const { stdout } = await execute('pdfinfo', [sourcePath], { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 });
		const pageCount = parsePageCount(stdout);
		if (!pageCount) throw new Error('pdfinfo reported no pages');
		return Math.min(pageCount, MAX_PAGES);
	} catch (error) {
		if (error.statusCode) throw error;
		throw pageError('Preview conversion failed', 422, error);
	}
}

export async function renderPdfPage({
	userId,
	file,
	page,
	openStream,
	cacheDir = env.previewCacheDir,
	execute = execFileAsync,
	maxBytes = DEFAULT_MAX_BYTES,
	timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
	const pageNumber = Number(page);
	if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > MAX_PAGES) {
		throw pageError('Page is out of range', 404);
	}

	await fs.mkdir(cacheDir, { recursive: true });
	const targetPath = path.join(cacheDir, `${getPreviewCacheKey(userId, file)}.p${pageNumber}.jpg`);
	try {
		await fs.access(targetPath);
		return targetPath;
	} catch {
	}

	const sourcePath = await ensureSourcePdf({ userId, file, openStream, cacheDir, execute, maxBytes, timeoutMs });
	const tempDir = await fs.mkdtemp(path.join(cacheDir, '.tmp-page-'));
	try {
		const prefix = path.join(tempDir, 'page');
		await execute('pdftoppm', [
			'-f', String(pageNumber),
			'-l', String(pageNumber),
			'-singlefile',
			'-jpeg',
			'-r', '150',
			sourcePath,
			prefix,
		], { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 });

		const output = await fs.stat(`${prefix}.jpg`).catch(() => null);
		if (!output?.size) throw pageError('Page is out of range', 404);

		await fs.rename(`${prefix}.jpg`, targetPath);
		return targetPath;
	} catch (error) {
		if (error.statusCode) throw error;
		throw pageError('Preview conversion failed', 422, error);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
}
