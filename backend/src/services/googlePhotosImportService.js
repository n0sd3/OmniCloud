import { randomUUID } from 'node:crypto';
import { createAdapter as createRegisteredAdapter } from './adapterRegistry.js';
import { getAccountById, markAccountStatus } from './accountService.js';
import { emitUploadEvent } from './websocketHub.js';
import { syncAccount } from './syncService.js';
import { decryptJson } from '../utils/crypto.js';
import { isAuthError } from '../utils/providerErrors.js';

export const GOOGLE_PHOTOS_PICKER_SCOPE =
	'https://www.googleapis.com/auth/photospicker.mediaitems.readonly';

const PICKER_API = 'https://photospicker.googleapis.com/v1';
const TERMINAL_JOB_TTL_MS = 5 * 60 * 1000;

function durationMs(duration) {
	const match = String(duration || '').match(/^([\d.]+)s$/);
	return match ? Math.round(Number(match[1]) * 1000) : 0;
}

function errorMessage(error) {
	const message = error?.response?.data?.error?.message || error?.message;
	if (!message || /https?:\/\/|\b(?:access_?token|refresh_?token|id_?token|token|authorization)\b\s*(?:[=:]\s*|\s+)\S+|\bbearer\s+\S+/i.test(message)) {
		return 'Google Photos Picker request failed';
	}
	return message;
}

function errorStatus(error) {
	const status = error?.status ?? error?.statusCode ?? error?.code ?? error?.response?.status;
	const numeric = Number(status);
	return Number.isFinite(numeric) ? numeric : undefined;
}

function isGoogleImportAuthError(error) {
	const status = errorStatus(error);
	if (status === 401) return true;
	if (status !== 403) return isAuthError(error);

	const details = error?.response?.data?.error;
	const reasons = (details?.errors || []).map(({ reason }) => reason).filter(Boolean);
	if (reasons.some((reason) => /^(?:authError|invalidCredentials|insufficientPermissions|permissionDenied)$/i.test(reason))) {
		return true;
	}
	const message = [details?.message, error?.message].filter(Boolean).join(' ');
	return /invalid (?:credential|token)|expired token|revoked token|authentication|authorization|insufficient (?:authentication )?scope|not authorized|login required/i.test(message);
}

function credentialsFor(account) {
	if (account.credentials) return account.credentials;
	return account.encrypted_credentials ? decryptJson(account.encrypted_credentials) : {};
}

function scopesFor(credentials) {
	return new Set(Array.isArray(credentials.scope) ? credentials.scope : String(credentials.scope || '').split(/\s+/));
}

function itemFileName(item) {
	return item.mediaFile?.filename || item.id || 'media';
}

function itemDownloadUrl(item) {
	return `${item.mediaFile?.baseUrl || ''}=${item.type === 'VIDEO' ? 'dv' : 'd'}`;
}

export function buildGooglePhotosImportPath(email) {
	const local = String(email || '').split('@')[0].replace(/[\\/\0]/g, '_').trim() || 'conta';
	return `/OmniCloud/Google Fotos/${local}/`;
}

export function allocateDuplicateNames(fileNames, existingNames) {
	const used = new Set(existingNames);
	return fileNames.map((fileName) => {
		const dot = fileName.lastIndexOf('.');
		const base = dot > 0 ? fileName.slice(0, dot) : fileName;
		const extension = dot > 0 ? fileName.slice(dot) : '';
		let candidate = fileName;
		let number = 2;
		while (used.has(candidate)) candidate = `${base} (${number++})${extension}`;
		used.add(candidate);
		return candidate;
	});
}

export function createGooglePhotosImportService({
	getAccount = getAccountById,
	createAdapter = createRegisteredAdapter,
	emitEvent = emitUploadEvent,
	sync = syncAccount,
	markStatus = markAccountStatus,
	runImport,
	setTimer = setTimeout,
	terminalJobTtlMs = TERMINAL_JOB_TTL_MS,
	now = Date.now,
} = {}) {
	const jobs = new Map();
	const transferQueue = [];
	const accountQueues = new Map();
	let activeTransfers = 0;

	function drainTransferQueue() {
		while (activeTransfers < 2 && transferQueue.length) {
			const waiter = transferQueue.shift();
			if (waiter.job.status === 'cancelled') {
				waiter.resolve(null);
				continue;
			}
			activeTransfers += 1;
			let released = false;
			waiter.resolve(() => {
				if (released) return;
				released = true;
				activeTransfers -= 1;
				drainTransferQueue();
			});
		}
	}

	function acquireTransfer(job) {
		return new Promise((resolve) => {
			transferQueue.push({ job, resolve });
			drainTransferQueue();
		});
	}

	function drainAccountQueue(accountId) {
		const queue = accountQueues.get(accountId);
		if (!queue || queue.active) return;

		while (queue.waiting.length) {
			const waiter = queue.waiting.shift();
			if (waiter.job.status === 'cancelled') {
				waiter.resolve(null);
				continue;
			}
			queue.active = true;
			let released = false;
			waiter.resolve(() => {
				if (released) return;
				released = true;
				queue.active = false;
				drainAccountQueue(accountId);
			});
			return;
		}

		accountQueues.delete(accountId);
	}

	function acquireAccount(job) {
		let queue = accountQueues.get(job.accountId);
		if (!queue) {
			queue = { active: false, waiting: [] };
			accountQueues.set(job.accountId, queue);
		}
		return new Promise((resolve) => {
			queue.waiting.push({ job, resolve });
			drainAccountQueue(job.accountId);
		});
	}

	function removeQueuedJob(job) {
		for (let index = transferQueue.length - 1; index >= 0; index -= 1) {
			if (transferQueue[index].job !== job) continue;
			transferQueue.splice(index, 1)[0].resolve(null);
		}
		const accountQueue = accountQueues.get(job.accountId);
		if (!accountQueue) return;
		for (let index = accountQueue.waiting.length - 1; index >= 0; index -= 1) {
			if (accountQueue.waiting[index].job !== job) continue;
			accountQueue.waiting.splice(index, 1)[0].resolve(null);
		}
		if (!accountQueue.active && !accountQueue.waiting.length) accountQueues.delete(job.accountId);
	}

	function sanitizeJob(job) {
		return {
			id: job.id,
			accountId: job.accountId,
			status: job.status,
			pickerUri: job.pickerUri,
			pollIntervalMs: job.pollIntervalMs,
			total: job.total,
			completed: job.completed,
			failed: job.failed,
			errors: job.errors,
		};
	}

	function updatePollingConfig(job, pollingConfig) {
		const pollIntervalMs = durationMs(pollingConfig?.pollInterval);
		const timeoutMs = durationMs(pollingConfig?.timeoutIn);
		if (pollIntervalMs > 0) job.pollIntervalMs = pollIntervalMs;
		if (timeoutMs > 0) job.timeoutAt = now() + timeoutMs;
	}

	function getJob(userId, importId) {
		const job = jobs.get(importId);
		if (!job || job.userId !== userId) throw new Error('Google Photos import not found');
		return job;
	}

	async function deletePickerSession(job) {
		if (job.sessionDeleted) return;
		job.sessionDeleted = true;
		try {
			await job.oauthClient.request({ method: 'DELETE', url: `${PICKER_API}/sessions/${job.pickerSessionId}` });
		} catch (error) {
			job.errors.push(errorMessage(error));
		}
	}

	function releaseTerminalJob(job) {
		if (job.released) return;
		job.released = true;
		job.oauthClient = null;
		job.account = null;
		job.adapter = null;
		job.pickerSessionId = null;
		job.pickerUri = null;
		job.promise = null;
		job.controllers.clear();
		job.streams.clear();
		const timer = setTimer(() => jobs.delete(job.id), terminalJobTtlMs);
		timer?.unref?.();
	}

	function abortTransfers(job) {
		removeQueuedJob(job);
		for (const controller of job.controllers) controller.abort();
		for (const stream of job.streams) stream.destroy?.();
	}

	async function listAllPickedItems(job) {
		const items = [];
		let pageToken;
		do {
			const { data } = await job.oauthClient.request({
				method: 'GET',
				url: `${PICKER_API}/mediaItems`,
				params: { sessionId: job.pickerSessionId, pageSize: 100, pageToken },
			});
			items.push(...(data.mediaItems || []));
			pageToken = data.nextPageToken || undefined;
			if (job.status !== 'waiting_for_selection') return items;
		} while (pageToken);
		return items;
	}

	function emitJobEvent(job, type, extra = {}) {
		try {
			emitEvent(job.id, {
				type,
				importId: job.id,
				status: job.status,
				total: job.total,
				completed: job.completed,
				failed: job.failed,
				...extra,
			});
		} catch {
			// A disconnected progress listener cannot change an import outcome.
		}
	}

	async function failPickerJob(job, error) {
		if (job.status !== 'waiting_for_selection') return sanitizeJob(job);
		job.status = 'failed';
		job.errors.push(errorMessage(error));
		if (isGoogleImportAuthError(error)) markStatus(job.userId, job.accountId, 'invalid_token');
		await deletePickerSession(job);
		emitJobEvent(job, 'photos-import:complete');
		releaseTerminalJob(job);
		return sanitizeJob(job);
	}

	async function importItems(job, items) {
		let stopped = false;
		let index = 0;
		let releaseAccount;

		try {
			releaseAccount = await acquireAccount(job);
			if (!releaseAccount || job.status === 'cancelled') return;
			const virtualPath = buildGooglePhotosImportPath(job.account.email);
			const remoteParentId = await job.adapter.ensureRemotePath(virtualPath);
			const existingNames = await job.adapter.listFileNames(remoteParentId);
			const allocatedNames = allocateDuplicateNames(items.map(itemFileName), existingNames);
			emitJobEvent(job, 'photos-import:started');

			async function worker() {
				while (!stopped && job.status !== 'cancelled') {
					const itemIndex = index++;
					if (itemIndex >= items.length) return;
					const item = items[itemIndex];
					const fileName = allocatedNames[itemIndex];
					const releaseTransfer = await acquireTransfer(job);
					if (!releaseTransfer || stopped || job.status === 'cancelled') {
						releaseTransfer?.();
						return;
					}
					const controller = new AbortController();
					let stream;
					job.controllers.add(controller);

					try {
						({ data: stream } = await job.oauthClient.request({
							url: itemDownloadUrl(item),
							responseType: 'stream',
							signal: controller.signal,
						}));
						job.streams.add(stream);
						if (stopped || job.status === 'cancelled') {
							stream.destroy?.();
							return;
						}
						emitJobEvent(job, 'photos-import:item-started', { fileName });
						await job.adapter.uploadStream({
							stream,
							fileName,
							mimeType: item.mediaFile?.mimeType || 'application/octet-stream',
							virtualPath,
							remoteParentId,
							signal: controller.signal,
							onProgress: (bytes) => emitJobEvent(job, 'photos-import:progress', {
								fileName,
								bytes: Number(bytes) || 0,
							}),
						});
						if (stopped || job.status === 'cancelled') return;
						job.completed += 1;
						emitJobEvent(job, 'photos-import:item-complete', { fileName });
					} catch (error) {
						if (stopped || job.status === 'cancelled') return;
						job.failed += 1;
						const message = errorMessage(error);
						job.errors.push({ fileName, message });
						emitJobEvent(job, 'photos-import:item-error', { fileName, message });
						if (isGoogleImportAuthError(error)) {
							stopped = true;
							abortTransfers(job);
							markStatus(job.userId, job.accountId, 'invalid_token');
						}
					} finally {
						job.controllers.delete(controller);
						job.streams.delete(stream);
						if (stopped || job.status === 'cancelled') stream?.destroy?.();
						releaseTransfer();
					}
				}
			}

			await Promise.all([worker(), worker()]);
			if (job.completed && job.status !== 'cancelled') {
				try {
					await sync(job.userId, job.account);
				} catch (error) {
					job.errors.push(errorMessage(error));
				}
			}

			if (job.status !== 'cancelled') {
				job.status = job.failed || job.completed < job.total
					? (job.completed ? 'completed_with_errors' : 'failed')
					: 'completed';
			}
		} catch (error) {
			if (isGoogleImportAuthError(error)) markStatus(job.userId, job.accountId, 'invalid_token');
			job.errors.push(errorMessage(error));
			if (job.status !== 'cancelled') job.status = 'failed';
		} finally {
			releaseAccount?.();
			await deletePickerSession(job);
			emitJobEvent(job, 'photos-import:complete');
			releaseTerminalJob(job);
		}
	}

	async function start(userId, accountId) {
		const account = await getAccount(userId, accountId);
		if (!account || account.provider !== 'google_drive') throw new Error('Google Drive account is required');
		if (account.status !== 'active') throw new Error('Google Drive account must be active');
		const scopes = scopesFor(credentialsFor(account));
		if (!scopes.has(GOOGLE_PHOTOS_PICKER_SCOPE)) {
			throw new Error('Google Photos Picker access requires reconnecting the account');
		}

		const adapter = createAdapter(account);
		const oauthClient = adapter.createOAuthClient();
		let response;
		try {
			response = await oauthClient.request({ method: 'POST', url: `${PICKER_API}/sessions`, data: {} });
		} catch (error) {
			if (isGoogleImportAuthError(error)) markStatus(userId, accountId, 'invalid_token');
			throw new Error(errorMessage(error));
		}

		const session = response.data;
		const pollIntervalMs = durationMs(session.pollingConfig?.pollInterval);
		const timeoutMs = durationMs(session.pollingConfig?.timeoutIn);
		const startedAt = now();
		const job = {
			id: randomUUID(),
			userId,
			accountId: account.id,
			pickerSessionId: session.id,
			oauthClient,
			account,
			adapter,
			pickerUri: session.pickerUri,
			pollIntervalMs,
			timeoutAt: startedAt + timeoutMs,
			status: 'waiting_for_selection',
			total: 0,
			completed: 0,
			failed: 0,
			errors: [],
			sessionDeleted: false,
			controllers: new Set(),
			streams: new Set(),
			released: false,
			cancelPromise: null,
		};
		jobs.set(job.id, job);
		return sanitizeJob(job);
	}

	async function refreshJob(job) {
		if (job.status !== 'waiting_for_selection') return sanitizeJob(job);
		if (now() > job.timeoutAt) return cancelJob(job);

		try {
			const { data } = await job.oauthClient.request({ url: `${PICKER_API}/sessions/${job.pickerSessionId}` });
			updatePollingConfig(job, data.pollingConfig);
			if (!data.mediaItemsSet) return sanitizeJob(job);
			if (job.status !== 'waiting_for_selection') return sanitizeJob(job);
			const items = await listAllPickedItems(job);
			if (job.status !== 'waiting_for_selection') return sanitizeJob(job);
			job.total = items.length;
			job.status = items.length ? 'importing' : 'completed';
			if (items.length) job.promise = runImport ? runImport(job, items) : importItems(job, items);
			if (!items.length) {
				await deletePickerSession(job);
				emitJobEvent(job, 'photos-import:complete');
				releaseTerminalJob(job);
			}
		} catch (error) {
			return failPickerJob(job, error);
		}

		return sanitizeJob(job);
	}

	function refresh(userId, importId) {
		const job = getJob(userId, importId);
		if (job.refreshPromise) return job.refreshPromise;
		job.refreshPromise = (async () => {
			try {
				return await refreshJob(job);
			} finally {
				job.refreshPromise = null;
				if (job.status === 'cancelled' && !job.released) releaseTerminalJob(job);
			}
		})();
		return job.refreshPromise;
	}

	async function get(userId, importId) {
		return sanitizeJob(getJob(userId, importId));
	}

	function cancelJob(job) {
		if (['completed', 'completed_with_errors', 'failed'].includes(job.status)) {
			return Promise.resolve(sanitizeJob(job));
		}
		if (job.cancelPromise) return job.cancelPromise;
		if (job.status === 'cancelled') return Promise.resolve(sanitizeJob(job));

		job.cancelPromise = (async () => {
			job.status = 'cancelled';
			abortTransfers(job);
			const activeImport = job.promise;
			if (activeImport) await activeImport;
			else {
				await deletePickerSession(job);
				emitJobEvent(job, 'photos-import:complete');
				if (!job.refreshPromise) releaseTerminalJob(job);
			}
			return sanitizeJob(job);
		})();
		return job.cancelPromise;
	}

	function cancel(userId, importId) {
		return cancelJob(getJob(userId, importId));
	}

	return { start, refresh, get, cancel };
}

const googlePhotosImportService = createGooglePhotosImportService();

export const startGooglePhotosImport = (userId, accountId) => googlePhotosImportService.start(userId, accountId);
export const refreshGooglePhotosImport = (userId, importId) => googlePhotosImportService.refresh(userId, importId);
export const getGooglePhotosImport = (userId, importId) => googlePhotosImportService.get(userId, importId);
export const cancelGooglePhotosImport = (userId, importId) => googlePhotosImportService.cancel(userId, importId);
