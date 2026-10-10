import { timingSafeEqual } from 'node:crypto';
import { SignatureV4 } from '@smithy/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import { findCredential, touchCredential } from './credentials.js';
import { s3Error } from './response.js';

export async function authenticate(req, now = Date.now()) {
	const rawUrl = req.originalUrl || req.url;
	const [rawPath, rawQuery = ''] = rawUrl.split('?');
	const params = new URLSearchParams(rawQuery);
	for (const name of new Set(params.keys()))
		if (params.getAll(name).length > 1)
			throw s3Error('InvalidArgument', 'Duplicate query parameter');
	const presigned = params.has('X-Amz-Algorithm');
	let credential, signed, signature, date;
	if (presigned) {
		if (params.get('X-Amz-Algorithm') !== 'AWS4-HMAC-SHA256') throw s3Error('AccessDenied');
		credential = params.get('X-Amz-Credential');
		signed = params.get('X-Amz-SignedHeaders');
		signature = params.get('X-Amz-Signature');
		date = params.get('X-Amz-Date');
	} else {
		const match =
			/^AWS4-HMAC-SHA256 Credential=([^, ]+),\s*SignedHeaders=([^, ]+),\s*Signature=([a-f0-9]{64})$/.exec(
				req.headers.authorization || '',
			);
		if (!match) throw s3Error('AccessDenied', 'AWS Signature Version 4 is required');
		[, credential, signed, signature] = match;
		date = req.headers['x-amz-date'];
	}
	if (!/^[a-f0-9]{64}$/.test(signature || '') || !/^\d{8}T\d{6}Z$/.test(date || ''))
		throw s3Error('AccessDenied', 'Invalid signature parameters');
	const scope = String(credential).split('/');
	const [key, day, region, service, terminal] = scope;
	if (
		scope.length !== 5 ||
		day !== date.slice(0, 8) ||
		!/^[a-z0-9-]{1,64}$/.test(region) ||
		service !== 's3' ||
		terminal !== 'aws4_request'
	)
		throw s3Error('AccessDenied', 'Invalid credential scope');
	const time = Date.parse(
		`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${date.slice(9, 11)}:${date.slice(11, 13)}:${date.slice(13, 15)}Z`,
	);
	if (!Number.isFinite(time)) throw s3Error('AccessDenied');
	if (presigned) {
		const expires = Number(params.get('X-Amz-Expires'));
		if (
			!Number.isInteger(expires) ||
			expires < 1 ||
			expires > 604800 ||
			time > now + 900000 ||
			now > time + expires * 1000
		)
			throw s3Error('AccessDenied', 'Presigned URL has expired or is invalid');
	} else if (Math.abs(now - time) > 900000)
		throw s3Error('RequestTimeTooSkewed', 'Request date exceeds fifteen minute skew');
	const headers = {};
	const names = String(signed || '').split(';');
	if (
		!names.includes('host') ||
		names.join(';') !== [...new Set(names)].sort().join(';') ||
		names.some((n) => !/^[a-z0-9-]+$/.test(n))
	)
		throw s3Error('AccessDenied', 'Invalid signed headers');
	for (const name of names) {
		if (req.headers[name] === undefined) throw s3Error('SignatureDoesNotMatch');
		headers[name] = String(req.headers[name]).trim().replace(/\s+/g, ' ');
	}
	if (!presigned && !names.includes('x-amz-date'))
		throw s3Error('AccessDenied', 'Request date must be signed');
	const payloadHash =
		req.headers['x-amz-content-sha256'] ||
		params.get('X-Amz-Content-Sha256') ||
		(presigned
			? 'UNSIGNED-PAYLOAD'
			: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
	if (payloadHash !== 'UNSIGNED-PAYLOAD' && !/^[a-f0-9]{64}$/.test(payloadHash))
		throw s3Error(
			'NotImplemented',
			'aws-chunked streaming signatures/trailers are not supported; use request_checksum_calculation=when_required',
		);
	const identity = findCredential(key);
	const signer = new SignatureV4({
		credentials: identity,
		region,
		service: 's3',
		sha256: Sha256,
		uriEscapePath: false,
	});
	const query = Object.fromEntries(params);
	// Smithy supplies canonical query sorting, scope key derivation and canonical request hashing.
	const canonical = signer.createCanonicalRequest(
		{ method: req.method, path: rawPath, query, headers },
		headers,
		payloadHash,
	);
	const expected = await signer.getSignature(
		date,
		scope.slice(1).join('/'),
		signer.getSigningKey(identity, region, day),
		canonical,
	);
	if (!timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex')))
		throw s3Error('SignatureDoesNotMatch', 'The request signature does not match');
	touchCredential(key);
	return { ...identity, payloadHash, params, rawPath };
}
