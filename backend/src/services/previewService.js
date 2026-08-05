import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { env } from '../config/env.js';
import { googleDocsExport } from '../utils/mime.js';
import { officeToPdf, writeStreamToFile } from './fileConvert.js';
import { previewTypeFor } from '@omnicloud/shared';

const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;
// Conversao completa para PDF e mais pesada que gerar uma capa: 60s contra os 30s
// do thumbnail.
const DEFAULT_TIMEOUT_MS = 60_000;
const execFileAsync = promisify(execFile);

// Arquivos nativos do Google so existem no formato de exportacao: a classificacao
// tem que olhar o destino da exportacao, nunca o mime original.
export function effectivePreviewSource(file) {
	const exportTarget = googleDocsExport(file);
	if (exportTarget) {
		return { mimeType: exportTarget.mimeType.toLowerCase(), extension: `.${exportTarget.extension}` };
	}
	return {
		mimeType: String(file?.mime_type || file?.mimeType || '').toLowerCase(),
		extension: path.extname(file?.display_name || file?.file_name || '').toLowerCase(),
	};
}

export function getPreviewKind(file) {
	if (!file || file.is_folder) return null;
	const { mimeType, extension } = effectivePreviewSource(file);
	return previewTypeFor({ mimeType, extension });
}

export function getPreviewCacheKey(userId, file) {
	const revision = file.modifiedTime || file.remote_modified_time || file.updated_at || '';
	return crypto
		.createHash('sha256')
		.update(JSON.stringify([userId, file.id, revision, Number(file.size || 0)]))
		.digest('hex');
}

function previewError(message, statusCode, cause) {
	const error = new Error(message, cause ? { cause } : undefined);
	error.statusCode = statusCode;
	return error;
}

const BROWSER_HOSTILE_IMAGES = new Set(['.heic', '.heif', '.tif', '.tiff']);

// Chrome e Firefox nao decodificam HEIC nem TIFF: sem conversao o preview e um
// icone de imagem quebrada.
export function needsImageConversion(file) {
	if (!file || getPreviewKind(file) !== 'image') return false;
	const { extension } = effectivePreviewSource(file);
	return BROWSER_HOSTILE_IMAGES.has(extension);
}

export async function renderImageJpeg({
	userId,
	file,
	openStream,
	cacheDir = env.previewCacheDir,
	execute = execFileAsync,
	maxBytes = DEFAULT_MAX_BYTES,
	timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
	if (!needsImageConversion(file)) throw previewError('Image conversion is not needed', 415);
	if (Number(file.size || 0) > maxBytes) throw previewError('File is too large for preview conversion', 415);

	await fs.mkdir(cacheDir, { recursive: true });
	const targetPath = path.join(cacheDir, `${getPreviewCacheKey(userId, file)}.jpg`);
	try {
		await fs.access(targetPath);
		return targetPath;
	} catch {
	}

	const tempDir = await fs.mkdtemp(path.join(cacheDir, '.tmp-image-'));
	try {
		const { extension } = effectivePreviewSource(file);
		const safeExtension = /^\.[a-z0-9]{1,8}$/.test(extension) ? extension : '.bin';
		const inputPath = path.join(tempDir, `source${safeExtension}`);
		const outputPath = path.join(tempDir, 'converted.jpg');
		await writeStreamToFile(await openStream(), inputPath, maxBytes);

		// ffmpeg ja e dependencia do thumbnail e decodifica os dois formatos.
		await execute('ffmpeg', ['-y', '-i', inputPath, '-frames:v', '1', '-q:v', '3', outputPath], {
			timeout: timeoutMs,
			windowsHide: true,
			maxBuffer: 1024 * 1024,
		});

		const output = await fs.stat(outputPath);
		if (!output.size) throw new Error('ffmpeg produced an empty image');

		await fs.rename(outputPath, targetPath);
		return targetPath;
	} catch (error) {
		if (error.statusCode === 415) throw error;
		throw previewError('Preview conversion failed', 422, error);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
}

export async function renderOfficePdf({
	userId,
	file,
	openStream,
	cacheDir = env.previewCacheDir,
	execute = execFileAsync,
	maxBytes = DEFAULT_MAX_BYTES,
	timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
	if (getPreviewKind(file) !== 'office') throw previewError('Preview is not supported for this file type', 415);
	if (Number(file.size || 0) > maxBytes) throw previewError('File is too large for preview conversion', 415);
	if (typeof openStream !== 'function') throw new TypeError('openStream is required');

	await fs.mkdir(cacheDir, { recursive: true });
	const targetPath = path.join(cacheDir, `${getPreviewCacheKey(userId, file)}.pdf`);
	try {
		await fs.access(targetPath);
		return targetPath;
	} catch {
	}

	const tempDir = await fs.mkdtemp(path.join(cacheDir, '.tmp-'));
	try {
		const { extension } = effectivePreviewSource(file);
		const safeExtension = /^\.[a-z0-9]{1,8}$/.test(extension) ? extension : '.bin';
		const inputPath = path.join(tempDir, `source${safeExtension}`);
		await writeStreamToFile(await openStream(), inputPath, maxBytes);

		const pdfPath = await officeToPdf({ execute, inputPath, outDir: tempDir, timeoutMs });
		const output = await fs.stat(pdfPath);
		if (!output.size) throw new Error('LibreOffice produced an empty PDF');

		await fs.rename(pdfPath, targetPath);
		return targetPath;
	} catch (error) {
		if (error.statusCode === 415) throw error;
		throw previewError('Preview conversion failed', 422, error);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
}
