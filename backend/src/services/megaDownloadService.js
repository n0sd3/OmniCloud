import { File } from 'megajs';
import { env } from '../config/env.js';
import { guessMimeType } from '../utils/mime.js';
import { createMegaBasterdClient, MegaBasterdError } from './megaBasterdClient.js';

const MEGA_HOSTS = new Set(['mega.nz', 'www.mega.nz', 'mega.co.nz', 'www.mega.co.nz']);

function invalidLink() {
	return new MegaBasterdError('INVALID_INPUT');
}

export function normalizeMegaFileLink(value) {
	let url;
	try {
		url = new URL(String(value || '').trim());
	} catch {
		throw invalidLink();
	}
	if (url.protocol !== 'https:' || url.username || url.password) throw invalidLink();
	if (!MEGA_HOSTS.has(url.hostname.toLowerCase())) throw invalidLink();
	const modern = /^\/file\/[^/]+$/.test(url.pathname) && url.hash.length > 1;
	const legacy = /^#![^!]+![^!]+$/.test(url.hash);
	if (!modern && !legacy) throw invalidLink();
	url.hostname = 'mega.nz';
	return url.toString();
}

function metadata(file) {
	return {
		file_name: file.name || 'download',
		size: Number(file.size || 0),
		mime_type: guessMimeType(file.name) || 'application/octet-stream',
	};
}

function bindSignal(stream, signal) {
	if (!signal) return stream;
	const abort = () => stream.destroy(new DOMException('The operation was aborted', 'AbortError'));
	if (signal.aborted) abort();
	else {
		signal.addEventListener('abort', abort, { once: true });
		stream.once('close', () => signal.removeEventListener('abort', abort));
	}
	return stream;
}

export function createMegaDownloadService({
	client,
	MegaFile = File,
	logger = console,
	fallbackEnabled = true,
} = {}) {
	async function initialFallback(primary, fallback, operation) {
		try {
			return await primary();
		} catch (error) {
			if (!fallbackEnabled || !error?.fallbackEligible || typeof fallback !== 'function') throw error;
			logger.warn?.('MEGA download using direct fallback', { operation, code: error.code || 'UNAVAILABLE' });
			return fallback();
		}
	}

	async function publicFile(link) {
		const file = MegaFile.fromURL(link);
		return await file.loadAttributes() || file;
	}

	return {
		async inspectPublic(link, { signal } = {}) {
			const canonical = normalizeMegaFileLink(link);
			const result = await initialFallback(
				() => client.inspectPublic(canonical, { signal }),
				async () => metadata(await publicFile(canonical)),
				'inspect-public',
			);
			return metadata({ name: result.file_name, size: result.size });
		},

		async streamPublic(link, { range, signal } = {}) {
			const canonical = normalizeMegaFileLink(link);
			return initialFallback(
				() => client.streamPublic(canonical, { range, signal }),
				async () => {
					const file = await publicFile(canonical);
					return bindSignal(file.download(range || {}), signal);
				},
				'stream-public',
			);
		},

		streamResolved(transfer, { range, fallback, signal } = {}) {
			return initialFallback(
				() => client.streamResolved(transfer, { range, signal }),
				fallback,
				'stream-private',
			);
		},
	};
}

const megaBasterdClient = createMegaBasterdClient({
	baseUrl: env.megaBasterdUrl,
	secret: env.megaBasterdSecret,
	timeoutMs: env.megaBasterdTimeoutMs,
});

export const megaDownloadService = createMegaDownloadService({
	client: megaBasterdClient,
	fallbackEnabled: env.megaBasterdFallbackEnabled,
});
