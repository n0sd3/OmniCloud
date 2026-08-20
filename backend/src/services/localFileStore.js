import crypto from 'node:crypto';
import { createWriteStream, mkdirSync } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

function versionOf(file) {
	return file.remote_modified_time || file.modifiedTime || null;
}

function sizeMismatch(file, actual) {
	// O tamanho vem do metadata sincronizado; divergencia quase sempre significa
	// registro desatualizado. Sem identificar o arquivo o log fica indiagnosticavel.
	return new Error(`Local file cache byte count mismatch for ${file.file_name || file.remote_file_id} `
		+ `(account ${file.cloud_account_id}, remote ${file.remote_file_id}): expected ${Number(file.size || 0)}, got ${actual}`);
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
	const identityLocks = new Map();
	const publicationStates = new Map();
	const keyFor = (file) => crypto
		.createHash('sha256')
		.update(JSON.stringify([file.user_id, file.cloud_account_id, file.remote_file_id]))
		.digest('hex');
	// Estrutura espelha o caminho real (virtual_path + file_name) pra dar pra abrir o
	// volume Docker e ver os arquivos com nome/hierarquia originais. Metadata fica numa
	// arvore paralela oculta pra nao colidir com o nome real do arquivo.
	const sanitizeSegment = (segment) => {
		const clean = String(segment).replace(/[\\/]|\s/g, '_');
		return /^\.+$/.test(clean) ? '_'.repeat(clean.length) : clean;
	};
	const relDirFor = (file) => (file.virtual_path || '/').split('/').filter(Boolean).map(sanitizeSegment);
	const pathsFor = (file) => {
		const segments = [sanitizeSegment(file.user_id), sanitizeSegment(file.cloud_account_id), ...relDirFor(file)];
		const fileName = sanitizeSegment(file.file_name || file.remote_file_id);
		const dataDir = path.join(rootDir, ...segments);
		return {
			data: path.join(dataDir, fileName),
			sidecar: path.join(rootDir, '.meta', ...segments, `${fileName}.json`),
		};
	};
	const tempPath = (target) => `${target}.${crypto.randomUUID()}.tmp`;
	const warn = (message) => logger?.warn?.(message);
	const beginPublication = (file) => {
		const key = keyFor(file);
		const state = publicationStates.get(key) || { active: 0, latest: 0 };
		state.active += 1;
		state.latest += 1;
		publicationStates.set(key, state);
		return { key, state, generation: state.latest };
	};
	const endPublication = ({ key, state }) => {
		state.active -= 1;
		if (!state.active && publicationStates.get(key) === state) publicationStates.delete(key);
	};
	const withIdentityLock = async (file, operation) => {
		const key = keyFor(file);
		const previous = identityLocks.get(key) || Promise.resolve();
		const current = previous.catch(() => {}).then(operation);
		identityLocks.set(key, current);
		try {
			return await current;
		} finally {
			if (identityLocks.get(key) === current) identityLocks.delete(key);
		}
	};

	async function readValid(file) {
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
		if (dataStat.size !== metadata.size) throw sizeMismatch(file, dataStat.size);
		const sidecarTemp = tempPath(paths.sidecar);
		let dataPublished = false;
		try {
			await Promise.all([
				fsp.mkdir(path.dirname(paths.data), { recursive: true }),
				fsp.mkdir(path.dirname(paths.sidecar), { recursive: true }),
			]);
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
		return withIdentityLock(file, async () => {
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
	}

	return {
		async getValidPath(file) {
			return withIdentityLock(file, async () => (await readValid(file))?.data || null);
		},

		async openReadStream(file, range = {}) {
			return withIdentityLock(file, async () => {
				const valid = await readValid(file);
				if (!valid) return null;
				let handle;
				try {
					handle = await fsp.open(valid.data, 'r');
					return handle.createReadStream(range);
				} catch {
					await handle?.close().catch(() => {});
					return null;
				}
			});
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
				await fsp.mkdir(path.dirname(dataTemp), { recursive: true });
				await pipeline(stream, counter, createWriteStream(dataTemp, { flags: 'wx' }));
				if (bytes !== Number(file.size || 0)) throw sizeMismatch(file, bytes);
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
			return withIdentityLock(file, async () => {
				const { data, sidecar } = pathsFor(file);
				await Promise.all([fsp.rm(data, { force: true }), fsp.rm(sidecar, { force: true })]);
			});
		},

		// `file` pode ter mudado de nome/pasta desde a ultima publicacao (rename remoto
		// preservado no cache) - o path espelha virtual_path+file_name, entao o conteudo
		// as vezes precisa ser movido fisicamente, nao so o sidecar reescrito.
		async rebind(previousFile, file = previousFile) {
			return withIdentityLock(file, async () => {
				const previous = pathsFor(previousFile);
				const target = pathsFor(file);
				try {
					const metadata = JSON.parse(await fsp.readFile(previous.sidecar, 'utf8'));
					const stat = await fsp.stat(previous.data);
					if (stat.size !== metadata.size || stat.size !== Number(file.size || 0)) return false;
					const sidecarTemp = tempPath(target.sidecar);
					await Promise.all([
						fsp.mkdir(path.dirname(target.data), { recursive: true }),
						fsp.mkdir(path.dirname(target.sidecar), { recursive: true }),
					]);
					await fsp.writeFile(sidecarTemp, JSON.stringify(metadataFor(file)), { flag: 'wx' });
					if (target.data !== previous.data) await fsp.rename(previous.data, target.data);
					await fsp.rename(sidecarTemp, target.sidecar);
					if (target.sidecar !== previous.sidecar) await fsp.rm(previous.sidecar, { force: true });
					return true;
				} catch {
					return false;
				}
			});
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
			async function walk(dir) {
				let entries;
				try {
					entries = await fsp.readdir(dir, { withFileTypes: true });
				} catch {
					return;
				}
				await Promise.all(entries.map((entry) => {
					const entryPath = path.join(dir, entry.name);
					if (entry.isDirectory()) return walk(entryPath);
					if (entry.isFile() && entry.name.endsWith('.tmp')) return fsp.rm(entryPath, { force: true });
					return null;
				}));
			}
			await walk(rootDir);
		},
	};
}
