import { Router } from 'express';
import { listFilesByPath, deleteFileMetadata, createFileMetadata } from '../services/fileService.js';
import { getAccountById } from '../services/accountService.js';
import { createAdapter } from '../services/adapterRegistry.js';
import { verifyWebdavToken } from '../services/smbCredentialService.js';
import { parseRangeHeader, parseDavPath, buildPropfindXml, encodeDavHref } from '../services/webdav.js';
import { fileCacheService } from '../services/fileCacheService.js';
import { selectBestAccount } from '../services/spaceAllocator.js';
import { createUploadSession } from '../services/uploadSessionService.js';
import { runUpload } from '../services/uploadService.js';
import { syncAccount } from '../services/syncService.js';

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

// O rclone manda o Destination como URL absoluta.
function parseDestination(header) {
	const raw = String(header || '');
	if (!raw) return null;
	const pathname = raw.startsWith('http') ? new URL(raw).pathname : raw;
	return parseDavPath(pathname, BASE_PATH);
}

router.mkcol('*splat', async (req, res, next) => {
	try {
		const { parentPath, name } = parseDavPath(req.path, BASE_PATH);
		if (!name) return res.status(405).end();

		const existing = listFilesByPath(req.webdavUserId, parentPath).find((item) => item.file_name === name);
		if (existing) return res.status(405).end();

		const parent = resolveResource(req.webdavUserId, req.path.replace(/\/[^/]+\/?$/, '') || BASE_PATH);
		const allocation = selectBestAccount(req.webdavUserId, 0);
		const adapter = createAdapter(allocation.selected);

		const folder = await adapter.createFolder({
			name,
			virtualPath: parentPath,
			remoteParentId: parent?.file?.remote_file_id || null,
		});

		createFileMetadata({
			user_id: req.webdavUserId,
			virtual_path: parentPath,
			file_name: name,
			is_folder: true,
			size: 0,
			mime_type: null,
			cloud_account_id: allocation.selected.id,
			remote_file_id: folder.remoteFileId,
			remote_parent_id: folder.remoteParentId,
		});

		return res.status(201).end();
	} catch (error) {
		return next(error);
	}
});

router.put('*splat', async (req, res, next) => {
	try {
		const { parentPath, name } = parseDavPath(req.path, BASE_PATH);
		if (!name) return res.status(405).end();

		const existing = listFilesByPath(req.webdavUserId, parentPath).find((item) => item.file_name === name);
		if (existing?.is_folder) return res.status(405).end();

		// ponytail: sobrescrever é delete + upload — os adapters não têm "trocar
		// conteúdo". Perde histórico de versões do provider. Upgrade quando algum
		// adapter expuser update de conteúdo.
		if (existing) {
			const account = getAccountById(req.webdavUserId, existing.cloud_account_id);
			if (account) await createAdapter(account).deleteFile(existing);
			// Invalida antes do upload: sem isso o cache continua servindo os bytes
			// antigos na janela entre o delete e o syncAccount que runUpload dispara.
			fileCacheService.invalidate(existing);
			deleteFileMetadata(req.webdavUserId, existing.id);
		}

		const size = Number(req.headers['content-length'] || 0);
		const allocation = selectBestAccount(req.webdavUserId, size);
		const session = createUploadSession({
			user_id: req.webdavUserId,
			file_name: name,
			size,
			mime_type: req.headers['content-type'] || 'application/octet-stream',
			virtual_path: parentPath,
			remote_parent_id: null,
			cloud_account_id: allocation.selected.id,
			fallback_chain: allocation.fallbackChain.map((account) => account.id),
		});

		await runUpload({
			session,
			stream: req,
			fileName: name,
			mimeType: req.headers['content-type'] || 'application/octet-stream',
		});

		return res.status(existing ? 204 : 201).end();
	} catch (error) {
		if (/space|quota/i.test(error?.message || '')) return res.status(507).end();
		return next(error);
	}
});

router.delete('*splat', async (req, res, next) => {
	try {
		const resource = resolveResource(req.webdavUserId, req.path);
		if (!resource || resource.isRoot) return res.status(404).end();

		const account = getAccountById(req.webdavUserId, resource.file.cloud_account_id);
		if (!account || account.status !== 'active') return res.status(503).end();

		await createAdapter(account).deleteFile(resource.file);
		deleteFileMetadata(req.webdavUserId, resource.file.id);
		await syncAccount(req.webdavUserId, account);

		return res.status(204).end();
	} catch (error) {
		return next(error);
	}
});

router.move('*splat', async (req, res, next) => {
	try {
		const resource = resolveResource(req.webdavUserId, req.path);
		if (!resource || resource.isRoot) return res.status(404).end();

		const destination = parseDestination(req.headers.destination);
		if (!destination?.name) return res.status(400).end();

		// Mover entre pastas exige mover entre providers no caso geral, e os
		// adapters só sabem renomear no lugar.
		if (destination.parentPath !== resource.parentPath) {
			return res.status(502).end();
		}

		const account = getAccountById(req.webdavUserId, resource.file.cloud_account_id);
		if (!account || account.status !== 'active') return res.status(503).end();

		await createAdapter(account).renameFile(resource.file, destination.name);
		await syncAccount(req.webdavUserId, account);

		return res.status(204).end();
	} catch (error) {
		return next(error);
	}
});

// O rclone cai sozinho no fallback GET + PUT quando COPY não existe.
router.copy('*splat', (_req, res) => res.status(501).end());

export default router;
