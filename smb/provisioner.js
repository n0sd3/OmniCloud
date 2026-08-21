// Reconcilia contas Samba e mounts rclone com os usuários do OmniCloud.
// Poll em vez de webhook: sobrevive a restart do container sem estado extra.

import { execFile, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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
const system = {
	run,
	setPassword: setSambaPassword,
	mkdir: mkdirSync,
	exists: existsSync,
	log: console.log,
	error: console.error,
};

// userId -> { username, token }: username para o removeMount saber qual conta
// Samba apagar, token para detectar rotação da credencial WebDAV.
const mounted = new Map();

// Config do Samba é gerado a partir de dados da API e recarregado ao vivo; um
// username com ']', '=' ou newline injetaria diretivas. Valida antes de usar.
const USERNAME_PATTERN = /^[a-z0-9._-]+$/;

// Contas de sistema do container: um usuário cujo email derive para um destes
// nomes ganharia conta Samba em cima da conta de sistema.
const RESERVED_USERNAMES = new Set([
	'root', 'daemon', 'bin', 'sys', 'sync', 'games', 'man', 'lp', 'mail',
	'news', 'uucp', 'proxy', 'www-data', 'backup', 'list', 'irc', 'nobody',
	'systemd-network', 'messagebus', 'sshd',
]);

function isSafeUsername(username) {
	const value = String(username || '');
	return USERNAME_PATTERN.test(value) && !RESERVED_USERNAMES.has(value);
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

async function ensureSystemUser(username, operations) {
	try {
		await operations.run('id', [username]);
	} catch {
		await operations.run('useradd', ['--no-create-home', '--shell', '/usr/sbin/nologin', username]);
	}
}

async function provisionUser(user, operations) {
	await ensureSystemUser(user.username, operations);
	await operations.setPassword(user.username, user.password);
	await ensureMount(user, operations);
}

// Isola por usuário: uma credencial quebrada travava o loop inteiro, deixando os
// usuários seguintes sem conta e sem o reload da config do Samba.
export async function provisionAll(users, operations = system) {
	const provisioned = [];

	for (const user of users) {
		try {
			await provisionUser(user, operations);
			provisioned.push(user);
		} catch (error) {
			operations.error(`provisioning failed for ${user.username}: ${error.message}`);
		}
	}

	return provisioned;
}

export async function ensureMount(user, operations = system) {
	const target = `${MOUNT_ROOT}/${user.userId}`;
	const current = mounted.get(user.userId);
	if (current?.token === user.webdavToken) return;

	// O daemon do rclone lê a credencial uma vez no mount: reescrever o
	// rclone.conf não basta quando o PUT /api/smb rotaciona o token.
	if (current) {
		await operations.run('fusermount3', ['-u', target]).catch((error) =>
			operations.error(`unmount failed for ${target}: ${error.message}`),
		);
		mounted.delete(user.userId);
	}

	operations.mkdir(target, { recursive: true });

	await operations.run('rclone', [
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

	mounted.set(user.userId, { username: user.username, token: user.webdavToken });
	operations.log(`mounted ${target}`);
}

export async function removeMount(userId, username, operations = system) {
	const target = `${MOUNT_ROOT}/${userId}`;

	if (operations.exists(target)) {
		await operations.run('fusermount3', ['-u', target]).catch((error) =>
			operations.error(`unmount failed for ${target}: ${error.message}`),
		);
		operations.log(`unmounted ${target}`);
	}

	await operations.run('smbpasswd', ['-x', username]).catch((error) =>
		operations.error(`smbpasswd -x failed for ${username}: ${error.message}`),
	);
	mounted.delete(userId);
	operations.log(`removed samba account ${username}`);
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

	const provisioned = await provisionAll(users);

	for (const [userId, entry] of [...mounted]) {
		if (!activeIds.has(userId)) await removeMount(userId, entry.username);
	}

	// Só os provisionados: um share apontando para um diretório não montado
	// aparece vazio, o que parece perda de arquivos.
	writeSmbConf(provisioned);
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	if (!SECRET) {
		console.error('SMB_PROVISION_SECRET is required');
		process.exit(1);
	}

	loop();
}
