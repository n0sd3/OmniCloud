import { Router } from 'express';
import { requireAppUser } from '../middleware/authMiddleware.js';
import { env } from '../config/env.js';
import {
	setSmbCredentials,
	getSmbCredential,
	deleteSmbCredentials,
} from '../services/smbCredentialService.js';

const router = Router();

router.use(requireAppUser);

// Nunca devolve senha nem token: o frontend só precisa saber se está ligado e
// onde montar.
function present(credential) {
	if (!credential) {
		return { enabled: false, username: null, host: env.smbHost, sharePath: null };
	}

	return {
		enabled: true,
		username: credential.username,
		host: env.smbHost,
		sharePath: `smb://${env.smbHost}/omnicloud-${credential.username}`,
	};
}

router.get('/smb', (req, res) => {
	res.json({ data: present(getSmbCredential(req.user.id)) });
});

router.put('/smb', (req, res) => {
	try {
		setSmbCredentials(req.user.id, req.body?.password);
		res.json({ data: present(getSmbCredential(req.user.id)) });
	} catch (error) {
		res.status(400).json({ error: error.message });
	}
});

// Responde 200 com corpo, não 204: o helper `request` do frontend sempre chama
// response.json(), e um 204 sem corpo o faria lançar.
router.delete('/smb', (req, res) => {
	deleteSmbCredentials(req.user.id);
	res.json({ data: present(null) });
});

export default router;
