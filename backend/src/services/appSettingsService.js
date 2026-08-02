import { db } from '../config/database.js';

const VALID_KEYS = ['registration_enabled'];

export function getAppSetting(key) {
	if (!VALID_KEYS.includes(key)) {
		throw new Error(`Invalid app setting key: ${key}`);
	}

	const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
	return row ? row.value : null;
}

export function setAppSetting(key, value) {
	if (!VALID_KEYS.includes(key)) {
		throw new Error(`Invalid app setting key: ${key}`);
	}

	db.prepare(`
		INSERT INTO app_settings (key, value, updated_at)
		VALUES (?, ?, CURRENT_TIMESTAMP)
		ON CONFLICT(key) DO UPDATE SET
			value = excluded.value,
			updated_at = CURRENT_TIMESTAMP
	`).run(key, value);

	return { key, value };
}

export function isRegistrationEnabled() {
	return getAppSetting('registration_enabled') !== 'false';
}
