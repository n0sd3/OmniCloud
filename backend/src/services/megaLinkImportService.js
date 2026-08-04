import { megaDownloadService } from './megaDownloadService.js';
import { selectBestAccount } from './spaceAllocator.js';
import {
	createUploadSession,
	removeUploadSession,
	updateUploadSession,
} from './uploadSessionService.js';
import { runUpload, startUpload } from './uploadService.js';
import { emitUploadEvent } from './websocketHub.js';

function normalizePath(input = '/') {
	if (!input || input === '/') return '/';
	const prefixed = input.startsWith('/') ? input : `/${input}`;
	return prefixed.endsWith('/') ? prefixed : `${prefixed}/`;
}

function abortError() {
	return new DOMException('The operation was aborted', 'AbortError');
}

export function createMegaLinkImportService({
	downloads = megaDownloadService,
	selectAccount = selectBestAccount,
	createSession = createUploadSession,
	beginUpload = startUpload,
	upload = runUpload,
	updateSession = updateUploadSession,
	removeSession = removeUploadSession,
	emitEvent = emitUploadEvent,
} = {}) {
	const jobs = new Map();

	function failBeforeUpload(job, message) {
		if (job.cleaned) return;
		job.cleaned = true;
		updateSession(job.session.id, { status: 'failed' });
		emitEvent(job.session.id, {
			type: 'upload:error',
			uploadId: job.session.id,
			status: 'failed',
			message,
		});
		removeSession(job.session.id);
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
			if (!job.uploadStarted) failBeforeUpload(job, 'MEGA import failed');
		} finally {
			jobs.delete(job.session.id);
		}
	}

	return {
		async start(userId, { link, virtualPath = '/' }) {
			const metadata = await downloads.inspectPublic(link);
			const allocation = selectAccount(userId, metadata.size);
			const session = createSession({
				user_id: userId,
				file_name: metadata.file_name,
				size: metadata.size,
				mime_type: metadata.mime_type,
				virtual_path: normalizePath(virtualPath),
				remote_parent_id: null,
				cloud_account_id: allocation.selected.id,
				fallback_chain: allocation.fallbackChain.map(({ id }) => id),
			});
			const job = {
				userId,
				session,
				controller: new AbortController(),
				stream: null,
				uploadStarted: false,
				cleaned: false,
			};
			jobs.set(session.id, job);
			beginUpload(session.id);
			void run(job, link, metadata);
			return { upload_id: session.id, file_name: metadata.file_name, size: metadata.size };
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
