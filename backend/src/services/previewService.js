import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { env } from '../config/env.js';
import { googleDocsExport } from '../utils/mime.js';
import { officeToPdf, writeStreamToFile } from './fileConvert.js';

const IMAGE_EXTENSIONS = new Set(['.avif', '.bmp', '.gif', '.heic', '.jpeg', '.jpg', '.png', '.svg', '.webp']);
const VIDEO_EXTENSIONS = new Set(['.avi', '.m4v', '.mkv', '.mov', '.mp4', '.webm']);
const AUDIO_EXTENSIONS = new Set(['.aac', '.flac', '.m4a', '.mp3', '.ogg', '.wav']);
const OFFICE_EXTENSIONS = new Set(['.doc', '.docx', '.odp', '.ods', '.odt', '.ppt', '.pptx', '.xls', '.xlsx']);
const TEXT_EXTENSIONS = new Set(['.csv', '.json', '.log', '.md', '.txt', '.xml', '.yaml', '.yml']);

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

	if (mimeType.startsWith('image/') || IMAGE_EXTENSIONS.has(extension)) return 'image';
	if (mimeType.startsWith('video/') || VIDEO_EXTENSIONS.has(extension)) return 'video';
	if (mimeType.startsWith('audio/') || AUDIO_EXTENSIONS.has(extension)) return 'audio';
	if (mimeType === 'application/pdf' || extension === '.pdf') return 'pdf';
	if (
		OFFICE_EXTENSIONS.has(extension)
		|| mimeType.includes('officedocument')
		|| mimeType.includes('opendocument')
		|| mimeType.includes('msword')
		|| mimeType.includes('ms-excel')
		|| mimeType.includes('ms-powerpoint')
	) return 'office';
	if (mimeType.startsWith('text/') || mimeType === 'application/json' || TEXT_EXTENSIONS.has(extension)) return 'text';

	return null;
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
