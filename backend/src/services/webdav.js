// Núcleo puro do WebDAV: parsing e serialização, sem I/O.
// O consumidor é sempre o rclone, então só as propriedades que ele lê são emitidas.

const XML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

function escapeXml(value) {
	return String(value ?? '').replace(/[&<>"']/g, (char) => XML_ESCAPES[char]);
}

export function parseRangeHeader(header, size) {
	const match = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
	if (!match) return null;

	const [, rawStart, rawEnd] = match;
	if (rawStart === '' && rawEnd === '') return null;

	const total = Number(size) || 0;
	let start;
	let end;

	if (rawStart === '') {
		// Sufixo: "bytes=-500" são os últimos 500 bytes.
		const suffix = Number(rawEnd);
		if (!suffix) return null;
		start = Math.max(0, total - suffix);
		end = total - 1;
	} else {
		start = Number(rawStart);
		end = rawEnd === '' ? total - 1 : Number(rawEnd);
	}

	if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
	if (start >= total || start < 0 || start > end) return null;

	return { start, end: Math.min(end, total - 1) };
}

export function parseDavPath(href, basePath = '/webdav') {
	const [pathOnly] = String(href || '').split('?');
	const decoded = decodeURIComponent(pathOnly);
	const withoutBase = decoded.startsWith(basePath) ? decoded.slice(basePath.length) : decoded;
	const segments = withoutBase.split('/').filter(Boolean);

	if (segments.some((segment) => segment === '..' || segment === '.')) {
		throw new Error('Invalid WebDAV path');
	}

	if (!segments.length) {
		return { parentPath: '/', name: null };
	}

	const name = segments.pop();
	const parentPath = segments.length ? `/${segments.join('/')}/` : '/';
	return { parentPath, name };
}

export function toHttpDate(value) {
	const date = value ? new Date(value) : new Date(0);
	const safe = Number.isNaN(date.getTime()) ? new Date(0) : date;
	return safe.toUTCString();
}

function buildResponse(entry) {
	const props = [`<D:displayname>${escapeXml(entry.displayName)}</D:displayname>`];

	if (entry.isFolder) {
		props.push('<D:resourcetype><D:collection/></D:resourcetype>');
	} else {
		props.push('<D:resourcetype/>');
		props.push(`<D:getcontentlength>${Number(entry.size || 0)}</D:getcontentlength>`);
		props.push(
			`<D:getcontenttype>${escapeXml(entry.mimeType || 'application/octet-stream')}</D:getcontenttype>`,
		);
	}

	props.push(`<D:getlastmodified>${toHttpDate(entry.modifiedTime)}</D:getlastmodified>`);

	return [
		'<D:response>',
		`<D:href>${escapeXml(entry.href)}</D:href>`,
		'<D:propstat>',
		`<D:prop>${props.join('')}</D:prop>`,
		'<D:status>HTTP/1.1 200 OK</D:status>',
		'</D:propstat>',
		'</D:response>',
	].join('');
}

export function buildPropfindXml(entries) {
	return [
		'<?xml version="1.0" encoding="utf-8"?>',
		'<D:multistatus xmlns:D="DAV:">',
		...entries.map(buildResponse),
		'</D:multistatus>',
	].join('');
}

// href já vem percent-encoded de quem monta a entrada; escapeXml só cuida do '&'.
export function encodeDavHref(basePath, parentPath, name, isFolder) {
	const parent = parentPath === '/' ? '' : parentPath.replace(/\/+$/, '');
	const segments = `${parent}/${name || ''}`.split('/').filter(Boolean);
	const encoded = segments.map((segment) => encodeURIComponent(segment)).join('/');
	const suffix = isFolder ? '/' : '';
	return `${basePath}/${encoded}${suffix}`.replace(/\/+/g, '/');
}
