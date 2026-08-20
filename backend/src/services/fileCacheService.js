import { env } from '../config/env.js';
import { createLocalFileStore } from './localFileStore.js';
import { googleDocsExport } from '../utils/mime.js';

const WARM_SKIP_THRESHOLD_BYTES = 100 * 1024 * 1024;

function versionOf(file) {
	return file.remote_modified_time || file.modifiedTime || null;
}

function normalizePath(input = '/') {
	if (!input || input === '/') return '/';
	const prefixed = input.startsWith('/') ? input : `/${input}`;
	return prefixed.endsWith('/') ? prefixed : `${prefixed}/`;
}

export function createFileCacheService({
	store,
	warmTtlMs = 60 * 60 * 1000,
	concurrency = 3,
	now = Date.now,
	logger = console,
} = {}) {
	// Warm e best-effort: falhar so significa servir direto da nuvem, nao e erro da requisicao.
	const warmFailed = (error) => logger.warn(`File cache warm failed: ${error?.message || error}`);
	const warmedFolders = new Map();
	const inflightDownloads = new Map();
	const queue = [];
	const limit = Math.max(1, Number(concurrency) || 1);
	let active = 0;

	const fileKey = (userId, file) => JSON.stringify([
		userId,
		file.cloud_account_id,
		String(file.remote_file_id),
		Number(file.size || 0),
		versionOf(file),
	]);
	const folderKey = (userId, virtualPath, folderScope) => JSON.stringify([
		userId,
		folderScope || normalizePath(virtualPath),
	]);

	function drain() {
		while (active < limit && queue.length) {
			const { run, resolve, reject } = queue.shift();
			active += 1;
			void run().then(resolve, reject).finally(() => {
				active -= 1;
				drain();
			});
		}
	}

	function warmFile({ userId, file, adapter }) {
		// ponytail: Google Docs nativos (Docs/Sheets/Slides/...) sao baixados via export e o
		// `size` sincronizado e bytes de quota do Drive, nao o tamanho do export gerado -
		// nunca bate, entao o warm falharia sempre. Nao vale cachear.
		if (!Number(file.size) || googleDocsExport(file)) return Promise.resolve();

		const key = fileKey(userId, file);
		const inflight = inflightDownloads.get(key);
		if (inflight) return inflight;

		const pending = new Promise((resolve, reject) => {
			queue.push({
				run: async () => {
					if (await store.getValidPath(file)) return;
					await store.writeFromStream(file, await adapter.getDownloadStream(file));
				},
				resolve,
				reject,
			});
			drain();
		});
		inflightDownloads.set(key, pending);
		void pending.then(
			() => inflightDownloads.delete(key),
			() => inflightDownloads.delete(key),
		);
		return pending;
	}

	return {
		warmFile,

		warmFolder({ userId, virtualPath, folderScope, directChildren = false, files, adapterFor }) {
			const path = normalizePath(virtualPath);
			const key = folderKey(userId, path, folderScope);
			const expiresAt = warmedFolders.get(key);
			if (expiresAt && expiresAt > now()) return false;
			warmedFolders.delete(key);
			warmedFolders.set(key, now() + warmTtlMs);
			for (const file of files) {
				if (file.is_folder || (!directChildren && normalizePath(file.virtual_path) !== path)) continue;
				try {
					void warmFile({ userId, file, adapter: adapterFor(file) }).catch(warmFailed);
				} catch (error) {
					warmFailed(error);
				}
			}
			return true;
		},

		async openFile({ userId, file, adapter, range = {} }) {
			const local = await store.openReadStream(file, range);
			if (local) return { stream: local, cached: true };
			// Range num arquivo pequeno: warm em paralelo e barato, mantem o comportamento
			// de "esquenta o cache na primeira leitura" mesmo pra requests parciais.
			// Range num arquivo grande (video tocando) e outra historia: warm baixa o
			// arquivo inteiro pela mesma conta do provider que ja esta servindo o stream
			// ao vivo - em provider com slot de download limitado por conta (Mega) as duas
			// conexoes competem, o stream trava e o timeout do preview no frontend estoura.
			// ponytail: 100MB e o mesmo teto usado pra conversao de preview; ajustar junto
			// se um deles mudar.
			const isLargeRangedRead = Object.keys(range).length > 0 && Number(file.size || 0) > WARM_SKIP_THRESHOLD_BYTES;
			if (!isLargeRangedRead) void warmFile({ userId, file, adapter }).catch(warmFailed);
			return { stream: await adapter.getDownloadStream(file, range), cached: false };
		},

		invalidate(file) {
			return store.invalidate(file);
		},

		rebind(previousFile, file) {
			return store.rebind(previousFile, file);
		},

		async reconcileAccount(previousFiles, nextFiles, options) {
			await store.reconcile(previousFiles, nextFiles, options);
			warmedFolders.clear();
		},

		captureUpload(stream, uploadId) {
			return store.captureUpload(stream, uploadId);
		},

		commitCapture(capture, file) {
			return store.commitCapture(capture, file);
		},

		cleanupTemps() {
			return store.cleanupTemps();
		},
	};
}

export const fileCacheService = createFileCacheService({
	store: createLocalFileStore({ rootDir: env.fileCachePath }),
	warmTtlMs: env.fileCacheWarmTtlMs,
	concurrency: env.fileCacheConcurrency,
});
