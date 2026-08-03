// Reconcilia contas Samba e mounts rclone com os usuários do OmniCloud.
// Poll em vez de webhook: sobrevive a restart do container sem estado extra.

import { execFile, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { promisify } from 'node:util';

const run = promisify(execFile);

const API_URL = process.env.OMNICLOUD_API_URL || 'http://api:8787';
const SECRET = process.env.SMB_PROVISION_SECRET || '';
const POLL_MS = Number(process.env.SMB_POLL_INTERVAL_MS || 30000);
const CACHE_MAX_SIZE = process.env.RCLONE_VFS_CACHE_MAX_SIZE || '20G';
const CACHE_MAX_AGE = process.env.RCLONE_VFS_CACHE_MAX_AGE || '24h';
const MOUNT_ROOT = '/mnt/omnicloud';
const RCLONE_CONF = '/root/.config/rclone/rclone.conf';
const SMB_CONF = '/etc/samba/smb.conf';
const SMB_CONF_BASE = '/app/smb.conf.base';

// userId -> username, para o removeMount saber qual conta Samba apagar.
const mounted = new Map();

// Config do Samba é gerado a partir de dados da API e recarregado ao vivo; um
// username com ']', '=' ou newline injetaria diretivas. Valida antes de usar.
const USERNAME_PATTERN = /^[a-z0-9._-]+$/;

function isSafeUsername(username) {
	return USERNAME_PATTERN.test(String(username || ''));
}

async function fetchUsers() {
	const response = await fetch(`${API_URL}/internal/smb/users`, {
		headers: { 'x-smb-provision-secret': SECRET },
	});

	if (!response.ok) {
		throw new Error(`Provisioning endpoint returned ${response.status}`);
	}

	const payload = await response.json();
	return payload.data || [];
}

function obscure(token) {
	return execFileSync('rclone', ['obscure', token]).toString().trim();
}

function writeRcloneConf(users) {
	mkdirSync('/root/.config/rclone', { recursive: true });

	const body = users
		.map((user) =>
			[
				`[omnicloud-${user.userId}]`,
				'type = webdav',
				`url = ${API_URL}/webdav`,
				'vendor = other',
				`user = ${user.username}`,
				`pass = ${obscure(user.webdavToken)}`,
				'',
			].join('\n'),
		)
		.join('\n');

	writeFileSync(RCLONE_CONF, body, { mode: 0o600 });
}

function writeSmbConf(users) {
	const base = readFileSync(SMB_CONF_BASE, 'utf8');

	const shares = users
		.map((user) =>
			[
				`[omnicloud-${user.username}]`,
				`   path = ${MOUNT_ROOT}/${user.userId}`,
				`   valid users = ${user.username}`,
				'   writable = yes',
				'   browseable = yes',
				'   vfs objects = catia fruit streams_xattr',
				'   fruit:metadata = stream',
				'   fruit:posix_rename = yes',
				'',
			].join('\n'),
		)
		.join('\n');

	writeFileSync(SMB_CONF, `${base}\n${shares}`);
}

async function setSambaPassword(username, password) {
	// smbpasswd lê a senha duas vezes do stdin.
	const child = execFile('smbpasswd', ['-s', '-a', username]);
	child.stdin.write(`${password}\n${password}\n`);
	child.stdin.end();

	await new Promise((resolve, reject) => {
		child.on('error', reject);
		child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`smbpasswd exited ${code}`))));
	});
}

async function ensureSystemUser(username) {
	try {
		await run('id', [username]);
	} catch {
		await run('useradd', ['--no-create-home', '--shell', '/usr/sbin/nologin', username]);
	}
}

async function ensureMount(user) {
	const target = `${MOUNT_ROOT}/${user.userId}`;
	if (mounted.has(user.userId)) return;

	mkdirSync(target, { recursive: true });

	await run('rclone', [
		'mount',
		`omnicloud-${user.userId}:`,
		target,
		'--daemon',
		'--allow-other',
		'--vfs-cache-mode',
		'full',
		'--vfs-cache-max-size',
		CACHE_MAX_SIZE,
		'--vfs-cache-max-age',
		CACHE_MAX_AGE,
		'--vfs-read-chunk-size',
		'32M',
		'--cache-dir',
		'/var/cache/rclone',
		'--dir-cache-time',
		'30s',
	]);

	mounted.set(user.userId, user.username);
	console.log(`mounted ${target}`);
}

async function removeMount(userId, username) {
	const target = `${MOUNT_ROOT}/${userId}`;

	if (existsSync(target)) {
		await run('fusermount3', ['-u', target]).catch(() => {});
		console.log(`unmounted ${target}`);
	}

	await run('smbpasswd', ['-x', username]).catch(() => {});
	mounted.delete(userId);
	console.log(`removed samba account ${username}`);
}

async function reconcile() {
	const fetched = await fetchUsers();
	const users = fetched.filter((user) => {
		if (isSafeUsername(user.username)) return true;
		console.error(`skipping user with unsafe username: ${JSON.stringify(user.username)}`);
		return false;
	});
	const activeIds = new Set(users.map((user) => user.userId));

	writeRcloneConf(users);

	for (const user of users) {
		await ensureSystemUser(user.username);
		await setSambaPassword(user.username, user.password);
		await ensureMount(user);
	}

	for (const [userId, username] of [...mounted]) {
		if (!activeIds.has(userId)) await removeMount(userId, username);
	}

	writeSmbConf(users);
	await run('smbcontrol', ['all', 'reload-config']).catch(() => {});
}

async function loop() {
	for (;;) {
		try {
			await reconcile();
		} catch (error) {
			console.error(`reconcile failed: ${error.message}`);
		}
		await new Promise((resolve) => setTimeout(resolve, POLL_MS));
	}
}

if (!SECRET) {
	console.error('SMB_PROVISION_SECRET is required');
	process.exit(1);
}

loop();
