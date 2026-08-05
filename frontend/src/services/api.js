const API_BASE_URL = import.meta.env?.VITE_API_BASE_URL || 'http://localhost:8787/api';
const WS_BASE_URL = import.meta.env?.VITE_WS_BASE_URL
	|| API_BASE_URL.replace(/^http/, 'ws').replace(/\/api$/, '/ws/uploads');

async function request(path, options = {}) {
	const response = await fetch(`${API_BASE_URL}${path}`, {
		credentials: 'include',
		headers: {
			'Content-Type': 'application/json',
			...(options.headers || {}),
		},
		...options,
	});

	if (!response.ok) {
		const payload = await response.json().catch(() => ({ error: 'Unknown API error' }));
		const error = new Error(payload.error || 'API request failed');
		error.status = response.status;
		throw error;
	}

	if (response.status === 204) return null;
	return response.json();
}

export const authApi = {
	me() {
		return request('/auth/me');
	},
	login(payload) {
		return request('/auth/login', {
			method: 'POST',
			body: JSON.stringify(payload),
		});
	},
	register(payload) {
		return request('/auth/register', {
			method: 'POST',
			body: JSON.stringify(payload),
		});
	},
	logout() {
		return request('/auth/logout', {
			method: 'POST',
		});
	},
};

export const settingsApi = {
	getSettings() {
		return request('/settings');
	},
	updateSettings(payload) {
		return request('/settings', {
			method: 'PATCH',
			body: JSON.stringify(payload),
		});
	},
	getAppSettings() {
		return request('/app-settings');
	},
	updateAppSettings(payload) {
		return request('/app-settings', {
			method: 'PATCH',
			body: JSON.stringify(payload),
		});
	},
};

export const smbApi = {
	get() {
		return request('/smb');
	},
	update(password) {
		return request('/smb', {
			method: 'PUT',
			body: JSON.stringify({ password }),
		});
	},
	disable() {
		return request('/smb', { method: 'DELETE' });
	},
};

export const api = {
	listFiles(virtualPath = '/') {
		const query = new URLSearchParams({ path: virtualPath }).toString();
		return request(`/files?${query}`);
	},
	searchFiles(term, limit = 50) {
		const query = new URLSearchParams({ search: term, limit: String(limit) }).toString();
		return request(`/files?${query}`);
	},
	listStarredFiles() {
		return request('/files?starred=1');
	},
	listRecentFiles() {
		return request('/files?recent=1');
	},
	listSharedWithMeFiles() {
		return request('/files?shared=1');
	},
	listSharedFolderChildren(fileId) {
		return request(`/files/${fileId}/shared-children`);
	},
	getFileDetails(fileId) {
		return request(`/files/${fileId}`);
	},
	createFolder(payload) {
		return request('/files/folders', {
			method: 'POST',
			body: JSON.stringify(payload),
		});
	},
	renameFile(fileId, payload) {
		return request(`/files/${fileId}/rename`, {
			method: 'PATCH',
			body: JSON.stringify(payload),
		});
	},
	toggleStar(fileId, isStarred = true) {
		return request(`/files/${fileId}/star`, {
			method: 'PATCH',
			body: JSON.stringify({ is_starred: isStarred }),
		});
	},
	deleteFile(fileId) {
		return request(`/files/${fileId}`, {
			method: 'DELETE',
		});
	},
	deleteFiles(fileIds) {
		return request('/files/bulk/delete', {
			method: 'POST',
			body: JSON.stringify({ ids: fileIds }),
		});
	},
	getGoogleIntegrationStatus() {
		return request('/accounts/google/status');
	},
	getGoogleConnectUrl() {
		return request('/accounts/google/connect');
	},
	startGooglePhotosImport(accountId) {
		return request(`/accounts/google/${encodeURIComponent(accountId)}/photos/imports`, { method: 'POST' });
	},
	getGooglePhotosImport(importId) {
		return request(`/accounts/google/photos/imports/${encodeURIComponent(importId)}`);
	},
	cancelGooglePhotosImport(importId) {
		return request(`/accounts/google/photos/imports/${encodeURIComponent(importId)}`, { method: 'DELETE' });
	},
	getOneDriveIntegrationStatus() {
		return request('/accounts/onedrive/status');
	},
	getOneDriveConnectUrl() {
		return request('/accounts/onedrive/connect');
	},
	getDropboxIntegrationStatus() {
		return request('/accounts/dropbox/status');
	},
	getDropboxConnectUrl() {
		return request('/accounts/dropbox/connect');
	},
	getMegaIntegrationStatus() {
		return request('/accounts/mega/status');
	},
	connectMegaAccount(payload) {
		return request('/accounts/mega/connect', {
			method: 'POST',
			body: JSON.stringify(payload),
		});
	},
	connectS3Account(payload) {
		return request('/accounts/s3/connect', {
			method: 'POST',
			body: JSON.stringify(payload),
		});
	},
	connectPCloudAccount(payload) {
		return request('/accounts/pcloud/connect', {
			method: 'POST',
			body: JSON.stringify(payload),
		});
	},
	getYandexConnectUrl() {
		return request('/accounts/yandex/connect');
	},
	listAccounts() {
		return request('/accounts');
	},
	disconnectAccount(accountId) {
		return request(`/accounts/${accountId}`, {
			method: 'DELETE',
		});
	},
	getHealth() {
		return request('/health');
	},
	runSync() {
		return request('/sync/run', {
			method: 'POST',
		});
	},
	initiateUpload(payload, options = {}) {
		return request('/uploads/initiate', {
			method: 'POST',
			body: JSON.stringify(payload),
			signal: options.signal,
		});
	},
	async uploadFile(uploadId, file, options = {}) {
		const formData = new FormData();
		formData.append('file', file);

		const response = await fetch(`${API_BASE_URL}/uploads/${uploadId}/stream`, {
			method: 'POST',
			credentials: 'include',
			body: formData,
			signal: options.signal,
		});

		if (!response.ok) {
			const payload = await response.json().catch(() => ({ error: 'Upload failed' }));
			throw new Error(payload.error || 'Upload failed');
		}

		return response.json();
	},
	async uploadFileInChunks(uploadId, file, chunkSize, options = {}) {
		const total = Math.max(1, Math.ceil(file.size / chunkSize));
		let lastResponse = null;

		for (let index = 0; index < total; index += 1) {
			const start = index * chunkSize;
			const response = await fetch(`${API_BASE_URL}/uploads/${uploadId}/chunk`, {
				method: 'POST',
				credentials: 'include',
				body: file.slice(start, Math.min(start + chunkSize, file.size)),
				signal: options.signal,
				headers: {
					'Content-Type': 'application/octet-stream',
					'X-Chunk-Index': String(index),
					'X-Chunk-Last': index === total - 1 ? '1' : '0',
					'X-File-Name': encodeURIComponent(file.name),
					'X-File-Type': file.type || 'application/octet-stream',
				},
			});

			if (!response.ok) {
				const payload = await response.json().catch(() => ({ error: 'Upload failed' }));
				throw new Error(payload.error || 'Upload failed');
			}

			lastResponse = await response.json();
		}

		return lastResponse;
	},
	createUploadSocket(uploadId) {
		return new WebSocket(`${WS_BASE_URL}?uploadId=${encodeURIComponent(uploadId)}`);
	},
	inspectMegaLink(link, options = {}) {
		return request('/mega-links/inspect', {
			method: 'POST',
			body: JSON.stringify({ link }),
			signal: options.signal,
		});
	},
	downloadMegaLink(link) {
		const target = `mega-download-${crypto.randomUUID()}`;
		const frame = document.createElement('iframe');
		frame.name = target;
		frame.hidden = true;
		frame.setAttribute('aria-hidden', 'true');

		const form = document.createElement('form');
		form.method = 'POST';
		form.action = `${API_BASE_URL}/mega-links/download`;
		form.target = target;
		form.enctype = 'application/x-www-form-urlencoded';
		form.hidden = true;

		const input = document.createElement('input');
		input.type = 'hidden';
		input.name = 'link';
		input.value = link;
		form.appendChild(input);
		document.body.appendChild(frame);
		document.body.appendChild(form);
		form.submit();
		form.remove();
		window.setTimeout(() => frame.remove(), 60_000);
	},
	importMegaLink(link, virtualPath, options = {}) {
		return request('/mega-links/import', {
			method: 'POST',
			body: JSON.stringify({ link, virtual_path: virtualPath }),
			signal: options.signal,
		});
	},
	cancelMegaLinkImport(uploadId) {
		return request(`/mega-links/import/${encodeURIComponent(uploadId)}`, { method: 'DELETE' });
	},
	downloadUrl(fileId) {
		return `${API_BASE_URL}/files/${fileId}/download`;
	},
	previewUrl(fileId) {
		return `${API_BASE_URL}/files/${fileId}/preview`;
	},
	previewPages(fileId) {
		return request(`/files/${fileId}/preview/pages`);
	},
	previewPageUrl(fileId, page) {
		return `${API_BASE_URL}/files/${fileId}/preview/page/${page}`;
	},
	async previewText(fileId) {
		const response = await fetch(`${API_BASE_URL}/files/${fileId}/preview`, { credentials: 'include' });
		if (!response.ok) throw new Error(`Preview request failed with ${response.status}`);
		return response.text();
	},
	thumbnailUrl(file) {
		const revision = file.modifiedTime || file.remote_modified_time || file.updated_at || '';
		const query = new URLSearchParams({ v: `${revision}:${Number(file.size || 0)}` }).toString();
		return `${API_BASE_URL}/files/${file.id}/thumbnail?${query}`;
	},
	getSettings() {
		return settingsApi.getSettings();
	},
	updateSettings(payload) {
		return settingsApi.updateSettings(payload);
	},
	getAppSettings() {
		return settingsApi.getAppSettings();
	},
	updateAppSettings(payload) {
		return settingsApi.updateAppSettings(payload);
	},
	getSmbAccess() {
		return smbApi.get();
	},
	updateSmbAccess(password) {
		return smbApi.update(password);
	},
	disableSmbAccess() {
		return smbApi.disable();
	},
	getAllocation() {
		return request('/allocation');
	},
	updateAllocation(payload) {
		return request('/allocation', {
			method: 'PATCH',
			body: JSON.stringify(payload),
		});
	},
};
