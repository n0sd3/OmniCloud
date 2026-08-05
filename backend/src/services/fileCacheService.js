import { env } from '../config/env.js';
import { createLocalFileStore } from './localFileStore.js';
import { googleDocsExport } from '../utils/mime.js';

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
			void warmFile({ userId, file, adapter }).catch(warmFailed);
			return { stream: await adapter.getDownloadStream(file, range), cached: false };
		},

		invalidate(file) {
			return store.invalidate(file);
		},

		rebind(file) {
			return store.rebind(file);
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
