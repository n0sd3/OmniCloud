const status = {
	AccessDenied: 403,
	InvalidAccessKeyId: 403,
	SignatureDoesNotMatch: 403,
	RequestTimeTooSkewed: 403,
	NoSuchBucket: 404,
	NoSuchKey: 404,
	NoSuchUpload: 404,
	InvalidArgument: 400,
	InvalidRequest: 400,
	InvalidPart: 400,
	InvalidPartOrder: 400,
	EntityTooSmall: 400,
	EntityTooLarge: 413,
	BadDigest: 400,
	InternalError: 500,
	ServiceUnavailable: 503,
	SlowDown: 503,
	InvalidRange: 416,
	NotImplemented: 501,
	PreconditionFailed: 412,
};
export function s3Error(code, message = code) {
	return Object.assign(new Error(message), { s3Code: code, status: status[code] || 500 });
}
export function xml(value) {
	return String(value ?? '')
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '')
		.replace(
			/[&<>"']/g,
			(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c],
		);
}
export function tag(name, value) {
	return `<${name}>${xml(value)}</${name}>`;
}
export function sendXml(res, root, body, code = 200) {
	res
		.status(code)
		.type('application/xml')
		.end(
			`<?xml version="1.0" encoding="UTF-8"?><${root} xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${body}</${root}>`,
		);
}
export function fail(res, error, requestId) {
	if (res.headersSent) return res.destroy();
	res.removeHeader('Content-Length');
	const code = error.s3Code || (error.code === 'ENOSPC' ? 'EntityTooLarge' : 'ServiceUnavailable');
	sendXml(
		res,
		'Error',
		tag('Code', code) +
			tag('Message', error.s3Code ? error.message : 'Storage operation failed.') +
			tag('RequestId', requestId),
		status[code] || 500,
	);
}
export function mapKey(raw) {
	let key;
	try {
		key = decodeURIComponent(raw);
	} catch {
		throw s3Error('InvalidArgument', 'Invalid URL encoding');
	}
	if (!key || Buffer.byteLength(key) > 1024 || /[\\\u0000-\u001f\u007f]/.test(key))
		throw s3Error('InvalidArgument', 'Invalid object key');
	// Reject second encodings and path aliases: the virtual filesystem cannot represent them faithfully.
	const folder = key.endsWith('/');
	const resource = folder ? key.slice(0, -1) : key;
	if (
		/%[0-9a-f]{2}/i.test(key) ||
		resource.split('/').some((s) => s === '.' || s === '..' || s === '')
	)
		throw s3Error('InvalidArgument', 'Ambiguous object key');
	const segments = resource.split('/');
	const name = segments.pop();
	return { key, name, folder, parentPath: segments.length ? `/${segments.join('/')}/` : '/' };
}
