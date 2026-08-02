import { Router } from 'express';
import { requireAppUser } from '../middleware/authMiddleware.js';
import { getSettings, updateSettings } from '../services/settingsService.js';
import { isRegistrationEnabled, setAppSetting } from '../services/appSettingsService.js';

const router = Router();

router.use(requireAppUser);

router.get('/settings', (req, res) => {
	try {
		const settings = getSettings(req.user.id);
		res.json({ data: settings });
	} catch (error) {
		res.status(500).json({ error: error.message });
	}
});

router.patch('/settings', (req, res) => {
	try {
		const settings = req.body;
		const updated = updateSettings(req.user.id, settings);
		res.json({ data: updated });
	} catch (error) {
		res.status(400).json({ error: error.message });
	}
});

router.get('/app-settings', (_req, res) => {
	res.json({ data: { registration_enabled: isRegistrationEnabled() } });
});

router.patch('/app-settings', (req, res) => {
	try {
		const enabled = Boolean(req.body?.registration_enabled);
		setAppSetting('registration_enabled', String(enabled));
		res.json({ data: { registration_enabled: enabled } });
	} catch (error) {
		res.status(400).json({ error: error.message });
	}
});

export default router;
