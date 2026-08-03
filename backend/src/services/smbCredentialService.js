import crypto from 'crypto';
import { db } from '../config/database.js';
import { encryptJson, decryptJson } from '../utils/crypto.js';
import { getUserById } from './userService.js';

// Tabela dedicada em vez de user_settings: as credenciais SMB precisam ser
// recuperáveis em claro pelo provisionador, e user_settings é servido inteiro
// para o frontend em GET /api/settings.

export function deriveSmbUsername(email, isTaken) {
	const base =
		String(email || '')
			.split('@')[0]
			.split('+')[0]
			.toLowerCase()
			.replace(/[^a-z0-9._-]/g, '')
			.replace(/^[._-]+|[._-]+$/g, '') || 'omnicloud';

	if (!isTaken(base)) return base;

	let suffix = 2;
	while (isTaken(`${base}${suffix}`)) suffix += 1;
	return `${base}${suffix}`;
}

function usernameTaken(userId) {
	return (candidate) => {
		const row = db.prepare('SELECT user_id FROM smb_credentials WHERE username = ?').get(candidate);
		return Boolean(row) && row.user_id !== userId;
	};
}

function hydrate(row) {
	if (!row) return null;
	return {
		userId: row.user_id,
		username: row.username,
		password: decryptJson(row.password_enc),
		webdavToken: decryptJson(row.webdav_token_enc),
	};
}

export function setSmbCredentials(userId, password) {
	if (!password || String(password).length < 8) {
		throw new Error('SMB password must have at least 8 characters');
	}

	const existing = db.prepare('SELECT username FROM smb_credentials WHERE user_id = ?').get(userId);
	const user = getUserById(userId);
	const username = existing?.username || deriveSmbUsername(user?.email, usernameTaken(userId));
	const webdavToken = crypto.randomBytes(32).toString('hex');

	db.prepare(`
    INSERT INTO smb_credentials (user_id, username, password_enc, webdav_token_enc)
    VALUES (@user_id, @username, @password_enc, @webdav_token_enc)
    ON CONFLICT(user_id) DO UPDATE SET
      password_enc = excluded.password_enc,
      webdav_token_enc = excluded.webdav_token_enc,
      updated_at = CURRENT_TIMESTAMP
  `).run({
		user_id: userId,
		username,
		password_enc: encryptJson(String(password)),
		webdav_token_enc: encryptJson(webdavToken),
	});

	return { username, webdavToken };
}

export function getSmbCredential(userId) {
	return hydrate(db.prepare('SELECT * FROM smb_credentials WHERE user_id = ?').get(userId));
}

export function findSmbCredentialByUsername(username) {
	return hydrate(db.prepare('SELECT * FROM smb_credentials WHERE username = ?').get(username));
}

export function listSmbCredentials() {
	return db.prepare('SELECT * FROM smb_credentials').all().map(hydrate);
}

export function deleteSmbCredentials(userId) {
	db.prepare('DELETE FROM smb_credentials WHERE user_id = ?').run(userId);
}

export function verifyWebdavToken(username, token) {
	const credential = findSmbCredentialByUsername(username);
	if (!credential) return null;

	const expected = Buffer.from(credential.webdavToken);
	const received = Buffer.from(String(token || ''));
	if (expected.length !== received.length) return null;
	if (!crypto.timingSafeEqual(expected, received)) return null;

	return { userId: credential.userId, username: credential.username };
}
