import crypto from 'crypto';
import { Router } from 'express';
import { env } from '../config/env.js';
import { listSmbCredentials } from '../services/smbCredentialService.js';

const router = Router();

// Montado fora de /api: o nginx do frontend só proxeia /api/ e /ws/uploads, então
// esta rota só é alcançável de dentro da rede do compose.
function requireProvisionSecret(req, res, next) {
	const expected = Buffer.from(env.smbProvisionSecret || '');
	const received = Buffer.from(String(req.headers['x-smb-provision-secret'] || ''));

	if (!expected.length || expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) {
		return res.status(401).json({ error: 'Invalid provisioning secret' });
	}

	return next();
}

router.get('/smb/users', requireProvisionSecret, (_req, res) => {
	res.json({ data: listSmbCredentials() });
});

export default router;
