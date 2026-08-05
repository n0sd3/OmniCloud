import fs from 'node:fs/promises';
import path from 'node:path';

// Antes desta branch o cache de preview guardava um PDF por arquivo de office.
// Agora tambem guarda .src.pdf de todo PDF visto, uma .jpg por pagina, uma
// .jpg por HEIC/TIFF convertido e uma .entries.json por arquivo compactado, e
// nada nunca varria o diretorio. Idade por mtime e suficiente aqui, sem LRU.
export const PREVIEW_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export async function sweepPreviewCache(cacheDir, { maxAgeMs = PREVIEW_CACHE_MAX_AGE_MS, now = Date.now } = {}) {
	let entries;
	try {
		entries = await fs.readdir(cacheDir, { withFileTypes: true });
	} catch {
		return 0;
	}

	const cutoff = now() - maxAgeMs;
	let removed = 0;
	for (const entry of entries) {
		// Diretorios temporarios (.tmp-*) tem sua propria limpeza no finally de
		// quem os cria; a varredura so mexe nos arquivos de cache finalizados.
		if (!entry.isFile()) continue;
		const entryPath = path.join(cacheDir, entry.name);
		try {
			const stat = await fs.stat(entryPath);
			if (stat.mtimeMs < cutoff) {
				await fs.rm(entryPath, { force: true });
				removed += 1;
			}
		} catch {
		}
	}
	return removed;
}
