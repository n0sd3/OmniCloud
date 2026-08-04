import express, { Router } from 'express';
import { pipeline } from 'node:stream/promises';
import { env } from '../config/env.js';
import { requireAppUser } from '../middleware/authMiddleware.js';
import { megaDownloadService, normalizeMegaFileLink } from '../services/megaDownloadService.js';
import { megaLinkImportService, validateMegaFileName } from '../services/megaLinkImportService.js';
import { parseRangeHeader } from '../services/webdav.js';

const ERRORS = {
	INVALID_INPUT: [400, 'Invalid MEGA file link'],
	NOT_FOUND: [404, 'MEGA file not found'],
	QUOTA: [429, 'MEGA quota exhausted'],
	CANCELLED: [499, 'MEGA transfer cancelled'],
	UNSUPPORTED: [422, 'MEGA transfer is unsupported'],
	UNAVAILABLE: [503, 'MEGA download service unavailable'],
	TIMEOUT: [504, 'MEGA download service timed out'],
	UPSTREAM: [502, 'MEGA download failed'],
	UNAUTHORIZED: [502, 'MEGA download service authentication failed'],
	CONFLICT: [409, 'A file with this name already exists'],
	NO_SPACE: [507, 'Not enough cloud storage space'],
	NO_STREAMING_DESTINATION: [422, 'No streaming-capable cloud account available'],
};

const parseNativeDownloadForm = express.urlencoded({
	extended: false,
	limit: '4kb',
	parameterLimit: 1,
	type: 'application/x-www-form-urlencoded',
});

const trustedNativeDownloadOrigins = new Set(
	[env.corsOrigin].flatMap((value) => {
		try {
			return [new URL(value).origin];
		} catch {
			return [];
		}
	}),
);

function requireTrustedNativeDownloadOrigin(req, res, next) {
	if (!req.is('application/x-www-form-urlencoded')) return next();
	const origin = req.get('origin');
	if (!origin || !trustedNativeDownloadOrigins.has(origin)) {
		return res.status(403).json({ error: 'Untrusted download origin' });
	}
	return next();
}

function sendError(res, error) {
	const [status, message] = ERRORS[error?.code] || [500, 'MEGA request failed'];
	return res.status(status).json({ error: message });
}

function safeFileName(value) {
	const leaf = String(value || '').split(/[\\/]/).pop();
	return leaf.replace(/[\u0000-\u001f\u007f]/g, '').trim() || 'download';
}

function contentDisposition(value) {
	const name = safeFileName(value);
	const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
	const encoded = encodeURIComponent(name).replace(/['()*]/g, (character) =>
		`%${character.charCodeAt(0).toString(16).toUpperCase()}`,
	);
	return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export function createMegaLinkRouter({
	downloads = megaDownloadService,
	imports = megaLinkImportService,
} = {}) {
	const router = Router();
	router.use(requireAppUser);

	router.post('/mega-links/inspect', async (req, res) => {
		try {
			const link = normalizeMegaFileLink(req.body?.link);
			const metadata = await downloads.inspectPublic(link);
			validateMegaFileName(metadata.file_name);
			return res.json({ data: metadata });
		} catch (error) {
			return sendError(res, error);
		}
	});

	router.post('/mega-links/download', requireTrustedNativeDownloadOrigin, parseNativeDownloadForm, async (req, res) => {
		const controller = new AbortController();
		const onClose = () => {
			if (!res.writableFinished) controller.abort();
		};
		res.once('close', onClose);
		try {
			const link = normalizeMegaFileLink(req.body?.link);
			const metadata = await downloads.inspectPublic(link, { signal: controller.signal });
			validateMegaFileName(metadata.file_name);
			const size = Number(metadata.size || 0);
			const rangeHeader = String(req.headers.range || '').trim();
			const range = parseRangeHeader(rangeHeader, size);
			if (rangeHeader && /^bytes=\d*-\d*$/.test(rangeHeader) && !range) {
				res.setHeader('Accept-Ranges', 'bytes');
				res.setHeader('Content-Range', `bytes */${size}`);
				return res.status(416).end();
			}
			const stream = await downloads.streamPublic(link, { range, signal: controller.signal });

			res.setHeader('Accept-Ranges', 'bytes');
			res.setHeader('Content-Disposition', contentDisposition(metadata.file_name));
			res.setHeader('Content-Type', metadata.mime_type || 'application/octet-stream');
			if (range) {
				res.status(206);
				res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
				res.setHeader('Content-Length', String(range.end - range.start + 1));
			} else {
				res.status(200);
				res.setHeader('Content-Length', String(size));
			}
			await pipeline(stream, res);
		} catch (error) {
			if (res.headersSent) {
				if (!res.destroyed) res.destroy();
				return;
			}
			return sendError(res, error);
		} finally {
			res.off('close', onClose);
		}
	});

	router.post('/mega-links/import', async (req, res) => {
		try {
			const link = normalizeMegaFileLink(req.body?.link);
			const job = await imports.start(req.user.id, {
				link,
				virtualPath: req.body?.virtualPath ?? req.body?.virtual_path ?? '/',
			});
			return res.status(202).json({ data: job });
		} catch (error) {
			return sendError(res, error);
		}
	});

	router.delete('/mega-links/import/:uploadId', async (req, res) => {
		try {
			const cancelled = await imports.cancel(req.user.id, req.params.uploadId);
			return cancelled ? res.status(204).end() : res.status(404).json({ error: 'MEGA import not found' });
		} catch (error) {
			return sendError(res, error);
		}
	});

	return router;
}

export default createMegaLinkRouter();
