import { randomUUID } from 'node:crypto';
import { db } from '../config/database.js';
import { getAccountById, updateAccountUsage } from './accountService.js';
import { createAdapter } from './adapterRegistry.js';
import { fileCacheService } from './fileCacheService.js';
import { deleteFileMetadata, renameFileMetadata } from './fileService.js';

// shortcut: remote rename is not a transaction, preserve a named backup for recovery if rollback fails.
export async function replaceExisting(userId, existing, uploaded, name, onPromoted = () => {}) {
	const adapter = createAdapter(getAccountById(userId, uploaded.cloud_account_id));
	const previousAccount = getAccountById(userId, existing.cloud_account_id);
	const previousAdapter = createAdapter(previousAccount);
	const backupName = `${name}.omnicloud-backup-${randomUUID()}`;
	const backedUp = await previousAdapter.renameFile(existing, backupName);
	const backup = {
		...existing,
		file_name: backupName,
		remote_file_id: backedUp?.remoteFileId || existing.remote_file_id,
	};
	renameFileMetadata(userId, existing.id, backupName, backup.remote_file_id);
	let renamed;
	try {
		renamed = await adapter.renameFile(uploaded, name);
	} catch (error) {
		try {
			const restored = await previousAdapter.renameFile(backup, name);
			renameFileMetadata(
				userId,
				existing.id,
				name,
				restored?.remoteFileId || backup.remote_file_id,
			);
		} catch {
			console.warn(
				JSON.stringify({
					service: 'filesystem',
					event: 'overwrite-rollback-failed',
					userId,
					fileId: existing.id,
				}),
			);
		}
		throw error;
	}
	onPromoted();
	const promoted = {
		...uploaded,
		file_name: name,
		remote_file_id: renamed?.remoteFileId || uploaded.remote_file_id,
	};
	// Publish new metadata together; do not delete the backup until publication is durable.
	db.transaction(() => {
		deleteFileMetadata(userId, existing.id);
		renameFileMetadata(userId, uploaded.id, name, promoted.remote_file_id);
	})();
	try {
		await fileCacheService.invalidate(existing);
		await fileCacheService.rebind(uploaded, promoted);
	} catch {
		console.warn(
			JSON.stringify({
				service: 'filesystem',
				event: 'overwrite-cache-failed',
				userId,
				fileId: uploaded.id,
			}),
		);
	}
	try {
		await previousAdapter.deleteFile(backup);
		updateAccountUsage(
			userId,
			previousAccount.id,
			Math.max(0, Number(previousAccount.used_space) - Number(existing.size)),
		);
	} catch {
		// Keep the backup discoverable by the next sync; never roll back a committed object by deleting it.
		console.warn(
			JSON.stringify({
				service: 'filesystem',
				event: 'overwrite-backup-cleanup-failed',
				userId,
				fileId: existing.id,
			}),
		);
	}
	return promoted;
}
