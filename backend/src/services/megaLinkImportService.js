import { megaDownloadService } from './megaDownloadService.js';
import { listFilesByPath } from './fileService.js';
import { releaseAccountReservation, reserveBestAccount } from './spaceAllocator.js';
import {
	createUploadSession,
	removeUploadSession,
	updateUploadSession,
} from './uploadSessionService.js';
import { runUpload, startUpload } from './uploadService.js';
import { emitUploadEvent } from './websocketHub.js';

function codedError(code, message) {
	return Object.assign(new Error(message), { code });
}

export function validateMegaFileName(input) {
	const name = String(input || '');
	if (!name || name === '.' || name === '..' || /[\\/\u0000-\u001f\u007f]/.test(name)) {
		throw codedError('INVALID_INPUT', 'Invalid MEGA file name');
	}
	return name;
}

export function normalizeMegaDestinationPath(input = '/') {
	const value = String(input || '/');
	if (/[\\\u0000-\u001f\u007f]/.test(value)) {
		throw codedError('INVALID_INPUT', 'Invalid MEGA import destination');
	}
	const segments = value.split('/').filter(Boolean);
	if (segments.some((segment) => segment === '.' || segment === '..')) {
		throw codedError('INVALID_INPUT', 'Invalid MEGA import destination');
	}
	return segments.length ? `/${segments.join('/')}/` : '/';
}

function abortError() {
	return new DOMException('The operation was aborted', 'AbortError');
}

export function createMegaLinkImportService({
	downloads = megaDownloadService,
	selectAccount = null,
	reserveAccount = reserveBestAccount,
	releaseReservation = releaseAccountReservation,
	listFiles = listFilesByPath,
	createSession = createUploadSession,
	beginUpload = startUpload,
	upload = runUpload,
	updateSession = updateUploadSession,
	removeSession = removeUploadSession,
	emitEvent = emitUploadEvent,
} = {}) {
	const jobs = new Map();
	const destinations = new Set();

	function releaseJob(job) {
		if (job.reservationId) {
			releaseReservation(job.reservationId);
			job.reservationId = null;
		}
		if (job.destinationKey) {
			destinations.delete(job.destinationKey);
			job.destinationKey = null;
		}
	}

	function failBeforeUpload(job, message) {
		if (job.cleaned) return;
		job.cleaned = true;
		updateSession(job.session.id, { status: 'failed' });
		try {
			emitEvent(job.session.id, {
				type: 'upload:error',
				uploadId: job.session.id,
				status: 'failed',
				message,
			});
		} finally {
			removeSession(job.session.id);
		}
	}

	async function run(job, link, metadata) {
		try {
			const stream = await downloads.streamPublic(link, { signal: job.controller.signal });
			job.stream = stream;
			if (job.controller.signal.aborted) {
				stream.once('error', () => {});
				stream.destroy(abortError());
				failBeforeUpload(job, 'MEGA import cancelled');
				return;
			}
			job.uploadStarted = true;
			await upload({
				session: job.session,
				stream,
				fileName: metadata.file_name,
				mimeType: metadata.mime_type,
			});
		} catch {
			job.controller.abort();
			if (job.stream && !job.stream.destroyed) {
				job.stream.once('error', () => {});
				job.stream.destroy(abortError());
			}
			if (!job.uploadStarted) failBeforeUpload(job, 'MEGA import failed');
		} finally {
			releaseJob(job);
			jobs.delete(job.session.id);
		}
	}

	return {
		async start(userId, { link, virtualPath = '/' }) {
			const metadata = await downloads.inspectPublic(link);
			const fileName = validateMegaFileName(metadata.file_name);
			const destination = normalizeMegaDestinationPath(virtualPath);
			const destinationKey = JSON.stringify([userId, destination, fileName]);
			if (destinations.has(destinationKey)
				|| listFiles(userId, destination).some((file) => file.file_name === fileName)) {
				throw codedError('CONFLICT', 'A file with this name already exists');
			}
			destinations.add(destinationKey);
			let allocation;
			try {
				allocation = selectAccount
					? selectAccount(userId, metadata.size)
					: reserveAccount(userId, metadata.size, { excludeProviders: ['pcloud'] });
			} catch (error) {
				destinations.delete(destinationKey);
				throw error;
			}
			let session;
			try {
				session = createSession({
					user_id: userId,
					file_name: fileName,
					size: metadata.size,
					mime_type: metadata.mime_type,
					virtual_path: destination,
					remote_parent_id: null,
					cloud_account_id: allocation.selected.id,
					fallback_chain: [],
				});
			} catch (error) {
				destinations.delete(destinationKey);
				if (allocation.reservationId) releaseReservation(allocation.reservationId);
				throw error;
			}
			const job = {
				userId,
				session,
				controller: new AbortController(),
				stream: null,
				uploadStarted: false,
				cleaned: false,
				reservationId: allocation.reservationId || null,
				destinationKey,
			};
			jobs.set(session.id, job);
			try {
				beginUpload(session.id);
			} catch (error) {
				jobs.delete(session.id);
				try {
					failBeforeUpload(job, 'MEGA import failed');
				} finally {
					releaseJob(job);
				}
				throw error;
			}
			void run(job, link, metadata);
			return { upload_id: session.id, file_name: fileName, size: metadata.size };
		},

		async cancel(userId, uploadId) {
			const job = jobs.get(uploadId);
			if (!job || job.userId !== userId) return false;
			jobs.delete(uploadId);
			job.controller.abort();
			if (job.stream) job.stream.destroy(abortError());
			if (!job.uploadStarted) failBeforeUpload(job, 'MEGA import cancelled');
			return true;
		},
	};
}

export const megaLinkImportService = createMegaLinkImportService();
