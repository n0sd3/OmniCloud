# SMB Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expor a árvore virtual do OmniCloud como compartilhamento SMB, para que Linux, macOS, iOS e Windows montem o drive nativamente.

**Architecture:** O backend Express ganha uma camada WebDAV (`/webdav`) mapeada sobre o `fileService` (metadados, do mirror SQLite) e sobre a camada de adapters (bytes, com `Range`). Um container novo roda `rclone mount` contra esse WebDAV e serve os pontos de montagem via Samba, um share por usuário. Nenhum código de FUSE é escrito — o rclone é o cliente FUSE, e o cache de bytes é o VFS cache dele.

**Tech Stack:** Node 22 + Express 5 (ESM), better-sqlite3, `node --test`, Samba, rclone, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-08-02-smb-server-design.md`

## Global Constraints

- Backend é ESM (`"type": "module"`) — sempre `import`, nunca `require`.
- Indentação com **tabs**, seguindo todo o código existente em `backend/src`.
- Testes com `node --test` e `node:assert/strict`. Sem framework, sem dependência nova.
- Todo teste que toca o banco define `process.env.DATABASE_PATH` para um caminho em `os.tmpdir()` **antes** de importar qualquer módulo que carregue `src/config/database.js`, e usa `await import(...)` dinâmico. Padrão em `backend/test/uploadChunks.test.js`.
- Nenhuma dependência npm nova no backend.
- Credenciais em repouso usam `encryptJson`/`decryptJson` de `backend/src/utils/crypto.js`.
- Rotas WebDAV e internas são montadas **fora** de `/api`, porque `frontend/docker/nginx.conf` só proxeia `/api/` e `/ws/uploads`. Isso é o que as mantém inacessíveis de fora do compose.
- Samba: `server min protocol = SMB2_10`, sem acesso guest.
- O único consumidor do WebDAV é o rclone. Não implementar `LOCK`, `UNLOCK` nem `COPY`.
- Comentários de código em português, como no resto do repositório.

---

### Task 1: Núcleo puro do WebDAV (parsing e XML)

Funções sem I/O, sem banco, sem rede. Base de tudo que vem depois.

**Files:**
- Create: `backend/src/services/webdav.js`
- Test: `backend/test/webdav.test.js`

**Interfaces:**
- Consumes: nada.
- Produces:
  - `parseRangeHeader(header: string|undefined, size: number): { start: number, end: number } | null`
  - `parseDavPath(href: string, basePath?: string): { parentPath: string, name: string|null }`
  - `buildPropfindXml(entries: Array<{ href: string, isFolder: boolean, displayName: string, size?: number, mimeType?: string, modifiedTime?: string }>): string`
  - `toHttpDate(value: string|null|undefined): string`

- [ ] **Step 1: Write the failing test**

Create `backend/test/webdav.test.js`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';

const { parseRangeHeader, parseDavPath, buildPropfindXml, toHttpDate } = await import(
	'../src/services/webdav.js'
);

test('parseRangeHeader lê intervalo fechado', () => {
	assert.deepEqual(parseRangeHeader('bytes=0-499', 1000), { start: 0, end: 499 });
});

test('parseRangeHeader lê intervalo aberto no fim', () => {
	assert.deepEqual(parseRangeHeader('bytes=500-', 1000), { start: 500, end: 999 });
});

test('parseRangeHeader lê sufixo como bytes finais', () => {
	assert.deepEqual(parseRangeHeader('bytes=-500', 1000), { start: 500, end: 999 });
});

test('parseRangeHeader trunca fim maior que o arquivo', () => {
	assert.deepEqual(parseRangeHeader('bytes=0-99999', 1000), { start: 0, end: 999 });
});

test('parseRangeHeader devolve null para header ausente ou inválido', () => {
	assert.equal(parseRangeHeader(undefined, 1000), null);
	assert.equal(parseRangeHeader('items=0-10', 1000), null);
	assert.equal(parseRangeHeader('bytes=abc', 1000), null);
});

test('parseRangeHeader devolve null quando start passa do fim', () => {
	assert.equal(parseRangeHeader('bytes=2000-', 1000), null);
});

test('parseDavPath resolve a raiz', () => {
	assert.deepEqual(parseDavPath('/webdav/'), { parentPath: '/', name: null });
	assert.deepEqual(parseDavPath('/webdav'), { parentPath: '/', name: null });
});

test('parseDavPath resolve item na raiz', () => {
	assert.deepEqual(parseDavPath('/webdav/Fotos'), { parentPath: '/', name: 'Fotos' });
});

test('parseDavPath resolve item aninhado', () => {
	assert.deepEqual(parseDavPath('/webdav/Fotos/2024/a.jpg'), {
		parentPath: '/Fotos/2024/',
		name: 'a.jpg',
	});
});

test('parseDavPath decodifica percent-encoding', () => {
	assert.deepEqual(parseDavPath('/webdav/Minhas%20Fotos/f%C3%A9rias.jpg'), {
		parentPath: '/Minhas Fotos/',
		name: 'férias.jpg',
	});
});

test('parseDavPath ignora barra final de pasta', () => {
	assert.deepEqual(parseDavPath('/webdav/Fotos/2024/'), { parentPath: '/Fotos/', name: '2024' });
});

test('parseDavPath rejeita travessia de diretório', () => {
	assert.throws(() => parseDavPath('/webdav/../etc/passwd'), /Invalid WebDAV path/);
});

test('buildPropfindXml marca pasta como collection', () => {
	const xml = buildPropfindXml([
		{ href: '/webdav/Fotos/', isFolder: true, displayName: 'Fotos', modifiedTime: null },
	]);

	assert.match(xml, /<D:multistatus xmlns:D="DAV:">/);
	assert.match(xml, /<D:collection\/>/);
	assert.match(xml, /<D:href>\/webdav\/Fotos\/<\/D:href>/);
	assert.doesNotMatch(xml, /getcontentlength/);
});

test('buildPropfindXml emite tamanho e tipo para arquivo', () => {
	const xml = buildPropfindXml([
		{
			href: '/webdav/a.jpg',
			isFolder: false,
			displayName: 'a.jpg',
			size: 2048,
			mimeType: 'image/jpeg',
			modifiedTime: '2026-08-02T10:00:00.000Z',
		},
	]);

	assert.match(xml, /<D:getcontentlength>2048<\/D:getcontentlength>/);
	assert.match(xml, /<D:getcontenttype>image\/jpeg<\/D:getcontenttype>/);
	assert.match(xml, /<D:getlastmodified>Sun, 02 Aug 2026 10:00:00 GMT<\/D:getlastmodified>/);
	assert.doesNotMatch(xml, /<D:collection\/>/);
});

test('buildPropfindXml escapa caracteres especiais de XML', () => {
	const xml = buildPropfindXml([
		{ href: '/webdav/a%20&%20b.txt', isFolder: false, displayName: 'a & b.txt', size: 1 },
	]);

	assert.match(xml, /<D:displayname>a &amp; b\.txt<\/D:displayname>/);
	assert.match(xml, /<D:href>\/webdav\/a%20&amp;%20b\.txt<\/D:href>/);
});

test('toHttpDate converte ISO para formato HTTP', () => {
	assert.equal(toHttpDate('2026-08-02T10:00:00.000Z'), 'Sun, 02 Aug 2026 10:00:00 GMT');
});

test('toHttpDate usa epoch para valor ausente', () => {
	assert.equal(toHttpDate(null), 'Thu, 01 Jan 1970 00:00:00 GMT');
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd backend && node --test test/webdav.test.js
```

Expected: FAIL — `Cannot find module '../src/services/webdav.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `backend/src/services/webdav.js`:

```js
// Núcleo puro do WebDAV: parsing e serialização, sem I/O.
// O consumidor é sempre o rclone, então só as propriedades que ele lê são emitidas.

const XML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

function escapeXml(value) {
	return String(value ?? '').replace(/[&<>"']/g, (char) => XML_ESCAPES[char]);
}

export function parseRangeHeader(header, size) {
	const match = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
	if (!match) return null;

	const [, rawStart, rawEnd] = match;
	if (rawStart === '' && rawEnd === '') return null;

	const total = Number(size) || 0;
	let start;
	let end;

	if (rawStart === '') {
		// Sufixo: "bytes=-500" são os últimos 500 bytes.
		const suffix = Number(rawEnd);
		if (!suffix) return null;
		start = Math.max(0, total - suffix);
		end = total - 1;
	} else {
		start = Number(rawStart);
		end = rawEnd === '' ? total - 1 : Number(rawEnd);
	}

	if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
	if (start >= total || start < 0) return null;

	return { start, end: Math.min(end, total - 1) };
}

export function parseDavPath(href, basePath = '/webdav') {
	const [pathOnly] = String(href || '').split('?');
	const decoded = decodeURIComponent(pathOnly);
	const withoutBase = decoded.startsWith(basePath) ? decoded.slice(basePath.length) : decoded;
	const segments = withoutBase.split('/').filter(Boolean);

	if (segments.some((segment) => segment === '..' || segment === '.')) {
		throw new Error('Invalid WebDAV path');
	}

	if (!segments.length) {
		return { parentPath: '/', name: null };
	}

	const name = segments.pop();
	const parentPath = segments.length ? `/${segments.join('/')}/` : '/';
	return { parentPath, name };
}

export function toHttpDate(value) {
	const date = value ? new Date(value) : new Date(0);
	const safe = Number.isNaN(date.getTime()) ? new Date(0) : date;
	return safe.toUTCString();
}

function buildResponse(entry) {
	const props = [`<D:displayname>${escapeXml(entry.displayName)}</D:displayname>`];

	if (entry.isFolder) {
		props.push('<D:resourcetype><D:collection/></D:resourcetype>');
	} else {
		props.push('<D:resourcetype/>');
		props.push(`<D:getcontentlength>${Number(entry.size || 0)}</D:getcontentlength>`);
		props.push(
			`<D:getcontenttype>${escapeXml(entry.mimeType || 'application/octet-stream')}</D:getcontenttype>`,
		);
	}

	props.push(`<D:getlastmodified>${toHttpDate(entry.modifiedTime)}</D:getlastmodified>`);

	return [
		'<D:response>',
		`<D:href>${escapeXml(entry.href)}</D:href>`,
		'<D:propstat>',
		`<D:prop>${props.join('')}</D:prop>`,
		'<D:status>HTTP/1.1 200 OK</D:status>',
		'</D:propstat>',
		'</D:response>',
	].join('');
}

export function buildPropfindXml(entries) {
	return [
		'<?xml version="1.0" encoding="utf-8"?>',
		'<D:multistatus xmlns:D="DAV:">',
		...entries.map(buildResponse),
		'</D:multistatus>',
	].join('');
}

// href já vem percent-encoded de quem monta a entrada; escapeXml só cuida do '&'.
export function encodeDavHref(basePath, parentPath, name, isFolder) {
	const parent = parentPath === '/' ? '' : parentPath.replace(/\/+$/, '');
	const segments = `${parent}/${name || ''}`.split('/').filter(Boolean);
	const encoded = segments.map((segment) => encodeURIComponent(segment)).join('/');
	const suffix = isFolder ? '/' : '';
	return `${basePath}/${encoded}${suffix}`.replace(/\/+/g, '/');
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd backend && node --test test/webdav.test.js
```

Expected: PASS, 17 testes.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/webdav.js backend/test/webdav.test.js
git commit -m "feat: add pure WebDAV parsing and XML serialization core"
```

---

### Task 2: Suporte a Range nos adapters

**Files:**
- Modify: `backend/src/adapters/BaseCloudAdapter.js:9-15` (capabilities), `:67-70` (getDownloadStream)
- Modify: `backend/src/adapters/GoogleDriveAdapter.js:303-316`
- Modify: `backend/src/adapters/S3Adapter.js:217-237`
- Modify: `backend/src/adapters/DropboxAdapter.js:125-136` (aceitar headers), `:284-303`
- Modify: `backend/src/adapters/OneDriveAdapter.js:341-362`
- Modify: `backend/src/adapters/YandexAdapter.js:254-267`
- Test: `backend/test/adapterRange.test.js`

**Interfaces:**
- Consumes: nada da Task 1.
- Produces:
  - `BaseCloudAdapter.getCapabilities()` passa a incluir `supportsRange: boolean` (default `false`).
  - `adapter.getDownloadStream(fileRecord, options?)` onde `options` é `{ start?: number, end?: number }`. Adapters com `supportsRange: true` honram; os demais ignoram e devolvem o corpo inteiro.
  - `buildRangeHeader({ start, end }): string | null` exportado de `backend/src/adapters/BaseCloudAdapter.js`.

- [ ] **Step 1: Write the failing test**

Create `backend/test/adapterRange.test.js`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';

const { BaseCloudAdapter, buildRangeHeader } = await import(
	'../src/adapters/BaseCloudAdapter.js'
);

test('buildRangeHeader monta intervalo fechado', () => {
	assert.equal(buildRangeHeader({ start: 0, end: 499 }), 'bytes=0-499');
});

test('buildRangeHeader monta intervalo aberto', () => {
	assert.equal(buildRangeHeader({ start: 500 }), 'bytes=500-');
});

test('buildRangeHeader devolve null sem range', () => {
	assert.equal(buildRangeHeader(null), null);
	assert.equal(buildRangeHeader({}), null);
});

test('BaseCloudAdapter declara supportsRange false', () => {
	const adapter = new BaseCloudAdapter({ provider: 'fake' });
	assert.equal(adapter.getCapabilities().supportsRange, false);
});

test('BaseCloudAdapter aceita options sem quebrar', async () => {
	const adapter = new BaseCloudAdapter({ provider: 'fake' });
	const stream = await adapter.getDownloadStream({ file_name: 'a.txt' }, { start: 0, end: 5 });
	const chunks = [];
	for await (const chunk of stream) chunks.push(chunk);
	assert.match(chunks.join(''), /Simulated download for a\.txt/);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd backend && node --test test/adapterRange.test.js
```

Expected: FAIL — `buildRangeHeader` não é exportado; `supportsRange` é `undefined`.

- [ ] **Step 3: Write minimal implementation**

Em `backend/src/adapters/BaseCloudAdapter.js`, adicionar antes da classe:

```js
// Monta o header Range HTTP a partir de { start, end }. Compartilhado pelos
// adapters que falam HTTP direto.
export function buildRangeHeader(range) {
	if (!range || !Number.isFinite(Number(range.start))) return null;
	const end = Number.isFinite(Number(range.end)) ? Number(range.end) : '';
	return `bytes=${Number(range.start)}-${end}`;
}
```

Em `getCapabilities()`, adicionar `supportsRange: false`:

```js
	getCapabilities() {
		return {
			starred: false,
			rename: true,
			delete: true,
			supportsRange: false,
		};
	}
```

Em `getDownloadStream`, aceitar o segundo argumento (a base ignora):

```js
	async getDownloadStream(fileRecord, _options = {}) {
		const content = `Simulated download for ${fileRecord.file_name} from ${this.account.provider}`;
		return Readable.from([content]);
	}
```

`GoogleDriveAdapter.js` — `getCapabilities()` do adapter passa a devolver `supportsRange: true` (adicione a chave ao objeto que ele já retorna; se ele não sobrescreve `getCapabilities`, crie o método devolvendo `{ ...super.getCapabilities(), supportsRange: true }`). Depois:

```js
	async getDownloadStream(fileRecord, options = {}) {
		const drive = await this.getDriveClient();
		const range = buildRangeHeader(options);
		const response = await drive.files.get(
			{
				fileId: fileRecord.remote_file_id,
				alt: 'media',
			},
			{
				responseType: 'stream',
				...(range ? { headers: { Range: range } } : {}),
			},
		);

		return response.data;
	}
```

`S3Adapter.js`:

```js
	async getDownloadStream(fileRecord, options = {}) {
		const { client, bucket } = this.getClient();
		const key = fileRecord.remote_file_id || toKey(fileRecord.virtual_path, fileRecord.file_name);
		const range = buildRangeHeader(options);

		const response = await client.send(
			new GetObjectCommand({
				Bucket: bucket,
				Key: key,
				...(range ? { Range: range } : {}),
			}),
		);

		if (!response.Body) {
			throw new Error('S3 download returned an empty body');
		}

		if (response.Body instanceof Readable) {
			return response.Body;
		}

		return Readable.fromWeb(response.Body);
	}
```

`DropboxAdapter.js` — `content()` precisa aceitar headers extras. Mude a assinatura e o `fetch`:

```js
	async content(path, { args, body, contentType = 'application/octet-stream', headers = {} } = {}) {
		return this.requestWithReauth(async (accessToken) => {
			const response = await fetch(`https://content.dropboxapi.com/2${path}`, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${accessToken}`,
					'Dropbox-API-Arg': JSON.stringify(args),
					...(contentType ? { 'Content-Type': contentType } : {}),
					...headers,
				},
				body,
				...(body ? { duplex: 'half' } : {}),
			});
```

E o download:

```js
	async getDownloadStream(fileRecord, options = {}) {
		const range = buildRangeHeader(options);
		const response = await this.content('/files/download', {
			args: {
				path: fileRecord.remote_file_id || joinDropboxPath(fileRecord.virtual_path, fileRecord.file_name),
			},
			body: null,
			contentType: '',
			...(range ? { headers: { Range: range } } : {}),
		});
```

O resto do método fica igual.

`OneDriveAdapter.js` — `requestGraph` já aceita `options.headers`:

```js
	async getDownloadStream(fileRecord, options = {}) {
		const range = buildRangeHeader(options);
		const response = await this.requestGraph(
			`https://graph.microsoft.com/v1.0/me/drive/items/${encodeURIComponent(fileRecord.remote_file_id)}/content`,
			range ? { headers: { Range: range } } : {},
		);
```

O resto fica igual.

`YandexAdapter.js`:

```js
	async getDownloadStream(fileRecord, options = {}) {
		const info = await this.request('/resources/download', {
			query: { path: this.resolvePath(fileRecord) },
		});
		if (!info?.href) {
			throw new Error('Yandex did not return a download URL');
		}

		const range = buildRangeHeader(options);
		const response = await fetch(info.href, range ? { headers: { Range: range } } : undefined);
		if (!response.ok || !response.body) {
			throw new Error('Failed to download file from Yandex Disk');
		}
		return Readable.fromWeb(response.body);
	}
```

Nos cinco adapters acima, importe `buildRangeHeader` do `BaseCloudAdapter.js` (todos já importam `BaseCloudAdapter` dele) e faça cada um declarar `supportsRange: true` no `getCapabilities()`.

`MegaAdapter.js` e `PCloudAdapter.js` **não** mudam — herdam `supportsRange: false` e ignoram `options`.

- [ ] **Step 4: Run test to verify it passes**

```bash
cd backend && node --test test/adapterRange.test.js
```

Expected: PASS, 5 testes.

Verifique também que nada quebrou:

```bash
cd backend && npm test
```

Expected: PASS em todos os arquivos.

- [ ] **Step 5: Commit**

```bash
git add backend/src/adapters backend/test/adapterRange.test.js
git commit -m "feat: support HTTP Range in cloud adapters"
```

---

### Task 3: Credenciais SMB por usuário

**Files:**
- Modify: `backend/src/config/database.js:80-84` (adicionar tabela após `app_settings`)
- Create: `backend/src/services/smbCredentialService.js`
- Test: `backend/test/smbCredentials.test.js`

**Interfaces:**
- Consumes: `encryptJson`/`decryptJson` de `backend/src/utils/crypto.js`.
- Produces:
  - `deriveSmbUsername(email: string, isTaken: (name: string) => boolean): string`
  - `setSmbCredentials(userId: string, password: string): { username: string, webdavToken: string }`
  - `getSmbCredential(userId: string): { userId, username, password, webdavToken } | null`
  - `findSmbCredentialByUsername(username: string): { userId, username, password, webdavToken } | null`
  - `listSmbCredentials(): Array<{ userId, username, password, webdavToken }>`
  - `deleteSmbCredentials(userId: string): void`
  - `verifyWebdavToken(username: string, token: string): { userId, username } | null`

- [ ] **Step 1: Write the failing test**

Create `backend/test/smbCredentials.test.js`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';

process.env.DATABASE_PATH = path.join(os.tmpdir(), `omnicloud-smb-test-${process.pid}.db`);

const {
	deriveSmbUsername,
	setSmbCredentials,
	getSmbCredential,
	findSmbCredentialByUsername,
	listSmbCredentials,
	deleteSmbCredentials,
	verifyWebdavToken,
} = await import('../src/services/smbCredentialService.js');
const { LOCAL_USER_ID } = await import('../src/config/database.js');

test('deriveSmbUsername sanitiza o email', () => {
	assert.equal(deriveSmbUsername('Ed.Cleubert+drive@gmail.com', () => false), 'ed.cleubert');
});

test('deriveSmbUsername resolve colisão com sufixo numérico', () => {
	const taken = new Set(['edson', 'edson2']);
	assert.equal(deriveSmbUsername('edson@x.com', (name) => taken.has(name)), 'edson3');
});

test('deriveSmbUsername usa fallback quando o email não sobra nada utilizável', () => {
	assert.equal(deriveSmbUsername('!!!@x.com', () => false), 'omnicloud');
});

test('setSmbCredentials grava e getSmbCredential devolve em claro', () => {
	const created = setSmbCredentials(LOCAL_USER_ID, 'senha-forte-123');
	assert.ok(created.username);
	assert.equal(created.webdavToken.length, 64);

	const stored = getSmbCredential(LOCAL_USER_ID);
	assert.equal(stored.password, 'senha-forte-123');
	assert.equal(stored.webdavToken, created.webdavToken);
	assert.equal(stored.username, created.username);
});

test('setSmbCredentials preserva username e rotaciona token ao redefinir a senha', () => {
	const first = getSmbCredential(LOCAL_USER_ID);
	const updated = setSmbCredentials(LOCAL_USER_ID, 'outra-senha-456');

	assert.equal(updated.username, first.username);
	assert.notEqual(updated.webdavToken, first.webdavToken);
	assert.equal(getSmbCredential(LOCAL_USER_ID).password, 'outra-senha-456');
});

test('findSmbCredentialByUsername encontra pelo nome do share', () => {
	const stored = getSmbCredential(LOCAL_USER_ID);
	const found = findSmbCredentialByUsername(stored.username);
	assert.equal(found.userId, LOCAL_USER_ID);
	assert.equal(findSmbCredentialByUsername('nao-existe'), null);
});

test('verifyWebdavToken aceita token correto e recusa errado', () => {
	const stored = getSmbCredential(LOCAL_USER_ID);
	assert.equal(verifyWebdavToken(stored.username, stored.webdavToken).userId, LOCAL_USER_ID);
	assert.equal(verifyWebdavToken(stored.username, 'token-errado'), null);
	assert.equal(verifyWebdavToken('nao-existe', stored.webdavToken), null);
});

test('listSmbCredentials devolve todas as credenciais em claro', () => {
	const all = listSmbCredentials();
	assert.equal(all.length, 1);
	assert.equal(all[0].userId, LOCAL_USER_ID);
	assert.equal(all[0].password, 'outra-senha-456');
});

test('deleteSmbCredentials remove o registro', () => {
	deleteSmbCredentials(LOCAL_USER_ID);
	assert.equal(getSmbCredential(LOCAL_USER_ID), null);
	assert.deepEqual(listSmbCredentials(), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd backend && node --test test/smbCredentials.test.js
```

Expected: FAIL — `Cannot find module '../src/services/smbCredentialService.js'`.

- [ ] **Step 3: Write minimal implementation**

Em `backend/src/config/database.js`, dentro do `db.exec(...)` que cria as tabelas, adicione após o bloco de `app_settings`:

```sql
  CREATE TABLE IF NOT EXISTS smb_credentials (
    user_id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_enc TEXT NOT NULL,
    webdav_token_enc TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );
```

Create `backend/src/services/smbCredentialService.js`:

```js
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
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd backend && node --test test/smbCredentials.test.js
```

Expected: PASS, 9 testes.

- [ ] **Step 5: Commit**

```bash
git add backend/src/config/database.js backend/src/services/smbCredentialService.js backend/test/smbCredentials.test.js
git commit -m "feat: store per-user SMB credentials encrypted at rest"
```

---

### Task 4: Rotas de API e endpoint interno de provisionamento

**Files:**
- Create: `backend/src/routes/smbRoutes.js`
- Create: `backend/src/routes/internalRoutes.js`
- Modify: `backend/src/config/env.js:17-44` (adicionar `smbProvisionSecret`, `smbHost`)
- Modify: `backend/src/app.js:39-46` (montar as rotas)

**Interfaces:**
- Consumes: `setSmbCredentials`, `getSmbCredential`, `deleteSmbCredentials`, `listSmbCredentials` da Task 3; `requireAppUser` de `middleware/authMiddleware.js`.
- Produces:
  - `GET /api/smb` → `{ data: { enabled: boolean, username: string|null, host: string, sharePath: string|null } }`
  - `PUT /api/smb` body `{ password: string }` → `{ data: { enabled: true, username, host, sharePath } }`
  - `DELETE /api/smb` → `200` com `{ data: { enabled: false, ... } }`
  - `GET /internal/smb/users` header `x-smb-provision-secret` → `{ data: [{ userId, username, password, webdavToken }] }`

- [ ] **Step 1: Write the failing test**

Create `backend/test/smbRoutes.test.js`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';

process.env.DATABASE_PATH = path.join(os.tmpdir(), `omnicloud-smbroutes-test-${process.pid}.db`);
process.env.SMB_PROVISION_SECRET = 'segredo-de-teste';
process.env.APP_MODE = 'local';

const { createApp } = await import('../src/app.js');

const app = createApp();
let server;
let baseUrl;

test.before(async () => {
	server = app.listen(0);
	await new Promise((resolve) => server.once('listening', resolve));
	baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server.close());

test('GET /api/smb devolve desabilitado antes de configurar', async () => {
	const response = await fetch(`${baseUrl}/api/smb`);
	const payload = await response.json();

	assert.equal(response.status, 200);
	assert.equal(payload.data.enabled, false);
	assert.equal(payload.data.username, null);
});

test('PUT /api/smb cria as credenciais', async () => {
	const response = await fetch(`${baseUrl}/api/smb`, {
		method: 'PUT',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ password: 'senha-forte-123' }),
	});
	const payload = await response.json();

	assert.equal(response.status, 200);
	assert.equal(payload.data.enabled, true);
	assert.ok(payload.data.username);
	assert.ok(payload.data.sharePath.includes(payload.data.username));
});

test('PUT /api/smb recusa senha curta', async () => {
	const response = await fetch(`${baseUrl}/api/smb`, {
		method: 'PUT',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ password: 'curta' }),
	});

	assert.equal(response.status, 400);
});

test('GET /api/smb nunca devolve a senha nem o token', async () => {
	const response = await fetch(`${baseUrl}/api/smb`);
	const body = await response.text();

	assert.doesNotMatch(body, /senha-forte-123/);
	assert.doesNotMatch(body, /webdavToken/);
});

test('GET /internal/smb/users exige o segredo', async () => {
	const semSegredo = await fetch(`${baseUrl}/internal/smb/users`);
	assert.equal(semSegredo.status, 401);

	const errado = await fetch(`${baseUrl}/internal/smb/users`, {
		headers: { 'x-smb-provision-secret': 'errado' },
	});
	assert.equal(errado.status, 401);
});

test('GET /internal/smb/users devolve credenciais em claro com o segredo', async () => {
	const response = await fetch(`${baseUrl}/internal/smb/users`, {
		headers: { 'x-smb-provision-secret': 'segredo-de-teste' },
	});
	const payload = await response.json();

	assert.equal(response.status, 200);
	assert.equal(payload.data.length, 1);
	assert.equal(payload.data[0].password, 'senha-forte-123');
	assert.ok(payload.data[0].webdavToken);
});

test('DELETE /api/smb remove as credenciais', async () => {
	const response = await fetch(`${baseUrl}/api/smb`, { method: 'DELETE' });
	const payload = await response.json();

	assert.equal(response.status, 200);
	assert.equal(payload.data.enabled, false);

	const after = await fetch(`${baseUrl}/api/smb`).then((res) => res.json());
	assert.equal(after.data.enabled, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd backend && node --test test/smbRoutes.test.js
```

Expected: FAIL — `GET /api/smb` responde 404.

- [ ] **Step 3: Write minimal implementation**

Em `backend/src/config/env.js`, dentro do objeto `env`, adicione:

```js
	smbProvisionSecret: process.env.SMB_PROVISION_SECRET || '',
	smbHost: process.env.SMB_HOST || 'omnicloud',
```

E em `redactEnv()`:

```js
		smbProvisionSecret: env.smbProvisionSecret ? '[configured]' : '[missing]',
		smbHost: env.smbHost,
```

Create `backend/src/routes/smbRoutes.js`:

```js
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
```

Create `backend/src/routes/internalRoutes.js`:

```js
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
```

Em `backend/src/app.js`, importe e monte:

```js
import smbRoutes from './routes/smbRoutes.js';
import internalRoutes from './routes/internalRoutes.js';
```

```js
	app.use('/api', allocationRoutes);
	app.use('/api', smbRoutes);
	app.use('/internal', internalRoutes);
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd backend && node --test test/smbRoutes.test.js
```

Expected: PASS, 7 testes.

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/smbRoutes.js backend/src/routes/internalRoutes.js backend/src/config/env.js backend/src/app.js backend/test/smbRoutes.test.js
git commit -m "feat: expose SMB credential API and internal provisioning endpoint"
```

---

### Task 5: Rotas WebDAV de leitura

`OPTIONS`, `PROPFIND`, `HEAD` e `GET`, com autenticação Basic.

**Files:**
- Create: `backend/src/routes/webdavRoutes.js`
- Modify: `backend/src/app.js` (montar `/webdav`)
- Modify: `backend/src/services/adapterRegistry.js:9-17` (registrar o provider `base`)
- Test: `backend/test/webdavRoutes.test.js`

**Interfaces:**
- Consumes: `parseRangeHeader`, `parseDavPath`, `buildPropfindXml`, `encodeDavHref` da Task 1; `getCapabilities().supportsRange` e `getDownloadStream(file, options)` da Task 2; `verifyWebdavToken` da Task 3.
- Produces: rotas em `/webdav/*`. `req.user` é preenchido pelo middleware Basic local a este router, não pelo `attachAuthContext`.

- [ ] **Step 1: Write the failing test**

Create `backend/test/webdavRoutes.test.js`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';

process.env.DATABASE_PATH = path.join(os.tmpdir(), `omnicloud-dav-test-${process.pid}.db`);
process.env.APP_MODE = 'local';

const { createApp } = await import('../src/app.js');
const { db, LOCAL_USER_ID } = await import('../src/config/database.js');
const { setSmbCredentials, getSmbCredential } = await import(
	'../src/services/smbCredentialService.js'
);

db.prepare(`
  INSERT INTO cloud_accounts (id, user_id, email, provider, encrypted_credentials, total_space, used_space, status)
  VALUES ('acc-1', ?, 'a@b.c', 'base', 'x', 1000, 0, 'active')
`).run(LOCAL_USER_ID);

db.prepare(`
  INSERT INTO file_metadata (id, user_id, virtual_path, file_name, is_folder, size, mime_type, cloud_account_id, remote_file_id, remote_modified_time)
  VALUES ('f-1', ?, '/', 'Fotos', 1, 0, NULL, 'acc-1', 'r-1', '2026-08-02T10:00:00.000Z')
`).run(LOCAL_USER_ID);

db.prepare(`
  INSERT INTO file_metadata (id, user_id, virtual_path, file_name, is_folder, size, mime_type, cloud_account_id, remote_file_id, remote_modified_time)
  VALUES ('f-2', ?, '/Fotos/', 'a.txt', 0, 12, 'text/plain', 'acc-1', 'r-2', '2026-08-02T11:00:00.000Z')
`).run(LOCAL_USER_ID);

setSmbCredentials(LOCAL_USER_ID, 'senha-forte-123');
const credential = getSmbCredential(LOCAL_USER_ID);
const auth = `Basic ${Buffer.from(`${credential.username}:${credential.webdavToken}`).toString('base64')}`;

const app = createApp();
let server;
let baseUrl;

test.before(async () => {
	server = app.listen(0);
	await new Promise((resolve) => server.once('listening', resolve));
	baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server.close());

test('WebDAV exige autenticação', async () => {
	const response = await fetch(`${baseUrl}/webdav/`, { method: 'PROPFIND' });
	assert.equal(response.status, 401);
	assert.match(response.headers.get('www-authenticate'), /^Basic/);
});

test('WebDAV recusa token errado', async () => {
	const response = await fetch(`${baseUrl}/webdav/`, {
		method: 'PROPFIND',
		headers: { Authorization: `Basic ${Buffer.from(`${credential.username}:errado`).toString('base64')}` },
	});
	assert.equal(response.status, 401);
});

test('OPTIONS anuncia DAV 1', async () => {
	const response = await fetch(`${baseUrl}/webdav/`, {
		method: 'OPTIONS',
		headers: { Authorization: auth },
	});

	assert.equal(response.status, 200);
	assert.equal(response.headers.get('dav'), '1');
	assert.match(response.headers.get('allow'), /PROPFIND/);
});

test('PROPFIND Depth 1 na raiz lista os filhos', async () => {
	const response = await fetch(`${baseUrl}/webdav/`, {
		method: 'PROPFIND',
		headers: { Authorization: auth, Depth: '1' },
	});
	const xml = await response.text();

	assert.equal(response.status, 207);
	assert.match(response.headers.get('content-type'), /application\/xml/);
	assert.match(xml, /<D:href>\/webdav\/<\/D:href>/);
	assert.match(xml, /<D:href>\/webdav\/Fotos\/<\/D:href>/);
});

test('PROPFIND Depth 0 devolve só o próprio recurso', async () => {
	const response = await fetch(`${baseUrl}/webdav/`, {
		method: 'PROPFIND',
		headers: { Authorization: auth, Depth: '0' },
	});
	const xml = await response.text();

	assert.equal(response.status, 207);
	assert.equal(xml.match(/<D:response>/g).length, 1);
});

test('PROPFIND em arquivo devolve tamanho', async () => {
	const response = await fetch(`${baseUrl}/webdav/Fotos/a.txt`, {
		method: 'PROPFIND',
		headers: { Authorization: auth, Depth: '0' },
	});
	const xml = await response.text();

	assert.equal(response.status, 207);
	assert.match(xml, /<D:getcontentlength>12<\/D:getcontentlength>/);
});

test('PROPFIND em caminho inexistente devolve 404', async () => {
	const response = await fetch(`${baseUrl}/webdav/nao-existe.txt`, {
		method: 'PROPFIND',
		headers: { Authorization: auth, Depth: '0' },
	});

	assert.equal(response.status, 404);
});

test('HEAD devolve tamanho sem corpo', async () => {
	const response = await fetch(`${baseUrl}/webdav/Fotos/a.txt`, {
		method: 'HEAD',
		headers: { Authorization: auth },
	});

	assert.equal(response.status, 200);
	assert.equal(response.headers.get('content-length'), '12');
	assert.equal(response.headers.get('accept-ranges'), 'bytes');
});

test('GET devolve o conteúdo do adapter', async () => {
	const response = await fetch(`${baseUrl}/webdav/Fotos/a.txt`, {
		headers: { Authorization: auth },
	});
	const body = await response.text();

	assert.equal(response.status, 200);
	assert.match(body, /Simulated download for a\.txt/);
});

test('GET com Range em adapter sem suporte devolve 200 inteiro', async () => {
	const response = await fetch(`${baseUrl}/webdav/Fotos/a.txt`, {
		headers: { Authorization: auth, Range: 'bytes=0-3' },
	});

	// O adapter base declara supportsRange: false, então a resposta é o corpo completo.
	assert.equal(response.status, 200);
	assert.equal(response.headers.get('content-range'), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd backend && node --test test/webdavRoutes.test.js
```

Expected: FAIL — `/webdav/` responde 404.

- [ ] **Step 3: Write minimal implementation**

Primeiro, em `backend/src/services/adapterRegistry.js`, registre o provider de simulação que os testes usam. `BaseCloudAdapter` já é inteiramente simulado (`getDownloadStream` devolve texto sintético), mas hoje `createAdapter` lança `Unsupported provider` para qualquer coisa fora do mapa. Adicione o import e a entrada:

```js
import { BaseCloudAdapter } from '../adapters/BaseCloudAdapter.js';
```

```js
const adapters = {
	google_drive: GoogleDriveAdapter,
	onedrive: OneDriveAdapter,
	dropbox: DropboxAdapter,
	mega: MegaAdapter,
	s3: S3Adapter,
	pcloud: PCloudAdapter,
	yandex: YandexAdapter,
	// Provider simulado: nenhuma rota de conexão de conta cria contas 'base',
	// então ele só aparece em testes.
	base: BaseCloudAdapter,
};
```

Create `backend/src/routes/webdavRoutes.js`:

```js
import { Router } from 'express';
import { listFilesByPath } from '../services/fileService.js';
import { getAccountById } from '../services/accountService.js';
import { createAdapter } from '../services/adapterRegistry.js';
import { verifyWebdavToken } from '../services/smbCredentialService.js';
import { parseRangeHeader, parseDavPath, buildPropfindXml, encodeDavHref } from '../services/webdav.js';

const BASE_PATH = '/webdav';

const router = Router();

// O único cliente é o rclone, que usa Basic Auth com o token dedicado — não a
// senha SMB e não o cookie de sessão do app.
function requireWebdavAuth(req, res, next) {
	const header = String(req.headers.authorization || '');
	if (!header.startsWith('Basic ')) {
		res.setHeader('WWW-Authenticate', 'Basic realm="OmniCloud"');
		return res.status(401).end();
	}

	const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
	const separator = decoded.indexOf(':');
	const identity = verifyWebdavToken(decoded.slice(0, separator), decoded.slice(separator + 1));

	if (!identity) {
		res.setHeader('WWW-Authenticate', 'Basic realm="OmniCloud"');
		return res.status(401).end();
	}

	req.webdavUserId = identity.userId;
	return next();
}

router.use(requireWebdavAuth);

// Resolve o recurso pedido. A raiz não tem registro no banco, então é sintética.
function resolveResource(userId, href) {
	const { parentPath, name } = parseDavPath(href, BASE_PATH);

	if (!name) {
		return { file: null, parentPath: '/', isRoot: true };
	}

	const file = listFilesByPath(userId, parentPath).find((item) => item.file_name === name);
	if (!file) return null;

	return { file, parentPath, isRoot: false };
}

function toEntry(file, parentPath) {
	return {
		href: encodeDavHref(BASE_PATH, parentPath, file.file_name, Boolean(file.is_folder)),
		isFolder: Boolean(file.is_folder),
		displayName: file.file_name,
		size: Number(file.size || 0),
		mimeType: file.mime_type,
		modifiedTime: file.modifiedTime || file.remote_modified_time,
	};
}

// O caminho do próprio recurso, usado como primeira entrada de todo PROPFIND.
function selfEntry(resource) {
	if (resource.isRoot) {
		return { href: `${BASE_PATH}/`, isFolder: true, displayName: 'OmniCloud', modifiedTime: null };
	}
	return toEntry(resource.file, resource.parentPath);
}

function childrenPath(resource) {
	if (resource.isRoot) return '/';
	return `${resource.parentPath === '/' ? '' : resource.parentPath.replace(/\/+$/, '')}/${resource.file.file_name}/`;
}

router.options('*splat', (_req, res) => {
	res.setHeader('DAV', '1');
	res.setHeader('Allow', 'OPTIONS, HEAD, GET, PUT, DELETE, MKCOL, MOVE, PROPFIND');
	res.setHeader('MS-Author-Via', 'DAV');
	res.status(200).end();
});

router.propfind('*splat', (req, res, next) => {
	try {
		const resource = resolveResource(req.webdavUserId, req.path);
		if (!resource) return res.status(404).end();

		const entries = [selfEntry(resource)];
		const depth = String(req.headers.depth ?? '1');
		const isCollection = resource.isRoot || Boolean(resource.file.is_folder);

		if (depth !== '0' && isCollection) {
			const path = childrenPath(resource);
			listFilesByPath(req.webdavUserId, path).forEach((child) => entries.push(toEntry(child, path)));
		}

		res.status(207);
		res.setHeader('Content-Type', 'application/xml; charset=utf-8');
		return res.end(buildPropfindXml(entries));
	} catch (error) {
		return next(error);
	}
});

async function sendFile(req, res, { bodyless }) {
	const resource = resolveResource(req.webdavUserId, req.path);
	if (!resource || resource.isRoot || resource.file.is_folder) {
		return res.status(404).end();
	}

	const { file } = resource;
	const size = Number(file.size || 0);
	res.setHeader('Accept-Ranges', 'bytes');
	res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');

	if (bodyless) {
		res.setHeader('Content-Length', String(size));
		return res.status(200).end();
	}

	const account = getAccountById(req.webdavUserId, file.cloud_account_id);
	if (!account || account.status !== 'active') {
		return res.status(503).end();
	}

	const adapter = createAdapter(account);
	const range = adapter.getCapabilities?.().supportsRange
		? parseRangeHeader(req.headers.range, size)
		: null;

	const stream = await adapter.getDownloadStream(file, range || {});

	if (range) {
		res.status(206);
		res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
		res.setHeader('Content-Length', String(range.end - range.start + 1));
	} else {
		res.status(200);
		if (size) res.setHeader('Content-Length', String(size));
	}

	stream.on('error', () => res.destroy());
	return stream.pipe(res);
}

router.head('*splat', async (req, res, next) => {
	try {
		await sendFile(req, res, { bodyless: true });
	} catch (error) {
		next(error);
	}
});

router.get('*splat', async (req, res, next) => {
	try {
		await sendFile(req, res, { bodyless: false });
	} catch (error) {
		next(error);
	}
});

export default router;
```

Em `backend/src/app.js`, importe e monte **antes** do `app.use(express.json())` para que o body de `PUT` chegue como stream à Task 6:

```js
import webdavRoutes from './routes/webdavRoutes.js';
```

```js
	app.use('/webdav', webdavRoutes);
	app.use(express.json());
	app.use(attachAuthContext);
```

Express 5 não registra `propfind` como método por padrão — mas `router.propfind` existe porque o Express deriva os métodos de `node:http.METHODS`, que inclui `PROPFIND`, `MKCOL`, `MOVE` e `COPY`. Se `router.propfind` for `undefined` no seu ambiente, troque por `router.use((req, res, next) => req.method === 'PROPFIND' ? handler(req, res, next) : next())`.

- [ ] **Step 4: Run test to verify it passes**

```bash
cd backend && node --test test/webdavRoutes.test.js
```

Expected: PASS, 10 testes.

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/webdavRoutes.js backend/src/app.js backend/src/services/adapterRegistry.js backend/test/webdavRoutes.test.js
git commit -m "feat: add read-only WebDAV endpoints backed by the virtual tree"
```

---

### Task 6: Rotas WebDAV de escrita

`PUT`, `MKCOL`, `DELETE`, `MOVE`, e `COPY` respondendo `501`.

**Files:**
- Modify: `backend/src/routes/webdavRoutes.js` (adicionar handlers)
- Modify: `backend/src/services/uploadService.js:26` (exportar `runUpload`)
- Modify: `backend/src/services/fileService.js` (adicionar `deleteFileMetadata`)
- Modify: `backend/src/app.js` (mover o mount de `/webdav` para antes do `cors()`)
- Modify: `backend/test/webdavRoutes.test.js:103-111` (corrigir o teste de OPTIONS)
- Test: `backend/test/webdavWrite.test.js`

**Correção do OPTIONS (feita nesta task).** Hoje `app.js` monta `/webdav` depois do
`cors()`. O middleware `cors()` responde qualquer `OPTIONS` com um 204 de preflight, então
o `router.options` de `webdavRoutes.js:75-80` nunca executa e o WebDAV nunca anuncia
`DAV: 1`. Mova a linha `app.use('/webdav', webdavRoutes);` para **antes** do `app.use(cors(...))`
— o WebDAV não é consumido por browser, então CORS não se aplica a ele. Depois troque o
teste `'OPTIONS recebe a resposta CORS global'` em `backend/test/webdavRoutes.test.js`
por:

```js
test('OPTIONS anuncia DAV 1', async () => {
	const response = await fetch(`${baseUrl}/webdav/`, {
		method: 'OPTIONS',
		headers: { Authorization: auth },
	});

	assert.equal(response.status, 200);
	assert.equal(response.headers.get('dav'), '1');
	assert.match(response.headers.get('allow'), /PROPFIND/);
});
```

**Interfaces:**
- Consumes: tudo da Task 5; `createUploadSession` de `uploadSessionService.js`; `selectBestAccount` de `spaceAllocator.js`; `syncAccount` de `syncService.js`.
- Produces:
  - `runUpload({ session, stream, fileName, mimeType })` passa a ser exportado de `uploadService.js`.
  - `deleteFileMetadata(userId: string, id: string): void` exportado de `fileService.js`.

- [ ] **Step 1: Write the failing test**

Create `backend/test/webdavWrite.test.js`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';

process.env.DATABASE_PATH = path.join(os.tmpdir(), `omnicloud-davwrite-test-${process.pid}.db`);
process.env.APP_MODE = 'local';

const { createApp } = await import('../src/app.js');
const { db, LOCAL_USER_ID } = await import('../src/config/database.js');
const { setSmbCredentials, getSmbCredential } = await import(
	'../src/services/smbCredentialService.js'
);
const { listFilesByPath } = await import('../src/services/fileService.js');

db.prepare(`
  INSERT INTO cloud_accounts (id, user_id, email, provider, encrypted_credentials, total_space, used_space, status)
  VALUES ('acc-1', ?, 'a@b.c', 'base', 'x', 1000000, 0, 'active')
`).run(LOCAL_USER_ID);

db.prepare(`
  INSERT INTO file_metadata (id, user_id, virtual_path, file_name, is_folder, size, mime_type, cloud_account_id, remote_file_id)
  VALUES ('f-1', ?, '/', 'antigo.txt', 0, 5, 'text/plain', 'acc-1', 'r-1')
`).run(LOCAL_USER_ID);

setSmbCredentials(LOCAL_USER_ID, 'senha-forte-123');
const credential = getSmbCredential(LOCAL_USER_ID);
const auth = `Basic ${Buffer.from(`${credential.username}:${credential.webdavToken}`).toString('base64')}`;

const app = createApp();
let server;
let baseUrl;

test.before(async () => {
	server = app.listen(0);
	await new Promise((resolve) => server.once('listening', resolve));
	baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server.close());

test('MKCOL cria pasta na árvore virtual', async () => {
	const response = await fetch(`${baseUrl}/webdav/NovaPasta`, {
		method: 'MKCOL',
		headers: { Authorization: auth },
	});

	assert.equal(response.status, 201);
	const created = listFilesByPath(LOCAL_USER_ID, '/').find((item) => item.file_name === 'NovaPasta');
	assert.ok(created);
	assert.equal(created.is_folder, 1);
});

test('MKCOL em pasta existente devolve 405', async () => {
	const response = await fetch(`${baseUrl}/webdav/NovaPasta`, {
		method: 'MKCOL',
		headers: { Authorization: auth },
	});

	assert.equal(response.status, 405);
});

test('PUT cria arquivo novo', async () => {
	const response = await fetch(`${baseUrl}/webdav/novo.txt`, {
		method: 'PUT',
		headers: { Authorization: auth, 'Content-Length': '11', 'Content-Type': 'text/plain' },
		body: 'ola do smb!',
	});

	assert.equal(response.status, 201);
	const created = listFilesByPath(LOCAL_USER_ID, '/').find((item) => item.file_name === 'novo.txt');
	assert.ok(created);
	assert.equal(Number(created.size), 11);
});

test('PUT sobre arquivo existente devolve 204', async () => {
	const response = await fetch(`${baseUrl}/webdav/novo.txt`, {
		method: 'PUT',
		headers: { Authorization: auth, 'Content-Length': '3', 'Content-Type': 'text/plain' },
		body: 'abc',
	});

	assert.equal(response.status, 204);
	const files = listFilesByPath(LOCAL_USER_ID, '/').filter((item) => item.file_name === 'novo.txt');
	assert.equal(files.length, 1, 'não pode duplicar o registro ao sobrescrever');
});

test('MOVE renomeia dentro da mesma pasta', async () => {
	const response = await fetch(`${baseUrl}/webdav/antigo.txt`, {
		method: 'MOVE',
		headers: { Authorization: auth, Destination: `${baseUrl}/webdav/renomeado.txt` },
	});

	assert.equal(response.status, 204);
	const names = listFilesByPath(LOCAL_USER_ID, '/').map((item) => item.file_name);
	assert.ok(names.includes('renomeado.txt'));
	assert.ok(!names.includes('antigo.txt'));
});

test('MOVE entre pastas diferentes devolve 502', async () => {
	const response = await fetch(`${baseUrl}/webdav/renomeado.txt`, {
		method: 'MOVE',
		headers: { Authorization: auth, Destination: `${baseUrl}/webdav/NovaPasta/renomeado.txt` },
	});

	assert.equal(response.status, 502);
});

test('DELETE remove o arquivo', async () => {
	const response = await fetch(`${baseUrl}/webdav/renomeado.txt`, {
		method: 'DELETE',
		headers: { Authorization: auth },
	});

	assert.equal(response.status, 204);
	const names = listFilesByPath(LOCAL_USER_ID, '/').map((item) => item.file_name);
	assert.ok(!names.includes('renomeado.txt'));
});

test('COPY responde 501 para o rclone cair no fallback', async () => {
	const response = await fetch(`${baseUrl}/webdav/novo.txt`, {
		method: 'COPY',
		headers: { Authorization: auth, Destination: `${baseUrl}/webdav/copia.txt` },
	});

	assert.equal(response.status, 501);
});

test('DELETE em caminho inexistente devolve 404', async () => {
	const response = await fetch(`${baseUrl}/webdav/fantasma.txt`, {
		method: 'DELETE',
		headers: { Authorization: auth },
	});

	assert.equal(response.status, 404);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd backend && node --test test/webdavWrite.test.js
```

Expected: FAIL — `MKCOL` responde 404.

- [ ] **Step 3: Write minimal implementation**

Em `backend/src/services/uploadService.js`, troque `async function runUpload(` por `export async function runUpload(`.

Em `backend/src/services/fileService.js`, adicione:

```js
export function deleteFileMetadata(userId, id) {
	db.prepare('DELETE FROM file_metadata WHERE user_id = ? AND id = ?').run(userId, id);
}
```

Em `backend/src/routes/webdavRoutes.js`, adicione os imports:

```js
import { listFilesByPath, deleteFileMetadata, createFileMetadata } from '../services/fileService.js';
import { selectBestAccount } from '../services/spaceAllocator.js';
import { createUploadSession } from '../services/uploadSessionService.js';
import { runUpload } from '../services/uploadService.js';
import { syncAccount } from '../services/syncService.js';
import { fileCacheService } from '../services/fileCacheService.js';
```

`runUpload` já captura o stream no cache local (`captureUpload`/`commitCapture`) e já chama
`syncAccount` ao final, então o `PUT` herda cache e reconciliação de graça. `DELETE` e
`MOVE` chamam `syncAccount` explicitamente, e `syncService` faz `reconcileAccount`/`rebind`
no cache — por isso só o caminho de sobrescrita precisa de `invalidate` manual.

E os handlers, depois do `router.get`:

```js
// O rclone manda o Destination como URL absoluta.
function parseDestination(header) {
	const raw = String(header || '');
	if (!raw) return null;
	const pathname = raw.startsWith('http') ? new URL(raw).pathname : raw;
	return parseDavPath(pathname, BASE_PATH);
}

router.mkcol('*splat', async (req, res, next) => {
	try {
		const { parentPath, name } = parseDavPath(req.path, BASE_PATH);
		if (!name) return res.status(405).end();

		const existing = listFilesByPath(req.webdavUserId, parentPath).find((item) => item.file_name === name);
		if (existing) return res.status(405).end();

		const parent = resolveResource(req.webdavUserId, req.path.replace(/\/[^/]+\/?$/, '') || BASE_PATH);
		const allocation = selectBestAccount(req.webdavUserId, 0);
		const adapter = createAdapter(allocation.selected);

		const folder = await adapter.createFolder({
			name,
			virtualPath: parentPath,
			remoteParentId: parent?.file?.remote_file_id || null,
		});

		createFileMetadata({
			user_id: req.webdavUserId,
			virtual_path: parentPath,
			file_name: name,
			is_folder: true,
			size: 0,
			mime_type: null,
			cloud_account_id: allocation.selected.id,
			remote_file_id: folder.remoteFileId,
			remote_parent_id: folder.remoteParentId,
		});

		return res.status(201).end();
	} catch (error) {
		return next(error);
	}
});

router.put('*splat', async (req, res, next) => {
	try {
		const { parentPath, name } = parseDavPath(req.path, BASE_PATH);
		if (!name) return res.status(405).end();

		const existing = listFilesByPath(req.webdavUserId, parentPath).find((item) => item.file_name === name);
		if (existing?.is_folder) return res.status(405).end();

		// ponytail: sobrescrever é delete + upload — os adapters não têm "trocar
		// conteúdo". Perde histórico de versões do provider. Upgrade quando algum
		// adapter expuser update de conteúdo.
		if (existing) {
			const account = getAccountById(req.webdavUserId, existing.cloud_account_id);
			if (account) await createAdapter(account).deleteFile(existing);
			// Invalida antes do upload: sem isso o cache continua servindo os bytes
			// antigos na janela entre o delete e o syncAccount que runUpload dispara.
			fileCacheService.invalidate(existing);
			deleteFileMetadata(req.webdavUserId, existing.id);
		}

		const size = Number(req.headers['content-length'] || 0);
		const allocation = selectBestAccount(req.webdavUserId, size);
		const session = createUploadSession({
			user_id: req.webdavUserId,
			file_name: name,
			size,
			mime_type: req.headers['content-type'] || 'application/octet-stream',
			virtual_path: parentPath,
			remote_parent_id: null,
			cloud_account_id: allocation.selected.id,
			fallback_chain: allocation.fallbackChain.map((account) => account.id),
		});

		await runUpload({
			session,
			stream: req,
			fileName: name,
			mimeType: req.headers['content-type'] || 'application/octet-stream',
		});

		return res.status(existing ? 204 : 201).end();
	} catch (error) {
		if (/space|quota/i.test(error?.message || '')) return res.status(507).end();
		return next(error);
	}
});

router.delete('*splat', async (req, res, next) => {
	try {
		const resource = resolveResource(req.webdavUserId, req.path);
		if (!resource || resource.isRoot) return res.status(404).end();

		const account = getAccountById(req.webdavUserId, resource.file.cloud_account_id);
		if (!account || account.status !== 'active') return res.status(503).end();

		await createAdapter(account).deleteFile(resource.file);
		deleteFileMetadata(req.webdavUserId, resource.file.id);
		await syncAccount(req.webdavUserId, account);

		return res.status(204).end();
	} catch (error) {
		return next(error);
	}
});

router.move('*splat', async (req, res, next) => {
	try {
		const resource = resolveResource(req.webdavUserId, req.path);
		if (!resource || resource.isRoot) return res.status(404).end();

		const destination = parseDestination(req.headers.destination);
		if (!destination?.name) return res.status(400).end();

		// Mover entre pastas exige mover entre providers no caso geral, e os
		// adapters só sabem renomear no lugar.
		if (destination.parentPath !== resource.parentPath) {
			return res.status(502).end();
		}

		const account = getAccountById(req.webdavUserId, resource.file.cloud_account_id);
		if (!account || account.status !== 'active') return res.status(503).end();

		await createAdapter(account).renameFile(resource.file, destination.name);
		await syncAccount(req.webdavUserId, account);

		return res.status(204).end();
	} catch (error) {
		return next(error);
	}
});

// O rclone cai sozinho no fallback GET + PUT quando COPY não existe.
router.copy('*splat', (_req, res) => res.status(501).end());
```

O `syncAccount` no `DELETE` e no `MOVE` mantém o mirror alinhado com o provider, como já faz `deleteContextFile` em `fileRoutes.js`.

- [ ] **Step 4: Run test to verify it passes**

```bash
cd backend && node --test test/webdavWrite.test.js
```

Expected: PASS, 9 testes.

Rode a suíte inteira:

```bash
cd backend && npm test
```

Expected: PASS em todos os arquivos.

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/webdavRoutes.js backend/src/services/uploadService.js backend/src/services/fileService.js backend/test/webdavWrite.test.js
git commit -m "feat: add WebDAV write operations mapped onto cloud adapters"
```

---

### Task 7: Tela de acesso SMB no frontend

**Files:**
- Modify: `frontend/src/services/api.js` (métodos de SMB)
- Modify: `frontend/src/views/SettingsView.vue` (seção nova)
- Modify: `frontend/src/locales/en.json`, `frontend/src/locales/id.json`

**Interfaces:**
- Consumes: `GET/PUT/DELETE /api/smb` da Task 4.
- Produces: nada consumido por tarefas seguintes.

- [ ] **Step 1: Adicionar os métodos de API**

`frontend/src/services/api.js` expõe objetos de namespace (`settingsApi`, `authApi`) e reexporta os métodos no objeto `api`. Siga esse padrão exatamente.

Adicione o namespace novo logo após o fechamento de `settingsApi` (linha ~67):

```js
export const smbApi = {
	get() {
		return request('/smb');
	},
	update(password) {
		return request('/smb', {
			method: 'PUT',
			body: JSON.stringify({ password }),
		});
	},
	disable() {
		return request('/smb', { method: 'DELETE' });
	},
};
```

E dentro do objeto `api`, junto dos reexports de settings (linha ~255):

```js
	getSmbAccess() {
		return smbApi.get();
	},
	updateSmbAccess(password) {
		return smbApi.update(password);
	},
	disableSmbAccess() {
		return smbApi.disable();
	},
```

- [ ] **Step 2: Adicionar as chaves de tradução**

Em `frontend/src/locales/en.json`, dentro do objeto `settings` (as chaves finais precisam resolver como `settings.smb.*`, que é como o template as consome):

```json
"smb": {
  "title": "SMB access",
  "description": "Mount your OmniCloud drive natively on Linux, macOS, iOS and Windows.",
  "password": "SMB password",
  "passwordHint": "At least 8 characters. This is separate from your account password.",
  "enable": "Enable SMB access",
  "update": "Update password",
  "disable": "Disable",
  "enabled": "SMB access is enabled",
  "username": "Username",
  "sharePath": "Share path",
  "howToMount": "How to mount",
  "macos": "Finder → Go → Connect to Server",
  "windows": "Explorer → Map network drive",
  "ios": "Files → Browse → Connect to Server",
  "linux": "mount -t cifs //<host>/<share> /mnt/point -o user=<username>"
}
```

Traduza as mesmas chaves em `frontend/src/locales/id.json`.

- [ ] **Step 3: Adicionar a seção em SettingsView.vue**

No `<script setup>`, adicione `IconServer` ao import de `@tabler/icons-vue` (a linha que já traz `IconMoon, IconSun, ...`), e depois de `const registrationLoading = ref(false);`:

```js
const smb = ref({ enabled: false, username: null, host: '', sharePath: null });
const smbPassword = ref('');
const smbLoading = ref(false);
const smbError = ref('');

async function saveSmbPassword() {
	if (smbPassword.value.length < 8) {
		smbError.value = t('settings.smb.passwordHint');
		return;
	}

	smbError.value = '';
	smbLoading.value = true;
	try {
		const { data } = await api.updateSmbAccess(smbPassword.value);
		smb.value = data;
		smbPassword.value = '';
	} catch (error) {
		smbError.value = error.message;
	} finally {
		smbLoading.value = false;
	}
}

async function disableSmb() {
	smbLoading.value = true;
	try {
		const { data } = await api.disableSmbAccess();
		smb.value = data;
	} finally {
		smbLoading.value = false;
	}
}
```

No `onMounted`, depois do bloco `if (isHosted.value) { ... }`, acrescente:

```js
	const { data: smbData } = await api.getSmbAccess();
	smb.value = smbData;
```

No template, adicione esta seção entre a seção de contas integradas (`quota.integratedAccounts`) e a de `isHosted` / `settings.newAccounts`:

```html
				<section class="rounded-2xl border border-[#e7edf6] bg-[#f8fafd] p-5 dark:border-slate-800 dark:bg-slate-800/70">
					<h2 class="flex items-center gap-2 text-sm font-semibold text-[#202124] dark:text-slate-100">
						<IconServer :size="18" :stroke="1.8" />
						{{ t('settings.smb.title') }}
					</h2>
					<p class="mt-1 text-xs text-[#5f6368] dark:text-slate-400">{{ t('settings.smb.description') }}</p>

					<div v-if="smb.enabled" class="mt-3 space-y-1 rounded-2xl border border-[#e7edf6] bg-white p-3 text-sm dark:border-slate-700 dark:bg-slate-900/80">
						<p class="text-[#202124] dark:text-slate-100">{{ t('settings.smb.username') }}: <span class="font-mono">{{ smb.username }}</span></p>
						<p class="text-[#202124] dark:text-slate-100">{{ t('settings.smb.sharePath') }}: <span class="font-mono">{{ smb.sharePath }}</span></p>
					</div>

					<div class="mt-3 flex flex-col gap-2 sm:flex-row">
						<input v-model="smbPassword" type="password" autocomplete="new-password" :placeholder="t('settings.smb.password')" class="flex-1 rounded-2xl border border-[#e7edf6] bg-white px-4 py-2 text-sm text-[#202124] outline-none focus:border-[#1a73e8] dark:border-slate-700 dark:bg-slate-900/80 dark:text-slate-100" />
						<button type="button" :disabled="smbLoading" class="rounded-full bg-[#1a73e8] px-4 py-2 text-sm font-semibold text-white transition disabled:opacity-60" @click="saveSmbPassword">
							{{ smb.enabled ? t('settings.smb.update') : t('settings.smb.enable') }}
						</button>
						<button v-if="smb.enabled" type="button" :disabled="smbLoading" class="rounded-full bg-[#fce8e6] px-4 py-2 text-sm font-semibold text-[#c5221f] transition disabled:opacity-60 dark:bg-red-950/40 dark:text-red-300" @click="disableSmb">
							{{ t('settings.smb.disable') }}
						</button>
					</div>

					<p v-if="smbError" class="mt-2 text-xs text-[#c5221f] dark:text-red-300">{{ smbError }}</p>
					<p v-else class="mt-2 text-xs text-[#5f6368] dark:text-slate-400">{{ t('settings.smb.passwordHint') }}</p>

					<div v-if="smb.enabled" class="mt-4 space-y-1 text-xs text-[#5f6368] dark:text-slate-400">
						<p class="font-semibold text-[#202124] dark:text-slate-100">{{ t('settings.smb.howToMount') }}</p>
						<p>macOS — {{ t('settings.smb.macos') }}</p>
						<p>Windows — {{ t('settings.smb.windows') }}</p>
						<p>iOS — {{ t('settings.smb.ios') }}</p>
						<p>Linux — <span class="font-mono">{{ t('settings.smb.linux') }}</span></p>
					</div>
				</section>
```

A senha e o token nunca aparecem: `GET /api/smb` não os devolve, e o campo de input é sempre limpo após salvar.

- [ ] **Step 4: Verificar no navegador**

```bash
cd frontend && npm run dev
```

Abra Settings, defina uma senha SMB, confirme que `username` e `sharePath` aparecem, recarregue a página e confirme que o estado persiste. Desative e confirme que volta ao estado inicial.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/services/api.js frontend/src/views/SettingsView.vue frontend/src/locales
git commit -m "feat: add SMB access section to settings"
```

---

### Task 8: Container Samba com provisionador

**Files:**
- Create: `smb/Dockerfile`
- Create: `smb/provisioner.js`
- Create: `smb/smb.conf.base`
- Create: `smb/entrypoint.sh`

**Interfaces:**
- Consumes: `GET /internal/smb/users` da Task 4; `/webdav` das Tasks 5 e 6.
- Produces: imagem de container que expõe a porta 445.

- [ ] **Step 1: Criar a configuração base do Samba**

Create `smb/smb.conf.base`:

```ini
[global]
   workgroup = WORKGROUP
   server string = OmniCloud
   security = user
   map to guest = never
   server min protocol = SMB2_10
   server signing = auto
   load printers = no
   printing = bsd
   printcap name = /dev/null
   disable spoolss = yes
   log level = 1
   log file = /var/log/samba/log.%m
   max log size = 1000

   # Os shares por usuário são acrescentados abaixo pelo provisionador.
```

- [ ] **Step 2: Criar o Dockerfile**

Create `smb/Dockerfile`:

```dockerfile
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends samba samba-common-bin rclone fuse3 procps ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# O rclone precisa que outros usuários enxerguem o mount para o smbd servir os arquivos.
RUN echo "user_allow_other" >> /etc/fuse.conf

WORKDIR /app
COPY smb/provisioner.js ./provisioner.js
COPY smb/smb.conf.base ./smb.conf.base
COPY smb/entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

RUN mkdir -p /mnt/omnicloud /var/cache/rclone /var/log/samba

EXPOSE 445
CMD ["./entrypoint.sh"]
```

- [ ] **Step 3: Criar o entrypoint**

Create `smb/entrypoint.sh`:

```sh
#!/bin/sh
set -e

cp /app/smb.conf.base /etc/samba/smb.conf

# smbd em foreground como processo filho; o provisionador recarrega a config
# via smbcontrol conforme os usuários mudam.
smbd --foreground --no-process-group --debug-stdout &
SMBD_PID=$!

node /app/provisioner.js &
PROVISIONER_PID=$!

trap 'kill $SMBD_PID $PROVISIONER_PID 2>/dev/null; exit 0' TERM INT

wait -n $SMBD_PID $PROVISIONER_PID
```

- [ ] **Step 4: Criar o provisionador**

Create `smb/provisioner.js`:

```js
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

const mounted = new Set();

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

	mounted.add(user.userId);
	console.log(`mounted ${target}`);
}

async function removeMount(userId) {
	const target = `${MOUNT_ROOT}/${userId}`;
	if (!existsSync(target)) return;

	await run('fusermount3', ['-u', target]).catch(() => {});
	mounted.delete(userId);
	console.log(`unmounted ${target}`);
}

async function reconcile() {
	const users = await fetchUsers();
	const activeIds = new Set(users.map((user) => user.userId));

	writeRcloneConf(users);

	for (const user of users) {
		await ensureSystemUser(user.username);
		await setSambaPassword(user.username, user.password);
		await ensureMount(user);
	}

	for (const userId of [...mounted]) {
		if (!activeIds.has(userId)) await removeMount(userId);
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
```

- [ ] **Step 5: Verificar que a imagem constrói**

```bash
docker build -f smb/Dockerfile -t omnicloud-smb:test .
```

Expected: build sem erro. Confirme que as ferramentas estão presentes:

```bash
docker run --rm omnicloud-smb:test sh -c "rclone version && smbd --version && node --version"
```

Expected: as três versões impressas.

- [ ] **Step 6: Commit**

```bash
git add smb/
git commit -m "feat: add Samba container with rclone-backed per-user provisioning"
```

---

### Task 9: Integração no compose e documentação

**Files:**
- Modify: `docker-compose.yml`
- Modify: `.dockerignore` (não excluir `smb/`)
- Modify: `README.md`

**Interfaces:**
- Consumes: a imagem da Task 8 e as variáveis de ambiente da Task 4.
- Produces: stack completa executável.

- [ ] **Step 1: Adicionar o serviço ao compose**

Em `docker-compose.yml`, adicione ao serviço `api`, no bloco `environment`:

```yaml
      SMB_PROVISION_SECRET: ${SMB_PROVISION_SECRET:?defina SMB_PROVISION_SECRET no .env}
      SMB_HOST: ${SMB_HOST:-omnicloud}
```

E o serviço novo, antes do bloco `volumes:`:

```yaml
  smb:
    build:
      context: .
      dockerfile: smb/Dockerfile
    # FUSE precisa destas três permissões; é uma elevação real em relação aos
    # outros containers da stack.
    cap_add:
      - SYS_ADMIN
    devices:
      - /dev/fuse
    security_opt:
      - apparmor:unconfined
    environment:
      OMNICLOUD_API_URL: http://api:8787
      SMB_PROVISION_SECRET: ${SMB_PROVISION_SECRET:?defina SMB_PROVISION_SECRET no .env}
      RCLONE_VFS_CACHE_MAX_SIZE: ${RCLONE_VFS_CACHE_MAX_SIZE:-20G}
    volumes:
      - omnicloud_rclone_cache:/var/cache/rclone
    ports:
      - "445:445"
    depends_on:
      - api
    restart: unless-stopped
```

E o volume novo:

```yaml
volumes:
  omnicloud_api_data:
  omnicloud_rclone_cache:
```

- [ ] **Step 2: Verificar o .dockerignore**

```bash
cat .dockerignore
```

Se houver alguma regra que exclua `smb/`, remova-a — o build da Task 8 copia daquele diretório.

- [ ] **Step 3: Subir a stack e verificar**

```bash
docker compose up -d --build
```

Verifique que o provisionador está reconciliando:

```bash
docker compose logs -f smb
```

Expected: sem `reconcile failed`. Depois de configurar uma senha SMB em Settings, deve aparecer `mounted /mnt/omnicloud/<userId>`.

Confirme que o mount tem conteúdo:

```bash
docker compose exec smb ls -la /mnt/omnicloud
```

Confirme que o Samba lista o share:

```bash
docker compose exec smb smbclient -L localhost -U <username>
```

Expected: `omnicloud-<username>` na lista de shares.

- [ ] **Step 4: Montar de um cliente real**

macOS: Finder → Ir → Conectar ao Servidor → `smb://<host>/omnicloud-<username>`.
Windows: Explorador → Mapear unidade de rede → `\\<host>\omnicloud-<username>`.
iOS: Arquivos → Procurar → Conectar ao Servidor → `smb://<host>`.
Linux:

```bash
sudo mount -t cifs //<host>/omnicloud-<username> /mnt/omnicloud -o user=<username>,vers=3.0
```

Em cada um: listar pastas, abrir um arquivo, criar uma pasta, copiar um arquivo para dentro, renomear e apagar.

Se a porta 445 já estiver ocupada pelo Samba nativo do ZimaOS, o `docker compose up` falha com `address already in use`. Nesse caso, dê ao container uma rede `macvlan` com IP próprio na LAN e remova o bloco `ports:`:

```yaml
networks:
  lan:
    driver: macvlan
    driver_opts:
      parent: eth0
    ipam:
      config:
        - subnet: 192.168.1.0/24
          gateway: 192.168.1.1
```

Ajuste `parent`, `subnet` e `gateway` para a rede real do host, e adicione `networks: [lan, default]` ao serviço `smb`.

- [ ] **Step 5: Documentar no README**

Adicione uma seção "SMB access" ao `README.md`, após a seção de providers, cobrindo: para que serve, como habilitar em Settings, os quatro comandos de montagem por sistema operacional, as variáveis de ambiente novas (`SMB_PROVISION_SECRET`, `SMB_HOST`, `RCLONE_VFS_CACHE_MAX_SIZE`), e as limitações conhecidas do spec — sobrescrever perde histórico de versões, mover entre pastas não é suportado, um processo rclone por usuário.

- [ ] **Step 6: Commit**

```bash
git add docker-compose.yml .dockerignore README.md
git commit -m "feat: wire SMB container into compose and document mounting"
```

---

## Verificação final

```bash
cd backend && npm test
```

Expected: PASS em `uploadChunks`, `webdav`, `adapterRange`, `smbCredentials`, `smbRoutes`, `webdavRoutes` e `webdavWrite`.

Depois, o roteiro manual da Task 9 Step 4 nos quatro sistemas operacionais.
