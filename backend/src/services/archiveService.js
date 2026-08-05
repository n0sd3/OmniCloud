import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { env } from '../config/env.js';
import { extensionOf } from '@omnicloud/shared';
import { writeStreamToFile } from './fileConvert.js';

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_ENTRIES = 1000;
const execFileAsync = promisify(execFile);

const ZIP_EXTENSIONS = new Set(['zip', 'jar']);
const SEVEN_ZIP_EXTENSIONS = new Set(['7z', 'rar', 'tar', 'gz', 'tgz', 'bz2', 'xz']);

function archiveError(message, statusCode, cause) {
	const error = new Error(message, cause ? { cause } : undefined);
	error.statusCode = statusCode;
	return error;
}

// unzip -l imprime uma tabela: cabecalho, linha de tracos, itens, rodape.
// O nome comeca na quarta coluna e pode conter espaco, entao o split e limitado.
export function parseUnzipList(stdout) {
	const lines = String(stdout || '').split('\n');
	const start = lines.findIndex((line) => /^-{5,}\s/.test(line.trim()));
	if (start === -1) return [];

	const entries = [];
	for (const line of lines.slice(start + 1)) {
		if (/^-{5,}/.test(line.trim())) break;
		const match = /^\s*(\d+)\s+\S+\s+\S+\s+(.+?)\s*$/.exec(line);
		if (!match) continue;
		entries.push({ name: match[2], size: Number(match[1]) });
	}
	return entries;
}

export function parse7zList(stdout) {
	const entries = [];
	for (const line of String(stdout || '').split('\n')) {
		// Formato: "2026-07-01 10:12:00 ....A         612          600  readme.md"
		const match = /^\d{4}-\d{2}-\d{2}\s+\S+\s+\S+\s+(\d+)\s+\d*\s+(.+?)\s*$/.exec(line);
		if (!match) continue;
		entries.push({ name: match[2], size: Number(match[1]) });
	}
	return entries;
}

export function archiveToolFor(file) {
	const extension = extensionOf(file?.display_name || file?.file_name || '');
	if (ZIP_EXTENSIONS.has(extension)) return 'unzip';
	if (SEVEN_ZIP_EXTENSIONS.has(extension)) return '7z';
	return null;
}

export async function listArchiveEntries({
	userId,
	file,
	openStream,
	cacheDir = env.previewCacheDir,
	execute = execFileAsync,
	maxBytes = DEFAULT_MAX_BYTES,
	timeoutMs = DEFAULT_TIMEOUT_MS,
	maxEntries = DEFAULT_MAX_ENTRIES,
}) {
	const tool = archiveToolFor(file);
	if (!tool) throw archiveError('Archive listing is not supported for this file type', 415);
	if (Number(file.size || 0) > maxBytes) throw archiveError('File is too large for preview', 415);

	await fs.mkdir(cacheDir, { recursive: true });
	const tempDir = await fs.mkdtemp(path.join(cacheDir, '.tmp-archive-'));
	try {
		const inputPath = path.join(tempDir, 'source.archive');
		await writeStreamToFile(await openStream(), inputPath, maxBytes);

		// Nada e extraido: so a listagem. Sem extracao nao existe path traversal.
		const { stdout } = tool === 'unzip'
			? await execute('unzip', ['-l', inputPath], { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 })
			: await execute('7z', ['l', '-ba', inputPath], { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });

		const parsed = tool === 'unzip' ? parseUnzipList(stdout) : parse7zList(stdout);
		return {
			entries: parsed.slice(0, maxEntries),
			truncated: parsed.length > maxEntries,
		};
	} catch (error) {
		if (error.statusCode) throw error;
		throw archiveError('Archive listing failed', 422, error);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
}
