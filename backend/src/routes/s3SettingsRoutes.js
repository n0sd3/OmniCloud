import { Router } from 'express';
import { requireAppUser } from '../middleware/authMiddleware.js';
import { env } from '../config/env.js';
import { db } from '../config/database.js';
import {
	createCredential,
	listCredentials,
	revokeCredential,
	isEnabled,
	setEnabled,
} from '../s3/credentials.js';

const router = Router();
router.use(requireAppUser);
function settings(userId) {
	return {
		available: env.s3GatewayEnabled,
		enabled: isEnabled(userId),
		bucket: env.s3GatewayBucket,
		region: env.s3GatewayRegion,
		endpoint: env.s3GatewayEndpoint,
		keys: listCredentials(userId),
	};
}
router.use('/s3-gateway', (_req, res, next) => {
	res.setHeader('Cache-Control', 'no-store');
	next();
});
router.get('/s3-gateway', (req, res) => res.json({ data: settings(req.user.id) }));
router.patch('/s3-gateway', (req, res) => {
	if (typeof req.body?.enabled !== 'boolean')
		return res.status(400).json({ error: 'enabled must be boolean' });
	setEnabled(req.user.id, req.body.enabled);
	res.json({ data: settings(req.user.id) });
});
router.post('/s3-gateway/keys', (req, res, next) => {
	try {
		res.status(201).json({ data: createCredential(req.user.id) });
	} catch (error) {
		next(error);
	}
});
router.delete('/s3-gateway/keys/:key', (req, res) => {
	revokeCredential(req.user.id, req.params.key);
	res.json({ data: settings(req.user.id) });
});
router.post('/s3-gateway/keys/:key/rotate', (req, res, next) => {
	try {
		const result = db.transaction(() => {
			if (
				!listCredentials(req.user.id).some((c) => c.access_key_id === req.params.key && c.enabled)
			)
				throw new Error('Access key not found');
			revokeCredential(req.user.id, req.params.key);
			return createCredential(req.user.id);
		})();
		res.status(201).json({ data: result });
	} catch (error) {
		next(error);
	}
});
export default router;
