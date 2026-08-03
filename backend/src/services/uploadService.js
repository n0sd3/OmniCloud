import Busboy from 'busboy';
import { PassThrough } from 'stream';
import { createAdapter } from './adapterRegistry.js';
import { getAccountById, markAccountStatus, updateAccountUsage } from './accountService.js';
import { createFileMetadata, getFileByRemoteId } from './fileService.js';
import { emitUploadEvent } from './websocketHub.js';
import { getUploadSessionForUser, updateUploadSession, removeUploadSession } from './uploadSessionService.js';
import { syncAccount } from './syncService.js';
import { fileCacheService } from './fileCacheService.js';
import { isAuthError } from '../utils/providerErrors.js';

// Proxy da Cloudflare corta o corpo da request em 100 MB (plano free).
export const CLOUDFLARE_MAX_BODY_BYTES = Number(process.env.CLOUDFLARE_MAX_BODY_BYTES || 100 * 1024 * 1024);
// ponytail: 20 MB deixa margem para o timeout de 100s da Cloudflare (erro 524)
// mesmo em conexões lentas. Sobe via UPLOAD_CHUNK_BYTES se a origem for direta.
export const UPLOAD_CHUNK_BYTES = Number(process.env.UPLOAD_CHUNK_BYTES || 20 * 1024 * 1024);

export function isBehindCloudflare(req) {
	return Boolean(req.headers['cf-ray']);
}

export function needsChunkedUpload(req, size) {
	return isBehindCloudflare(req) && Number(size) > CLOUDFLARE_MAX_BODY_BYTES;
}

async function runUpload({ session, stream, fileName, mimeType }) {
	let activeAccountId = session.cloud_account_id;
	const tried = new Set();
	let capture = { stream, discard: async () => {} };
	try {
		capture = fileCacheService.captureUpload(stream, session.id);
	} catch (error) {
		console.warn('Local file cache capture failed:', error);
	}

	const attemptUpload = async (accountId) => {
		tried.add(accountId);
		const account = getAccountById(session.user_id, accountId);
		if (!account) {
			throw new Error('Target upload account not found');
		}
		const adapter = createAdapter(account);

		const result = await adapter.uploadStream({
			stream: capture.stream,
			size: session.size,
			fileName,
			mimeType,
			virtualPath: session.virtual_path,
			remoteParentId: session.remote_parent_id,
			onProgress: (bytes) => {
				const percent = Math.min(100, Math.round((bytes / session.size) * 100));
				emitUploadEvent(session.id, {
					type: 'upload:progress',
					uploadId: session.id,
					bytes,
					percent,
					status: 'uploading',
				});
			},
		});

		return { result, account };
	};

	try {
		let uploadResponse;
		let account;

		try {
			({ result: uploadResponse, account } = await attemptUpload(activeAccountId));
		} catch (error) {
			if (isAuthError(error)) {
				markAccountStatus(session.user_id, activeAccountId, 'invalid_token');
			}
			const fallbackId = session.fallback_chain.find((id) => !tried.has(id));
			if (!fallbackId) {
				throw error;
			}
			activeAccountId = fallbackId;
			({ result: uploadResponse, account } = await attemptUpload(activeAccountId));
		}

		const usedSpace = Number(account.used_space) + Number(session.size);
		updateAccountUsage(session.user_id, account.id, usedSpace);

		let metadata = createFileMetadata({
			user_id: session.user_id,
			virtual_path: session.virtual_path,
			file_name: fileName,
			is_folder: false,
			size: session.size,
			mime_type: mimeType,
			cloud_account_id: account.id,
			remote_file_id: uploadResponse.remoteFileId,
			remote_parent_id: uploadResponse.remoteParentId,
		});

		await syncAccount(session.user_id, account);
		metadata = getFileByRemoteId(session.user_id, account.id, uploadResponse.remoteFileId) || metadata;
		try {
			await fileCacheService.commitCapture(capture, metadata);
		} catch (error) {
			console.warn('Local file cache commit failed:', error);
		}

		updateUploadSession(session.id, { status: 'completed', cloud_account_id: account.id });
		emitUploadEvent(session.id, {
			type: 'upload:complete',
			uploadId: session.id,
			percent: 100,
			status: 'completed',
			file: metadata,
		});
		return metadata;
	} catch (error) {
		updateUploadSession(session.id, { status: 'failed' });
		emitUploadEvent(session.id, {
			type: 'upload:error',
			uploadId: session.id,
			status: 'failed',
			message: error.message,
		});
		throw error;
	} finally {
		removeUploadSession(session.id);
		try {
			await capture.discard();
		} catch (error) {
			console.warn('Local file cache cleanup failed:', error);
		}
	}
}

function pipeUpload({ req, session }) {
	return new Promise((resolve, reject) => {
		const busboy = Busboy({ headers: req.headers });
		let fileReceived = false;

		busboy.on('file', (_field, file, info) => {
			fileReceived = true;
			const stream = new PassThrough();
			file.pipe(stream);
			runUpload({ session, stream, fileName: info.filename, mimeType: info.mimeType }).then(resolve, reject);
		});

		busboy.on('error', reject);
		busboy.on('finish', () => {
			if (!fileReceived) {
				removeUploadSession(session.id);
				reject(new Error('No file payload received'));
			}
		});

		req.pipe(busboy);
	});
}

function startUpload(uploadId) {
	updateUploadSession(uploadId, { status: 'uploading' });
	emitUploadEvent(uploadId, {
		type: 'upload:started',
		uploadId,
		percent: 0,
		status: 'uploading',
	});
}

export async function handleUpload(req, uploadId) {
	const session = getUploadSessionForUser(req.user.id, uploadId);

	if (!session) {
		throw new Error('Upload session not found');
	}

	startUpload(uploadId);
	return pipeUpload({ req, session });
}

// ponytail: estado em memória, igual ao uploadSessionService — vale enquanto a
// API for um processo só. Vários workers exigem sticky session ou storage compartilhado.
const chunkedUploads = new Map();

// Os listeners são removidos no fim de cada chunk: o mesmo stream atende todos
// eles, e acumular handlers estoura o limite de listeners em arquivos grandes.
function writeChunk(req, stream) {
	return new Promise((resolve, reject) => {
		const cleanup = () => {
			req.off('error', onError);
			req.off('end', onEnd);
			stream.off('error', onError);
			req.unpipe(stream);
		};

		function onError(error) {
			cleanup();
			reject(error);
		}

		function onEnd() {
			cleanup();
			resolve();
		}

		req.on('error', onError);
		req.on('end', onEnd);
		stream.on('error', onError);
		req.pipe(stream, { end: false });
	});
}

function abortChunkedUpload(uploadId, pending, error) {
	chunkedUploads.delete(uploadId);
	pending.stream.destroy(error);
}

// `upload` só é substituído pelo teste; em produção é sempre runUpload.
export async function handleChunk(req, uploadId, { index, isLast, fileName, mimeType, upload = runUpload }) {
	let pending = chunkedUploads.get(uploadId);

	// Antes da sessão: runUpload já a removeu ao falhar, e o erro real vale mais
	// para o cliente do que um "session not found" genérico.
	if (pending?.failure) {
		abortChunkedUpload(uploadId, pending, pending.failure);
		throw pending.failure;
	}

	const session = getUploadSessionForUser(req.user.id, uploadId);

	if (!session) {
		throw new Error('Upload session not found');
	}

	if (!pending) {
		if (index !== 0) {
			throw new Error('Invalid chunk order: upload was not started');
		}

		startUpload(uploadId);
		const stream = new PassThrough();
		// Handler permanente: sem ele, destruir o stream fora de um writeChunk
		// derrubaria o processo com um 'error' sem ouvinte.
		stream.on('error', () => {});
		pending = {
			stream,
			nextIndex: 0,
			failure: null,
			result: upload({
				session,
				stream,
				fileName: fileName || session.file_name,
				mimeType: mimeType || session.mime_type,
			}),
		};
		// O erro é entregue na resposta do chunk seguinte; destruir o stream aqui
		// impede que um chunk em voo fique preso esperando um consumidor morto.
		pending.result.catch((error) => {
			pending.failure = error;
			stream.destroy(error);
		});
		chunkedUploads.set(uploadId, pending);
	}

	if (index !== pending.nextIndex) {
		const error = new Error(`Invalid chunk order: expected ${pending.nextIndex}, received ${index}`);
		abortChunkedUpload(uploadId, pending, error);
		throw error;
	}

	try {
		await writeChunk(req, pending.stream);
	} catch (error) {
		abortChunkedUpload(uploadId, pending, error);
		throw error;
	}

	pending.nextIndex += 1;

	if (!isLast) {
		return null;
	}

	chunkedUploads.delete(uploadId);
	pending.stream.end();
	return pending.result;
}
