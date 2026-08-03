import crypto from 'node:crypto';
import { createReadStream, createWriteStream, mkdirSync } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

function versionOf(file) {
	return file.remote_modified_time || file.modifiedTime || null;
}

function metadataFor(file) {
	return {
		userId: file.user_id,
		accountId: file.cloud_account_id,
		remoteId: String(file.remote_file_id),
		size: Number(file.size || 0),
		remoteModifiedTime: versionOf(file),
		completedAt: new Date().toISOString(),
	};
}

export function createLocalFileStore({ rootDir, logger = console }) {
	const publicationStates = new Map();
	const keyFor = (file) => crypto
		.createHash('sha256')
		.update(JSON.stringify([file.user_id, file.cloud_account_id, file.remote_file_id]))
		.digest('hex');
	const pathsFor = (file) => {
		const key = keyFor(file);
		return { data: path.join(rootDir, `${key}.data`), sidecar: path.join(rootDir, `${key}.json`) };
	};
	const tempPath = (target) => `${target}.${crypto.randomUUID()}.tmp`;
	const warn = (message) => logger?.warn?.(message);
	const beginPublication = (file) => {
		const key = keyFor(file);
		const state = publicationStates.get(key) || { active: 0, latest: 0, pending: Promise.resolve() };
		state.active += 1;
		state.latest += 1;
		publicationStates.set(key, state);
		return { key, state, generation: state.latest };
	};
	const endPublication = ({ key, state }) => {
		state.active -= 1;
		if (!state.active && publicationStates.get(key) === state) publicationStates.delete(key);
	};

	async function readValid(file) {
		await publicationStates.get(keyFor(file))?.pending.catch(() => {});
		try {
			const expected = metadataFor(file);
			const paths = pathsFor(file);
			const metadata = JSON.parse(await fsp.readFile(paths.sidecar, 'utf8'));
			const stat = await fsp.stat(paths.data);
			if (
				metadata.userId !== expected.userId ||
				metadata.accountId !== expected.accountId ||
				metadata.remoteId !== expected.remoteId ||
				metadata.size !== expected.size ||
				metadata.remoteModifiedTime !== expected.remoteModifiedTime ||
				stat.size !== metadata.size
			) return null;
			return paths;
		} catch {
			return null;
		}
	}

	async function publishGeneration(dataTemp, file) {
		const paths = pathsFor(file);
		const metadata = metadataFor(file);
		const dataStat = await fsp.stat(dataTemp);
		if (dataStat.size !== metadata.size) throw new Error('Local file cache byte count mismatch');
		const sidecarTemp = tempPath(paths.sidecar);
		let dataPublished = false;
		try {
			await fsp.writeFile(sidecarTemp, JSON.stringify(metadata), { flag: 'wx' });
			await fsp.rename(dataTemp, paths.data);
			dataPublished = true;
			await fsp.rename(sidecarTemp, paths.sidecar);
		} catch (error) {
			await Promise.allSettled([
				fsp.rm(dataTemp, { force: true }),
				fsp.rm(sidecarTemp, { force: true }),
				...(dataPublished ? [fsp.rm(paths.data, { force: true }), fsp.rm(paths.sidecar, { force: true })] : []),
			]);
			throw error;
		}
	}

	async function publish(dataTemp, file, request) {
		const { state, generation } = request;
		const current = state.pending.catch(() => {}).then(async () => {
			if (generation !== state.latest) {
				await fsp.rm(dataTemp, { force: true });
				return false;
			}
			await publishGeneration(dataTemp, file);
			if (generation !== state.latest) {
				const { data, sidecar } = pathsFor(file);
				await Promise.all([fsp.rm(data, { force: true }), fsp.rm(sidecar, { force: true })]);
				return false;
			}
			return true;
		});
		state.pending = current;
		return current;
	}

	return {
		async getValidPath(file) {
			return (await readValid(file))?.data || null;
		},

		async openReadStream(file, range = {}) {
			const valid = await readValid(file);
			return valid ? createReadStream(valid.data, range) : null;
		},

		async writeFromStream(file, stream) {
			const publication = beginPublication(file);
			const dataTemp = tempPath(pathsFor(file).data);
			let bytes = 0;
			const counter = new Transform({
				transform(chunk, encoding, callback) {
					bytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk, encoding);
					callback(null, chunk);
				},
			});
			try {
				await fsp.mkdir(rootDir, { recursive: true });
				await pipeline(stream, counter, createWriteStream(dataTemp, { flags: 'wx' }));
				if (bytes !== Number(file.size || 0)) throw new Error('Local file cache byte count mismatch');
				await publish(dataTemp, file, publication);
			} catch (error) {
				await fsp.rm(dataTemp, { force: true });
				throw error;
			} finally {
				endPublication(publication);
			}
		},

		captureUpload(stream, uploadId) {
			const dataTemp = path.join(rootDir, `${crypto.createHash('sha256').update(String(uploadId)).digest('hex')}.${crypto.randomUUID()}.data.tmp`);
			let writer = null;
			let bytes = 0;
			let failed = false;
			let settled = false;
			let flushCallback = null;
			let resumePendingWrite = null;
			let resolveCompleted;
			const completed = new Promise((resolve) => { resolveCompleted = resolve; });
			const settle = (result) => {
				if (settled) return;
				settled = true;
				resolveCompleted(result);
				if (flushCallback) {
					const callback = flushCallback;
					flushCallback = null;
					callback();
				}
			};

			try {
				mkdirSync(rootDir, { recursive: true });
				writer = createWriteStream(dataTemp, { flags: 'wx' });
				writer.on('error', (error) => {
					failed = true;
					warn(`Local file cache capture failed: ${error.message}`);
					settle(null);
				});
			} catch (error) {
				failed = true;
				warn(`Local file cache capture failed: ${error.message}`);
			}

			const captured = new Transform({
				transform(chunk, encoding, callback) {
					bytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk, encoding);
					this.push(chunk);
					if (!failed && writer) {
						try {
							if (!writer.write(chunk)) {
								let resumed = false;
								const resume = () => {
									if (resumed) return;
									resumed = true;
									writer.off('drain', resume);
									writer.off('error', resume);
									writer.off('close', resume);
									if (resumePendingWrite === resume) resumePendingWrite = null;
									callback();
								};
								resumePendingWrite = resume;
								writer.once('drain', resume);
								writer.once('error', resume);
								writer.once('close', resume);
								return;
							}
						} catch (error) {
							failed = true;
							warn(`Local file cache capture failed: ${error.message}`);
							settle(null);
						}
					}
					callback();
				},
				flush(callback) {
					if (!writer) {
						settle(null);
						return callback();
					}
					if (settled) return callback();
					flushCallback = callback;
					writer.once('finish', () => settle(failed ? null : { dataTemp, size: bytes }));
					writer.end();
				},
			});
			stream.on('error', () => {
				failed = true;
				writer?.destroy();
				settle(null);
			});
			stream.pipe(captured);

			return {
				stream: captured,
				completed,
				discard: async () => {
					failed = true;
					writer?.destroy();
					settle(null);
					resumePendingWrite?.();
					await fsp.rm(dataTemp, { force: true });
				},
			};
		},

		async commitCapture(capture, file) {
			const publication = beginPublication(file);
			try {
				const result = await capture.completed;
				if (!result || result.size !== Number(file.size || 0)) {
					await capture.discard();
					return false;
				}
				return await publish(result.dataTemp, file, publication);
			} catch (error) {
				warn(`Local file cache commit failed: ${error.message}`);
				return false;
			} finally {
				endPublication(publication);
			}
		},

		async invalidate(file) {
			const { data, sidecar } = pathsFor(file);
			await Promise.all([fsp.rm(data, { force: true }), fsp.rm(sidecar, { force: true })]);
		},

		async rebind(file) {
			const { data, sidecar } = pathsFor(file);
			try {
				const metadata = JSON.parse(await fsp.readFile(sidecar, 'utf8'));
				const stat = await fsp.stat(data);
				if (stat.size !== metadata.size || stat.size !== Number(file.size || 0)) return false;
				const sidecarTemp = tempPath(sidecar);
				await fsp.writeFile(sidecarTemp, JSON.stringify(metadataFor(file)), { flag: 'wx' });
				await fsp.rename(sidecarTemp, sidecar);
				return true;
			} catch {
				return false;
			}
		},

		async reconcile(previousFiles, nextFiles, { preserveRemoteIds = [] } = {}) {
			const nextById = new Map(nextFiles.map((file) => [keyFor(file), file]));
			const preserved = new Set(preserveRemoteIds.map(String));
			for (const previous of previousFiles) {
				if (preserved.has(String(previous.remote_file_id))) continue;
				const next = nextById.get(keyFor(previous));
				if (
					!next ||
					!versionOf(previous) ||
					!versionOf(next) ||
					Number(previous.size || 0) !== Number(next.size || 0) ||
					versionOf(previous) !== versionOf(next)
				) await this.invalidate(previous);
			}
		},

		async cleanupTemps() {
			try {
				const entries = await fsp.readdir(rootDir, { withFileTypes: true });
				await Promise.all(entries
					.filter((entry) => entry.isFile() && entry.name.endsWith('.tmp'))
					.map((entry) => fsp.rm(path.join(rootDir, entry.name), { force: true })));
			} catch {
				// A missing or inaccessible cache directory has no temporary files to clean.
			}
		},
	};
}
