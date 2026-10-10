import { googleDocsExport } from '../utils/mime.js';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { db } from '../config/database.js';
import {
	listFilesByPath,
	listAllFiles,
	createFileMetadata,
	deleteFileMetadata,
	getFileById,
} from '../services/fileService.js';
import { getAccountById, updateAccountUsage } from '../services/accountService.js';
import { createAdapter } from '../services/adapterRegistry.js';
import { reserveBestAccount, releaseAccountReservation } from '../services/spaceAllocator.js';
import { createUploadSession, removeUploadSession } from '../services/uploadSessionService.js';
import { runUpload } from '../services/uploadService.js';
import { replaceExisting } from '../services/replaceFileService.js';
import { fileCacheService } from '../services/fileCacheService.js';
import { parseRangeHeader, toHttpDate } from '../services/webdav.js';
import { s3Error } from './response.js';

export function resolveObject(userId, mapped) {
	const matches = listFilesByPath(userId, mapped.parentPath).filter(
		(f) => f.file_name === mapped.name,
	);
	if (matches.length > 1)
		throw s3Error(
			'InvalidRequest',
			'Multiple providers contain this virtual key; resolve the duplicate in OmniCloud',
		);
	const file = matches[0];
	if (file && Boolean(file.is_folder) !== Boolean(mapped.folder))
		throw s3Error('InvalidRequest', 'Key type conflicts with the virtual filesystem');
	return file;
}
export function objectVersion(file) {
	if (file.is_folder)
		return {
			etag: '"d41d8cd98f00b204e9800998ecf8427e"',
			mimeType: 'application/x-directory',
			metadata: {},
		};
	const saved = db
		.prepare('SELECT * FROM s3_object_versions WHERE user_id=? AND account_id=? AND remote_id=?')
		.get(file.user_id, file.cloud_account_id, file.remote_file_id);
	if (
		saved &&
		saved.size === file.size &&
		saved.modified_time === (file.remote_modified_time || null)
	)
		return {
			etag: saved.etag,
			mimeType: saved.mime_type,
			metadata: JSON.parse(saved.metadata_json),
		};
	const value = JSON.stringify([
		file.cloud_account_id,
		file.remote_file_id,
		file.size,
		file.remote_modified_time || file.remote_created_time || null,
	]);
	return {
		etag: `"oc-${createHash('sha256').update(value).digest('hex')}"`,
		mimeType: file.mime_type || 'application/octet-stream',
		metadata: {},
	};
}
function saveVersion(file, etag, mimeType, metadata) {
	db.prepare(
		'INSERT INTO s3_object_versions(user_id,account_id,remote_id,size,modified_time,etag,mime_type,metadata_json) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(user_id,account_id,remote_id) DO UPDATE SET size=excluded.size,modified_time=excluded.modified_time,etag=excluded.etag,mime_type=excluded.mime_type,metadata_json=excluded.metadata_json',
	).run(
		file.user_id,
		file.cloud_account_id,
		file.remote_file_id,
		file.size,
		file.remote_modified_time || null,
		etag,
		mimeType,
		JSON.stringify(metadata),
	);
}
export function allObjects(userId) {
	const objects = new Map();
	for (const file of listAllFiles(userId, { activeOnly: true })) {
		const key = file.virtual_path.slice(1) + file.file_name + (file.is_folder ? '/' : '');
		if (objects.has(key) && !file.is_folder)
			throw s3Error('InvalidRequest', 'Duplicate virtual keys exist in connected providers');
		objects.set(key, { key, file });
	}
	return [...objects.values()].sort((a, b) =>
		Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)),
	);
}
async function ensureParents(userId, mapped, account) {
	let parentPath = '/';
	for (const name of mapped.parentPath.split('/').filter(Boolean)) {
		const existing = listFilesByPath(userId, parentPath).filter((f) => f.file_name === name);
		if (existing.some((f) => !f.is_folder))
			throw s3Error('InvalidRequest', 'A parent path is a file');
		if (!existing.length) {
			const created = await createAdapter(account).createFolder({
				name,
				virtualPath: parentPath,
				remoteParentId: null,
			});
			createFileMetadata({
				user_id: userId,
				virtual_path: parentPath,
				file_name: name,
				is_folder: true,
				size: 0,
				cloud_account_id: account.id,
				remote_file_id: created.remoteFileId,
				remote_parent_id: created.remoteParentId,
			});
		}
		parentPath += `${name}/`;
	}
}
export async function putObject(userId, mapped, { size, mimeType, stream, etag, metadata = {} }) {
	const existing = resolveObject(userId, mapped);
	if (mapped.folder && size !== 0)
		throw s3Error('InvalidRequest', 'Folder markers must have an empty body');
	const allocation = reserveBestAccount(userId, size);
	let uploaded;
	let session;
	let promoted = false;
	try {
		await ensureParents(userId, mapped, allocation.selected);
		if (mapped.folder) {
			if (!existing) {
				const folder = await createAdapter(allocation.selected).createFolder({
					name: mapped.name,
					virtualPath: mapped.parentPath,
					remoteParentId: null,
				});
				createFileMetadata({
					user_id: userId,
					file_name: mapped.name,
					virtual_path: mapped.parentPath,
					is_folder: true,
					size: 0,
					cloud_account_id: allocation.selected.id,
					remote_file_id: folder.remoteFileId,
					remote_parent_id: folder.remoteParentId,
				});
			}
			return etag;
		}
		// Only overwrite needs remote promotion; first writes use the normal upload path.
		const name = existing ? `${mapped.name}.omnicloud-upload-${randomUUID()}` : mapped.name;
		session = createUploadSession({
			user_id: userId,
			file_name: name,
			size,
			mime_type: mimeType,
			virtual_path: mapped.parentPath,
			remote_parent_id: null,
			cloud_account_id: allocation.selected.id,
			fallback_chain: allocation.fallbackChain.filter((a) => a.freeSpace >= size).map((a) => a.id),
		});
		uploaded = await runUpload({
			session,
			stream: stream(),
			streamFactory: stream,
			fileName: name,
			mimeType,
			synchronize: false,
		});
		if (existing) {
			await replaceExisting(userId, existing, uploaded, mapped.name, () => {
				promoted = true;
			});
			promoted = true;
		} else promoted = true;
		const file = getFileById(userId, uploaded.id);
		saveVersion(file, etag, mimeType, metadata);
		return etag;
	} catch (error) {
		if (uploaded && !promoted) {
			try {
				const failedAccount = getAccountById(userId, uploaded.cloud_account_id);
				await createAdapter(failedAccount).deleteFile(uploaded);
				updateAccountUsage(
					userId,
					failedAccount.id,
					Math.max(0, Number(failedAccount.used_space) - Number(uploaded.size)),
				);
				await fileCacheService.invalidate(uploaded);
				deleteFileMetadata(userId, uploaded.id);
			} catch {
				/* Leave failed cleanup visible for recovery through the application. */
			}
		}
		throw error;
	} finally {
		releaseAccountReservation(allocation.reservationId);
		if (session) removeUploadSession(session.id);
	}
}
export async function deleteObject(userId, mapped) {
	const file = resolveObject(userId, mapped);
	if (!file) return;
	if (
		file.is_folder &&
		listAllFiles(userId).some((child) => child.virtual_path.startsWith(`/${mapped.key}`))
	)
		throw s3Error('InvalidRequest', 'Deleting a nonempty folder marker is not supported');
	const account = getAccountById(userId, file.cloud_account_id);
	if (!account) throw s3Error('ServiceUnavailable');
	await createAdapter(account).deleteFile(file);
	updateAccountUsage(
		userId,
		account.id,
		Math.max(0, Number(account.used_space) - Number(file.size)),
	);
	deleteFileMetadata(userId, file.id);
	await fileCacheService.invalidate(file);
	db.prepare('DELETE FROM s3_object_versions WHERE user_id=? AND account_id=? AND remote_id=?').run(
		userId,
		account.id,
		file.remote_file_id,
	);
}
function safeType(value) {
	return /^[\x20-\x7e]{1,255}$/.test(value) ? value : 'application/octet-stream';
}
export async function sendObject(userId, mapped, req, res) {
	const file = resolveObject(userId, mapped);
	if (!file) throw s3Error('NoSuchKey', 'The specified key does not exist');
	if (googleDocsExport(file))
		throw s3Error(
			'NotImplemented',
			'Native Google documents must be exported to a binary file first',
		);
	const { etag, mimeType, metadata } = objectVersion(file);
	for (const [name, value] of Object.entries(metadata))
		if (/^[a-z0-9-]+$/.test(name) && /^[\x20-\x7e]*$/.test(value))
			res.setHeader(`x-amz-meta-${name}`, value);
	const size = Number(file.size);
	res.setHeader('ETag', etag);
	res.setHeader('Content-Type', safeType(mimeType));
	res.setHeader('Last-Modified', toHttpDate(file.remote_modified_time || file.created_at));
	res.setHeader('Accept-Ranges', 'bytes');
	if (
		req.headers['if-match'] &&
		req.headers['if-match'] !== '*' &&
		req.headers['if-match'] !== etag
	)
		throw s3Error('PreconditionFailed');
	if (req.headers['if-none-match'] === etag || req.headers['if-none-match'] === '*') {
		res.status(304).end();
		return;
	}
	const range = req.headers.range ? parseRangeHeader(req.headers.range, size) : null;
	if (req.headers.range && !range) {
		res.setHeader('Content-Range', `bytes */${size}`);
		throw s3Error('InvalidRange');
	}
	res.status(range ? 206 : 200);
	res.setHeader('Content-Length', String(range ? range.end - range.start + 1 : size));
	if (range) res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
	if (req.method === 'HEAD') {
		res.end();
		return;
	}
	if (file.is_folder) {
		res.end();
		return;
	}
	const account = getAccountById(userId, file.cloud_account_id);
	const adapter = createAdapter(account);
	const supportsRange = adapter.getCapabilities?.().supportsRange;
	const opened = await fileCacheService.openFile({
		userId,
		file,
		adapter,
		range: supportsRange ? range || {} : {},
	});
	let source = opened.stream;
	if (range && !supportsRange) {
		const input = source;
		source = Readable.from(
			(async function* () {
				let offset = 0;
				for await (const chunk of input) {
					const from = Math.max(0, range.start - offset);
					const to = Math.min(chunk.length, range.end + 1 - offset);
					if (to > from) yield chunk.subarray(from, to);
					offset += chunk.length;
					if (offset > range.end) break;
				}
			})(),
		);
	}
	await pipeline(source, res);
}
