import { Router } from 'express';
import { listFilesByPath } from '../services/fileService.js';
import { getAccountById } from '../services/accountService.js';
import { createAdapter } from '../services/adapterRegistry.js';
import { verifyWebdavToken } from '../services/smbCredentialService.js';
import { parseRangeHeader, parseDavPath, buildPropfindXml, encodeDavHref } from '../services/webdav.js';
import { fileCacheService } from '../services/fileCacheService.js';

const BASE_PATH = '/webdav';

const router = Router();

// O único cliente é o rclone, que usa Basic Auth com o token dedicado — não a
// senha SMB e não o cookie de sessão do app.
function requireWebdavAuth(req, res, next) {
	const header = String(req.headers.authorization || '');
	if (!header.startsWith('Basic ')) {
		res.setHeader('WWW-Authenticate', 'Basic realm="OmniCloud"');
		return res.status(401).end();
	}

	const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
	const separator = decoded.indexOf(':');
	const identity = verifyWebdavToken(decoded.slice(0, separator), decoded.slice(separator + 1));

	if (!identity) {
		res.setHeader('WWW-Authenticate', 'Basic realm="OmniCloud"');
		return res.status(401).end();
	}

	req.webdavUserId = identity.userId;
	return next();
}

router.use(requireWebdavAuth);

// Resolve o recurso pedido. A raiz não tem registro no banco, então é sintética.
function resolveResource(userId, href) {
	const { parentPath, name } = parseDavPath(href, BASE_PATH);

	if (!name) {
		return { file: null, parentPath: '/', isRoot: true };
	}

	const file = listFilesByPath(userId, parentPath).find((item) => item.file_name === name);
	if (!file) return null;

	return { file, parentPath, isRoot: false };
}

function toEntry(file, parentPath) {
	return {
		href: encodeDavHref(BASE_PATH, parentPath, file.file_name, Boolean(file.is_folder)),
		isFolder: Boolean(file.is_folder),
		displayName: file.file_name,
		size: Number(file.size || 0),
		mimeType: file.mime_type,
		modifiedTime: file.modifiedTime || file.remote_modified_time,
	};
}

// O caminho do próprio recurso, usado como primeira entrada de todo PROPFIND.
function selfEntry(resource) {
	if (resource.isRoot) {
		return { href: `${BASE_PATH}/`, isFolder: true, displayName: 'OmniCloud', modifiedTime: null };
	}
	return toEntry(resource.file, resource.parentPath);
}

function childrenPath(resource) {
	if (resource.isRoot) return '/';
	return `${resource.parentPath === '/' ? '' : resource.parentPath.replace(/\/+$/, '')}/${resource.file.file_name}/`;
}

router.options('*splat', (_req, res) => {
	res.setHeader('DAV', '1');
	res.setHeader('Allow', 'OPTIONS, HEAD, GET, PUT, DELETE, MKCOL, MOVE, PROPFIND');
	res.setHeader('MS-Author-Via', 'DAV');
	res.status(200).end();
});

router.propfind('*splat', (req, res, next) => {
	try {
		const resource = resolveResource(req.webdavUserId, req.path);
		if (!resource) return res.status(404).end();

		const entries = [selfEntry(resource)];
		const depth = String(req.headers.depth ?? '1');
		const isCollection = resource.isRoot || Boolean(resource.file.is_folder);

		if (depth !== '0' && isCollection) {
			const path = childrenPath(resource);
			listFilesByPath(req.webdavUserId, path).forEach((child) => entries.push(toEntry(child, path)));
		}

		res.status(207);
		res.setHeader('Content-Type', 'application/xml; charset=utf-8');
		return res.end(buildPropfindXml(entries));
	} catch (error) {
		return next(error);
	}
});

async function sendFile(req, res, { bodyless }) {
	const resource = resolveResource(req.webdavUserId, req.path);
	if (!resource || resource.isRoot || resource.file.is_folder) {
		return res.status(404).end();
	}

	const { file } = resource;
	const size = Number(file.size || 0);
	res.setHeader('Accept-Ranges', 'bytes');
	res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');

	if (bodyless) {
		res.setHeader('Content-Length', String(size));
		return res.status(200).end();
	}

	const account = getAccountById(req.webdavUserId, file.cloud_account_id);
	if (!account || account.status !== 'active') {
		return res.status(503).end();
	}

	const adapter = createAdapter(account);
	const requestedRange = parseRangeHeader(req.headers.range, size);
	const opened = await fileCacheService.openFile({
		userId: req.webdavUserId,
		file,
		adapter,
		range: requestedRange || {},
	});
	const range = requestedRange
		&& (opened.cached || adapter.getCapabilities?.().supportsRange)
		? requestedRange
		: null;
	const { stream } = opened;

	if (range) {
		res.status(206);
		res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
		res.setHeader('Content-Length', String(range.end - range.start + 1));
	} else {
		res.status(200);
		if (size) res.setHeader('Content-Length', String(size));
	}

	stream.on('error', () => res.destroy());
	return stream.pipe(res);
}

router.head('*splat', async (req, res, next) => {
	try {
		await sendFile(req, res, { bodyless: true });
	} catch (error) {
		next(error);
	}
});

router.get('*splat', async (req, res, next) => {
	try {
		await sendFile(req, res, { bodyless: false });
	} catch (error) {
		next(error);
	}
});

export default router;
