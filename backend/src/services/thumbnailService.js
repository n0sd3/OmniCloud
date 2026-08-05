import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { env } from '../config/env.js';
import { officeToPdf, writeStreamToFile } from './fileConvert.js';
import { extensionOf, THUMBNAIL_DOCUMENT_EXTENSIONS, THUMBNAIL_TEXT_EXTENSIONS, THUMBNAIL_VIDEO_EXTENSIONS } from '@omnicloud/shared';

const DEFAULT_TIMEOUT_MS = 30_000;
const execFileAsync = promisify(execFile);

export function getThumbnailKind(file) {
	if (!file || file.is_folder) return null;

	const mimeType = String(file.mime_type || file.mimeType || '').toLowerCase();
	const extension = extensionOf(file.display_name || file.file_name || '');

	if (mimeType.startsWith('video/') || THUMBNAIL_VIDEO_EXTENSIONS.has(extension)) return 'video';
	if (mimeType === 'application/pdf' || extension === 'pdf') return 'pdf';
	if (
		THUMBNAIL_DOCUMENT_EXTENSIONS.has(extension)
		|| mimeType.includes('document')
		|| mimeType.includes('word')
		|| mimeType.includes('sheet')
		|| mimeType.includes('excel')
		|| mimeType.includes('presentation')
		|| mimeType.includes('powerpoint')
		|| mimeType.includes('opendocument')
	) return 'document';
	if (mimeType.startsWith('text/') || mimeType === 'application/json' || THUMBNAIL_TEXT_EXTENSIONS.has(extension)) return 'text';

	return null;
}

export function getThumbnailCacheKey(userId, file) {
	const revision = file.modifiedTime || file.remote_modified_time || file.updated_at || '';
	return crypto
		.createHash('sha256')
		.update(JSON.stringify([userId, file.id, revision, Number(file.size || 0)]))
		.digest('hex');
}

function thumbnailError(message, statusCode, cause) {
	const error = new Error(message, cause ? { cause } : undefined);
	error.statusCode = statusCode;
	return error;
}

function inputExtension(file, kind) {
	if (kind === 'pdf') return '.pdf';
	if (kind === 'text') return '.txt';
	const extension = path.extname(file.display_name || file.file_name || '').toLowerCase();
	return /^\.[a-z0-9]{1,8}$/.test(extension) ? extension : kind === 'video' ? '.mp4' : '.bin';
}

async function runConverter(execute, program, args, timeoutMs) {
	await execute(program, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 });
}

async function renderPdf(execute, inputPath, outputPath, timeoutMs) {
	const outputPrefix = outputPath.slice(0, -path.extname(outputPath).length);
	await runConverter(execute, 'pdftoppm', [
		'-f', '1',
		'-singlefile',
		'-jpeg',
		'-scale-to-x', '640',
		'-scale-to-y', '-1',
		inputPath,
		outputPrefix,
	], timeoutMs);
}

async function renderVideo(execute, inputPath, outputPath, timeoutMs) {
	const baseArgs = ['-y', '-i', inputPath, '-frames:v', '1', '-vf', 'scale=min(640\\,iw):-2', '-q:v', '4', outputPath];
	try {
		await runConverter(execute, 'ffmpeg', ['-ss', '1', ...baseArgs], timeoutMs);
	} catch {
		await fs.rm(outputPath, { force: true });
		await runConverter(execute, 'ffmpeg', baseArgs, timeoutMs);
	}
}

async function renderDocument(execute, inputPath, outputPath, tempDir, timeoutMs) {
	const pdfPath = await officeToPdf({ execute, inputPath, outDir: tempDir, timeoutMs });
	await renderPdf(execute, pdfPath, outputPath, timeoutMs);
}

export async function generateThumbnail({
	userId,
	file,
	openStream,
	cacheDir = env.thumbnailCacheDir,
	execute = execFileAsync,
	maxBytes = env.thumbnailMaxBytes,
	timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
	const kind = getThumbnailKind(file);
	if (!kind) throw thumbnailError('Thumbnail is not supported for this file type', 415);
	if (Number(file.size || 0) > maxBytes) throw thumbnailError('File is too large for thumbnail generation', 415);
	if (typeof openStream !== 'function') throw new TypeError('openStream is required');

	await fs.mkdir(cacheDir, { recursive: true });
	const targetPath = path.join(cacheDir, `${getThumbnailCacheKey(userId, file)}.jpg`);
	try {
		await fs.access(targetPath);
		return targetPath;
	} catch {
	}

	const tempDir = await fs.mkdtemp(path.join(cacheDir, '.tmp-'));
	try {
		const inputPath = path.join(tempDir, `source${inputExtension(file, kind)}`);
		const outputPath = path.join(tempDir, 'cover.jpg');
		await writeStreamToFile(await openStream(), inputPath, maxBytes);

		if (kind === 'video') await renderVideo(execute, inputPath, outputPath, timeoutMs);
		else if (kind === 'pdf') await renderPdf(execute, inputPath, outputPath, timeoutMs);
		else await renderDocument(execute, inputPath, outputPath, tempDir, timeoutMs);

		const output = await fs.stat(outputPath);
		if (!output.size) throw new Error('Converter produced an empty thumbnail');
		await fs.rename(outputPath, targetPath);
		return targetPath;
	} catch (error) {
		if (error.statusCode === 415) throw error;
		throw thumbnailError('Thumbnail generation failed', 422, error);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
}
