import { randomUUID } from 'node:crypto';
import { env } from '../config/env.js';
import { authenticate } from './signature.js';
import { withFilesystemLock } from '../services/filesystemCoordinator.js';
import { allObjects, objectVersion, sendObject, putObject, deleteObject } from './objects.js';
import {
	createMultipart,
	findMultipart,
	multipartLock,
	stageBody,
	storePart,
	completionParts,
	partsStream,
	removeMultipart,
	readControlBody,
	listParts,
} from './multipart.js';
import { tag, sendXml, s3Error, fail, mapKey } from './response.js';
import { guessMimeType } from '../utils/mime.js';

if (
	env.s3GatewayEnabled &&
	(!process.env.OMNICLOUD_SECRET_HALF || process.env.OMNICLOUD_SECRET_HALF.length < 32)
) {
	throw new Error('S3 gateway requires a strong OMNICLOUD_SECRET_HALF with at least 32 characters');
}
if (
	env.s3GatewayEnabled &&
	(!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(env.s3GatewayBucket) ||
		env.s3GatewayBucket.includes('..') ||
		['api', 'webdav', 'internal', 'ws'].includes(env.s3GatewayBucket))
) {
	throw new Error('Invalid S3_GATEWAY_BUCKET');
}
for (const value of [
	env.s3StagingMaxBytes,
	env.s3MultipartTtlMs,
	env.s3MaxUploadsPerUser,
	env.s3MaxConcurrentRequests,
]) {
	if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Invalid S3 gateway limit');
}
let activeRequests = 0;
const contents = (key, file, encode) =>
	`<Contents>${tag('Key', encode(key))}${tag('LastModified', new Date(file.remote_modified_time || file.created_at || 0).toISOString())}${tag('ETag', objectVersion(file).etag)}${tag('Size', file.size)}<StorageClass>STANDARD</StorageClass></Contents>`;
const compare = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
function listObjects(userId, params, res) {
	const prefix = params.get('prefix') || '';
	const delimiter = params.get('delimiter') || '';
	const max = Number(params.get('max-keys') ?? 1000);
	if (!Number.isInteger(max) || max < 0 || max > 1000)
		throw s3Error('InvalidArgument', 'max-keys must be between 0 and 1000');
	if (prefix.length > 1024 || delimiter.length > 1) throw s3Error('InvalidArgument');
	const v2 = params.get('list-type') === '2';
	const token = params.get('continuation-token');
	let after = params.get(v2 ? 'start-after' : 'marker') || '';
	if (token) {
		try {
			const parsed = JSON.parse(Buffer.from(token, 'base64url').toString());
			if (
				parsed.prefix !== prefix ||
				parsed.delimiter !== delimiter ||
				typeof parsed.last !== 'string'
			)
				throw Error();
			after = parsed.last;
		} catch {
			throw s3Error('InvalidArgument', 'Invalid continuation token');
		}
	}
	const groups = new Map();
	for (const { key, file } of allObjects(userId)) {
		if (!key.startsWith(prefix)) continue;
		const index = delimiter ? key.indexOf(delimiter, prefix.length) : -1;
		const result = index >= 0 ? key.slice(0, index + 1) : key;
		if (compare(result, after) <= 0) continue;
		groups.set(result, index >= 0 ? null : file);
	}
	const sorted = [...groups].sort(([a], [b]) => compare(a, b));
	const entries = sorted.slice(0, max);
	const truncated = max > 0 && sorted.length > max;
	const encode = params.get('encoding-type') === 'url' ? encodeURIComponent : (value) => value;
	if (params.has('encoding-type') && params.get('encoding-type') !== 'url')
		throw s3Error('InvalidArgument');
	let body =
		tag('Name', env.s3GatewayBucket) +
		tag('Prefix', encode(prefix)) +
		tag('MaxKeys', max) +
		tag('IsTruncated', truncated);
	if (delimiter) body += tag('Delimiter', encode(delimiter));
	if (params.has('encoding-type')) body += tag('EncodingType', 'url');
	if (v2) {
		body += tag('KeyCount', entries.length);
		if (token) body += tag('ContinuationToken', token);
		if (params.has('start-after')) body += tag('StartAfter', encode(params.get('start-after')));
	} else body += tag('Marker', after);
	if (truncated) {
		const last = entries.at(-1)[0];
		body += v2
			? tag(
					'NextContinuationToken',
					Buffer.from(JSON.stringify({ prefix, delimiter, last })).toString('base64url'),
				)
			: tag('NextMarker', last);
	}
	body += entries
		.map(([key, file]) =>
			file
				? contents(key, file, encode)
				: `<CommonPrefixes>${tag('Prefix', encode(key))}</CommonPrefixes>`,
		)
		.join('');
	sendXml(res, 'ListBucketResult', body);
}
function mimeType(req, name) {
	const value = req.headers['content-type'] || guessMimeType(name);
	if (typeof value !== 'string' || !/^[\x20-\x7e]{1,255}$/.test(value))
		throw s3Error('InvalidArgument', 'Invalid Content-Type');
	return value;
}
function expectedSize(req) {
	if (req.headers['content-length'] === undefined) return undefined;
	const size = Number(req.headers['content-length']);
	if (!Number.isSafeInteger(size) || size < 0) throw s3Error('InvalidArgument');
	return size;
}
async function dispatch(req, res, auth) {
	const segments = auth.rawPath.slice(1).split('/');
	let bucket;
	try {
		bucket = decodeURIComponent(segments.shift());
	} catch {
		throw s3Error('InvalidArgument');
	}
	auth.bucket = bucket;
	const params = auth.params;
	const userId = auth.userId;
	if (!bucket) {
		if (req.method !== 'GET' || auth.rawPath !== '/') throw s3Error('NotImplemented');
		return sendXml(
			res,
			'ListAllMyBucketsResult',
			`<Owner>${tag('ID', userId)}${tag('DisplayName', 'OmniCloud')}</Owner><Buckets><Bucket>${tag('Name', env.s3GatewayBucket)}${tag('CreationDate', '2026-01-01T00:00:00.000Z')}</Bucket></Buckets>`,
		);
	}
	if (bucket !== env.s3GatewayBucket) throw s3Error('NoSuchBucket');
	if (!segments.length || segments.join('/') === '') {
		if (req.method === 'HEAD') {
			res.setHeader('x-amz-bucket-region', env.s3GatewayRegion);
			return res.status(200).end();
		}
		if (req.method === 'GET' && params.has('location'))
			return sendXml(
				res,
				'LocationConstraint',
				env.s3GatewayRegion === 'us-east-1' ? '' : env.s3GatewayRegion,
			);
		if (
			req.method === 'GET' &&
			(!params.has('list-type') || params.get('list-type') === '2') &&
			!['uploads', 'versions', 'versioning', 'acl', 'policy', 'tagging'].some((p) => params.has(p))
		)
			return withFilesystemLock(userId, () => listObjects(userId, params, res));
		throw s3Error('NotImplemented', 'Bucket operation is not supported');
	}
	if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity')
		throw s3Error('NotImplemented', 'Encoded upload bodies are not supported');
	const mapped = mapKey(segments.join('/'));
	auth.key = mapped.key;
	if (req.headers['x-amz-acl'] && req.headers['x-amz-acl'] !== 'private')
		throw s3Error('NotImplemented', 'Only private objects are supported');
	if (
		req.headers['x-amz-copy-source'] ||
		['versionId', 'acl', 'tagging', 'restore', 'select', 'torrent', 'retention', 'legal-hold'].some(
			(p) => params.has(p),
		)
	)
		throw s3Error('NotImplemented', 'Object operation is not supported');
	const metadataBytes = Object.entries(req.headers)
		.filter(([k]) => k.startsWith('x-amz-meta-'))
		.reduce((n, [k, v]) => n + k.length + String(v).length, 0);
	if (metadataBytes > 2048) throw s3Error('InvalidArgument', 'Metadata exceeds 2 KiB');
	const metadata = {};
	for (const [header, value] of Object.entries(req.headers).filter(([name]) =>
		name.startsWith('x-amz-meta-'),
	)) {
		const name = header.slice(11);
		if (!/^[a-z0-9-]+$/.test(name) || !/^[\x20-\x7e]*$/.test(String(value)))
			throw s3Error('InvalidArgument', 'Invalid metadata header');
		metadata[name] = String(value);
	}
	const uploadId = params.get('uploadId');
	if (mapped.folder && (uploadId || params.has('uploads')))
		throw s3Error('InvalidRequest', 'Folder markers do not support multipart');
	if (uploadId) {
		if (!/^[a-f0-9-]{36}$/.test(uploadId)) throw s3Error('NoSuchUpload');
		return multipartLock(uploadId, async () => {
			const upload = findMultipart(userId, mapped.key, uploadId);
			if (req.method === 'DELETE') {
				await removeMultipart(uploadId);
				return res.status(204).end();
			}
			if (req.method === 'GET') {
				const marker = Number(params.get('part-number-marker') || 0);
				const max = Number(params.get('max-parts') || 1000);
				if (
					!Number.isInteger(marker) ||
					marker < 0 ||
					!Number.isInteger(max) ||
					max < 1 ||
					max > 1000
				)
					throw s3Error('InvalidArgument');
				const pending = listParts(uploadId).filter((part) => part.part_number > marker);
				const parts = pending.slice(0, max);
				const truncated = pending.length > max;
				return sendXml(
					res,
					'ListPartsResult',
					tag('Bucket', bucket) +
						tag('Key', mapped.key) +
						tag('UploadId', uploadId) +
						tag('PartNumberMarker', marker) +
						tag('NextPartNumberMarker', parts.at(-1)?.part_number || marker) +
						tag('MaxParts', max) +
						tag('IsTruncated', truncated) +
						parts
							.map(
								(p) =>
									`<Part>${tag('PartNumber', p.part_number)}${tag('ETag', `"${p.md5}"`)}${tag('Size', p.size)}</Part>`,
							)
							.join(''),
				);
			}
			if (req.method === 'PUT') {
				const number = Number(params.get('partNumber'));
				if (!Number.isInteger(number) || number < 1 || number > 10000)
					throw s3Error('InvalidArgument', 'Invalid part number');
				const staged = await stageBody(req, {
					payloadHash: auth.payloadHash,
					expectedSize: expectedSize(req),
					contentMd5: req.headers['content-md5'],
					checksums: req.headers,
				});
				try {
					const etag = await storePart(upload, number, staged);
					res.setHeader('ETag', etag);
					res.status(200).end();
				} finally {
					await staged.dispose();
				}
				return;
			}
			if (req.method === 'POST') {
				const body = await readControlBody(req, auth.payloadHash);
				const result = completionParts(body, uploadId);
				await withFilesystemLock(userId, () =>
					putObject(userId, mapped, {
						...result,
						mimeType: upload.mime_type,
						metadata: JSON.parse(upload.metadata_json),
						stream: () => partsStream(result.parts),
					}),
				);
				await removeMultipart(uploadId);
				return sendXml(
					res,
					'CompleteMultipartUploadResult',
					tag('Bucket', bucket) + tag('Key', mapped.key) + tag('ETag', result.etag),
				);
			}
			throw s3Error('NotImplemented');
		});
	}
	if (req.method === 'POST' && params.has('uploads')) {
		await readControlBody(req, auth.payloadHash);
		const id = await withFilesystemLock(userId, () =>
			createMultipart(userId, mapped.key, mimeType(req, mapped.name), metadata),
		);
		return sendXml(
			res,
			'InitiateMultipartUploadResult',
			tag('Bucket', bucket) + tag('Key', mapped.key) + tag('UploadId', id),
		);
	}
	if (req.method === 'GET' || req.method === 'HEAD')
		return withFilesystemLock(userId, () => sendObject(userId, mapped, req, res));
	if (req.method === 'DELETE')
		return withFilesystemLock(userId, async () => {
			await deleteObject(userId, mapped);
			res.status(204).end();
		});
	if (req.method === 'PUT') {
		const type = mimeType(req, mapped.name);
		const staged = await stageBody(req, {
			payloadHash: auth.payloadHash,
			expectedSize: expectedSize(req),
			contentMd5: req.headers['content-md5'],
			checksums: req.headers,
		});
		try {
			const etag = `"${staged.md5}"`;
			await withFilesystemLock(userId, () =>
				putObject(userId, mapped, {
					size: staged.size,
					mimeType: type,
					stream: staged.stream,
					etag,
					metadata,
				}),
			);
			res.setHeader('ETag', etag);
			res.status(200).end();
		} finally {
			await staged.dispose();
		}
		return;
	}
	throw s3Error('NotImplemented', 'S3 operation is not supported');
}

export async function s3Gateway(req, res, next) {
	// Explicit application paths retain REST/WebDAV; S3 lives directly at the HTTP root.
	const raw = req.originalUrl || req.url;
	if (/^\/(api|webdav|internal|ws)(\/|\?|$)/.test(raw)) return next();
	const requestId = randomUUID();
	res.setHeader('x-amz-request-id', requestId);
	const started = Date.now();
	let auth;
	res.once('finish', () =>
		console.info(
			JSON.stringify({
				service: 's3',
				requestId,
				method: req.method,
				userId: auth?.userId,
				accessKey: auth ? `${auth.accessKeyId.slice(0, 6)}***` : undefined,
				bucket: auth?.bucket,
				key: auth?.key,
				status: res.statusCode,
				elapsedMs: Date.now() - started,
			}),
		),
	);
	let counted = false;
	try {
		if (!env.s3GatewayEnabled) throw s3Error('AccessDenied', 'S3 gateway is disabled');
		if (activeRequests >= env.s3MaxConcurrentRequests)
			throw s3Error('SlowDown', 'Gateway request concurrency exceeded');
		counted = true;
		activeRequests++;
		auth = await authenticate(req);
		await dispatch(req, res, auth);
	} catch (error) {
		fail(res, error, requestId);
	} finally {
		if (counted) activeRequests--;
	}
}
