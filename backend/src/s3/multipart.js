import { Crc32 } from '@aws-crypto/crc32';
import { Crc32c } from '@aws-crypto/crc32c';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { db } from '../config/database.js';
import { env } from '../config/env.js';
import { withFilesystemLock } from '../services/filesystemCoordinator.js';
import { s3Error } from './response.js';

const inProgress = new Set();
let transientBytes = 0;
let orphanBytes = 0;
const filePath = (name) => path.join(env.s3MultipartPath, name);
export const multipartLock = (id, work) => withFilesystemLock(`s3-multipart:${id}`, work);
const readStoredBytes = () =>
	db.prepare('SELECT COALESCE(sum(size),0) n FROM s3_multipart_parts').get().n;
let persistedBytes;
// One API process updates this counter; do not scan every part for each network chunk.
const storedBytes = () => (persistedBytes ??= readStoredBytes());

export async function stageBody(
	stream,
	{ payloadHash = 'UNSIGNED-PAYLOAD', expectedSize, contentMd5, checksums = {} } = {},
) {
	await mkdir(env.s3MultipartPath, { recursive: true, mode: 0o700 });
	const checksumHashers = {};
	for (const algorithm of ['crc32', 'crc32c', 'sha1', 'sha256'])
		if (checksums[`x-amz-checksum-${algorithm}`])
			checksumHashers[algorithm] =
				algorithm === 'crc32'
					? new Crc32()
					: algorithm === 'crc32c'
						? new Crc32c()
						: createHash(algorithm);
	if (checksums['x-amz-checksum-crc64nvme'])
		throw s3Error('NotImplemented', 'CRC64NVME checksums are not supported');
	const name = `${randomUUID()}.tmp`;
	inProgress.add(name);
	let size = 0;
	const md5 = createHash('md5');
	const sha = createHash('sha256');
	const meter = new Transform({
		transform(chunk, _encoding, cb) {
			if (storedBytes() + transientBytes + orphanBytes + chunk.length > env.s3StagingMaxBytes)
				return cb(s3Error('EntityTooLarge', 'Staging disk quota exceeded'));
			size += chunk.length;
			transientBytes += chunk.length;
			md5.update(chunk);
			sha.update(chunk);
			for (const hasher of Object.values(checksumHashers)) hasher.update(chunk);
			cb(null, chunk);
		},
	});
	let disposed = false;
	const dispose = async () => {
		if (disposed) return;
		disposed = true;
		transientBytes -= size;
		inProgress.delete(name);
		await rm(filePath(name), { force: true });
	};
	try {
		await pipeline(stream, meter, createWriteStream(filePath(name), { flags: 'wx', mode: 0o600 }));
		const digest = md5.digest('hex');
		const hash = sha.digest('hex');
		if (expectedSize !== undefined && size !== expectedSize)
			throw s3Error('InvalidRequest', 'Body length does not match Content-Length');
		if (payloadHash !== 'UNSIGNED-PAYLOAD' && hash !== payloadHash)
			throw s3Error('SignatureDoesNotMatch', 'Payload SHA256 does not match');
		for (const [algorithm, hasher] of Object.entries(checksumHashers)) {
			let bytes = hasher.digest();
			if (typeof bytes === 'number') {
				const buffer = Buffer.alloc(4);
				buffer.writeUInt32BE(bytes);
				bytes = buffer;
			}
			if (Buffer.from(bytes).toString('base64') !== checksums[`x-amz-checksum-${algorithm}`])
				throw s3Error('BadDigest', `${algorithm} checksum does not match`);
		}
		if (contentMd5 && Buffer.from(digest, 'hex').toString('base64') !== contentMd5)
			throw s3Error('BadDigest', 'Content-MD5 does not match');
		return { name, size, md5: digest, dispose, stream: () => createReadStream(filePath(name)) };
	} catch (error) {
		await dispose();
		throw error;
	}
}
export function createMultipart(userId, key, mimeType, metadata = {}) {
	if (
		db.prepare('SELECT count(*) n FROM s3_multipart_uploads WHERE user_id=?').get(userId).n >=
		env.s3MaxUploadsPerUser
	)
		throw s3Error('SlowDown', 'Too many unfinished uploads');
	const id = randomUUID();
	const now = Date.now();
	db.prepare(
		'INSERT INTO s3_multipart_uploads(id,user_id,object_key,mime_type,created_at,touched_at,metadata_json) VALUES (?,?,?,?,?,?,?)',
	).run(id, userId, key, mimeType, now, now, JSON.stringify(metadata));
	return id;
}
export function findMultipart(userId, key, id) {
	const upload = db
		.prepare('SELECT * FROM s3_multipart_uploads WHERE id=? AND user_id=? AND object_key=?')
		.get(id, userId, key);
	if (!upload || Date.now() - upload.touched_at > env.s3MultipartTtlMs)
		throw s3Error('NoSuchUpload');
	return upload;
}
export function listParts(id) {
	return db
		.prepare('SELECT * FROM s3_multipart_parts WHERE upload_id=? ORDER BY part_number')
		.all(id);
}
export async function storePart(upload, partNumber, staged) {
	storedBytes();
	if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000)
		throw s3Error('InvalidArgument', 'Part number must be between 1 and 10000');
	if (staged.size > 5 * 1024 ** 3) throw s3Error('EntityTooLarge', 'Part exceeds 5 GiB');
	const name = `${randomUUID()}.part`;
	const previous = db
		.prepare('SELECT file_name, size FROM s3_multipart_parts WHERE upload_id=? AND part_number=?')
		.get(upload.id, partNumber);
	await rename(filePath(staged.name), filePath(name));
	try {
		db.transaction(() => {
			db.prepare(
				'INSERT INTO s3_multipart_parts(upload_id,part_number,file_name,size,md5) VALUES (?,?,?,?,?) ON CONFLICT(upload_id,part_number) DO UPDATE SET file_name=excluded.file_name,size=excluded.size,md5=excluded.md5',
			).run(upload.id, partNumber, name, staged.size, staged.md5);
			db.prepare('UPDATE s3_multipart_uploads SET touched_at=? WHERE id=?').run(
				Date.now(),
				upload.id,
			);
		})();
	} catch (error) {
		await rm(filePath(name), { force: true });
		throw error;
	}
	persistedBytes += staged.size - (previous?.size || 0);
	await staged.dispose();
	if (previous) await rm(filePath(previous.file_name), { force: true });
	return `"${staged.md5}"`;
}
export async function removeMultipart(id) {
	const parts = listParts(id);
	storedBytes();
	db.prepare('DELETE FROM s3_multipart_uploads WHERE id=?').run(id);
	persistedBytes -= parts.reduce((sum, part) => sum + part.size, 0);
	await Promise.all(parts.map((p) => rm(filePath(p.file_name), { force: true })));
}
export async function readControlBody(req, payloadHash) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > 1024 * 1024) throw s3Error('EntityTooLarge', 'XML body exceeds 1 MiB');
		chunks.push(chunk);
	}
	const body = Buffer.concat(chunks);
	if (
		payloadHash !== 'UNSIGNED-PAYLOAD' &&
		createHash('sha256').update(body).digest('hex') !== payloadHash
	)
		throw s3Error('SignatureDoesNotMatch');
	return body.toString('utf8');
}
export function completionParts(body, id) {
	if (/<!DOCTYPE|<!ENTITY/i.test(body) || XMLValidator.validate(body) !== true)
		throw s3Error('InvalidArgument', 'Invalid completion XML');
	const parsed = new XMLParser({
		htmlEntities: true,
		processEntities: {
			maxTotalExpansions: 40000,
			maxExpandedLength: 1048576,
			maxExpansionDepth: 1,
		},
		parseTagValue: false,
		ignoreAttributes: false,
		isArray: (name) => name === 'Part',
	}).parse(body);
	const requested = parsed.CompleteMultipartUpload?.Part;
	if (!Array.isArray(requested) || !requested.length || requested.length > 10000)
		throw s3Error('InvalidArgument', 'Completion requires 1 to 10000 parts');
	const stored = new Map(listParts(id).map((p) => [p.part_number, p]));
	let previous = 0;
	const parts = requested.map((p, index) => {
		const number = Number(p.PartNumber);
		if (!Number.isInteger(number) || number <= previous) throw s3Error('InvalidPartOrder');
		previous = number;
		const part = stored.get(number);
		if (!part || String(p.ETag).replace(/^"|"$/g, '') !== part.md5) throw s3Error('InvalidPart');
		if (index < requested.length - 1 && part.size < 5 * 1024 * 1024)
			throw s3Error('EntityTooSmall');
		return part;
	});
	return {
		parts,
		size: parts.reduce((sum, p) => sum + p.size, 0),
		etag: `"${createHash('md5')
			.update(Buffer.concat(parts.map((p) => Buffer.from(p.md5, 'hex'))))
			.digest('hex')}-${parts.length}"`,
	};
}
export function partsStream(parts) {
	return Readable.from(
		(async function* () {
			for (const part of parts)
				for await (const chunk of createReadStream(filePath(part.file_name))) yield chunk;
		})(),
	);
}
export async function cleanupMultipart(now = Date.now(), { startup = false } = {}) {
	await mkdir(env.s3MultipartPath, { recursive: true, mode: 0o700 });
	const expired = db
		.prepare('SELECT id FROM s3_multipart_uploads WHERE touched_at<?')
		.all(now - env.s3MultipartTtlMs);
	for (const row of expired)
		await multipartLock(row.id, async () => {
			const current = db
				.prepare('SELECT touched_at FROM s3_multipart_uploads WHERE id=?')
				.get(row.id);
			if (current && current.touched_at < now - env.s3MultipartTtlMs) await removeMultipart(row.id);
		});
	const referenced = new Set(
		db
			.prepare('SELECT file_name FROM s3_multipart_parts')
			.all()
			.map((p) => p.file_name),
	);
	let remainingOrphans = 0;
	for (const name of await readdir(env.s3MultipartPath)) {
		if (!/^[a-f0-9-]{36}\.(tmp|part)$/.test(name) || referenced.has(name) || inProgress.has(name))
			continue;
		const info = await stat(filePath(name)).catch((error) => {
			if (error.code === 'ENOENT') return null;
			throw error;
		});
		if (!info) continue;
		if (startup || now - info.mtimeMs > env.s3MultipartTtlMs)
			await rm(filePath(name), { force: true });
		else remainingOrphans += info.size;
	}
	orphanBytes = remainingOrphans;
	persistedBytes = readStoredBytes();
	return expired.length;
}
