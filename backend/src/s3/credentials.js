import { randomBytes } from 'node:crypto';
import { db } from '../config/database.js';
import { env } from '../config/env.js';
import { encryptJson, decryptJson } from '../utils/crypto.js';
import { s3Error } from './response.js';

export function isEnabled(userId) {
	return (
		env.s3GatewayEnabled &&
		db.prepare('SELECT enabled FROM s3_gateway_settings WHERE user_id=?').get(userId)?.enabled === 1
	);
}
export function setEnabled(userId, enabled) {
	db.prepare(
		'INSERT INTO s3_gateway_settings(user_id,enabled) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET enabled=excluded.enabled',
	).run(userId, enabled ? 1 : 0);
}
export function listCredentials(userId) {
	return db
		.prepare(
			'SELECT access_key_id,enabled,created_at,last_used_at FROM s3_gateway_credentials WHERE user_id=? ORDER BY created_at DESC',
		)
		.all(userId);
}
export function createCredential(userId) {
	if (listCredentials(userId).filter((c) => c.enabled).length >= 10)
		throw s3Error('InvalidArgument', 'At most ten active gateway keys per user');
	const accessKeyId = `OC${randomBytes(10).toString('hex').toUpperCase()}`;
	const secretAccessKey = randomBytes(32).toString('base64url');
	db.prepare(
		'INSERT INTO s3_gateway_credentials(access_key_id,user_id,secret_enc) VALUES (?,?,?)',
	).run(accessKeyId, userId, encryptJson(secretAccessKey));
	return { accessKeyId, secretAccessKey };
}
export function revokeCredential(userId, key) {
	db.prepare('UPDATE s3_gateway_credentials SET enabled=0 WHERE user_id=? AND access_key_id=?').run(
		userId,
		key,
	);
}
export function findCredential(key) {
	const row = db
		.prepare(
			'SELECT c.* FROM s3_gateway_credentials c JOIN users u ON u.id=c.user_id WHERE c.access_key_id=? AND c.enabled=1',
		)
		.get(key);
	if (!row) throw s3Error('InvalidAccessKeyId', 'The access key does not exist or is disabled');
	if (!isEnabled(row.user_id)) throw s3Error('AccessDenied', 'Gateway access is disabled');
	return { userId: row.user_id, accessKeyId: key, secretAccessKey: decryptJson(row.secret_enc) };
}
export function touchCredential(key) {
	db.prepare(
		'UPDATE s3_gateway_credentials SET last_used_at=CURRENT_TIMESTAMP WHERE access_key_id=?',
	).run(key);
}
