import { Router } from 'express';
import { env, redactEnv } from '../config/env.js';
import { getAuthSummary } from '../services/authService.js';
import { requireAppUser } from '../middleware/authMiddleware.js';
import { getLastSyncReport, runDeltaSync } from '../services/syncService.js';
import { megaBasterdClient } from '../services/megaDownloadService.js';

export function createHealthRouter({
	client = megaBasterdClient,
	secret = env.megaBasterdSecret,
	fallbackEnabled = env.megaBasterdFallbackEnabled,
} = {}) {
	const router = Router();

	router.get('/health', async (req, res) => {
		let sidecar = String(secret || '').trim() ? 'unavailable' : 'unconfigured';
		if (sidecar !== 'unconfigured') {
			try {
				await client.health({ signal: AbortSignal.timeout(1500) });
				sidecar = 'available';
			} catch {
				// Health reporting must preserve fallback-only API availability.
			}
		}
		res.json({
			status: 'ok',
			service: 'omnicloud-api',
			config: redactEnv(),
			auth: getAuthSummary(req.user),
			sync: getLastSyncReport(),
			mega_download: {
				sidecar,
				fallback_enabled: Boolean(fallbackEnabled),
			},
			timestamp: new Date().toISOString(),
		});
	});

	router.post('/sync/run', requireAppUser, async (req, res, next) => {
		try {
			const report = await runDeltaSync(req.user.id);
			res.json({ data: report });
		} catch (error) {
			next(error);
		}
	});

	return router;
}

export default createHealthRouter();
