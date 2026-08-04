import dotenv from 'dotenv';
import os from 'os';
import crypto from 'crypto';
import path from 'path';

dotenv.config();

const machineFingerprint = crypto
	.createHash('sha256')
	.update(`${os.hostname()}|${os.platform()}|${os.arch()}`)
	.digest('hex');

const envHalf = process.env.OMNICLOUD_SECRET_HALF || 'omnicloud-dev-secret-half';
const derivedKeyMaterial = `${envHalf}:${machineFingerprint}`;
const encryptionKey = crypto.createHash('sha256').update(derivedKeyMaterial).digest();

export const env = {
	port: Number(process.env.PORT || 8787),
	appMode: process.env.APP_MODE === 'hosted' ? 'hosted' : 'local',
	corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173',
	syncIntervalMinutes: Number(process.env.SYNC_INTERVAL_MINUTES || 5),
	authCookieName: process.env.AUTH_COOKIE_NAME || 'omnicloud_session',
	authSessionTtlHours: Number(process.env.AUTH_SESSION_TTL_HOURS || 24 * 14),
	authSecret: process.env.AUTH_SECRET || process.env.OMNICLOUD_SECRET_HALF || 'omnicloud-dev-auth-secret',
	encryptionKey,
	frontendUrl: process.env.FRONTEND_URL || process.env.CORS_ORIGIN || 'http://localhost:5173',
	googleClientId: process.env.GOOGLE_CLIENT_ID || '',
	googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
	googleRedirectUri:
		process.env.GOOGLE_REDIRECT_URI || 'http://localhost:8787/api/accounts/google/callback',
	onedriveClientId: process.env.ONEDRIVE_CLIENT_ID || '',
	onedriveClientSecret: process.env.ONEDRIVE_CLIENT_SECRET || '',
	onedriveTenantId: process.env.ONEDRIVE_TENANT_ID || 'common',
	onedriveRedirectUri:
		process.env.ONEDRIVE_REDIRECT_URI || 'http://localhost:8787/api/accounts/onedrive/callback',
	dropboxClientId: process.env.DROPBOX_CLIENT_ID || '',
	dropboxClientSecret: process.env.DROPBOX_CLIENT_SECRET || '',
	dropboxRedirectUri:
		process.env.DROPBOX_REDIRECT_URI || 'http://localhost:8787/api/accounts/dropbox/callback',
	yandexClientId: process.env.YANDEX_CLIENT_ID || '',
	yandexClientSecret: process.env.YANDEX_CLIENT_SECRET || '',
	yandexRedirectUri:
		process.env.YANDEX_REDIRECT_URI || 'http://localhost:8787/api/accounts/yandex/callback',
	smbProvisionSecret: process.env.SMB_PROVISION_SECRET || '',
	smbHost: process.env.SMB_HOST || 'omnicloud',
	thumbnailCacheDir: process.env.THUMBNAIL_CACHE_DIR || path.resolve(process.cwd(), 'data/thumbnails'),
	previewCacheDir: process.env.PREVIEW_CACHE_DIR || path.resolve(process.cwd(), 'data/previews'),
	fileCachePath: process.env.FILE_CACHE_PATH || path.resolve(process.cwd(), '.cache/files'),
	fileCacheWarmTtlMs: Number(process.env.FILE_CACHE_WARM_TTL_MS || 60 * 60 * 1000),
	fileCacheConcurrency: Math.max(1, Number(process.env.FILE_CACHE_CONCURRENCY || 3)),
	megaBasterdUrl: process.env.MEGABASTERD_URL || 'http://megabasterd:8788',
	megaBasterdSecret: String(process.env.MEGABASTERD_INTERNAL_SECRET || '').trim(),
	megaBasterdTimeoutMs: Math.max(1000, Number(process.env.MEGABASTERD_TIMEOUT_MS || 15000)),
	megaBasterdFallbackEnabled: process.env.MEGABASTERD_FALLBACK_ENABLED !== 'false',
};

export function redactEnv() {
	return {
		port: env.port,
		appMode: env.appMode,
		corsOrigin: env.corsOrigin,
		syncIntervalMinutes: env.syncIntervalMinutes,
		authCookieName: env.authCookieName,
		authSessionTtlHours: env.authSessionTtlHours,
		frontendUrl: env.frontendUrl,
		googleClientId: env.googleClientId ? '[configured]' : '[missing]',
		googleRedirectUri: env.googleRedirectUri,
		onedriveClientId: env.onedriveClientId ? '[configured]' : '[missing]',
		onedriveTenantId: env.onedriveTenantId,
		onedriveRedirectUri: env.onedriveRedirectUri,
		dropboxClientId: env.dropboxClientId ? '[configured]' : '[missing]',
		dropboxRedirectUri: env.dropboxRedirectUri,
		yandexClientId: env.yandexClientId ? '[configured]' : '[missing]',
		yandexRedirectUri: env.yandexRedirectUri,
		smbProvisionSecret: env.smbProvisionSecret ? '[configured]' : '[missing]',
		smbHost: env.smbHost,
		megaBasterdUrl: env.megaBasterdUrl,
		megaBasterdSecret: String(env.megaBasterdSecret || '').trim() ? '[configured]' : '[missing]',
		megaBasterdTimeoutMs: env.megaBasterdTimeoutMs,
		megaBasterdFallbackEnabled: env.megaBasterdFallbackEnabled,
	};
}
