import { defineStore } from 'pinia';
import { api } from '../services/api.js';
import { i18n } from '../i18n.js';

function formatBytes(value) {
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let amount = Number(value || 0);
	let index = 0;
	while (amount >= 1024 && index < units.length - 1) {
		amount /= 1024;
		index += 1;
	}
	return `${amount.toFixed(amount >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function normalizePath(path) {
	if (!path || path === '/') return '/';
	const prefixed = path.startsWith('/') ? path : `/${path}`;
	return prefixed.endsWith('/') ? prefixed : `${prefixed}/`;
}

function buildVirtualPath(currentPath, relativePath = '') {
	const normalizedCurrent = normalizePath(currentPath);
	if (!relativePath) return normalizedCurrent;

	const segments = relativePath.split('/').filter(Boolean);
	segments.pop();

	if (!segments.length) return normalizedCurrent;
	return normalizePath(`${normalizedCurrent}${segments.join('/')}`);
}

function normalizeUploadEntry(entry) {
	if (entry instanceof File) {
		return {
			file: entry,
			relativePath: entry.webkitRelativePath || entry.name,
		};
	}

	return {
		file: entry.file,
		relativePath: entry.relativePath || entry.file?.webkitRelativePath || entry.file?.name,
	};
}

function isAbortError(error) {
	return error?.name === 'AbortError';
}

function isCancellable(operation) {
	return ['upload', 'download'].includes(operation?.type) && ['pending', 'uploading', 'downloading'].includes(operation?.status);
}

function createBatchId() {
	return crypto.randomUUID();
}

function cancelRemoteBestEffort(operation) {
	try {
		Promise.resolve(operation?.cancelRemote?.()).catch(() => {});
	} catch {
	}
}

const IMPORT_SOCKET_RETRIES = 3;

function createImportSocketTracker({ uploadId, signal, update, onCompleted }) {
	let socket = null;
	let reconnectTimer = null;
	let reconnectAttempts = 0;
	let terminal = false;

	function stop() {
		terminal = true;
		if (reconnectTimer) window.clearTimeout(reconnectTimer);
		reconnectTimer = null;
		if (socket) {
			socket.onerror = null;
			socket.onclose = null;
		}
	}

	function scheduleReconnect(failedSocket) {
		if (terminal || signal.aborted || failedSocket !== socket || reconnectTimer) return;
		if (reconnectAttempts >= IMPORT_SOCKET_RETRIES) {
			update({ error: i18n.global.t('megaLink.socketError') });
			return;
		}

		const delay = 250 * (2 ** reconnectAttempts);
		reconnectAttempts += 1;
		reconnectTimer = window.setTimeout(() => {
			reconnectTimer = null;
			if (terminal || signal.aborted) return;
			if (socket) {
				socket.onerror = null;
				socket.onclose = null;
				socket.close();
			}
			connect();
		}, delay);
	}

	function connect() {
		if (terminal || signal.aborted) return;
		const nextSocket = api.createUploadSocket(uploadId);
		socket = nextSocket;
		update({ socket: nextSocket, stopTracking: stop });

		nextSocket.onmessage = (event) => {
			if (terminal || signal.aborted || nextSocket !== socket) return;
			let message;
			try {
				message = JSON.parse(event.data);
			} catch {
				return;
			}

			if (message.type === 'socket:ready') {
				update({ error: null });
			}
			if (message.type === 'upload:started' || message.type === 'upload:progress') {
				update({
					progress_percentage: Number(message.percent || 0),
					status: message.status || 'uploading',
					error: null,
				});
			}
			if (message.type === 'upload:complete') {
				stop();
				update({ progress_percentage: 100, status: 'completed', error: null });
				nextSocket.close();
				onCompleted?.(message.file);
			}
			if (message.type === 'upload:error') {
				stop();
				update({ status: 'failed', error: message.message });
				nextSocket.close();
			}
		};
		nextSocket.onerror = () => scheduleReconnect(nextSocket);
		nextSocket.onclose = () => scheduleReconnect(nextSocket);
	}

	connect();
	return stop;
}

async function saveDownloadResponse({ response, queueItem, fileName, size, update }) {
	const contentLength = Number(response.headers.get('Content-Length')) || size || 0;
	const reader = response.body?.getReader();
	const chunks = [];
	let received = 0;

	if (reader) {
		while (true) {
			if (queueItem.abortController.signal.aborted) throw new DOMException('Download cancelled', 'AbortError');
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
			received += value.length;
			const percent = contentLength ? Math.min(99, Math.round((received / contentLength) * 100)) : 50;
			update({ progress_percentage: percent });
		}
	} else {
		chunks.push(await response.blob());
	}

	const blob = chunks[0] instanceof Blob ? chunks[0] : new Blob(chunks);
	const url = URL.createObjectURL(blob);
	const link = document.createElement('a');
	link.href = url;
	link.download = fileName || 'download';
	document.body.appendChild(link);
	link.click();
	link.remove();
	URL.revokeObjectURL(url);
}

// ponytail: confirm nativo — troca por modal se o aviso precisar de mais contexto.
function confirmChunkedUpload(file, chunked) {
	return window.confirm(
		i18n.global.t('upload.chunkedPrompt', {
			name: file.name,
			size: formatBytes(file.size),
			limit: formatBytes(chunked.limit),
		}),
	);
}

export const useUploadQueueStore = defineStore('uploadQueue', {
	state: () => ({
		uploads: [],
	}),
	getters: {
		activeUploads: (state) => state.uploads.filter((item) => !['completed', 'failed', 'cancelled'].includes(item.status)),
		totalProgress: (state) => {
			const activeItems = state.uploads.filter((item) => !['completed', 'failed', 'cancelled'].includes(item.status));
			if (!activeItems.length) return 0;
			const total = activeItems.reduce((sum, item) => sum + item.progress_percentage, 0);
			return Math.round(total / activeItems.length);
		},
	},
	actions: {
		registerOperation({ type, name, size = 0, status = 'pending', progress = 0, ...metadata }) {
			const operation = {
				id: crypto.randomUUID(),
				type,
				name,
				...metadata,
				size,
				progress_percentage: progress,
				status,
				error: null,
				createdAt: Date.now(),
			};

			this.uploads.unshift(operation);
			return operation;
		},
		registerUpload(file, currentPath, relativePath, metadata = {}) {
			const abortController = new AbortController();
			const upload = {
				id: crypto.randomUUID(),
				type: 'upload',
				file,
				name: relativePath || file.name,
				...metadata,
				size: file.size,
				progress_percentage: 0,
				status: 'pending',
				socket: null,
				abortController,
				currentPath,
				error: null,
			};

			this.uploads.unshift(upload);
			return upload;
		},
		updateUpload(id, patch) {
			const index = this.uploads.findIndex((item) => item.id === id);
			if (index === -1) return;
			this.uploads[index] = { ...this.uploads[index], ...patch };
		},
		closeOperation(id) {
			const operation = this.uploads.find((item) => item.id === id);
			const batchOperations = operation ? [] : this.uploads.filter((item) => item.batchId === id);

			if (batchOperations.length) {
				const hasCancellable = batchOperations.some((item) => isCancellable(item));
				if (hasCancellable) {
					for (const item of batchOperations) {
						cancelRemoteBestEffort(item);
						item.abortController?.abort?.();
						item.stopTracking?.();
						item.socket?.close?.();
						this.updateUpload(item.id, {
							status: 'cancelled',
							error: null,
						});
					}
					return;
				}

				for (const item of batchOperations) {
					item.socket?.close?.();
				}
				this.uploads = this.uploads.filter((item) => item.batchId !== id);
				return;
			}

			if (isCancellable(operation)) {
				cancelRemoteBestEffort(operation);
				operation.abortController?.abort?.();
				operation.stopTracking?.();
				operation.socket?.close?.();
				this.updateUpload(id, {
					status: 'cancelled',
					error: null,
				});
				return;
			}

			if (operation?.socket) {
				operation.socket.close();
			}

			this.uploads = this.uploads.filter((item) => item.id !== id);
		},
		clearOperations() {
			for (const operation of this.uploads) {
				if (isCancellable(operation)) cancelRemoteBestEffort(operation);
				operation.abortController?.abort?.();
				operation.stopTracking?.();
				operation.socket?.close?.();
			}
			this.uploads = [];
		},
		async trackServerOperation(metadata, operation) {
			const queueItem = this.registerOperation({ ...metadata, status: 'processing', progress: 15 });

			try {
				this.updateUpload(queueItem.id, { progress_percentage: 45 });
				const result = await operation();
				this.updateUpload(queueItem.id, {
					progress_percentage: 100,
					status: 'completed',
				});
				return result;
			} catch (error) {
				this.updateUpload(queueItem.id, {
					status: 'failed',
					error: error.message,
				});
				throw error;
			}
		},
		async downloadFile(file) {
			return this.downloadFiles(file ? [file] : []);
		},
		async downloadFiles(files) {
			const downloadableFiles = files.filter((file) => file && !file.is_folder);
			if (!downloadableFiles.length) return;

			const batchId = createBatchId();
			const batchTotal = downloadableFiles.length;

			for (const file of downloadableFiles) {
			const abortController = new AbortController();

			const queueItem = this.registerOperation({
				type: 'download',
				name: file.display_name || file.file_name,
				size: file.size || 0,
				status: 'downloading',
				abortController,
				batchId,
				batchTotal,
			});

			try {
				const response = await fetch(api.downloadUrl(file.id), { signal: abortController.signal });
				if (!response.ok) {
					const payload = await response.json().catch(() => ({ error: 'Download failed' }));
					throw new Error(payload.error || 'Download failed');
				}

				await saveDownloadResponse({
					response,
					queueItem,
					fileName: file.display_name || file.file_name,
					size: file.size,
					update: (patch) => this.updateUpload(queueItem.id, patch),
				});

				this.updateUpload(queueItem.id, {
					progress_percentage: 100,
					status: 'completed',
				});
			} catch (error) {
				if (isAbortError(error)) {
					this.updateUpload(queueItem.id, {
						status: 'cancelled',
						error: null,
					});
					return;
				}

				this.updateUpload(queueItem.id, {
					status: 'failed',
					error: error.message,
				});
				if (batchTotal === 1) throw error;
			}
			}
		},
		async downloadMegaLink(link) {
			const { data: metadata } = await api.inspectMegaLink(link);
			const queueItem = this.registerOperation({
				type: 'download',
				name: metadata.file_name,
				size: metadata.size || 0,
				status: 'processing',
			});

			try {
				api.downloadMegaLink(link);
				this.updateUpload(queueItem.id, { progress_percentage: 100, status: 'completed' });
			} catch (error) {
				this.updateUpload(queueItem.id, { status: 'failed', error: error.message });
				throw error;
			}

			return metadata;
		},
		async importMegaLink(link, currentPath, onCompleted) {
			const abortController = new AbortController();
			const queueItem = this.registerOperation({
				type: 'upload',
				name: i18n.global.t('megaLink.pendingName'),
				status: 'pending',
				abortController,
				currentPath,
			});

			try {
				const { data } = await api.importMegaLink(link, currentPath, { signal: abortController.signal });
				if (abortController.signal.aborted) {
					void api.cancelMegaLinkImport(data.upload_id).catch(() => {});
					return data;
				}

				this.updateUpload(queueItem.id, {
					name: data.file_name,
					size: data.size || 0,
					status: 'uploading',
					remoteUploadId: data.upload_id,
					cancelRemote: () => api.cancelMegaLinkImport(data.upload_id),
				});

				createImportSocketTracker({
					uploadId: data.upload_id,
					signal: abortController.signal,
					update: (patch) => this.updateUpload(queueItem.id, patch),
					onCompleted,
				});

				return data;
			} catch (error) {
				this.updateUpload(queueItem.id, {
					status: isAbortError(error) || abortController.signal.aborted ? 'cancelled' : 'failed',
					error: isAbortError(error) || abortController.signal.aborted ? null : error.message,
				});
				throw error;
			}
		},
		async uploadFiles(files, currentPath, onCompleted) {
			const entries = Array.from(files || []);
			const batchId = createBatchId();
			const batchTotal = entries.length;
			// Decisão de enviar em partes vale para o lote inteiro, não por arquivo.
			let chunkedAccepted = null;

			for (const rawEntry of entries) {
				const { file, relativePath } = normalizeUploadEntry(rawEntry);
				const queueItem = this.registerUpload(file, currentPath, relativePath, { batchId, batchTotal });
				const targetPath = buildVirtualPath(currentPath, relativePath);

				try {
					const { data } = await api.initiateUpload({
						file_name: file.name,
						size: file.size,
						mime_type: file.type || 'application/octet-stream',
						virtual_path: targetPath,
					}, { signal: queueItem.abortController.signal });

					if (data.chunked?.required) {
						if (chunkedAccepted === null) {
							chunkedAccepted = confirmChunkedUpload(file, data.chunked);
						}

						if (!chunkedAccepted) {
							this.updateUpload(queueItem.id, {
								status: 'failed',
								error: i18n.global.t('upload.chunkedDeclined'),
							});
							continue;
						}
					}

					const socket = api.createUploadSocket(data.upload_id);
					this.updateUpload(queueItem.id, {
						status: 'uploading',
						socket,
						remoteUploadId: data.upload_id,
					});

					socket.onmessage = (event) => {
						if (queueItem.abortController.signal.aborted) return;

						const message = JSON.parse(event.data);
						if (message.type === 'upload:progress') {
							this.updateUpload(queueItem.id, {
								progress_percentage: message.percent,
								status: message.status,
							});
						}

						if (message.type === 'upload:complete') {
							this.updateUpload(queueItem.id, {
								progress_percentage: 100,
								status: 'completed',
							});
							socket.close();
							onCompleted?.();
						}

						if (message.type === 'upload:error') {
							this.updateUpload(queueItem.id, {
								status: 'failed',
								error: message.message,
							});
							socket.close();
						}
					};

					socket.onerror = () => {
						this.updateUpload(queueItem.id, {
							status: 'failed',
							error: 'WebSocket connection failed',
						});
					};

					if (data.chunked?.required) {
						await api.uploadFileInChunks(data.upload_id, file, data.chunked.chunk_size, {
							signal: queueItem.abortController.signal,
						});
					} else {
						await api.uploadFile(data.upload_id, file, { signal: queueItem.abortController.signal });
					}
				} catch (error) {
					if (isAbortError(error) || queueItem.abortController.signal.aborted) {
						this.updateUpload(queueItem.id, {
							status: 'cancelled',
							error: null,
						});
						continue;
					}

					this.updateUpload(queueItem.id, {
						status: 'failed',
						error: error.message,
					});
				}
			}
		},
	},
});
