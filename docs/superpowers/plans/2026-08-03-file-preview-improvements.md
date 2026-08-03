# File Preview Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fazer a previsualização suportar Office e áudio, permitir seek em vídeo, cachear no navegador, e dar ao modal teclado, navegação, zoom, download e estado de erro.

**Architecture:** O backend ganha uma classificação única de `previewKind` sobre o mime efetivo (após `googleDocsExport`), converte Office → PDF com o LibreOffice que já existe no container, e serve tudo pela rota `/files/:id/preview` com `Range`/206/`ETag`/304. O frontend espelha a classificação em `getPreviewType`, e o modal renderiza cada tipo com o elemento nativo correspondente.

**Tech Stack:** Node 22 + Express 5 (backend, testes com `node --test`), Vue 3 + Vite + vue-i18n (frontend, testes com `node --test` sobre módulos JS puros), LibreOffice/ffmpeg/pdftoppm já presentes na imagem.

## Global Constraints

- Nenhuma dependência npm nova, backend ou frontend.
- Testes com `node --test`, no padrão já existente (`backend/test/*.test.js`, `frontend/test/*.test.js`). Sem framework adicional, sem mock de DOM.
- Indentação com TAB, aspas simples, ponto e vírgula — como o restante do repositório.
- Comentários no código em português, sem acentos (padrão dos comentários existentes, ex.: `fileCacheService.js:51`).
- Mensagens de erro de API em inglês (padrão das rotas existentes).
- Strings de UI sempre via `t(...)`, com a chave adicionada em `frontend/src/locales/en.json` **e** `frontend/src/locales/id.json`.
- Limites da conversão Office: 100 MB (`DEFAULT_MAX_BYTES`), 60 s (`DEFAULT_TIMEOUT_MS`).
- Cache de preview em `env.previewCacheDir` (`PREVIEW_CACHE_DIR`), separado de `THUMBNAIL_CACHE_DIR`.
- Autenticação é por cookie; `previewUrl` continua sendo uma URL simples usada direto em `src` de elementos de mídia.

---

### Task 1: Extrair a conversão LibreOffice para um módulo compartilhado

Hoje a invocação do LibreOffice e a escrita do stream para disco vivem dentro de `thumbnailService.js`. O serviço de preview precisa das duas. Extrair antes de escrever o novo serviço evita duplicar a chamada.

**Files:**
- Create: `backend/src/services/fileConvert.js`
- Modify: `backend/src/services/thumbnailService.js`
- Test: `backend/test/fileConvert.test.js`

**Interfaces:**
- Consumes: nada.
- Produces:
  - `officeToPdf({ execute, inputPath, outDir, timeoutMs }): Promise<string>` — devolve o caminho do PDF gerado dentro de `outDir`.
  - `writeStreamToFile(stream, targetPath, maxBytes): Promise<void>` — lança `Error` com `statusCode = 415` se o stream ultrapassar `maxBytes`.

- [ ] **Step 1: Write the failing test**

Criar `backend/test/fileConvert.test.js`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const { officeToPdf, writeStreamToFile } = await import('../src/services/fileConvert.js');

async function createDir(t) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'omnicloud-convert-'));
	t.after(() => fs.rm(dir, { recursive: true, force: true }));
	return dir;
}

test('officeToPdf drives libreoffice headless and returns the pdf path', async (t) => {
	const dir = await createDir(t);
	const inputPath = path.join(dir, 'source.docx');
	await fs.writeFile(inputPath, 'docx');

	let seenArgs;
	const execute = async (program, args, options) => {
		assert.equal(program, 'libreoffice');
		assert.equal(options.timeout, 1234);
		seenArgs = args;
		const outDir = args[args.indexOf('--outdir') + 1];
		await fs.writeFile(path.join(outDir, 'source.pdf'), 'pdf');
	};

	const pdfPath = await officeToPdf({ execute, inputPath, outDir: dir, timeoutMs: 1234 });

	assert.equal(pdfPath, path.join(dir, 'source.pdf'));
	assert.equal(await fs.readFile(pdfPath, 'utf8'), 'pdf');
	assert.ok(seenArgs[0].startsWith('-env:UserInstallation=file://'));
	assert.deepEqual(seenArgs.slice(1), ['--headless', '--convert-to', 'pdf', '--outdir', dir, inputPath]);
});

test('writeStreamToFile stops at the byte limit', async (t) => {
	const dir = await createDir(t);
	const targetPath = path.join(dir, 'out.bin');

	await writeStreamToFile(Readable.from(['abc']), targetPath, 10);
	assert.equal(await fs.readFile(targetPath, 'utf8'), 'abc');

	await assert.rejects(
		writeStreamToFile(Readable.from(['123456']), targetPath, 4),
		(error) => error.statusCode === 415,
	);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd backend && node --test test/fileConvert.test.js
```

Expected: FAIL — `Cannot find module '../src/services/fileConvert.js'`.

- [ ] **Step 3: Write the module**

Criar `backend/src/services/fileConvert.js`:

```js
import fs from 'node:fs/promises';
import path from 'node:path';

// LibreOffice headless compartilha estado no perfil do usuario: um perfil por
// conversao evita corrida entre processos simultaneos.
export async function officeToPdf({ execute, inputPath, outDir, timeoutMs }) {
	await execute('libreoffice', [
		`-env:UserInstallation=file://${path.join(outDir, 'profile')}`,
		'--headless',
		'--convert-to', 'pdf',
		'--outdir', outDir,
		inputPath,
	], { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 });

	return path.join(outDir, `${path.basename(inputPath, path.extname(inputPath))}.pdf`);
}

export async function writeStreamToFile(stream, targetPath, maxBytes) {
	const handle = await fs.open(targetPath, 'w');
	let bytes = 0;
	try {
		for await (const chunk of stream) {
			bytes += Buffer.byteLength(chunk);
			if (bytes > maxBytes) {
				const error = new Error('File is too large');
				error.statusCode = 415;
				throw error;
			}
			await handle.write(chunk);
		}
	} finally {
		await handle.close();
	}
}
```

- [ ] **Step 4: Point thumbnailService at the shared module**

Em `backend/src/services/thumbnailService.js`:

1. Adicionar o import junto dos demais:

```js
import { officeToPdf, writeStreamToFile } from './fileConvert.js';
```

2. Remover a função local `writeInput` (linhas 52-64) por inteiro.

3. Substituir `renderDocument` (linhas 100-110) por:

```js
async function renderDocument(execute, inputPath, outputPath, tempDir, timeoutMs) {
	const pdfPath = await officeToPdf({ execute, inputPath, outDir: tempDir, timeoutMs });
	await renderPdf(execute, pdfPath, outputPath, timeoutMs);
}
```

4. Na chamada dentro de `generateThumbnail`, trocar:

```js
		await writeInput(await openStream(), inputPath, maxBytes);
```

por:

```js
		await writeStreamToFile(await openStream(), inputPath, maxBytes);
```

`runConverter`, `renderPdf` e `renderVideo` permanecem como estão.

- [ ] **Step 5: Run the full backend suite**

```bash
cd backend && npm test
```

Expected: PASS, incluindo `thumbnailService.test.js` sem alteração (o teste já assume `--outdir` e a extensão `.pdf` derivada do nome do input).

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/fileConvert.js backend/src/services/thumbnailService.js backend/test/fileConvert.test.js
git commit -m "refactor: extract libreoffice conversion into fileConvert"
```

---

### Task 2: Classificar tipos de preview no backend

**Files:**
- Create: `backend/src/services/previewService.js`
- Test: `backend/test/previewService.test.js`

**Interfaces:**
- Consumes: `googleDocsExport(record)` de `backend/src/utils/mime.js` — devolve `{ mimeType, extension } | null`.
- Produces:
  - `effectivePreviewSource(file): { mimeType: string, extension: string }` — mime e extensão após aplicar a exportação do Google. `extension` inclui o ponto (`.pdf`).
  - `getPreviewKind(file): 'image'|'video'|'audio'|'pdf'|'office'|'text'|null`
  - `getPreviewCacheKey(userId, file): string` — sha256 hex.

- [ ] **Step 1: Write the failing test**

Criar `backend/test/previewService.test.js`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';

const { getPreviewKind, getPreviewCacheKey, effectivePreviewSource } = await import('../src/services/previewService.js');

test('getPreviewKind classifies by effective mime type', () => {
	const cases = [
		[{ file_name: 'photo.jpg', mime_type: 'image/jpeg' }, 'image'],
		[{ file_name: 'photo.heic', mime_type: 'application/octet-stream' }, 'image'],
		[{ file_name: 'clip.mp4', mime_type: 'video/mp4' }, 'video'],
		[{ file_name: 'clip.mkv', mime_type: 'application/octet-stream' }, 'video'],
		[{ file_name: 'song.mp3', mime_type: 'audio/mpeg' }, 'audio'],
		[{ file_name: 'report.pdf', mime_type: 'application/pdf' }, 'pdf'],
		[{ file_name: 'report.pdf', mime_type: 'application/octet-stream' }, 'pdf'],
		[{ file_name: 'letter.docx', mime_type: 'application/octet-stream' }, 'office'],
		[{ file_name: 'sheet.ods', mime_type: 'application/vnd.oasis.opendocument.spreadsheet' }, 'office'],
		[{ file_name: 'notes.txt', mime_type: 'text/plain' }, 'text'],
		[{ file_name: 'data.json', mime_type: 'application/json' }, 'text'],
		[{ file_name: 'table.csv', mime_type: 'application/octet-stream' }, 'text'],
		[{ file_name: 'archive.zip', mime_type: 'application/zip' }, null],
		[{ file_name: 'setup.exe', mime_type: 'application/x-msdownload' }, null],
		[{ file_name: 'folder', is_folder: true }, null],
	];

	for (const [file, expected] of cases) {
		assert.equal(getPreviewKind(file), expected, file.file_name);
	}
});

test('getPreviewKind resolves google native files through their export target', () => {
	const cases = [
		['application/vnd.google-apps.document', 'pdf'],
		['application/vnd.google-apps.spreadsheet', 'office'],
		['application/vnd.google-apps.presentation', 'office'],
		['application/vnd.google-apps.drawing', 'image'],
		['application/vnd.google-apps.script', 'text'],
	];

	for (const [mimeType, expected] of cases) {
		assert.equal(getPreviewKind({ file_name: 'native doc', mime_type: mimeType, size: 0 }), expected, mimeType);
	}
});

test('effectivePreviewSource exposes the export extension for google files', () => {
	assert.deepEqual(
		effectivePreviewSource({ file_name: 'Budget', mime_type: 'application/vnd.google-apps.spreadsheet' }),
		{ mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', extension: '.xlsx' },
	);
	assert.deepEqual(
		effectivePreviewSource({ file_name: 'Photo.JPG', mime_type: 'image/jpeg' }),
		{ mimeType: 'image/jpeg', extension: '.jpg' },
	);
});

test('getPreviewCacheKey isolates users and file revisions', () => {
	const file = { id: 'file-1', remote_modified_time: '2026-08-02T12:00:00.000Z', size: 42 };
	const baseline = getPreviewCacheKey('user-1', file);

	assert.match(baseline, /^[a-f0-9]{64}$/);
	assert.notEqual(getPreviewCacheKey('user-2', file), baseline);
	assert.notEqual(getPreviewCacheKey('user-1', { ...file, id: 'file-2' }), baseline);
	assert.notEqual(getPreviewCacheKey('user-1', { ...file, remote_modified_time: '2026-08-03T12:00:00.000Z' }), baseline);
	assert.notEqual(getPreviewCacheKey('user-1', { ...file, size: 43 }), baseline);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd backend && node --test test/previewService.test.js
```

Expected: FAIL — `Cannot find module '../src/services/previewService.js'`.

- [ ] **Step 3: Write the classification**

Criar `backend/src/services/previewService.js`:

```js
import crypto from 'node:crypto';
import path from 'node:path';
import { googleDocsExport } from '../utils/mime.js';

const IMAGE_EXTENSIONS = new Set(['.avif', '.bmp', '.gif', '.heic', '.jpeg', '.jpg', '.png', '.svg', '.webp']);
const VIDEO_EXTENSIONS = new Set(['.avi', '.m4v', '.mkv', '.mov', '.mp4', '.webm']);
const AUDIO_EXTENSIONS = new Set(['.aac', '.flac', '.m4a', '.mp3', '.ogg', '.wav']);
const OFFICE_EXTENSIONS = new Set(['.doc', '.docx', '.odp', '.ods', '.odt', '.ppt', '.pptx', '.xls', '.xlsx']);
const TEXT_EXTENSIONS = new Set(['.csv', '.json', '.log', '.md', '.txt', '.xml', '.yaml', '.yml']);

// Arquivos nativos do Google so existem no formato de exportacao: a classificacao
// tem que olhar o destino da exportacao, nunca o mime original.
export function effectivePreviewSource(file) {
	const exportTarget = googleDocsExport(file);
	if (exportTarget) {
		return { mimeType: exportTarget.mimeType.toLowerCase(), extension: `.${exportTarget.extension}` };
	}
	return {
		mimeType: String(file?.mime_type || file?.mimeType || '').toLowerCase(),
		extension: path.extname(file?.display_name || file?.file_name || '').toLowerCase(),
	};
}

export function getPreviewKind(file) {
	if (!file || file.is_folder) return null;
	const { mimeType, extension } = effectivePreviewSource(file);

	if (mimeType.startsWith('image/') || IMAGE_EXTENSIONS.has(extension)) return 'image';
	if (mimeType.startsWith('video/') || VIDEO_EXTENSIONS.has(extension)) return 'video';
	if (mimeType.startsWith('audio/') || AUDIO_EXTENSIONS.has(extension)) return 'audio';
	if (mimeType === 'application/pdf' || extension === '.pdf') return 'pdf';
	if (
		OFFICE_EXTENSIONS.has(extension)
		|| mimeType.includes('officedocument')
		|| mimeType.includes('opendocument')
		|| mimeType.includes('msword')
		|| mimeType.includes('ms-excel')
		|| mimeType.includes('ms-powerpoint')
	) return 'office';
	if (mimeType.startsWith('text/') || mimeType === 'application/json' || TEXT_EXTENSIONS.has(extension)) return 'text';

	return null;
}

export function getPreviewCacheKey(userId, file) {
	const revision = file.modifiedTime || file.remote_modified_time || file.updated_at || '';
	return crypto
		.createHash('sha256')
		.update(JSON.stringify([userId, file.id, revision, Number(file.size || 0)]))
		.digest('hex');
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd backend && node --test test/previewService.test.js
```

Expected: PASS (4 testes).

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/previewService.js backend/test/previewService.test.js
git commit -m "feat: classify preview kinds over the effective mime type"
```

---

### Task 3: Converter Office para PDF com cache em disco

**Files:**
- Modify: `backend/src/config/env.js:46-49`
- Modify: `backend/src/services/previewService.js`
- Test: `backend/test/previewService.test.js`

**Interfaces:**
- Consumes: `officeToPdf`, `writeStreamToFile` (Task 1); `getPreviewKind`, `getPreviewCacheKey`, `effectivePreviewSource` (Task 2).
- Produces: `renderOfficePdf({ userId, file, openStream, cacheDir, execute, maxBytes, timeoutMs }): Promise<string>` — caminho do PDF cacheado. Erros carregam `statusCode` 415 (tipo errado ou grande demais) ou 422 (conversão falhou).

- [ ] **Step 1: Add the cache directory to env**

Em `backend/src/config/env.js`, logo após a linha `thumbnailCacheDir:`:

```js
	previewCacheDir: process.env.PREVIEW_CACHE_DIR || path.resolve(process.cwd(), 'data/previews'),
```

- [ ] **Step 2: Write the failing test**

Em `backend/test/previewService.test.js`, trocar o cabeçalho de imports por este (os
`import` só valem no topo do módulo):

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const {
	getPreviewKind,
	getPreviewCacheKey,
	effectivePreviewSource,
	renderOfficePdf,
} = await import('../src/services/previewService.js');
```

e acrescentar ao fim do arquivo:

```js
async function createCache(t) {
	const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'omnicloud-previews-'));
	t.after(() => fs.rm(cacheDir, { recursive: true, force: true }));
	return cacheDir;
}

test('renderOfficePdf converts once and reuses the cached pdf', async (t) => {
	const cacheDir = await createCache(t);
	const file = { id: 'doc-1', file_name: 'report.docx', mime_type: 'application/octet-stream', size: 8 };
	let conversions = 0;
	const execute = async (program, args) => {
		assert.equal(program, 'libreoffice');
		conversions += 1;
		const outDir = args[args.indexOf('--outdir') + 1];
		const input = args.at(-1);
		assert.equal(path.extname(input), '.docx');
		await fs.writeFile(path.join(outDir, `${path.basename(input, '.docx')}.pdf`), 'converted-pdf');
	};

	const first = await renderOfficePdf({
		userId: 'user-1',
		file,
		cacheDir,
		execute,
		openStream: async () => Readable.from(['document']),
	});
	assert.equal(await fs.readFile(first, 'utf8'), 'converted-pdf');

	const cached = await renderOfficePdf({
		userId: 'user-1',
		file,
		cacheDir,
		execute: async () => { throw new Error('cache reran the converter'); },
		openStream: async () => { throw new Error('cache opened the provider'); },
	});
	assert.equal(cached, first);
	assert.equal(conversions, 1);
});

test('renderOfficePdf uses the google export extension as libreoffice input', async (t) => {
	const cacheDir = await createCache(t);
	const file = { id: 'sheet-1', file_name: 'Budget', mime_type: 'application/vnd.google-apps.spreadsheet', size: 0 };
	const execute = async (program, args) => {
		const outDir = args[args.indexOf('--outdir') + 1];
		const input = args.at(-1);
		assert.equal(path.extname(input), '.xlsx');
		await fs.writeFile(path.join(outDir, `${path.basename(input, '.xlsx')}.pdf`), 'sheet-pdf');
	};

	const pdfPath = await renderOfficePdf({
		userId: 'user-1',
		file,
		cacheDir,
		execute,
		openStream: async () => Readable.from(['xlsx']),
	});
	assert.equal(await fs.readFile(pdfPath, 'utf8'), 'sheet-pdf');
});

test('renderOfficePdf rejects wrong kinds, oversized files and converter failures', async (t) => {
	const cacheDir = await createCache(t);

	await assert.rejects(
		renderOfficePdf({
			userId: 'user-1',
			cacheDir,
			file: { id: 'img', file_name: 'photo.jpg', mime_type: 'image/jpeg', size: 1 },
			openStream: async () => { throw new Error('provider should stay closed'); },
		}),
		(error) => error.statusCode === 415,
	);

	await assert.rejects(
		renderOfficePdf({
			userId: 'user-1',
			cacheDir,
			maxBytes: 10,
			file: { id: 'big', file_name: 'big.docx', mime_type: 'application/octet-stream', size: 11 },
			openStream: async () => { throw new Error('provider should stay closed'); },
		}),
		(error) => error.statusCode === 415,
	);

	await assert.rejects(
		renderOfficePdf({
			userId: 'user-1',
			cacheDir,
			file: { id: 'broken', file_name: 'broken.docx', mime_type: 'application/octet-stream', size: 3 },
			openStream: async () => Readable.from(['doc']),
			execute: async () => { throw new Error('libreoffice crashed'); },
		}),
		(error) => error.statusCode === 422,
	);

	const leftovers = (await fs.readdir(cacheDir)).filter((entry) => entry.startsWith('.tmp-'));
	assert.deepEqual(leftovers, []);
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
cd backend && node --test test/previewService.test.js
```

Expected: FAIL — `renderOfficePdf is not a function`.

- [ ] **Step 4: Implement the conversion**

Em `backend/src/services/previewService.js`, acrescentar os imports no topo:

```js
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { promisify } from 'node:util';
import { env } from '../config/env.js';
import { officeToPdf, writeStreamToFile } from './fileConvert.js';
```

e as constantes, o helper de erro e a função ao fim do arquivo:

```js
const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;
// Conversao completa para PDF e mais pesada que gerar uma capa: 60s contra os 30s
// do thumbnail.
const DEFAULT_TIMEOUT_MS = 60_000;
const execFileAsync = promisify(execFile);

function previewError(message, statusCode, cause) {
	const error = new Error(message, cause ? { cause } : undefined);
	error.statusCode = statusCode;
	return error;
}

export async function renderOfficePdf({
	userId,
	file,
	openStream,
	cacheDir = env.previewCacheDir,
	execute = execFileAsync,
	maxBytes = DEFAULT_MAX_BYTES,
	timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
	if (getPreviewKind(file) !== 'office') throw previewError('Preview is not supported for this file type', 415);
	if (Number(file.size || 0) > maxBytes) throw previewError('File is too large for preview conversion', 415);
	if (typeof openStream !== 'function') throw new TypeError('openStream is required');

	await fs.mkdir(cacheDir, { recursive: true });
	const targetPath = path.join(cacheDir, `${getPreviewCacheKey(userId, file)}.pdf`);
	try {
		await fs.access(targetPath);
		return targetPath;
	} catch {
	}

	const tempDir = await fs.mkdtemp(path.join(cacheDir, '.tmp-'));
	try {
		const { extension } = effectivePreviewSource(file);
		const safeExtension = /^\.[a-z0-9]{1,8}$/.test(extension) ? extension : '.bin';
		const inputPath = path.join(tempDir, `source${safeExtension}`);
		await writeStreamToFile(await openStream(), inputPath, maxBytes);

		const pdfPath = await officeToPdf({ execute, inputPath, outDir: tempDir, timeoutMs });
		const output = await fs.stat(pdfPath);
		if (!output.size) throw new Error('LibreOffice produced an empty PDF');

		await fs.rename(pdfPath, targetPath);
		return targetPath;
	} catch (error) {
		if (error.statusCode === 415) throw error;
		throw previewError('Preview conversion failed', 422, error);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
cd backend && node --test test/previewService.test.js
```

Expected: PASS (7 testes).

- [ ] **Step 6: Commit**

```bash
git add backend/src/config/env.js backend/src/services/previewService.js backend/test/previewService.test.js
git commit -m "feat: convert office files to cached pdf for preview"
```

---

### Task 4: Reescrever a rota de preview com Range, ETag e Office

**Files:**
- Modify: `backend/src/routes/fileRoutes.js:335-372`
- Test: `backend/test/previewRoutes.test.js`

**Interfaces:**
- Consumes: `getPreviewKind`, `getPreviewCacheKey`, `effectivePreviewSource`, `renderOfficePdf` (Tasks 2-3); `parseRangeHeader(header, size)` de `backend/src/services/webdav.js`; `fileCacheService.openFile({ userId, file, adapter, range })`; `getFileContext` / `ensureFileContext`, já definidos em `fileRoutes.js:110` e `:128`.
- Produces: `GET /api/files/:id/preview` com `Accept-Ranges`, 206, 304 e Office servido como `application/pdf`.

- [ ] **Step 1: Write the failing test**

Criar `backend/test/previewRoutes.test.js`, no padrão de `thumbnailRoutes.test.js`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const taskRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'omnicloud-preview-routes-'));
process.env.DATABASE_PATH = path.join(taskRoot, 'omnicloud.db');
process.env.PREVIEW_CACHE_DIR = path.join(taskRoot, 'previews');
process.env.FILE_CACHE_PATH = path.join(taskRoot, 'files');
process.env.APP_MODE = 'local';

const [
	{ createApp },
	{ db, LOCAL_USER_ID },
	{ createFileMetadata },
	{ getPreviewCacheKey },
] = await Promise.all([
	import('../src/app.js'),
	import('../src/config/database.js'),
	import('../src/services/fileService.js'),
	import('../src/services/previewService.js'),
]);

const app = createApp();
let server;
let baseUrl;
let textFile;
let archiveFile;
let officeFile;

test.before(async () => {
	db.prepare(`
		INSERT INTO cloud_accounts (
			id, user_id, email, provider, encrypted_credentials,
			total_space, used_space, status
		) VALUES (?, ?, ?, 'base', '', 1000, 0, 'active')
	`).run('account-1', LOCAL_USER_ID, 'local@example.com');

	textFile = createFileMetadata({
		user_id: LOCAL_USER_ID,
		virtual_path: '/',
		file_name: 'notes.txt',
		is_folder: false,
		size: 11,
		mime_type: 'text/plain',
		cloud_account_id: 'account-1',
		remote_file_id: 'text-remote',
		remote_modified_time: '2026-08-02T12:00:00.000Z',
	});
	archiveFile = createFileMetadata({
		user_id: LOCAL_USER_ID,
		virtual_path: '/',
		file_name: 'archive.zip',
		is_folder: false,
		size: 4,
		mime_type: 'application/zip',
		cloud_account_id: 'account-1',
		remote_file_id: 'zip-remote',
	});
	officeFile = createFileMetadata({
		user_id: LOCAL_USER_ID,
		virtual_path: '/',
		file_name: 'report.docx',
		is_folder: false,
		size: 6,
		mime_type: 'application/octet-stream',
		cloud_account_id: 'account-1',
		remote_file_id: 'docx-remote',
		remote_modified_time: '2026-08-02T12:00:00.000Z',
	});

	// PDF ja convertido: a rota deve servir o cache sem chamar o LibreOffice.
	await fs.mkdir(process.env.PREVIEW_CACHE_DIR, { recursive: true });
	await fs.writeFile(
		path.join(process.env.PREVIEW_CACHE_DIR, `${getPreviewCacheKey(LOCAL_USER_ID, officeFile)}.pdf`),
		'converted-pdf',
	);

	server = app.listen(0);
	await new Promise((resolve) => server.once('listening', resolve));
	baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
	server.close();
	db.close();
	await fs.rm(taskRoot, { recursive: true, force: true });
});

test('preview rejects file types without a renderer', async () => {
	const response = await fetch(`${baseUrl}/api/files/${archiveFile.id}/preview`);
	assert.equal(response.status, 415);
});

test('preview advertises range support and an etag', async () => {
	const response = await fetch(`${baseUrl}/api/files/${textFile.id}/preview`);

	assert.equal(response.headers.get('accept-ranges'), 'bytes');
	assert.equal(response.headers.get('cache-control'), 'private, max-age=3600');
	assert.match(response.headers.get('etag'), /^"[a-f0-9]{64}"$/);
	assert.match(response.headers.get('content-disposition'), /^inline;/);
	await response.arrayBuffer();
});

test('preview answers 304 when the etag matches', async () => {
	const first = await fetch(`${baseUrl}/api/files/${textFile.id}/preview`);
	const etag = first.headers.get('etag');
	await first.arrayBuffer();

	const second = await fetch(`${baseUrl}/api/files/${textFile.id}/preview`, {
		headers: { 'If-None-Match': etag },
	});

	assert.equal(second.status, 304);
});

test('preview serves converted office files as pdf with a partial range', async () => {
	const full = await fetch(`${baseUrl}/api/files/${officeFile.id}/preview`);
	assert.equal(full.status, 200);
	assert.equal(full.headers.get('content-type'), 'application/pdf');
	assert.equal(await full.text(), 'converted-pdf');

	const partial = await fetch(`${baseUrl}/api/files/${officeFile.id}/preview`, {
		headers: { Range: 'bytes=0-8' },
	});
	assert.equal(partial.status, 206);
	assert.equal(partial.headers.get('content-range'), 'bytes 0-8/13');
	assert.equal(partial.headers.get('content-length'), '9');
	assert.equal(await partial.text(), 'converted');
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd backend && node --test test/previewRoutes.test.js
```

Expected: FAIL — a rota atual responde 415 para `.docx` e não envia `Accept-Ranges` nem `ETag`.

- [ ] **Step 3: Rewrite the route**

Em `backend/src/routes/fileRoutes.js`, acrescentar aos imports do topo:

```js
import { statSync } from 'node:fs';
import { parseRangeHeader } from '../services/webdav.js';
import { effectivePreviewSource, getPreviewCacheKey, getPreviewKind, renderOfficePdf } from '../services/previewService.js';
```

(`createReadStream` já está importado por causa da rota de thumbnail; `statSync` é novo.)

Substituir todo o bloco `router.get('/files/:id/preview', ...)` (linhas 335-372) por:

```js
function sendLocalPreview(req, res, filePath) {
	const size = statSync(filePath).size;
	const range = parseRangeHeader(req.headers.range, size);

	if (range) {
		res.status(206);
		res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
		res.setHeader('Content-Length', String(range.end - range.start + 1));
	} else {
		res.status(200);
		res.setHeader('Content-Length', String(size));
	}

	const stream = createReadStream(filePath, range ? { start: range.start, end: range.end } : undefined);
	stream.on('error', () => res.destroy());
	stream.pipe(res);
}

router.get('/files/:id/preview', async (req, res, next) => {
	try {
		const context = await getFileContext(req.user.id, req.params.id);
		if (!ensureFileContext(context, res)) {
			return;
		}

		if (context.file.is_folder) {
			return res.status(400).json({ error: 'Folder preview is not supported' });
		}

		const kind = getPreviewKind(context.file);
		if (!kind) {
			return res.status(415).json({ error: 'Preview is not supported for this file type' });
		}

		const etag = `"${getPreviewCacheKey(req.user.id, context.file)}"`;
		res.setHeader('ETag', etag);
		res.setHeader('Cache-Control', 'private, max-age=3600');
		res.setHeader('Accept-Ranges', 'bytes');
		res.setHeader('Content-Disposition', `inline; filename="${context.file.file_name}"`);
		if (req.headers['if-none-match'] === etag) {
			return res.status(304).end();
		}

		if (kind === 'office') {
			const pdfPath = await renderOfficePdf({
				userId: req.user.id,
				file: context.file,
				openStream: async () => (await fileCacheService.openFile({
					userId: req.user.id,
					file: context.file,
					adapter: context.adapter,
				})).stream,
			});
			res.setHeader('Content-Type', 'application/pdf');
			return sendLocalPreview(req, res, pdfPath);
		}

		const size = Number(context.file.size || 0);
		const requestedRange = parseRangeHeader(req.headers.range, size);
		const opened = await fileCacheService.openFile({
			userId: req.user.id,
			file: context.file,
			adapter: context.adapter,
			range: requestedRange || {},
		});
		// Nem todo provider honra range remoto: sem cache local e sem suporte do
		// adapter, o corpo devolvido e o arquivo inteiro e 206 seria mentira.
		const range = requestedRange
			&& (opened.cached || context.adapter.getCapabilities?.().supportsRange)
			? requestedRange
			: null;

		res.setHeader('Content-Type', effectivePreviewSource(context.file).mimeType || 'application/octet-stream');
		if (range) {
			res.status(206);
			res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
			res.setHeader('Content-Length', String(range.end - range.start + 1));
		} else {
			res.status(200);
			if (size) res.setHeader('Content-Length', String(size));
		}

		opened.stream.on('error', () => res.destroy());
		opened.stream.pipe(res);
	} catch (error) {
		if (error.statusCode === 415 || error.statusCode === 422) {
			return res.status(error.statusCode).json({ error: error.message });
		}
		next(error);
	}
});
```

- [ ] **Step 4: Run the full backend suite**

```bash
cd backend && npm test
```

Expected: PASS. `previewRoutes.test.js` cobre 415, cabeçalhos, 304 e Office com 206.

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/fileRoutes.js backend/test/previewRoutes.test.js
git commit -m "feat: serve previews with range, etag and office conversion"
```

---

### Task 5: Espelhar a classificação no frontend

**Files:**
- Modify: `frontend/src/composables/useFileType.js:29-32`
- Test: `frontend/test/previewType.test.js`

**Interfaces:**
- Consumes: nada.
- Produces: `getPreviewType(file): 'image'|'video'|'audio'|'pdf'|'text'|null` — mesmo vocabulário do backend, com `office` mapeado para `pdf` (o cliente recebe o Office já convertido).

- [ ] **Step 1: Write the failing test**

Criar `frontend/test/previewType.test.js`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { getPreviewType } from '../src/composables/useFileType.js';
import { getPreviewKind } from '../../backend/src/services/previewService.js';

const FIXTURES = [
	{ file_name: 'photo.jpg', mime_type: 'image/jpeg' },
	{ file_name: 'photo.heic', mime_type: 'application/octet-stream' },
	{ file_name: 'clip.mp4', mime_type: 'video/mp4' },
	{ file_name: 'song.mp3', mime_type: 'audio/mpeg' },
	{ file_name: 'report.pdf', mime_type: 'application/pdf' },
	{ file_name: 'letter.docx', mime_type: 'application/octet-stream' },
	{ file_name: 'sheet.ods', mime_type: 'application/vnd.oasis.opendocument.spreadsheet' },
	{ file_name: 'notes.txt', mime_type: 'text/plain' },
	{ file_name: 'data.json', mime_type: 'application/json' },
	{ file_name: 'archive.zip', mime_type: 'application/zip' },
	{ file_name: 'folder', is_folder: true },
	{ file_name: 'Doc', mime_type: 'application/vnd.google-apps.document' },
	{ file_name: 'Budget', mime_type: 'application/vnd.google-apps.spreadsheet' },
	{ file_name: 'Deck', mime_type: 'application/vnd.google-apps.presentation' },
	{ file_name: 'Sketch', mime_type: 'application/vnd.google-apps.drawing' },
	{ file_name: 'Macro', mime_type: 'application/vnd.google-apps.script' },
];

test('getPreviewType agrees with the backend, mapping office to pdf', () => {
	for (const file of FIXTURES) {
		// office chega ao cliente ja convertido em PDF pela rota de preview.
		const expected = getPreviewKind(file) === 'office' ? 'pdf' : getPreviewKind(file);
		assert.equal(getPreviewType(file), expected, file.file_name);
	}
});

test('getPreviewType rejects what has no renderer', () => {
	assert.equal(getPreviewType({ file_name: 'archive.zip', mime_type: 'application/zip' }), null);
	assert.equal(getPreviewType({ file_name: 'setup.exe', mime_type: 'application/x-msdownload' }), null);
	assert.equal(getPreviewType(null), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd frontend && node --test test/previewType.test.js
```

Expected: FAIL — `getPreviewType is not a function`.

- [ ] **Step 3: Implement getPreviewType**

Em `frontend/src/composables/useFileType.js`, logo após as constantes de extensão existentes (linhas 29-32), acrescentar:

```js
const OFFICE_EXTENSIONS = new Set(['doc', 'docx', 'odp', 'ods', 'odt', 'ppt', 'pptx', 'xls', 'xlsx']);
const TEXT_EXTENSIONS = new Set(['csv', 'json', 'log', 'md', 'txt', 'xml', 'yaml', 'yml']);

// Nativos do Google chegam pela rota de preview ja convertidos (Docs/Sheets/Slides
// viram PDF, Drawings viram PNG, Scripts viram JSON).
const GOOGLE_PREVIEW_TYPES = {
	'application/vnd.google-apps.document': 'pdf',
	'application/vnd.google-apps.spreadsheet': 'pdf',
	'application/vnd.google-apps.presentation': 'pdf',
	'application/vnd.google-apps.drawing': 'image',
	'application/vnd.google-apps.script': 'text',
};
```

e, ao fim do arquivo, a função:

```js
export function getPreviewType(file) {
	if (!file || file.is_folder) return null;

	const mimeType = (file.mime_type || file.mimeType || '').toLowerCase();
	if (GOOGLE_PREVIEW_TYPES[mimeType]) return GOOGLE_PREVIEW_TYPES[mimeType];

	const extension = getFileExtension(file);
	if (mimeType.startsWith('image/') || IMAGE_EXTENSIONS.has(extension)) return 'image';
	if (mimeType.startsWith('video/') || VIDEO_EXTENSIONS.has(extension)) return 'video';
	if (mimeType.startsWith('audio/') || AUDIO_EXTENSIONS.has(extension)) return 'audio';
	if (mimeType === 'application/pdf' || extension === 'pdf') return 'pdf';
	if (
		OFFICE_EXTENSIONS.has(extension)
		|| mimeType.includes('officedocument')
		|| mimeType.includes('opendocument')
		|| mimeType.includes('msword')
		|| mimeType.includes('ms-excel')
		|| mimeType.includes('ms-powerpoint')
	) return 'pdf';
	if (mimeType.startsWith('text/') || mimeType === 'application/json' || TEXT_EXTENSIONS.has(extension)) return 'text';

	return null;
}
```

`getFileCategory`, `canShowGridThumbnail`, `getFileIcon` e `getTypeFilterIcon` ficam intactos: continuam servindo ícones e filtros.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd frontend && npm test
```

Expected: PASS, incluindo `fileType.test.js` sem alteração.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/composables/useFileType.js frontend/test/previewType.test.js
git commit -m "feat: mirror backend preview classification in the client"
```

---

### Task 6: Navegação, erro e conteúdo de texto no composable

**Files:**
- Modify: `frontend/src/composables/useFilePreviewModal.js`
- Modify: `frontend/src/services/api.js:256-258`
- Test: `frontend/test/useFilePreviewModal.test.js`

**Interfaces:**
- Consumes: `getPreviewType` (Task 5).
- Produces, além do que já devolve (`previewFile`, `isPreviewOpen`, `isPreviewLoading`, `canPreview`, `openPreview`, `closePreview`, `handlePreviewLoaded`, `handlePreviewFailed`):
  - `previewError: Ref<string|null>`
  - `previewText: Ref<string|null>`
  - `hasPreviousPreview: ComputedRef<boolean>`, `hasNextPreview: ComputedRef<boolean>`
  - `showPreviousPreview(): void`, `showNextPreview(): void`
  - opções novas: `sourceList` (ref de array, opcional), `fetchText(url): Promise<string>` (opcional, default usa `fetch` com `credentials: 'include'`), `textLoadErrorMessage: string`.

- [ ] **Step 1: Add the text fetcher to the API client**

Em `frontend/src/services/api.js`, logo após `previewUrl`:

```js
	async previewText(fileId) {
		const response = await fetch(`${API_BASE_URL}/files/${fileId}/preview`, { credentials: 'include' });
		if (!response.ok) throw new Error(`Preview request failed with ${response.status}`);
		return response.text();
	},
```

- [ ] **Step 2: Write the failing test**

Criar `frontend/test/useFilePreviewModal.test.js`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { ref } from 'vue';
import { useFilePreviewModal } from '../src/composables/useFilePreviewModal.js';

const IMAGE = { id: 'a', file_name: 'a.jpg', mime_type: 'image/jpeg' };
const ZIP = { id: 'b', file_name: 'b.zip', mime_type: 'application/zip' };
const PDF = { id: 'c', file_name: 'c.pdf', mime_type: 'application/pdf' };
const TEXT = { id: 'd', file_name: 'd.txt', mime_type: 'text/plain' };

function setup(overrides = {}) {
	const sourceList = ref([IMAGE, ZIP, PDF, TEXT]);
	return useFilePreviewModal({
		getFileCategory: () => 'other',
		getPreviewType: (file) => ({ a: 'image', c: 'pdf', d: 'text' })[file?.id] ?? null,
		buildPreviewUrl: (file) => `/preview/${file.id}`,
		sourceList,
		fetchText: async () => 'file body',
		...overrides,
	});
}

test('navigation walks only over previewable files', async () => {
	const modal = setup();

	modal.openPreview(IMAGE);
	assert.equal(modal.hasPreviousPreview.value, false);
	assert.equal(modal.hasNextPreview.value, true);

	modal.showNextPreview();
	assert.equal(modal.previewFile.value.id, 'c', 'skips the zip');
	assert.equal(modal.hasPreviousPreview.value, true);

	modal.showNextPreview();
	assert.equal(modal.previewFile.value.id, 'd');
	assert.equal(modal.hasNextPreview.value, false);

	modal.showNextPreview();
	assert.equal(modal.previewFile.value.id, 'd', 'stops at the end');

	modal.showPreviousPreview();
	assert.equal(modal.previewFile.value.id, 'c');
});

test('opening a text file loads its body and truncates at the limit', async () => {
	const modal = setup({ fetchText: async () => 'x'.repeat(10), maxTextBytes: 4 });

	modal.openPreview(TEXT);
	await new Promise((resolve) => setTimeout(resolve, 0));

	assert.equal(modal.previewText.value, 'xxxx');
	assert.equal(modal.isPreviewLoading.value, false);
});

test('failures surface as previewError instead of a blank pane', async () => {
	const modal = setup();

	modal.openPreview(IMAGE);
	modal.handlePreviewFailed();
	assert.equal(modal.isPreviewLoading.value, false);
	assert.ok(modal.previewError.value);

	modal.openPreview(PDF);
	assert.equal(modal.previewError.value, null, 'reopening clears the error');
});

test('failing to load text reports the configured message', async () => {
	const modal = setup({
		fetchText: async () => { throw new Error('network down'); },
		textLoadErrorMessage: 'could not load',
	});

	modal.openPreview(TEXT);
	await new Promise((resolve) => setTimeout(resolve, 0));

	assert.equal(modal.previewError.value, 'could not load');
	assert.equal(modal.isPreviewLoading.value, false);
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
cd frontend && node --test test/useFilePreviewModal.test.js
```

Expected: FAIL — `modal.hasPreviousPreview` é `undefined`.

- [ ] **Step 4: Rewrite the composable**

Substituir o conteúdo de `frontend/src/composables/useFilePreviewModal.js` por:

```js
import { computed, ref } from 'vue';

const DEFAULT_MAX_TEXT_BYTES = 1024 * 1024;

function defaultCanPreview(file, getFileCategory) {
	return Boolean(
		file
			&& !file.is_folder
			&& ['image', 'video', 'audio', 'document'].includes(getFileCategory(file)),
	);
}

export function useFilePreviewModal({
	getFileCategory,
	buildPreviewUrl,
	getPreviewType,
	onUnsupported,
	sourceList,
	fetchText,
	textLoadErrorMessage = 'Preview failed to load.',
	loadErrorMessage = 'Preview failed to load.',
	maxTextBytes = DEFAULT_MAX_TEXT_BYTES,
} = {}) {
	if (typeof getFileCategory !== 'function') {
		throw new Error('useFilePreviewModal: getFileCategory is required');
	}
	if (typeof buildPreviewUrl !== 'function') {
		throw new Error('useFilePreviewModal: buildPreviewUrl is required');
	}

	const previewFile = ref(null);
	const isPreviewOpen = ref(false);
	const isPreviewLoading = ref(false);
	const previewError = ref(null);
	const previewText = ref(null);

	const previewTypeOf = typeof getPreviewType === 'function'
		? getPreviewType
		: (file) => getFileCategory(file);

	const canPreview = typeof getPreviewType === 'function'
		? (file) => Boolean(previewTypeOf(file))
		: (file) => defaultCanPreview(file, getFileCategory);

	const previewableFiles = computed(
		() => (sourceList?.value || []).filter((file) => canPreview(file)),
	);
	const currentIndex = computed(
		() => previewableFiles.value.findIndex((file) => file.id === previewFile.value?.id),
	);
	const hasPreviousPreview = computed(() => currentIndex.value > 0);
	const hasNextPreview = computed(
		() => currentIndex.value >= 0 && currentIndex.value < previewableFiles.value.length - 1,
	);

	async function loadText(file, url) {
		if (typeof fetchText !== 'function') return;
		const token = file.id;
		try {
			const body = await fetchText(url, file);
			// Corrida: o usuario pode ter navegado para outro arquivo antes da resposta.
			if (previewFile.value?.id !== token) return;
			previewText.value = body.length > maxTextBytes ? body.slice(0, maxTextBytes) : body;
			isPreviewLoading.value = false;
		} catch {
			if (previewFile.value?.id !== token) return;
			previewError.value = textLoadErrorMessage;
			isPreviewLoading.value = false;
		}
	}

	function openPreview(file) {
		if (!canPreview(file)) {
			if (typeof onUnsupported === 'function') onUnsupported(file);
			return false;
		}

		const previewType = previewTypeOf(file);
		const previewUrl = buildPreviewUrl(file);

		isPreviewLoading.value = true;
		previewError.value = null;
		previewText.value = null;
		previewFile.value = { ...file, previewType, previewUrl };
		isPreviewOpen.value = true;

		if (previewType === 'text') void loadText(file, previewUrl);
		return true;
	}

	function closePreview() {
		isPreviewOpen.value = false;
		previewFile.value = null;
		isPreviewLoading.value = false;
		previewError.value = null;
		previewText.value = null;
	}

	function step(offset) {
		const next = previewableFiles.value[currentIndex.value + offset];
		if (next) openPreview(next);
	}

	function showPreviousPreview() {
		if (hasPreviousPreview.value) step(-1);
	}

	function showNextPreview() {
		if (hasNextPreview.value) step(1);
	}

	function handlePreviewLoaded() {
		isPreviewLoading.value = false;
	}

	function handlePreviewFailed() {
		isPreviewLoading.value = false;
		previewError.value = loadErrorMessage;
	}

	return {
		previewFile,
		isPreviewOpen,
		isPreviewLoading,
		previewError,
		previewText,
		canPreview,
		hasPreviousPreview,
		hasNextPreview,
		openPreview,
		closePreview,
		showPreviousPreview,
		showNextPreview,
		handlePreviewLoaded,
		handlePreviewFailed,
	};
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd frontend && npm test
```

Expected: PASS (4 testes novos + os já existentes).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/composables/useFilePreviewModal.js frontend/src/services/api.js frontend/test/useFilePreviewModal.test.js
git commit -m "feat: add preview navigation, error state and text loading"
```

---

### Task 7: Modal com áudio, texto, zoom, teclado, download e erro

**Files:**
- Modify: `frontend/src/components/FilePreviewModal.vue`
- Modify: `frontend/src/locales/en.json:442-447`
- Modify: `frontend/src/locales/id.json:442-447`

**Interfaces:**
- Consumes: `previewFile.previewType` ∈ `image|video|audio|pdf|text`; `previewText`, `previewError`, `hasPreviousPreview`, `hasNextPreview` (Task 6).
- Produces: props `preview-text`, `preview-error`, `has-previous`, `has-next`; eventos `previous`, `next`, `download`, além dos já existentes `close`, `loaded`, `failed`.

- [ ] **Step 1: Add the locale keys**

Em `frontend/src/locales/en.json`, substituir o bloco `"preview"` por:

```json
	"preview": {
		"loading": "Loading preview...",
		"notAvailable": "Preview is not available for this file type.",
		"document": "Document preview",
		"failed": "Preview failed to load. Some provider files are not compatible with lightweight preview.",
		"previous": "Previous file",
		"next": "Next file",
		"zoomHint": "Click to zoom, scroll to adjust"
	}
```

Em `frontend/src/locales/id.json`, o mesmo bloco:

```json
	"preview": {
		"loading": "Memuat preview...",
		"notAvailable": "Preview belum tersedia untuk tipe file ini.",
		"document": "Preview dokumen",
		"failed": "Preview gagal dimuat. Beberapa file provider memang tidak kompatibel untuk preview ringan.",
		"previous": "File sebelumnya",
		"next": "File berikutnya",
		"zoomHint": "Klik untuk zoom, gulir untuk menyesuaikan"
	}
```

O rótulo do botão de download reutiliza `common.download`, que já existe nos dois arquivos.

- [ ] **Step 2: Rewrite the component**

Substituir o conteúdo de `frontend/src/components/FilePreviewModal.vue` por:

```vue
<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { IconChevronLeft, IconChevronRight, IconDownload, IconPlayerPlay, IconX } from '@tabler/icons-vue';
import { useI18n } from 'vue-i18n';

const props = defineProps({
	file: { type: Object, default: null },
	isOpen: { type: Boolean, default: false },
	isLoading: { type: Boolean, default: false },
	previewText: { type: String, default: null },
	previewError: { type: String, default: null },
	hasPrevious: { type: Boolean, default: false },
	hasNext: { type: Boolean, default: false },
});

const emit = defineEmits(['close', 'loaded', 'failed', 'previous', 'next', 'download']);

const { t } = useI18n();

const zoom = ref(1);

const displayName = computed(() => {
	if (!props.file) return '';
	return props.file.display_name || props.file.file_name || props.file.name || '';
});

const isVisible = computed(() => Boolean(props.isOpen && props.file));

function onKeydown(event) {
	if (event.key === 'Escape') {
		emit('close');
		return;
	}
	// As setas pertencem aos controles de midia quando o foco esta neles.
	if (event.target instanceof HTMLMediaElement) return;
	if (event.key === 'ArrowLeft' && props.hasPrevious) emit('previous');
	if (event.key === 'ArrowRight' && props.hasNext) emit('next');
}

watch(isVisible, (visible) => {
	zoom.value = 1;
	if (visible) window.addEventListener('keydown', onKeydown);
	else window.removeEventListener('keydown', onKeydown);
});

watch(() => props.file?.id, () => {
	zoom.value = 1;
});

onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));

// ponytail: zoom por transform, sem lib de pan/pinch. Se precisar arrastar a imagem
// ampliada, ai sim vale uma biblioteca.
function toggleZoom() {
	zoom.value = zoom.value > 1 ? 1 : 2;
}

function onWheelZoom(event) {
	event.preventDefault();
	const next = zoom.value + (event.deltaY < 0 ? 0.25 : -0.25);
	zoom.value = Math.min(4, Math.max(1, Number(next.toFixed(2))));
}
</script>

<template>
	<div v-if="isVisible" class="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 px-4 py-8" @click="emit('close')">
		<div class="flex max-h-full w-full max-w-5xl flex-col overflow-hidden rounded-[28px] bg-white text-[#202124] shadow-[0_24px_60px_rgba(32,33,36,0.28)] dark:bg-slate-900 dark:text-slate-100" @click.stop>
			<div class="flex items-center justify-between gap-4 border-b border-[#e8eaed] px-5 py-4 dark:border-slate-800">
				<div class="min-w-0">
					<p class="truncate text-base font-semibold">{{ displayName }}</p>
				</div>
				<div class="flex items-center gap-2">
					<button type="button" class="grid size-10 place-items-center rounded-full text-[#5f6368] hover:bg-black/5 disabled:opacity-40 dark:text-slate-400 dark:hover:bg-white/8" :disabled="!props.hasPrevious" :title="t('preview.previous')" @click="emit('previous')">
						<IconChevronLeft :size="18" :stroke="2" />
					</button>
					<button type="button" class="grid size-10 place-items-center rounded-full text-[#5f6368] hover:bg-black/5 disabled:opacity-40 dark:text-slate-400 dark:hover:bg-white/8" :disabled="!props.hasNext" :title="t('preview.next')" @click="emit('next')">
						<IconChevronRight :size="18" :stroke="2" />
					</button>
					<button type="button" class="grid size-10 place-items-center rounded-full text-[#5f6368] hover:bg-black/5 dark:text-slate-400 dark:hover:bg-white/8" :title="t('common.download')" @click="emit('download')">
						<IconDownload :size="18" :stroke="2" />
					</button>
					<button type="button" class="grid size-10 place-items-center rounded-full text-[#5f6368] hover:bg-black/5 dark:text-slate-400 dark:hover:bg-white/8" @click="emit('close')">
						<IconX :size="18" :stroke="2" />
					</button>
				</div>
			</div>
			<div class="relative min-h-[420px] flex-1 overflow-auto bg-[#f8fafd] dark:bg-slate-950">
				<div v-if="props.isLoading && !props.previewError" class="absolute inset-0 z-10 grid place-items-center text-sm text-[#5f6368] dark:text-slate-400">
					{{ t('preview.loading') }}
				</div>

				<div v-if="props.previewError" class="grid min-h-[420px] place-items-center px-6 text-center text-sm text-[#5f6368] dark:text-slate-400">
					<div>
						<p>{{ props.previewError }}</p>
						<button type="button" class="mt-4 rounded-full bg-[#1a73e8] px-5 py-2 text-sm font-medium text-white" @click="emit('download')">
							{{ t('common.download') }}
						</button>
					</div>
				</div>

				<div v-else-if="props.file?.previewType === 'image'" class="grid min-h-[420px] place-items-center overflow-auto" :title="t('preview.zoomHint')" @wheel="onWheelZoom">
					<img :src="props.file?.previewUrl" class="max-h-[75vh] w-full origin-center object-contain transition-transform" :style="{ transform: `scale(${zoom})`, cursor: zoom > 1 ? 'zoom-out' : 'zoom-in' }" alt="Preview file" @click="toggleZoom" @load="emit('loaded')" @error="emit('failed')" />
				</div>

				<video v-else-if="props.file?.previewType === 'video'" class="max-h-[75vh] w-full bg-black" controls playsinline @loadeddata="emit('loaded')" @error="emit('failed')">
					<source :src="props.file?.previewUrl" :type="props.file?.mime_type || 'video/mp4'" />
				</video>

				<div v-else-if="props.file?.previewType === 'audio'" class="grid min-h-[420px] place-items-center px-6">
					<audio class="w-full max-w-xl" controls @loadeddata="emit('loaded')" @error="emit('failed')">
						<source :src="props.file?.previewUrl" :type="props.file?.mime_type || 'audio/mpeg'" />
					</audio>
				</div>

				<iframe v-else-if="props.file?.previewType === 'pdf'" :src="props.file?.previewUrl" class="h-[75vh] w-full border-0" :title="t('preview.document')" @load="emit('loaded')" />

				<pre v-else-if="props.file?.previewType === 'text'" class="h-[75vh] w-full overflow-auto whitespace-pre-wrap break-words px-5 py-4 font-mono text-xs leading-relaxed">{{ props.previewText }}</pre>

				<div v-else class="grid min-h-[420px] place-items-center px-6 text-center text-sm text-[#5f6368] dark:text-slate-400">
					<div>
						<div class="mx-auto grid size-16 place-items-center rounded-full bg-[#e8f0fe] text-[#1a73e8] dark:bg-slate-800">
							<IconPlayerPlay :size="28" :stroke="1.8" />
						</div>
						<p class="mt-4">{{ t('preview.notAvailable') }}</p>
					</div>
				</div>
			</div>
		</div>
	</div>
</template>
```

- [ ] **Step 3: Verify the build**

```bash
cd frontend && npm run build
```

Expected: build sem erros. Se `IconChevronLeft`/`IconChevronRight`/`IconDownload` não existirem em `@tabler/icons-vue`, o build falha na resolução do import — nesse caso confirmar os nomes com:

```bash
cd frontend && node -e "import('@tabler/icons-vue').then(m => console.log(['IconChevronLeft','IconChevronRight','IconDownload'].map(n => [n, typeof m[n]])))"
```

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/FilePreviewModal.vue frontend/src/locales/en.json frontend/src/locales/id.json
git commit -m "feat: render audio, text and zoomable images in the preview modal"
```

---

### Task 8: Ligar o composable às quatro views

**Files:**
- Modify: `frontend/src/composables/useFileActions.js:8-47` e o bloco de retorno em `:220-227`
- Modify: `frontend/src/views/MyDriveView.vue`
- Modify: `frontend/src/views/StarredView.vue`
- Modify: `frontend/src/views/SharedWithMeView.vue`
- Modify: `frontend/src/views/RecentView.vue`

**Interfaces:**
- Consumes: tudo produzido pelas Tasks 5-7.
- Produces: previsualização com teclado, navegação, download e erro funcionando em My Drive, Starred, Shared with me e Recent.

- [ ] **Step 1: Forward the new options in useFileActions**

Em `frontend/src/composables/useFileActions.js`, substituir a desestruturação de `useFilePreviewModal` (linhas 30-47) por:

```js
	const {
		previewFile,
		isPreviewOpen,
		isPreviewLoading,
		previewError,
		previewText,
		canPreview,
		hasPreviousPreview,
		hasNextPreview,
		openPreview,
		closePreview,
		showPreviousPreview,
		showNextPreview,
		handlePreviewLoaded,
		handlePreviewFailed,
	} = useFilePreviewModal({
		getFileCategory,
		buildPreviewUrl: (file) => api.previewUrl(file.id),
		getPreviewType,
		sourceList,
		fetchText: (_url, file) => api.previewText(file.id),
		textLoadErrorMessage: t('preview.failed'),
		loadErrorMessage: t('preview.failed'),
		onUnsupported: () => {
			closeContextMenu();
			errorRef.value = previewUnsupportedMessage;
		},
	});
```

E, no objeto retornado (linhas 220-227), acrescentar as chaves novas junto das existentes:

```js
		previewFile,
		isPreviewOpen,
		isPreviewLoading,
		previewError,
		previewText,
		canPreview,
		hasPreviousPreview,
		hasNextPreview,
		openPreview,
		closePreview,
		showPreviousPreview,
		showNextPreview,
		handlePreviewLoaded,
		handlePreviewFailed,
```

- [ ] **Step 2: Pass getPreviewType from every view**

Em cada uma das quatro views (`MyDriveView.vue`, `StarredView.vue`, `SharedWithMeView.vue`, `RecentView.vue`):

1. No import de `useFileType`, incluir `getPreviewType`:

```js
import { getFileCategory, getFileIcon, getPreviewType } from '../composables/useFileType';
```

(manter os demais símbolos que a view já importava desse módulo)

2. Na chamada de `useFileActions({ ... })`, acrescentar a opção (hoje nenhuma das
   quatro views a passa, então `canPreview` ainda cai no caminho antigo baseado em
   `getFileCategory`):

```js
	getPreviewType,
```

3. Na desestruturação do retorno de `useFileActions`, acrescentar:

```js
	previewError,
	previewText,
	hasPreviousPreview,
	hasNextPreview,
	showPreviousPreview,
	showNextPreview,
```

- [ ] **Step 3: Wire the modal props and events**

Em cada view, substituir a tag `<FilePreviewModal ... />` por:

```html
			<FilePreviewModal :file="previewFile" :is-open="isPreviewOpen" :is-loading="isPreviewLoading" :preview-text="previewText" :preview-error="previewError" :has-previous="hasPreviousPreview" :has-next="hasNextPreview" @close="closePreview" @loaded="handlePreviewLoaded" @failed="handlePreviewFailed" @previous="showPreviousPreview" @next="showNextPreview" @download="downloadSelection" />
```

Se a view não expõe `downloadSelection` no escopo do template, usar o handler de download que ela já usa no `FileListSelectionBar` — em `MyDriveView.vue` é `downloadSelection` (linha 366).

- [ ] **Step 4: Verify the build and the suites**

```bash
cd frontend && npm run build && npm test
```

Expected: build sem erros e testes passando.

```bash
cd backend && npm test
```

Expected: PASS.

- [ ] **Step 5: Manual smoke test**

```bash
docker compose up -d --build backend frontend
```

Verificar no navegador:
1. Abrir um `.docx` → aparece o PDF convertido (a primeira abertura demora; a segunda é imediata).
2. Abrir um `.mp3` → player de áudio nativo, com seek.
3. Abrir um `.mp4` grande → arrastar a barra de progresso funciona.
4. Abrir um `.txt` → texto monoespaçado, com scroll.
5. Abrir uma imagem → clicar amplia, roda do mouse ajusta.
6. Esc fecha; ← e → trocam de arquivo pulando os não previsualizáveis.
7. Abrir um `.zip` pelo menu de contexto → a opção de preview está desabilitada.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/composables/useFileActions.js frontend/src/views
git commit -m "feat: wire preview navigation and download into the file views"
```

---

## Verificação final

```bash
cd backend && npm test && cd ../frontend && npm test && npm run build
```

Todos verdes antes de considerar o plano concluído.
