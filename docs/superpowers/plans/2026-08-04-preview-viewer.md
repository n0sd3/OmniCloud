# Visualizador de arquivos — Plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Substituir o modal de preview por um visualizador full-screen com carrossel por swipe, tira de miniaturas, PDF/Office que funciona no telefone, mais tipos de arquivo e players de mídia completos.

**Architecture:** Um shell (`FilePreviewViewer`) controla carrossel via `scroll-snap` nativo e `IntersectionObserver`; cada `PreviewSlide` é autônomo — busca o próprio conteúdo e mantém o próprio estado de carga/erro — e escolhe o renderizador por um mapa `previewType → componente`. O backend ganha rotas de página de PDF (`pdftoppm`, já instalado) e de listagem de compactados (`unzip`/`7z`), no mesmo padrão de cache e autenticação das rotas de preview e thumbnail existentes. As tabelas de tipo de front e back passam a sair de um workspace `shared/`.

**Tech Stack:** Vue 3 (`<script setup>`), Tailwind 4, Vite 8, Express, better-sqlite3, `node --test` para testes, `pdftoppm`/`pdfinfo` (poppler), `libreoffice`, `ffmpeg`, `unzip`/`7z`.

**Spec:** `docs/superpowers/specs/2026-08-04-preview-viewer-design.md`

## Global Constraints

- Indentação: **tab**, em todo arquivo `.js` e `.vue`. O repositório inteiro usa tab.
- Testes: `node --test`, sem framework adicional. Frontend: `npm --prefix frontend test`. Backend: `npm --prefix backend test`.
- Não existe biblioteca de teste de componente Vue no projeto. Lógica que precisa de teste vai para um `.js` puro, importado pelo componente. Componentes são verificados por build + verificação manual.
- Comentários no código: português, sem acento (padrão atual do repositório). Comentários explicam *por que*, nunca *o que*.
- Simplificações deliberadas levam comentário `// ponytail: <o que foi cortado>, <quando adicionar>`.
- Novas dependências de frontend só entram com `import()` dinâmico dentro do renderizador que as usa. Nenhuma vai para o bundle inicial.
- Toda rota nova de backend usa `getFileContext(req.user.id, req.params.id)` + `ensureFileContext(context, res)`, como as rotas vizinhas em `backend/src/routes/fileRoutes.js`.
- Códigos de erro do backend: 415 = tipo não suportado ou arquivo grande demais; 422 = conversão falhou; 404 = recurso inexistente.
- Mensagens de UI sempre via `t('...')` de `vue-i18n`, com a chave adicionada em **todos** os arquivos de `frontend/src/locales/`.
- Commits em inglês, no formato `tipo(escopo): descrição`.

---

## Estrutura de arquivos

**Novos:**

| Arquivo | Responsabilidade |
|---|---|
| `shared/package.json` | Workspace `@omnicloud/shared` |
| `shared/src/previewTypes.js` | Mapa único extensão/mime → tipo de preview |
| `shared/test/previewTypes.test.js` | Teste do mapa |
| `frontend/src/components/preview/FilePreviewViewer.vue` | Shell full-screen, carrossel, cabeçalho, auto-hide |
| `frontend/src/components/preview/PreviewSlide.vue` | Um arquivo: escolhe renderizador, guarda estado de carga |
| `frontend/src/components/preview/PreviewThumbStrip.vue` | Tira de miniaturas |
| `frontend/src/components/preview/renderers/ImageRender.vue` | Imagem com zoom |
| `frontend/src/components/preview/renderers/MediaRender.vue` | Vídeo e áudio |
| `frontend/src/components/preview/renderers/PagedRender.vue` | PDF/Office paginado |
| `frontend/src/components/preview/renderers/TextRender.vue` | Texto, código, markdown, CSV |
| `frontend/src/components/preview/renderers/ArchiveRender.vue` | Conteúdo de compactado |
| `frontend/src/components/preview/renderers/FallbackRender.vue` | Sem preview |
| `frontend/src/composables/usePreviewChrome.js` | Estado de auto-hide dos controles |
| `frontend/src/composables/useMediaResume.js` | Posição de reprodução em `localStorage` |
| `frontend/src/composables/useTextPreview.js` | Detecção de linguagem e leitura de CSV |
| `backend/src/services/pdfPageService.js` | Contagem e rasterização de página |
| `backend/src/services/archiveService.js` | Listagem de compactado |

**Modificados:**

| Arquivo | Mudança |
|---|---|
| `package.json` (raiz) | `workspaces` ganha `shared` |
| `frontend/src/composables/useFileType.js` | Passa a consumir `@omnicloud/shared` |
| `backend/src/services/previewService.js` | `getPreviewKind` passa a consumir `@omnicloud/shared` |
| `frontend/src/composables/useFilePreviewModal.js` | Estado de carrossel; carga de conteúdo sai daqui |
| `frontend/src/composables/useFileActions.js` | Ajuste ao novo retorno do composable |
| `frontend/src/components/FileListSurface.vue` | Usa `FilePreviewViewer` |
| `backend/src/routes/fileRoutes.js` | Rotas `preview/pages`, `preview/page/:n`, `preview/entries` |
| `frontend/src/services/api.js` | Métodos para as rotas novas |
| `frontend/src/locales/*.json` | Chaves novas |

**Removido:** `frontend/src/components/FilePreviewModal.vue`

---

### Task 1: Workspace `shared` com o mapa único de tipos

**Files:**
- Create: `shared/package.json`, `shared/src/previewTypes.js`, `shared/test/previewTypes.test.js`
- Modify: `package.json:16-19`, `frontend/src/composables/useFileType.js:29-110`, `backend/src/services/previewService.js:10-54`, `frontend/test/previewType.test.js`
- Test: `shared/test/previewTypes.test.js`

**Interfaces:**
- Consumes: nada.
- Produces: `previewTypeFor({ mimeType, extension })` → `'image' | 'video' | 'audio' | 'pdf' | 'office' | 'text' | null`. Também exporta os conjuntos `IMAGE_EXTENSIONS`, `VIDEO_EXTENSIONS`, `AUDIO_EXTENSIONS`, `OFFICE_EXTENSIONS`, `TEXT_EXTENSIONS` (todos `Set` de extensão **sem** ponto) e `extensionOf(name)`.

Nota de escopo: esta task **não** adiciona tipos novos (`archive`, código, markdown). Ela só unifica o que já existe, para que o comportamento observável não mude. Tipos novos entram nas tasks que sabem renderizá-los.

- [ ] **Step 1: Criar o workspace**

`shared/package.json`:

```json
{
	"name": "@omnicloud/shared",
	"version": "1.0.0",
	"private": true,
	"type": "module",
	"main": "src/previewTypes.js",
	"exports": {
		".": "./src/previewTypes.js"
	},
	"scripts": {
		"test": "node --test \"test/*.test.js\""
	}
}
```

Em `package.json` da raiz, `workspaces` passa a ser `["backend", "frontend", "shared"]`.

- [ ] **Step 2: Escrever o teste que falha**

`shared/test/previewTypes.test.js`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { extensionOf, previewTypeFor } from '../src/previewTypes.js';

test('extensionOf reads the last suffix, lowercased, without the dot', () => {
	assert.equal(extensionOf('Photo.JPG'), 'jpg');
	assert.equal(extensionOf('archive.tar.gz'), 'gz');
	assert.equal(extensionOf('Makefile'), '');
	assert.equal(extensionOf(''), '');
});

test('previewTypeFor classifies by mime first, extension second', () => {
	assert.equal(previewTypeFor({ mimeType: 'image/png' }), 'image');
	assert.equal(previewTypeFor({ extension: 'heic' }), 'image');
	assert.equal(previewTypeFor({ mimeType: 'video/mp4' }), 'video');
	assert.equal(previewTypeFor({ extension: 'mkv' }), 'video');
	assert.equal(previewTypeFor({ mimeType: 'audio/mpeg' }), 'audio');
	assert.equal(previewTypeFor({ mimeType: 'application/pdf' }), 'pdf');
	assert.equal(previewTypeFor({ extension: 'pdf' }), 'pdf');
	assert.equal(previewTypeFor({ extension: 'docx' }), 'office');
	assert.equal(previewTypeFor({ mimeType: 'application/msword' }), 'office');
	assert.equal(previewTypeFor({ mimeType: 'text/plain' }), 'text');
	assert.equal(previewTypeFor({ mimeType: 'application/json' }), 'text');
	assert.equal(previewTypeFor({ extension: 'yaml' }), 'text');
	assert.equal(previewTypeFor({}), null);
	assert.equal(previewTypeFor({ mimeType: 'application/octet-stream', extension: 'bin' }), null);
});

test('an office mime beats a generic octet-stream mime on the extension', () => {
	assert.equal(previewTypeFor({ mimeType: 'application/octet-stream', extension: 'xlsx' }), 'office');
});
```

- [ ] **Step 3: Rodar o teste e confirmar que falha**

Run: `npm --prefix shared test`
Expected: FAIL — `Cannot find module '../src/previewTypes.js'`

- [ ] **Step 4: Implementar**

`shared/src/previewTypes.js`:

```js
// Mapa unico de tipo de preview. Front e back importam daqui: as duas listas
// separadas divergiam em silencio e era isso que fazia o docx abrir em branco.

export const IMAGE_EXTENSIONS = new Set(['avif', 'bmp', 'gif', 'heic', 'jpeg', 'jpg', 'png', 'svg', 'tif', 'tiff', 'webp']);
export const VIDEO_EXTENSIONS = new Set(['avi', 'm4v', 'mkv', 'mov', 'mp4', 'webm']);
export const AUDIO_EXTENSIONS = new Set(['aac', 'flac', 'm4a', 'mp3', 'ogg', 'wav']);
export const OFFICE_EXTENSIONS = new Set(['doc', 'docx', 'odp', 'ods', 'odt', 'ppt', 'pptx', 'xls', 'xlsx']);
export const TEXT_EXTENSIONS = new Set(['csv', 'json', 'log', 'md', 'txt', 'xml', 'yaml', 'yml']);

export function extensionOf(name) {
	const parts = String(name || '').toLowerCase().split('.');
	return parts.length > 1 ? parts.at(-1) : '';
}

export function previewTypeFor({ mimeType = '', extension = '' } = {}) {
	const mime = String(mimeType).toLowerCase();
	const ext = String(extension).toLowerCase().replace(/^\./, '');

	if (mime.startsWith('image/') || IMAGE_EXTENSIONS.has(ext)) return 'image';
	if (mime.startsWith('video/') || VIDEO_EXTENSIONS.has(ext)) return 'video';
	if (mime.startsWith('audio/') || AUDIO_EXTENSIONS.has(ext)) return 'audio';
	if (mime === 'application/pdf' || ext === 'pdf') return 'pdf';
	if (
		OFFICE_EXTENSIONS.has(ext)
		|| mime.includes('officedocument')
		|| mime.includes('opendocument')
		|| mime.includes('msword')
		|| mime.includes('ms-excel')
		|| mime.includes('ms-powerpoint')
	) return 'office';
	if (mime.startsWith('text/') || mime === 'application/json' || TEXT_EXTENSIONS.has(ext)) return 'text';

	return null;
}
```

- [ ] **Step 5: Rodar o teste e confirmar que passa**

Run: `npm install && npm --prefix shared test`
Expected: PASS (o `npm install` cria o link do workspace em `node_modules/@omnicloud/shared`)

- [ ] **Step 6: Backend passa a consumir o shared**

Em `backend/src/services/previewService.js`, apagar as cinco constantes de extensão do topo (linhas 10-14) e reescrever `getPreviewKind`:

```js
import { extensionOf, previewTypeFor } from '@omnicloud/shared';
```

```js
export function getPreviewKind(file) {
	if (!file || file.is_folder) return null;
	const { mimeType, extension } = effectivePreviewSource(file);
	return previewTypeFor({ mimeType, extension });
}
```

`effectivePreviewSource` continua igual — ela é que resolve o formato de exportação dos arquivos nativos do Google. `extensionOf` não é usada aqui porque `effectivePreviewSource` já devolve a extensão com ponto, e `previewTypeFor` aceita as duas formas.

Adicionar `"@omnicloud/shared": "*"` em `dependencies` de `backend/package.json`.

- [ ] **Step 7: Rodar os testes do backend**

Run: `npm --prefix backend test`
Expected: PASS — `previewService.test.js` e `previewRoutes.test.js` continuam verdes, porque o resultado é o mesmo de antes.

- [ ] **Step 8: Frontend passa a consumir o shared**

Em `frontend/src/composables/useFileType.js`: apagar `IMAGE_EXTENSIONS`, `VIDEO_EXTENSIONS`, `AUDIO_EXTENSIONS`, `OFFICE_EXTENSIONS`, `TEXT_EXTENSIONS` e a função local `getFileExtension`; importar do shared. `DOCUMENT_EXTENSIONS` e `GOOGLE_PREVIEW_TYPES` ficam (só o front usa). `getFileCategory`, `getFileIcon`, `getTypeFilterIcon` e `canShowGridThumbnail` continuam neste arquivo, com `getFileExtension` trocado por `extensionOf(file.display_name || file.file_name || '')`.

```js
import { extensionOf, previewTypeFor, IMAGE_EXTENSIONS, VIDEO_EXTENSIONS, AUDIO_EXTENSIONS } from '@omnicloud/shared';
```

`getPreviewType` passa a ser:

```js
export function getPreviewType(file) {
	if (!file || file.is_folder) return null;

	const mimeType = (file.mime_type || file.mimeType || '').toLowerCase();
	if (GOOGLE_PREVIEW_TYPES[mimeType]) return GOOGLE_PREVIEW_TYPES[mimeType];

	return previewTypeFor({ mimeType, extension: extensionOf(file.display_name || file.file_name || '') });
}
```

Atenção: `getPreviewType` agora devolve `'office'` para docx/xlsx/etc, onde antes devolvia `'pdf'`. Quem consome isso hoje é o `v-else-if` de `FilePreviewModal.vue:115`, que só conhece `'pdf'`. Para não quebrar o preview nesta task, ajustar a condição daquele `v-else-if` para:

```html
<iframe v-else-if="props.file?.previewType === 'pdf' || props.file?.previewType === 'office'" ...
```

(o arquivo inteiro morre na Task 3; isto é só a ponte)

Adicionar `"@omnicloud/shared": "*"` em `dependencies` de `frontend/package.json`.

- [ ] **Step 9: Atualizar o teste de acordo entre front e back**

`frontend/test/previewType.test.js` hoje traduz `office` → `pdf` para comparar. Agora os dois lados devolvem exatamente o mesmo valor. Substituir o corpo do primeiro teste por:

```js
test('getPreviewType agrees with the backend', () => {
	for (const file of FIXTURES) {
		assert.equal(getPreviewType(file), getPreviewKind(file), file.file_name);
	}
});
```

Manter os demais testes do arquivo como estão.

- [ ] **Step 10: Rodar tudo e confirmar**

Run: `npm --prefix frontend test && npm --prefix backend test && npm --prefix shared test && npm --prefix frontend run build`
Expected: PASS nos três, build sem erro.

- [ ] **Step 11: Commit**

```bash
git add package.json package-lock.json shared backend/package.json backend/src/services/previewService.js frontend/package.json frontend/src/composables/useFileType.js frontend/src/components/FilePreviewModal.vue frontend/test/previewType.test.js
git commit -m "refactor(preview): share one file-type map between frontend and backend"
```

---

### Task 2: Estado de carrossel no composable

**Files:**
- Modify: `frontend/src/composables/useFilePreviewModal.js` (reescrita), `frontend/src/composables/useFileActions.js:30-57,231-244`, `frontend/src/components/FileListSurface.vue:72-84,197`
- Test: `frontend/test/useFilePreviewModal.test.js` (reescrita)

**Interfaces:**
- Consumes: `getPreviewType(file)` da Task 1.
- Produces: `useFilePreviewModal({ getPreviewType, sourceList, onUnsupported })` devolvendo `{ previewFile, isPreviewOpen, previewableFiles, currentIndex, total, canPreview, hasPreviousPreview, hasNextPreview, openPreview, closePreview, showPreviousPreview, showNextPreview, goToIndex, isNear }`.
  - `currentIndex: ComputedRef<number>` — posição do arquivo atual em `previewableFiles`, `-1` se nenhum.
  - `total: ComputedRef<number>`.
  - `goToIndex(i: number): void` — ignora índice fora do intervalo.
  - `isNear(i: number): boolean` — verdadeiro para `currentIndex ± 1`.

Mudança de responsabilidade: carga de conteúdo (`fetchText`, `previewText`, `isPreviewLoading`, `previewError`, `handlePreviewLoaded`, `handlePreviewFailed`, `buildPreviewUrl`) **sai** deste composable. Com carrossel, cada slide carrega e falha por conta própria; um estado global de "carregando" mentiria sobre qual slide está carregando. Quem passa a fazer isso é `PreviewSlide` (Task 3).

- [ ] **Step 1: Escrever os testes que falham**

Substituir `frontend/test/useFilePreviewModal.test.js` inteiro por:

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
		getPreviewType: (file) => ({ a: 'image', c: 'pdf', d: 'text' })[file?.id] ?? null,
		sourceList,
		...overrides,
	});
}

test('navigation walks only over previewable files', () => {
	const modal = setup();

	modal.openPreview(IMAGE);
	assert.equal(modal.hasPreviousPreview.value, false);
	assert.equal(modal.hasNextPreview.value, true);

	modal.showNextPreview();
	assert.equal(modal.previewFile.value.id, 'c', 'skips the zip');

	modal.showNextPreview();
	assert.equal(modal.previewFile.value.id, 'd');
	assert.equal(modal.hasNextPreview.value, false);

	modal.showNextPreview();
	assert.equal(modal.previewFile.value.id, 'd', 'stops at the end');
});

test('currentIndex and total describe the position in the previewable list', () => {
	const modal = setup();
	assert.equal(modal.total.value, 3);
	assert.equal(modal.currentIndex.value, -1);

	modal.openPreview(PDF);
	assert.equal(modal.currentIndex.value, 1);
});

test('goToIndex jumps and ignores out-of-range values', () => {
	const modal = setup();
	modal.openPreview(IMAGE);

	modal.goToIndex(2);
	assert.equal(modal.previewFile.value.id, 'd');

	modal.goToIndex(9);
	assert.equal(modal.previewFile.value.id, 'd', 'ignores an index past the end');

	modal.goToIndex(-1);
	assert.equal(modal.previewFile.value.id, 'd', 'ignores a negative index');
});

test('isNear covers the current slide and its two neighbours', () => {
	const modal = setup();
	modal.openPreview(PDF);

	assert.equal(modal.isNear(0), true);
	assert.equal(modal.isNear(1), true);
	assert.equal(modal.isNear(2), true);

	modal.openPreview(IMAGE);
	assert.equal(modal.isNear(2), false);
});

test('opening an unsupported file reports instead of opening', () => {
	let reported = null;
	const modal = setup({ onUnsupported: (file) => { reported = file; } });

	assert.equal(modal.openPreview(ZIP), false);
	assert.equal(modal.isPreviewOpen.value, false);
	assert.equal(reported.id, 'b');
});

test('closePreview clears the current file', () => {
	const modal = setup();
	modal.openPreview(IMAGE);
	modal.closePreview();

	assert.equal(modal.isPreviewOpen.value, false);
	assert.equal(modal.previewFile.value, null);
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npm --prefix frontend test -- --test-name-pattern="currentIndex"`
Expected: FAIL — `modal.total` é `undefined`

- [ ] **Step 3: Reescrever o composable**

`frontend/src/composables/useFilePreviewModal.js` inteiro:

```js
import { computed, ref } from 'vue';

export function useFilePreviewModal({ getPreviewType, sourceList, onUnsupported } = {}) {
	if (typeof getPreviewType !== 'function') {
		throw new Error('useFilePreviewModal: getPreviewType is required');
	}

	const previewFile = ref(null);
	const isPreviewOpen = ref(false);

	const canPreview = (file) => Boolean(file && !file.is_folder && getPreviewType(file));

	const previewableFiles = computed(
		() => (sourceList?.value || []).filter((file) => canPreview(file)),
	);
	const total = computed(() => previewableFiles.value.length);
	const currentIndex = computed(
		() => previewableFiles.value.findIndex((file) => file.id === previewFile.value?.id),
	);
	const hasPreviousPreview = computed(() => currentIndex.value > 0);
	const hasNextPreview = computed(
		() => currentIndex.value >= 0 && currentIndex.value < total.value - 1,
	);

	function openPreview(file) {
		if (!canPreview(file)) {
			if (typeof onUnsupported === 'function') onUnsupported(file);
			return false;
		}
		previewFile.value = { ...file, previewType: getPreviewType(file) };
		isPreviewOpen.value = true;
		return true;
	}

	function closePreview() {
		isPreviewOpen.value = false;
		previewFile.value = null;
	}

	function goToIndex(index) {
		const next = previewableFiles.value[index];
		if (next) openPreview(next);
	}

	function showPreviousPreview() {
		if (hasPreviousPreview.value) goToIndex(currentIndex.value - 1);
	}

	function showNextPreview() {
		if (hasNextPreview.value) goToIndex(currentIndex.value + 1);
	}

	// Janela de montagem do carrossel: so o slide atual e os vizinhos imediatos
	// carregam conteudo, senao uma pasta com 200 videos monta 200 players.
	function isNear(index) {
		return currentIndex.value >= 0 && Math.abs(index - currentIndex.value) <= 1;
	}

	return {
		previewFile,
		isPreviewOpen,
		previewableFiles,
		currentIndex,
		total,
		canPreview,
		hasPreviousPreview,
		hasNextPreview,
		openPreview,
		closePreview,
		showPreviousPreview,
		showNextPreview,
		goToIndex,
		isNear,
	};
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npm --prefix frontend test`
Expected: PASS

- [ ] **Step 5: Ajustar `useFileActions`**

Em `frontend/src/composables/useFileActions.js`, a chamada passa a ser:

```js
	const {
		previewFile,
		isPreviewOpen,
		previewableFiles,
		currentIndex,
		total: previewTotal,
		canPreview,
		hasPreviousPreview,
		hasNextPreview,
		openPreview,
		closePreview,
		showPreviousPreview,
		showNextPreview,
		goToIndex,
		isNear,
	} = useFilePreviewModal({
		getPreviewType,
		sourceList,
		onUnsupported: () => {
			closeContextMenu();
			errorRef.value = previewUnsupportedMessage;
		},
	});
```

No objeto de retorno, trocar as chaves `isPreviewLoading`, `previewError`, `previewText`, `handlePreviewLoaded`, `handlePreviewFailed` por `previewableFiles`, `currentIndex`, `previewTotal`, `goToIndex`, `isNear`. As demais chaves ficam. O parâmetro `getFileCategory` continua sendo exigido pela guarda da linha 19 porque outras partes do composable o usam — não mexer nela.

- [ ] **Step 6: Ajustar `FileListSurface`**

Em `frontend/src/components/FileListSurface.vue`, no destructuring de `props.view` (linhas 72-84), fazer a mesma troca de nomes do Step 5. A linha 197 (`<FilePreviewModal ... />`) fica temporariamente assim, para o build não quebrar antes da Task 3:

```html
		<FilePreviewModal :file="previewFile" :is-open="isPreviewOpen" :has-previous="hasPreviousPreview" :has-next="hasNextPreview" @close="closePreview" @previous="showPreviousPreview" @next="showNextPreview" @download="triggerDownload(previewFile)" />
```

Em `FilePreviewModal.vue`, remover as props `isLoading`, `previewText`, `previewError` e os emits `loaded`/`failed`, junto com os blocos `v-if="props.isLoading"` e `v-if="props.previewError"`, e trocar o `<pre>` de texto por um aviso fixo `{{ t('preview.loading') }}` — o componente morre na próxima task e não vale investir nele.

Verificar também `frontend/src/composables/useFileListView.js:272` e `frontend/src/composables/useFileListKeyboard.js:17,83,95`, que referenciam `isPreviewOpen` — essa chave continua existindo, então não precisam mudar.

- [ ] **Step 7: Verificar**

Run: `npm --prefix frontend test && npm --prefix frontend run build`
Expected: PASS e build limpo.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/composables/useFilePreviewModal.js frontend/src/composables/useFileActions.js frontend/src/components/FileListSurface.vue frontend/src/components/FilePreviewModal.vue frontend/test/useFilePreviewModal.test.js
git commit -m "refactor(preview): move per-file loading state out of the preview composable"
```

---

### Task 3: Visualizador full-screen com carrossel

**Files:**
- Create: `frontend/src/components/preview/FilePreviewViewer.vue`, `frontend/src/components/preview/PreviewSlide.vue`, `frontend/src/components/preview/renderers/ImageRender.vue`, `.../MediaRender.vue`, `.../TextRender.vue`, `.../FallbackRender.vue`
- Modify: `frontend/src/components/FileListSurface.vue`, `frontend/src/locales/*.json`
- Delete: `frontend/src/components/FilePreviewModal.vue`

**Interfaces:**
- Consumes: `previewableFiles`, `currentIndex`, `total`, `goToIndex`, `isNear`, `hasPreviousPreview`, `hasNextPreview`, `showPreviousPreview`, `showNextPreview`, `closePreview` (Task 2); `api.previewUrl(fileId)`, `api.previewText(fileId)` (já existem em `frontend/src/services/api.js:308-315`).
- Produces: contrato de renderizador — todo componente em `renderers/` recebe `props.file` (objeto de arquivo com `previewType`) e `props.active` (boolean, verdadeiro só no slide centralizado) e emite `loaded` e `failed`. `PreviewSlide` só monta o renderizador quando `props.near` é verdadeiro.

- [ ] **Step 1: Chaves de tradução**

Em `frontend/src/locales/en.json` e `frontend/src/locales/id.json` (os dois que existem), adicionar dentro do objeto `preview`:

```json
"position": "{current} de {total}",
"pageOf": "Página {page}",
"openSource": "Ver fonte",
"openRendered": "Ver renderizado",
"speed": "Velocidade",
"pictureInPicture": "Picture-in-picture",
"entries": "{count} itens",
"truncatedEntries": "Mostrando os primeiros {count} itens"
```

(traduzir o valor conforme o idioma do arquivo; as chaves são idênticas em todos)

- [ ] **Step 2: `FallbackRender.vue`**

```html
<script setup>
import { IconFileDescription } from '@tabler/icons-vue';
import { onMounted } from 'vue';
import { useI18n } from 'vue-i18n';

defineProps({ file: { type: Object, required: true } });
const emit = defineEmits(['loaded', 'failed']);
const { t } = useI18n();

onMounted(() => emit('loaded'));
</script>

<template>
	<div class="grid h-full place-items-center px-6 text-center text-sm text-slate-300">
		<div>
			<div class="mx-auto grid size-16 place-items-center rounded-full bg-white/10 text-white">
				<IconFileDescription :size="28" :stroke="1.8" />
			</div>
			<p class="mt-4">{{ t('preview.notAvailable') }}</p>
		</div>
	</div>
</template>
```

- [ ] **Step 3: `ImageRender.vue`**

Porta o zoom que já existe em `FilePreviewModal.vue:52-62,101-103`, agora por arquivo:

```html
<script setup>
import { ref, watch } from 'vue';
import { api } from '../../../services/api';

const props = defineProps({
	file: { type: Object, required: true },
	active: { type: Boolean, default: false },
});
const emit = defineEmits(['loaded', 'failed']);

const zoom = ref(1);
watch(() => props.file.id, () => { zoom.value = 1; });

// ponytail: zoom por transform, sem lib de pan/pinch. Se precisar arrastar a
// imagem ampliada, ai sim vale uma biblioteca.
function toggleZoom() {
	zoom.value = zoom.value > 1 ? 1 : 2;
}

function onWheelZoom(event) {
	event.preventDefault();
	const next = zoom.value + (event.deltaY < 0 ? 0.25 : -0.25);
	zoom.value = Math.min(4, Math.max(1, Number(next.toFixed(2))));
}

defineExpose({ isZoomed: () => zoom.value > 1 });
</script>

<template>
	<div class="grid h-full place-items-center overflow-auto" @wheel="onWheelZoom">
		<img
			:src="api.previewUrl(props.file.id)"
			class="max-h-full max-w-full origin-center object-contain transition-transform"
			:style="{ transform: `scale(${zoom})`, cursor: zoom > 1 ? 'zoom-out' : 'zoom-in' }"
			:alt="props.file.display_name || props.file.file_name"
			@click.stop="toggleZoom"
			@load="emit('loaded')"
			@error="emit('failed')"
		/>
	</div>
</template>
```

- [ ] **Step 4: `MediaRender.vue` — versão mínima**

Vídeo e áudio nativos. A versão completa (velocidade, PiP, retomar, auto-próximo) chega na Task 9; aqui só o suficiente para não regredir o que já funciona.

```html
<script setup>
import { computed, ref, watch } from 'vue';
import { api } from '../../../services/api';

const props = defineProps({
	file: { type: Object, required: true },
	active: { type: Boolean, default: false },
});
const emit = defineEmits(['loaded', 'failed']);

const mediaRef = ref(null);
const isVideo = computed(() => props.file.previewType === 'video');
const source = computed(() => api.previewUrl(props.file.id));

// Sair do slide para sempre, com o video tocando em background, e o pior tipo
// de surpresa sonora.
watch(() => props.active, (active) => {
	if (!active) mediaRef.value?.pause();
});
</script>

<template>
	<div class="grid h-full place-items-center px-4">
		<video
			v-if="isVideo"
			ref="mediaRef"
			class="max-h-full w-full bg-black"
			controls
			playsinline
			:poster="api.thumbnailUrl(props.file)"
			@loadeddata="emit('loaded')"
			@error="emit('failed')"
		>
			<source :src="source" :type="props.file.mime_type || 'video/mp4'" />
		</video>
		<audio
			v-else
			ref="mediaRef"
			class="w-full max-w-xl"
			controls
			@loadeddata="emit('loaded')"
			@error="emit('failed')"
		>
			<source :src="source" :type="props.file.mime_type || 'audio/mpeg'" />
		</audio>
	</div>
</template>
```

- [ ] **Step 5: `TextRender.vue` — versão mínima**

Busca o próprio conteúdo (era responsabilidade do composable até a Task 2). Realce e markdown chegam na Task 8.

```html
<script setup>
import { onBeforeUnmount, ref, watch } from 'vue';
import { api } from '../../../services/api';

const MAX_TEXT_BYTES = 1024 * 1024;

const props = defineProps({
	file: { type: Object, required: true },
	active: { type: Boolean, default: false },
});
const emit = defineEmits(['loaded', 'failed']);

const body = ref('');
let currentToken = null;

async function load() {
	const token = props.file.id;
	currentToken = token;
	try {
		const text = await api.previewText(props.file.id);
		// Corrida: o usuario pode ter passado para outro arquivo antes da resposta.
		if (currentToken !== token) return;
		body.value = text.length > MAX_TEXT_BYTES ? text.slice(0, MAX_TEXT_BYTES) : text;
		emit('loaded');
	} catch {
		if (currentToken !== token) return;
		emit('failed');
	}
}

watch(() => props.file.id, load, { immediate: true });
onBeforeUnmount(() => { currentToken = null; });
</script>

<template>
	<pre class="h-full w-full overflow-auto whitespace-pre-wrap break-words px-5 py-4 font-mono text-xs leading-relaxed text-slate-100">{{ body }}</pre>
</template>
```

- [ ] **Step 6: `PreviewSlide.vue`**

```html
<script setup>
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import ImageRender from './renderers/ImageRender.vue';
import MediaRender from './renderers/MediaRender.vue';
import TextRender from './renderers/TextRender.vue';
import FallbackRender from './renderers/FallbackRender.vue';

const props = defineProps({
	file: { type: Object, required: true },
	active: { type: Boolean, default: false },
	near: { type: Boolean, default: false },
});
const emit = defineEmits(['download']);
const { t } = useI18n();

// Tipo novo custa uma linha aqui e um arquivo em renderers/, nunca mais um
// elo na cadeia de v-else-if que existia antes.
const RENDERERS = {
	image: ImageRender,
	video: MediaRender,
	audio: MediaRender,
	text: TextRender,
};

const renderer = computed(() => RENDERERS[props.file.previewType] || FallbackRender);
const state = ref('loading');

watch(() => props.file.id, () => { state.value = 'loading'; });
</script>

<template>
	<div class="relative flex h-full w-full shrink-0 snap-center items-center justify-center" :style="{ width: '100%' }">
		<template v-if="props.near">
			<component
				:is="renderer"
				:file="props.file"
				:active="props.active"
				@loaded="state = 'ready'"
				@failed="state = 'error'"
			/>

			<div v-if="state === 'loading'" class="pointer-events-none absolute inset-0 grid place-items-center text-sm text-slate-300">
				{{ t('preview.loading') }}
			</div>

			<div v-if="state === 'error'" class="absolute inset-0 grid place-items-center bg-black/80 px-6 text-center text-sm text-slate-300">
				<div>
					<p>{{ t('preview.failed') }}</p>
					<button type="button" class="mt-4 rounded-full bg-[#1a73e8] px-5 py-2 text-sm font-medium text-white" @click.stop="emit('download', props.file)">
						{{ t('common.download') }}
					</button>
				</div>
			</div>
		</template>
	</div>
</template>
```

- [ ] **Step 7: `FilePreviewViewer.vue`**

```html
<script setup>
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { IconChevronLeft, IconChevronRight, IconDownload, IconX } from '@tabler/icons-vue';
import { useI18n } from 'vue-i18n';
import PreviewSlide from './PreviewSlide.vue';

const props = defineProps({
	files: { type: Array, default: () => [] },
	currentIndex: { type: Number, default: -1 },
	total: { type: Number, default: 0 },
	isOpen: { type: Boolean, default: false },
	hasPrevious: { type: Boolean, default: false },
	hasNext: { type: Boolean, default: false },
	isNear: { type: Function, required: true },
	previewTypeOf: { type: Function, required: true },
});

const emit = defineEmits(['close', 'previous', 'next', 'goto', 'download']);
const { t } = useI18n();

const trackRef = ref(null);
let observer = null;
// Rolagem programatica dispara o observer e ele reemitiria 'goto' para o
// indice que acabamos de pedir: o flag corta esse eco.
let scrollingToIndex = false;

function scrollToCurrent(behavior = 'smooth') {
	const track = trackRef.value;
	const slide = track?.children?.[props.currentIndex];
	if (!slide) return;
	scrollingToIndex = true;
	slide.scrollIntoView({ behavior, block: 'nearest', inline: 'center' });
	window.setTimeout(() => { scrollingToIndex = false; }, 400);
}

function observeSlides() {
	observer?.disconnect();
	const track = trackRef.value;
	if (!track) return;
	observer = new IntersectionObserver((entries) => {
		if (scrollingToIndex) return;
		for (const entry of entries) {
			if (!entry.isIntersecting || entry.intersectionRatio < 0.6) continue;
			const index = Number(entry.target.dataset.index);
			if (index !== props.currentIndex) emit('goto', index);
		}
	}, { root: track, threshold: [0.6] });
	for (const child of track.children) observer.observe(child);
}

function onKeydown(event) {
	if (event.key === 'Escape') return emit('close');
	if (event.target instanceof HTMLMediaElement) return;
	if (event.key === 'ArrowLeft' && props.hasPrevious) emit('previous');
	if (event.key === 'ArrowRight' && props.hasNext) emit('next');
	if (event.key === 'Home') emit('goto', 0);
	if (event.key === 'End') emit('goto', props.total - 1);
}

watch(() => props.isOpen, async (open) => {
	if (!open) {
		observer?.disconnect();
		window.removeEventListener('keydown', onKeydown);
		document.body.style.overflow = '';
		return;
	}
	window.addEventListener('keydown', onKeydown);
	document.body.style.overflow = 'hidden';
	await nextTick();
	scrollToCurrent('auto');
	observeSlides();
});

watch(() => props.files.length, async () => {
	if (!props.isOpen) return;
	await nextTick();
	observeSlides();
});

watch(() => props.currentIndex, () => {
	if (props.isOpen) scrollToCurrent();
});

onBeforeUnmount(() => {
	observer?.disconnect();
	window.removeEventListener('keydown', onKeydown);
	document.body.style.overflow = '';
});

function displayName(file) {
	return file?.display_name || file?.file_name || file?.name || '';
}
</script>

<template>
	<div v-if="props.isOpen && props.total" class="fixed inset-0 z-50 bg-black/95">
		<div class="absolute inset-x-0 top-0 z-20 flex items-center gap-3 bg-gradient-to-b from-black/70 to-transparent px-4 py-3 text-white">
			<div class="min-w-0 flex-1">
				<p class="truncate text-sm font-semibold">{{ displayName(props.files[props.currentIndex]) }}</p>
				<p class="text-xs text-slate-300">{{ t('preview.position', { current: props.currentIndex + 1, total: props.total }) }}</p>
			</div>
			<button type="button" class="grid size-10 shrink-0 place-items-center rounded-full hover:bg-white/10" :title="t('common.download')" @click="emit('download', props.files[props.currentIndex])">
				<IconDownload :size="20" :stroke="2" />
			</button>
			<button type="button" class="grid size-10 shrink-0 place-items-center rounded-full hover:bg-white/10" :title="t('common.close')" @click="emit('close')">
				<IconX :size="20" :stroke="2" />
			</button>
		</div>

		<!-- ponytail: scroll-snap nativo no lugar de lib de gestos. Swipe, momentum
		     e scroll de trackpad saem de graca. -->
		<div ref="trackRef" class="flex h-full w-full snap-x snap-mandatory overflow-x-auto overflow-y-hidden overscroll-x-contain">
			<PreviewSlide
				v-for="(file, index) in props.files"
				:key="file.id"
				:data-index="index"
				:file="{ ...file, previewType: props.previewTypeOf(file) }"
				:active="index === props.currentIndex"
				:near="props.isNear(index)"
				class="h-full w-full shrink-0"
				@download="emit('download', $event)"
			/>
		</div>

		<button v-if="props.hasPrevious" type="button" class="absolute left-4 top-1/2 z-20 hidden size-12 -translate-y-1/2 place-items-center rounded-full bg-black/50 text-white hover:bg-black/70 sm:grid" :title="t('preview.previous')" @click="emit('previous')">
			<IconChevronLeft :size="24" :stroke="2" />
		</button>
		<button v-if="props.hasNext" type="button" class="absolute right-4 top-1/2 z-20 hidden size-12 -translate-y-1/2 place-items-center rounded-full bg-black/50 text-white hover:bg-black/70 sm:grid" :title="t('preview.next')" @click="emit('next')">
			<IconChevronRight :size="24" :stroke="2" />
		</button>
	</div>
</template>
```

Nota: `PreviewSlide` já tem `snap-center` e largura total na raiz; o `data-index` chega como atributo herdado, que é o que o `IntersectionObserver` lê.

- [ ] **Step 8: Ligar em `FileListSurface.vue`**

Trocar o import de `FilePreviewModal` por `FilePreviewViewer` (`./preview/FilePreviewViewer.vue`), importar `getPreviewType` de `../composables/useFileType.js` e substituir a linha 197 por:

```html
		<FilePreviewViewer :files="previewableFiles" :current-index="currentIndex" :total="previewTotal" :is-open="isPreviewOpen" :has-previous="hasPreviousPreview" :has-next="hasNextPreview" :is-near="isNear" :preview-type-of="getPreviewType" @close="closePreview" @previous="showPreviousPreview" @next="showNextPreview" @goto="goToIndex" @download="triggerDownload" />
```

Apagar `frontend/src/components/FilePreviewModal.vue`.

- [ ] **Step 9: Verificar**

Run: `npm --prefix frontend test && npm --prefix frontend run build && grep -rn "FilePreviewModal" frontend/src || true`
Expected: testes passam, build limpo, `grep` sem nenhum resultado.

- [ ] **Step 10: Verificação manual**

Rodar `npm run dev`, abrir uma pasta com pelo menos 3 imagens, abrir a primeira e confirmar: swipe lateral troca de arquivo (ou scroll horizontal no desktop); o contador acompanha; `←`/`→` e `Esc` funcionam; a página atrás não rola.

- [ ] **Step 11: Commit**

```bash
git add frontend/src/components/preview frontend/src/components/FileListSurface.vue frontend/src/locales
git rm frontend/src/components/FilePreviewModal.vue
git commit -m "feat(preview): full-screen viewer with swipe carousel"
```

---

### Task 4: Auto-hide dos controles e tira de miniaturas

**Files:**
- Create: `frontend/src/composables/usePreviewChrome.js`, `frontend/src/components/preview/PreviewThumbStrip.vue`
- Create: `frontend/test/usePreviewChrome.test.js`
- Modify: `frontend/src/components/preview/FilePreviewViewer.vue`

**Interfaces:**
- Consumes: `api.thumbnailUrl(file)` (`frontend/src/services/api.js:316`), `getFileIcon(file, filled)` e `canShowGridThumbnail(file)` (`frontend/src/composables/useFileType.js`).
- Produces: `usePreviewChrome({ timeoutMs = 3000 })` → `{ visible, show, hide, toggle, hold, release }`. `hold()` impede o auto-hide enquanto algo o segura (vídeo pausado, menu aberto); `release()` devolve o comportamento normal e reinicia o temporizador. `hold`/`release` contam referências, então dois `hold()` exigem dois `release()`.

- [ ] **Step 1: Escrever o teste que falha**

`frontend/test/usePreviewChrome.test.js`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { usePreviewChrome } from '../src/composables/usePreviewChrome.js';

test('hides on its own after the timeout', async () => {
	const chrome = usePreviewChrome({ timeoutMs: 10 });
	chrome.show();
	assert.equal(chrome.visible.value, true);

	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(chrome.visible.value, false);
});

test('hold keeps it visible until every hold is released', async () => {
	const chrome = usePreviewChrome({ timeoutMs: 10 });
	chrome.show();
	chrome.hold();
	chrome.hold();

	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(chrome.visible.value, true, 'stays visible while held');

	chrome.release();
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(chrome.visible.value, true, 'one hold is still active');

	chrome.release();
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(chrome.visible.value, false);
});

test('toggle flips visibility and showing again restarts the timer', async () => {
	const chrome = usePreviewChrome({ timeoutMs: 40 });
	chrome.show();

	await new Promise((resolve) => setTimeout(resolve, 25));
	chrome.show();
	await new Promise((resolve) => setTimeout(resolve, 25));
	assert.equal(chrome.visible.value, true, 'the second show restarted the countdown');

	chrome.toggle();
	assert.equal(chrome.visible.value, false);
	chrome.toggle();
	assert.equal(chrome.visible.value, true);
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npm --prefix frontend test -- --test-name-pattern="hides on its own"`
Expected: FAIL — módulo inexistente

- [ ] **Step 3: Implementar**

`frontend/src/composables/usePreviewChrome.js`:

```js
import { onBeforeUnmount, ref } from 'vue';

export function usePreviewChrome({ timeoutMs = 3000 } = {}) {
	const visible = ref(true);
	let holds = 0;
	let timer = null;

	function clear() {
		if (timer) window.clearTimeout(timer);
		timer = null;
	}

	function arm() {
		clear();
		if (holds > 0) return;
		timer = window.setTimeout(() => { visible.value = false; }, timeoutMs);
	}

	function show() {
		visible.value = true;
		arm();
	}

	function hide() {
		clear();
		visible.value = false;
	}

	function toggle() {
		if (visible.value) hide();
		else show();
	}

	// Contagem de referencia: video pausado e menu aberto podem segurar ao mesmo
	// tempo, e soltar um nao pode esconder os controles que o outro ainda usa.
	function hold() {
		holds += 1;
		visible.value = true;
		clear();
	}

	function release() {
		holds = Math.max(0, holds - 1);
		if (holds === 0) arm();
	}

	onBeforeUnmount?.(clear);

	return { visible, show, hide, toggle, hold, release };
}
```

Nota: `onBeforeUnmount` fora de um componente lança aviso, não erro; a chamada opcional (`?.`) mantém o composable testável sem instância de componente ativa. Se o `node --test` reclamar de aviso, trocar por `if (getCurrentInstance()) onBeforeUnmount(clear)` importando `getCurrentInstance` de `vue`.

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npm --prefix frontend test`
Expected: PASS

- [ ] **Step 5: `PreviewThumbStrip.vue`**

```html
<script setup>
import { nextTick, ref, watch } from 'vue';
import { api } from '../../services/api';
import { canShowGridThumbnail, getFileIcon } from '../../composables/useFileType.js';

const props = defineProps({
	files: { type: Array, default: () => [] },
	currentIndex: { type: Number, default: -1 },
});
const emit = defineEmits(['goto']);

const stripRef = ref(null);

watch(() => props.currentIndex, async () => {
	await nextTick();
	stripRef.value?.children?.[props.currentIndex]?.scrollIntoView({
		behavior: 'smooth',
		block: 'nearest',
		inline: 'center',
	});
});
</script>

<template>
	<div ref="stripRef" class="flex gap-2 overflow-x-auto px-4 py-3">
		<button
			v-for="(file, index) in props.files"
			:key="file.id"
			type="button"
			class="grid size-14 shrink-0 place-items-center overflow-hidden rounded-lg bg-white/10 ring-2 transition"
			:class="index === props.currentIndex ? 'ring-[#1a73e8]' : 'ring-transparent hover:ring-white/40'"
			@click.stop="emit('goto', index)"
		>
			<img v-if="canShowGridThumbnail(file)" :src="api.thumbnailUrl(file)" :alt="file.display_name || file.file_name" class="size-full object-cover" loading="lazy" />
			<component :is="getFileIcon(file)" v-else :size="22" :stroke="1.8" class="text-slate-300" />
		</button>
	</div>
</template>
```

- [ ] **Step 6: Ligar no viewer**

Em `FilePreviewViewer.vue`:

1. Importar `usePreviewChrome` e `PreviewThumbStrip`.
2. `const chrome = usePreviewChrome();`
3. Envolver cabeçalho, setas laterais e a tira em `v-show="chrome.visible.value"`, cada um com `class="transition-opacity"`.
4. No `<div>` raiz, `@click="chrome.toggle()"` e `@mousemove="chrome.show()"`. Os elementos internos que já usam `@click.stop` (imagem, botões, miniaturas) não disparam o toggle — por isso os `.stop` dos steps anteriores são obrigatórios.
5. `watch(() => props.currentIndex, () => chrome.show())` para reexibir a cada troca.
6. Abaixo do carrossel, a tira:

```html
		<div v-show="chrome.visible.value" class="absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-black/80 to-transparent transition-opacity">
			<PreviewThumbStrip :files="props.files" :current-index="props.currentIndex" @goto="emit('goto', $event)" />
		</div>
```

- [ ] **Step 7: Fechar arrastando para baixo**

Ainda em `FilePreviewViewer.vue`, no `<div>` raiz:

```js
const dragStartY = ref(null);

function onTouchStart(event) {
	dragStartY.value = event.touches[0]?.clientY ?? null;
}

function onTouchEnd(event) {
	const start = dragStartY.value;
	dragStartY.value = null;
	if (start === null) return;
	const end = event.changedTouches[0]?.clientY ?? start;
	// Imagem ampliada usa o arrasto para pan; fechar so quando o gesto e claro
	// e vertical o bastante para nao competir com o swipe lateral.
	if (end - start > 120) emit('close');
}
```

com `@touchstart="onTouchStart"` e `@touchend="onTouchEnd"` no `<div>` raiz.

- [ ] **Step 8: Verificar**

Run: `npm --prefix frontend test && npm --prefix frontend run build`
Expected: PASS e build limpo.

- [ ] **Step 9: Verificação manual**

No telefone (ou DevTools em modo dispositivo): abrir o preview, confirmar que cabeçalho e tira somem após ~3 s, voltam ao tocar, que tocar numa miniatura pula para o arquivo e que a tira se recentraliza ao dar swipe. Arrastar de cima para baixo fecha.

- [ ] **Step 10: Commit**

```bash
git add frontend/src/composables/usePreviewChrome.js frontend/test/usePreviewChrome.test.js frontend/src/components/preview
git commit -m "feat(preview): auto-hiding chrome and thumbnail strip"
```

---

### Task 5: Backend — páginas de PDF

**Files:**
- Create: `backend/src/services/pdfPageService.js`, `backend/test/pdfPageService.test.js`
- Modify: `backend/src/routes/fileRoutes.js` (após a rota `/files/:id/preview`, antes de `/files/:id/thumbnail`)
- Test: `backend/test/pdfPageService.test.js`, `backend/test/previewRoutes.test.js`

**Interfaces:**
- Consumes: `getPreviewKind`, `getPreviewCacheKey`, `renderOfficePdf` (`backend/src/services/previewService.js`), `writeStreamToFile` (`backend/src/services/fileConvert.js`), `fileCacheService.openFile`, `env.previewCacheDir`.
- Produces:
  - `parsePageCount(stdout: string): number` — lê a saída de `pdfinfo`.
  - `getPdfPageCount({ userId, file, openStream, cacheDir?, execute? }): Promise<number>`
  - `renderPdfPage({ userId, file, page, openStream, cacheDir?, execute?, timeoutMs? }): Promise<string>` — devolve o caminho do JPEG da página.
  - Rotas `GET /files/:id/preview/pages` → `{ pageCount }` e `GET /files/:id/preview/page/:n` → `image/jpeg`.

- [ ] **Step 1: Escrever os testes que falham**

`backend/test/pdfPageService.test.js`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parsePageCount, renderPdfPage } from '../src/services/pdfPageService.js';

const PDF_FILE = { id: 'f1', file_name: 'report.pdf', mime_type: 'application/pdf', size: 2048 };

test('parsePageCount reads the Pages line from pdfinfo', () => {
	const stdout = 'Title:          Report\nPages:          12\nEncrypted:      no\n';
	assert.equal(parsePageCount(stdout), 12);
	assert.equal(parsePageCount('no pages here'), 0);
});

test('renderPdfPage rejects a page outside the document', async () => {
	const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'omnicloud-pdf-page-'));
	await assert.rejects(
		() => renderPdfPage({
			userId: 'u1',
			file: PDF_FILE,
			page: 0,
			openStream: async () => { throw new Error('should not be called'); },
			cacheDir,
		}),
		(error) => error.statusCode === 404,
	);
});

test('renderPdfPage caches the rendered page and skips the converter on the second call', async () => {
	const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'omnicloud-pdf-page-'));
	let conversions = 0;

	const execute = async (program, args) => {
		if (program === 'pdfinfo') return { stdout: 'Pages:          3\n' };
		conversions += 1;
		// pdftoppm escreve <prefixo>.jpg quando recebe -singlefile.
		const prefix = args.at(-1);
		await fs.writeFile(`${prefix}.jpg`, 'jpeg-bytes');
		return { stdout: '' };
	};

	const options = {
		userId: 'u1',
		file: PDF_FILE,
		page: 2,
		openStream: async () => (async function* () { yield Buffer.from('%PDF-1.4'); })(),
		cacheDir,
		execute,
	};

	const first = await renderPdfPage(options);
	assert.equal(await fs.readFile(first, 'utf8'), 'jpeg-bytes');
	assert.equal(conversions, 1);

	const second = await renderPdfPage(options);
	assert.equal(second, first);
	assert.equal(conversions, 1, 'second call is served from cache');
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npm --prefix backend test -- --test-name-pattern="parsePageCount"`
Expected: FAIL — módulo inexistente

- [ ] **Step 3: Implementar o serviço**

`backend/src/services/pdfPageService.js`:

```js
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { env } from '../config/env.js';
import { writeStreamToFile } from './fileConvert.js';
import { getPreviewCacheKey, getPreviewKind, renderOfficePdf } from './previewService.js';

const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_PAGES = 2000;
const execFileAsync = promisify(execFile);

function pageError(message, statusCode, cause) {
	const error = new Error(message, cause ? { cause } : undefined);
	error.statusCode = statusCode;
	return error;
}

export function parsePageCount(stdout) {
	const match = /^Pages:\s+(\d+)/m.exec(String(stdout || ''));
	return match ? Number(match[1]) : 0;
}

// Um PDF de origem por arquivo: office passa pelo LibreOffice, pdf vem direto.
async function ensureSourcePdf({ userId, file, openStream, cacheDir, execute, maxBytes, timeoutMs }) {
	const kind = getPreviewKind(file);
	if (kind === 'office') {
		return renderOfficePdf({ userId, file, openStream, cacheDir, execute, maxBytes, timeoutMs });
	}
	if (kind !== 'pdf') throw pageError('Paged preview is not supported for this file type', 415);
	if (Number(file.size || 0) > maxBytes) throw pageError('File is too large for preview', 415);

	await fs.mkdir(cacheDir, { recursive: true });
	const sourcePath = path.join(cacheDir, `${getPreviewCacheKey(userId, file)}.src.pdf`);
	try {
		await fs.access(sourcePath);
		return sourcePath;
	} catch {
	}

	const tempPath = `${sourcePath}.part`;
	await writeStreamToFile(await openStream(), tempPath, maxBytes);
	await fs.rename(tempPath, sourcePath);
	return sourcePath;
}

export async function getPdfPageCount({
	userId,
	file,
	openStream,
	cacheDir = env.previewCacheDir,
	execute = execFileAsync,
	maxBytes = DEFAULT_MAX_BYTES,
	timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
	const sourcePath = await ensureSourcePdf({ userId, file, openStream, cacheDir, execute, maxBytes, timeoutMs });
	try {
		const { stdout } = await execute('pdfinfo', [sourcePath], { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 });
		const pageCount = parsePageCount(stdout);
		if (!pageCount) throw new Error('pdfinfo reported no pages');
		return Math.min(pageCount, MAX_PAGES);
	} catch (error) {
		if (error.statusCode) throw error;
		throw pageError('Preview conversion failed', 422, error);
	}
}

export async function renderPdfPage({
	userId,
	file,
	page,
	openStream,
	cacheDir = env.previewCacheDir,
	execute = execFileAsync,
	maxBytes = DEFAULT_MAX_BYTES,
	timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
	const pageNumber = Number(page);
	if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > MAX_PAGES) {
		throw pageError('Page is out of range', 404);
	}

	await fs.mkdir(cacheDir, { recursive: true });
	const targetPath = path.join(cacheDir, `${getPreviewCacheKey(userId, file)}.p${pageNumber}.jpg`);
	try {
		await fs.access(targetPath);
		return targetPath;
	} catch {
	}

	const sourcePath = await ensureSourcePdf({ userId, file, openStream, cacheDir, execute, maxBytes, timeoutMs });
	const tempDir = await fs.mkdtemp(path.join(cacheDir, '.tmp-page-'));
	try {
		const prefix = path.join(tempDir, 'page');
		await execute('pdftoppm', [
			'-f', String(pageNumber),
			'-l', String(pageNumber),
			'-singlefile',
			'-jpeg',
			'-r', '150',
			sourcePath,
			prefix,
		], { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 });

		const output = await fs.stat(`${prefix}.jpg`).catch(() => null);
		if (!output?.size) throw pageError('Page is out of range', 404);

		await fs.rename(`${prefix}.jpg`, targetPath);
		return targetPath;
	} catch (error) {
		if (error.statusCode) throw error;
		throw pageError('Preview conversion failed', 422, error);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npm --prefix backend test -- --test-name-pattern="parsePageCount|renderPdfPage"`
Expected: PASS

- [ ] **Step 5: Rotas**

Em `backend/src/routes/fileRoutes.js`, importar:

```js
import { getPdfPageCount, renderPdfPage } from '../services/pdfPageService.js';
```

e adicionar, logo depois da rota `/files/:id/preview`:

```js
function openPreviewStream(req, context) {
	return async () => (await fileCacheService.openFile({
		userId: req.user.id,
		file: context.file,
		adapter: context.adapter,
	})).stream;
}

router.get('/files/:id/preview/pages', async (req, res, next) => {
	try {
		const context = await getFileContext(req.user.id, req.params.id);
		if (!ensureFileContext(context, res)) return;

		const pageCount = await getPdfPageCount({
			userId: req.user.id,
			file: context.file,
			openStream: openPreviewStream(req, context),
		});
		res.setHeader('Cache-Control', 'private, max-age=3600');
		return res.json({ pageCount });
	} catch (error) {
		if (error.statusCode === 404 || error.statusCode === 415 || error.statusCode === 422) {
			return res.status(error.statusCode).json({ error: error.message });
		}
		next(error);
	}
});

router.get('/files/:id/preview/page/:page', async (req, res, next) => {
	try {
		const context = await getFileContext(req.user.id, req.params.id);
		if (!ensureFileContext(context, res)) return;

		const pagePath = await renderPdfPage({
			userId: req.user.id,
			file: context.file,
			page: req.params.page,
			openStream: openPreviewStream(req, context),
		});
		res.setHeader('Content-Type', 'image/jpeg');
		res.setHeader('Cache-Control', 'private, max-age=86400');
		createReadStream(pagePath).on('error', next).pipe(res);
	} catch (error) {
		if (error.statusCode === 404 || error.statusCode === 415 || error.statusCode === 422) {
			return res.status(error.statusCode).json({ error: error.message });
		}
		next(error);
	}
});
```

Se `fileCacheService` ou `createReadStream` ainda não estiverem importados no arquivo, reaproveitar os imports que a rota de thumbnail já usa — não duplicar.

- [ ] **Step 6: Teste de rota**

Em `backend/test/previewRoutes.test.js`, no final do arquivo:

```js
test('rejects a page number that is not a positive integer', async () => {
	const response = await fetch(`${baseUrl}/api/files/${officeFile.id}/preview/page/0`);
	assert.equal(response.status, 404);
});

test('paged preview is refused for a text file', async () => {
	const response = await fetch(`${baseUrl}/api/files/${textFile.id}/preview/pages`);
	assert.equal(response.status, 415);
});
```

(`officeFile` e `textFile` já são criados no `test.before` deste arquivo)

- [ ] **Step 7: Rodar o backend inteiro**

Run: `npm --prefix backend test`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add backend/src/services/pdfPageService.js backend/test/pdfPageService.test.js backend/src/routes/fileRoutes.js backend/test/previewRoutes.test.js
git commit -m "feat(preview): serve PDF pages as images"
```

---

### Task 6: Frontend — renderizador paginado

**Files:**
- Create: `frontend/src/components/preview/renderers/PagedRender.vue`
- Modify: `frontend/src/services/api.js`, `frontend/src/components/preview/PreviewSlide.vue`

**Interfaces:**
- Consumes: rotas da Task 5; contrato de renderizador da Task 3.
- Produces: `api.previewPages(fileId): Promise<{ pageCount: number }>` e `api.previewPageUrl(fileId, page): string`. Entradas `pdf` e `office` no mapa `RENDERERS`.

- [ ] **Step 1: Métodos de API**

Em `frontend/src/services/api.js`, junto de `previewUrl` (linha 308):

```js
	previewPages(fileId) {
		return request(`/files/${fileId}/preview/pages`);
	},
	previewPageUrl(fileId, page) {
		return `${API_BASE_URL}/files/${fileId}/preview/page/${page}`;
	},
```

Conferir a assinatura do helper `request` no topo do arquivo e seguir o padrão dos métodos vizinhos (ele já trata credenciais e erro).

- [ ] **Step 2: `PagedRender.vue`**

```html
<script setup>
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../../../services/api';

const props = defineProps({
	file: { type: Object, required: true },
	active: { type: Boolean, default: false },
});
const emit = defineEmits(['loaded', 'failed']);
const { t } = useI18n();

const pageCount = ref(0);
let currentToken = null;

const pages = computed(() => Array.from({ length: pageCount.value }, (_, index) => index + 1));

async function load() {
	const token = props.file.id;
	currentToken = token;
	pageCount.value = 0;
	try {
		const { pageCount: count } = await api.previewPages(props.file.id);
		if (currentToken !== token) return;
		pageCount.value = Number(count) || 0;
		if (!pageCount.value) return emit('failed');
		emit('loaded');
	} catch {
		if (currentToken !== token) return;
		emit('failed');
	}
}

watch(() => props.file.id, load, { immediate: true });
</script>

<template>
	<div class="h-full w-full overflow-y-auto px-2 py-4">
		<!-- ponytail: paginas como <img> com lazy. Zoom e busca no texto exigiriam
		     pdf.js no bundle; entra so se alguem pedir. -->
		<img
			v-for="page in pages"
			:key="page"
			:src="api.previewPageUrl(props.file.id, page)"
			class="mx-auto mb-4 w-full max-w-3xl bg-white shadow-lg"
			loading="lazy"
			:alt="t('preview.pageOf', { page })"
		/>
	</div>
</template>
```

- [ ] **Step 3: Registrar no mapa**

Em `PreviewSlide.vue`:

```js
import PagedRender from './renderers/PagedRender.vue';
```

```js
const RENDERERS = {
	image: ImageRender,
	video: MediaRender,
	audio: MediaRender,
	text: TextRender,
	pdf: PagedRender,
	office: PagedRender,
};
```

- [ ] **Step 4: Verificar**

Run: `npm --prefix frontend test && npm --prefix frontend run build`
Expected: PASS e build limpo.

- [ ] **Step 5: Verificação manual — este é o bug original**

`npm run dev`, abrir um `.docx` e um `.pdf` no telefone (ou DevTools em modo dispositivo). As páginas devem aparecer como imagens roláveis. Antes desta task, a área ficava branca.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/services/api.js frontend/src/components/preview
git commit -m "feat(preview): render PDF and Office as scrollable pages"
```

---

### Task 7: Compactados

**Files:**
- Create: `backend/src/services/archiveService.js`, `backend/test/archiveService.test.js`, `frontend/src/components/preview/renderers/ArchiveRender.vue`
- Modify: `shared/src/previewTypes.js`, `shared/test/previewTypes.test.js`, `backend/src/routes/fileRoutes.js`, `frontend/src/services/api.js`, `frontend/src/components/preview/PreviewSlide.vue`

**Interfaces:**
- Consumes: contrato de renderizador (Task 3), `previewTypeFor` (Task 1).
- Produces:
  - `parseUnzipList(stdout: string): Array<{ name: string, size: number }>`
  - `listArchiveEntries({ userId, file, openStream, cacheDir?, execute?, maxEntries? }): Promise<{ entries, truncated }>`
  - `GET /files/:id/preview/entries` → `{ entries: [{ name, size }], truncated: boolean }`
  - `api.previewEntries(fileId)`
  - Tipo `'archive'` em `previewTypeFor`.

- [ ] **Step 1: Teste do parser**

`backend/test/archiveService.test.js`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseUnzipList } from '../src/services/archiveService.js';

const UNZIP_OUTPUT = `Archive:  sample.zip
  Length      Date    Time    Name
---------  ---------- -----   ----
      612  2026-07-01 10:12   readme.md
        0  2026-07-01 10:12   docs/
    10240  2026-07-01 10:13   docs/manual with spaces.pdf
---------                     -------
    10852                     3 files`;

test('parseUnzipList reads name and size, keeping spaces in names', () => {
	const entries = parseUnzipList(UNZIP_OUTPUT);

	assert.deepEqual(entries, [
		{ name: 'readme.md', size: 612 },
		{ name: 'docs/', size: 0 },
		{ name: 'docs/manual with spaces.pdf', size: 10240 },
	]);
});

test('parseUnzipList returns nothing for output without a table', () => {
	assert.deepEqual(parseUnzipList('cannot find zipfile directory'), []);
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npm --prefix backend test -- --test-name-pattern="parseUnzipList"`
Expected: FAIL — módulo inexistente

- [ ] **Step 3: Implementar o serviço**

`backend/src/services/archiveService.js`:

```js
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { env } from '../config/env.js';
import { extensionOf } from '@omnicloud/shared';
import { writeStreamToFile } from './fileConvert.js';
import { getPreviewCacheKey } from './previewService.js';

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_ENTRIES = 1000;
const execFileAsync = promisify(execFile);

const ZIP_EXTENSIONS = new Set(['zip', 'jar']);
const SEVEN_ZIP_EXTENSIONS = new Set(['7z', 'rar', 'tar', 'gz', 'tgz', 'bz2', 'xz']);

function archiveError(message, statusCode, cause) {
	const error = new Error(message, cause ? { cause } : undefined);
	error.statusCode = statusCode;
	return error;
}

// unzip -l imprime uma tabela: cabecalho, linha de tracos, itens, rodape.
// O nome comeca na quarta coluna e pode conter espaco, entao o split e limitado.
export function parseUnzipList(stdout) {
	const lines = String(stdout || '').split('\n');
	const start = lines.findIndex((line) => /^-{5,}\s/.test(line.trim()));
	if (start === -1) return [];

	const entries = [];
	for (const line of lines.slice(start + 1)) {
		if (/^-{5,}/.test(line.trim())) break;
		const match = /^\s*(\d+)\s+\S+\s+\S+\s+(.+?)\s*$/.exec(line);
		if (!match) continue;
		entries.push({ name: match[2], size: Number(match[1]) });
	}
	return entries;
}

export function parse7zList(stdout) {
	const entries = [];
	for (const line of String(stdout || '').split('\n')) {
		// Formato: "2026-07-01 10:12:00 ....A         612          600  readme.md"
		const match = /^\d{4}-\d{2}-\d{2}\s+\S+\s+\S+\s+(\d+)\s+\d*\s+(.+?)\s*$/.exec(line);
		if (!match) continue;
		entries.push({ name: match[2], size: Number(match[1]) });
	}
	return entries;
}

export function archiveToolFor(file) {
	const extension = extensionOf(file?.display_name || file?.file_name || '');
	if (ZIP_EXTENSIONS.has(extension)) return 'unzip';
	if (SEVEN_ZIP_EXTENSIONS.has(extension)) return '7z';
	return null;
}

export async function listArchiveEntries({
	userId,
	file,
	openStream,
	cacheDir = env.previewCacheDir,
	execute = execFileAsync,
	maxBytes = DEFAULT_MAX_BYTES,
	timeoutMs = DEFAULT_TIMEOUT_MS,
	maxEntries = DEFAULT_MAX_ENTRIES,
}) {
	const tool = archiveToolFor(file);
	if (!tool) throw archiveError('Archive listing is not supported for this file type', 415);
	if (Number(file.size || 0) > maxBytes) throw archiveError('File is too large for preview', 415);

	await fs.mkdir(cacheDir, { recursive: true });
	const tempDir = await fs.mkdtemp(path.join(cacheDir, '.tmp-archive-'));
	try {
		const inputPath = path.join(tempDir, 'source.archive');
		await writeStreamToFile(await openStream(), inputPath, maxBytes);

		// Nada e extraido: so a listagem. Sem extracao nao existe path traversal.
		const { stdout } = tool === 'unzip'
			? await execute('unzip', ['-l', inputPath], { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 })
			: await execute('7z', ['l', '-ba', inputPath], { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });

		const parsed = tool === 'unzip' ? parseUnzipList(stdout) : parse7zList(stdout);
		return {
			entries: parsed.slice(0, maxEntries),
			truncated: parsed.length > maxEntries,
		};
	} catch (error) {
		if (error.statusCode) throw error;
		throw archiveError('Archive listing failed', 422, error);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
}
```

Adicionar `"@omnicloud/shared": "*"` já foi feito na Task 1; conferir que está lá.

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npm --prefix backend test -- --test-name-pattern="parseUnzipList"`
Expected: PASS

- [ ] **Step 5: Rota**

Em `backend/src/routes/fileRoutes.js`, ao lado das rotas da Task 5:

```js
router.get('/files/:id/preview/entries', async (req, res, next) => {
	try {
		const context = await getFileContext(req.user.id, req.params.id);
		if (!ensureFileContext(context, res)) return;

		const listing = await listArchiveEntries({
			userId: req.user.id,
			file: context.file,
			openStream: openPreviewStream(req, context),
		});
		res.setHeader('Cache-Control', 'private, max-age=3600');
		return res.json(listing);
	} catch (error) {
		if (error.statusCode === 415 || error.statusCode === 422) {
			return res.status(error.statusCode).json({ error: error.message });
		}
		next(error);
	}
});
```

com `import { listArchiveEntries } from '../services/archiveService.js';`

- [ ] **Step 6: Teste de rota**

Em `backend/test/previewRoutes.test.js`:

```js
test('archive listing is refused for a text file', async () => {
	const response = await fetch(`${baseUrl}/api/files/${textFile.id}/preview/entries`);
	assert.equal(response.status, 415);
});
```

- [ ] **Step 7: Tipo `archive` no shared**

Em `shared/src/previewTypes.js`:

```js
export const ARCHIVE_EXTENSIONS = new Set(['7z', 'bz2', 'gz', 'jar', 'rar', 'tar', 'tgz', 'xz', 'zip']);
```

e, em `previewTypeFor`, **depois** da checagem de office e **antes** da de texto:

```js
	if (
		ARCHIVE_EXTENSIONS.has(ext)
		|| mime.includes('zip')
		|| mime.includes('rar')
		|| mime.includes('7z')
		|| mime.includes('tar')
	) return 'archive';
```

Em `shared/test/previewTypes.test.js`, adicionar:

```js
test('archives are their own preview type', () => {
	assert.equal(previewTypeFor({ mimeType: 'application/zip' }), 'archive');
	assert.equal(previewTypeFor({ extension: 'rar' }), 'archive');
	assert.equal(previewTypeFor({ extension: 'tgz' }), 'archive');
});
```

Atenção ao teste `frontend/test/useFilePreviewModal.test.js`: ele usa um `getPreviewType` falso, então continua válido. Já `frontend/test/previewType.test.js` tem `archive.zip` nas fixtures e passa a esperar `'archive'` dos dois lados — como a asserção é "front igual back", ela continua verde sem edição.

- [ ] **Step 8: `ArchiveRender.vue`**

```html
<script setup>
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../../../services/api';
import { formatBytes } from '../../../composables/useFormatFile.js';

const props = defineProps({
	file: { type: Object, required: true },
	active: { type: Boolean, default: false },
});
const emit = defineEmits(['loaded', 'failed']);
const { t } = useI18n();

const entries = ref([]);
const truncated = ref(false);
let currentToken = null;

async function load() {
	const token = props.file.id;
	currentToken = token;
	try {
		const listing = await api.previewEntries(props.file.id);
		if (currentToken !== token) return;
		entries.value = listing.entries || [];
		truncated.value = Boolean(listing.truncated);
		emit('loaded');
	} catch {
		if (currentToken !== token) return;
		emit('failed');
	}
}

watch(() => props.file.id, load, { immediate: true });
</script>

<template>
	<div class="h-full w-full overflow-y-auto px-4 py-6">
		<div class="mx-auto max-w-2xl rounded-2xl bg-white/5 p-4 text-slate-100">
			<p class="mb-3 text-sm text-slate-300">{{ t('preview.entries', { count: entries.length }) }}</p>
			<ul class="divide-y divide-white/10 text-sm">
				<li v-for="entry in entries" :key="entry.name" class="flex items-center justify-between gap-4 py-2">
					<span class="min-w-0 truncate font-mono text-xs">{{ entry.name }}</span>
					<span class="shrink-0 text-xs text-slate-400">{{ formatBytes(entry.size) }}</span>
				</li>
			</ul>
			<p v-if="truncated" class="mt-3 text-xs text-slate-400">{{ t('preview.truncatedEntries', { count: entries.length }) }}</p>
		</div>
	</div>
</template>
```

`formatBytes` já existe em `frontend/src/composables/useFormatFile.js:41`.

Registrar em `PreviewSlide.vue`: `archive: ArchiveRender`.

Em `frontend/src/services/api.js`:

```js
	previewEntries(fileId) {
		return request(`/files/${fileId}/preview/entries`);
	},
```

- [ ] **Step 9: Verificar**

Run: `npm --prefix shared test && npm --prefix backend test && npm --prefix frontend test && npm --prefix frontend run build`
Expected: PASS em todos.

- [ ] **Step 10: Verificação manual**

Abrir um `.zip` no visualizador: deve listar os arquivos com tamanho, em vez de "preview não disponível".

- [ ] **Step 11: Commit**

```bash
git add shared backend/src/services/archiveService.js backend/test/archiveService.test.js backend/src/routes/fileRoutes.js backend/test/previewRoutes.test.js frontend/src/services/api.js frontend/src/components/preview
git commit -m "feat(preview): list archive contents"
```

---

### Task 8: Texto rico — código, markdown e CSV

**Files:**
- Create: `frontend/src/composables/useTextPreview.js`, `frontend/test/useTextPreview.test.js`
- Modify: `frontend/src/components/preview/renderers/TextRender.vue`, `shared/src/previewTypes.js`, `shared/test/previewTypes.test.js`, `frontend/package.json`

**Interfaces:**
- Consumes: contrato de renderizador (Task 3).
- Produces:
  - `languageOf(name: string): string` — extensão → identificador de linguagem do highlight.js (`''` quando não é código).
  - `isMarkdown(name)`, `isCsv(name)`.
  - `parseCsv(text: string): { header: string[], rows: string[][] }` — respeita aspas duplas e vírgula dentro de campo.
  - Extensões de código em `previewTypeFor` → `'text'`.

- [ ] **Step 1: Dependências**

```bash
npm --prefix frontend install highlight.js marked
```

Ambas entram só por `import()` dinâmico — nenhuma no bundle inicial. Confirmar depois no Step 8 que o build não engordou o chunk principal.

- [ ] **Step 2: Escrever o teste que falha**

`frontend/test/useTextPreview.test.js`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { isCsv, isMarkdown, languageOf, parseCsv } from '../src/composables/useTextPreview.js';

test('languageOf maps known source extensions and ignores the rest', () => {
	assert.equal(languageOf('server.js'), 'javascript');
	assert.equal(languageOf('main.PY'), 'python');
	assert.equal(languageOf('query.sql'), 'sql');
	assert.equal(languageOf('notes.txt'), '');
	assert.equal(languageOf('README.md'), '');
});

test('isMarkdown and isCsv recognise their own files', () => {
	assert.equal(isMarkdown('README.md'), true);
	assert.equal(isMarkdown('readme.markdown'), true);
	assert.equal(isMarkdown('notes.txt'), false);
	assert.equal(isCsv('data.CSV'), true);
	assert.equal(isCsv('data.json'), false);
});

test('parseCsv splits rows and honours quoted fields', () => {
	const { header, rows } = parseCsv('name,city\n"Silva, Ana",Recife\nJoao,"Sao ""Paulo"""');

	assert.deepEqual(header, ['name', 'city']);
	assert.deepEqual(rows, [
		['Silva, Ana', 'Recife'],
		['Joao', 'Sao "Paulo"'],
	]);
});

test('parseCsv on empty input returns empty structures', () => {
	assert.deepEqual(parseCsv(''), { header: [], rows: [] });
});
```

- [ ] **Step 3: Rodar e confirmar que falha**

Run: `npm --prefix frontend test -- --test-name-pattern="languageOf"`
Expected: FAIL — módulo inexistente

- [ ] **Step 4: Implementar**

`frontend/src/composables/useTextPreview.js`:

```js
import { extensionOf } from '@omnicloud/shared';

const LANGUAGES = {
	bash: 'bash', c: 'c', cc: 'cpp', cpp: 'cpp', cs: 'csharp', css: 'css', go: 'go',
	h: 'c', hpp: 'cpp', html: 'xml', ini: 'ini', java: 'java', js: 'javascript',
	json: 'json', jsx: 'javascript', kt: 'kotlin', lua: 'lua', php: 'php', pl: 'perl',
	py: 'python', rb: 'ruby', rs: 'rust', scss: 'scss', sh: 'bash', sql: 'sql',
	swift: 'swift', toml: 'ini', ts: 'typescript', tsx: 'typescript', vue: 'xml',
	xml: 'xml', yaml: 'yaml', yml: 'yaml', zsh: 'bash',
};

export function languageOf(name) {
	return LANGUAGES[extensionOf(name)] || '';
}

export function isMarkdown(name) {
	return ['md', 'markdown'].includes(extensionOf(name));
}

export function isCsv(name) {
	return extensionOf(name) === 'csv';
}

// ponytail: parser proprio de ~20 linhas em vez de dependencia de CSV. Se
// aparecer separador ponto-e-virgula ou encoding exotico, trocar por papaparse.
export function parseCsv(text) {
	const body = String(text || '').trim();
	if (!body) return { header: [], rows: [] };

	const table = [];
	let row = [];
	let field = '';
	let quoted = false;

	for (let i = 0; i < body.length; i += 1) {
		const char = body[i];
		if (quoted) {
			if (char === '"' && body[i + 1] === '"') { field += '"'; i += 1; continue; }
			if (char === '"') { quoted = false; continue; }
			field += char;
			continue;
		}
		if (char === '"') { quoted = true; continue; }
		if (char === ',') { row.push(field); field = ''; continue; }
		if (char === '\n') { row.push(field); table.push(row); row = []; field = ''; continue; }
		if (char === '\r') continue;
		field += char;
	}
	row.push(field);
	table.push(row);

	return { header: table[0] || [], rows: table.slice(1) };
}
```

- [ ] **Step 5: Rodar e confirmar que passa**

Run: `npm --prefix frontend test`
Expected: PASS

- [ ] **Step 6: `TextRender.vue` completo**

Substituir o componente da Task 3 por:

```html
<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../../../services/api';
import { isCsv, isMarkdown, languageOf, parseCsv } from '../../../composables/useTextPreview.js';

const MAX_TEXT_BYTES = 1024 * 1024;

const props = defineProps({
	file: { type: Object, required: true },
	active: { type: Boolean, default: false },
});
const emit = defineEmits(['loaded', 'failed']);
const { t } = useI18n();

const body = ref('');
const html = ref('');
const showSource = ref(false);
let currentToken = null;

const name = computed(() => props.file.display_name || props.file.file_name || '');
const language = computed(() => languageOf(name.value));
const asMarkdown = computed(() => isMarkdown(name.value) && !showSource.value);
const asCsv = computed(() => isCsv(name.value) && !showSource.value);
const table = computed(() => (asCsv.value ? parseCsv(body.value) : { header: [], rows: [] }));

// Highlight e markdown chegam por import() dinamico: quem so ve fotos nao
// baixa nenhum dos dois.
async function decorate(token) {
	if (isMarkdown(name.value)) {
		const { marked } = await import('marked');
		if (currentToken !== token) return;
		html.value = marked.parse(body.value, { breaks: true });
		return;
	}
	if (language.value) {
		const hljs = (await import('highlight.js/lib/common')).default;
		if (currentToken !== token) return;
		html.value = hljs.highlight(body.value, { language: language.value, ignoreIllegals: true }).value;
	}
}

async function load() {
	const token = props.file.id;
	currentToken = token;
	body.value = '';
	html.value = '';
	showSource.value = false;
	try {
		const text = await api.previewText(props.file.id);
		if (currentToken !== token) return;
		body.value = text.length > MAX_TEXT_BYTES ? text.slice(0, MAX_TEXT_BYTES) : text;
		emit('loaded');
		await decorate(token);
	} catch {
		if (currentToken !== token) return;
		emit('failed');
	}
}

watch(() => props.file.id, load, { immediate: true });
onBeforeUnmount(() => { currentToken = null; });
</script>

<template>
	<div class="h-full w-full overflow-auto px-4 py-4 text-slate-100">
		<button
			v-if="isMarkdown(name) || isCsv(name)"
			type="button"
			class="mb-3 rounded-full bg-white/10 px-4 py-1.5 text-xs font-medium hover:bg-white/20"
			@click.stop="showSource = !showSource"
		>
			{{ showSource ? t('preview.openRendered') : t('preview.openSource') }}
		</button>

		<table v-if="asCsv" class="w-full border-collapse text-left text-xs">
			<thead>
				<tr>
					<th v-for="(cell, index) in table.header" :key="index" class="border border-white/15 bg-white/10 px-2 py-1 font-semibold">{{ cell }}</th>
				</tr>
			</thead>
			<tbody>
				<tr v-for="(row, rowIndex) in table.rows" :key="rowIndex">
					<td v-for="(cell, cellIndex) in row" :key="cellIndex" class="border border-white/10 px-2 py-1">{{ cell }}</td>
				</tr>
			</tbody>
		</table>

		<!-- eslint-disable-next-line vue/no-v-html -->
		<div v-else-if="asMarkdown && html" class="prose prose-invert max-w-3xl" v-html="html"></div>

		<!-- eslint-disable-next-line vue/no-v-html -->
		<pre v-else-if="html && !showSource" class="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed"><code v-html="html"></code></pre>

		<pre v-else class="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">{{ body }}</pre>
	</div>
</template>
```

Nota de segurança: os dois `v-html` recebem HTML gerado por `marked` e por `highlight.js` a partir de conteúdo do próprio usuário. `highlight.js` escapa a entrada, e `marked` sem `sanitize` permite HTML embutido no markdown. Como o arquivo pertence ao usuário logado e é servido na mesma origem, um markdown com `<script>` executaria no contexto dele — mesmo risco de abrir o próprio arquivo. Para fechar isso, chamar `marked.parse(body, { breaks: true })` sobre um corpo já escapado:

```js
const escaped = body.value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
html.value = marked.parse(escaped, { breaks: true });
```

Usar essa versão escapada — markdown continua renderizando, HTML embutido vira texto visível.

- [ ] **Step 7: Extensões de código no shared**

Em `shared/src/previewTypes.js`, ampliar `TEXT_EXTENSIONS`:

```js
export const TEXT_EXTENSIONS = new Set([
	'bash', 'c', 'cc', 'cfg', 'conf', 'cpp', 'cs', 'css', 'csv', 'env', 'go', 'h', 'hpp',
	'html', 'ini', 'java', 'js', 'json', 'jsx', 'kt', 'log', 'lua', 'markdown', 'md',
	'php', 'pl', 'py', 'rb', 'rs', 'scss', 'sh', 'sql', 'svelte', 'swift', 'toml', 'ts',
	'tsx', 'txt', 'vue', 'xml', 'yaml', 'yml', 'zsh',
]);
```

Em `shared/test/previewTypes.test.js`:

```js
test('source files preview as text', () => {
	assert.equal(previewTypeFor({ extension: 'py' }), 'text');
	assert.equal(previewTypeFor({ extension: 'vue' }), 'text');
	assert.equal(previewTypeFor({ extension: 'md' }), 'text');
});
```

Cuidado com `html`: ele fica em `TEXT_EXTENSIONS`, e como `previewTypeFor` checa `mime.startsWith('text/')` antes, um `.html` servido como `text/html` também cai em `text`. É o desejado — mostrar o fonte, nunca renderizar HTML de arquivo do usuário em iframe de mesma origem.

- [ ] **Step 8: Verificar que as libs ficaram fora do bundle inicial**

Run: `npm --prefix shared test && npm --prefix frontend test && npm --prefix frontend run build`
Expected: PASS; na saída do build, `highlight.js` e `marked` aparecem como chunks separados, não dentro do `index-*.js`.

- [ ] **Step 9: Verificação manual**

Abrir um `.js`, um `.md` e um `.csv`. Código com cores, markdown renderizado com botão "ver fonte", CSV em tabela.

- [ ] **Step 10: Commit**

```bash
git add shared frontend/package.json frontend/package-lock.json package-lock.json frontend/src/composables/useTextPreview.js frontend/test/useTextPreview.test.js frontend/src/components/preview
git commit -m "feat(preview): syntax highlighting, markdown and CSV rendering"
```

---

### Task 9: Players completos

**Files:**
- Create: `frontend/src/composables/useMediaResume.js`, `frontend/test/useMediaResume.test.js`
- Modify: `frontend/src/components/preview/renderers/MediaRender.vue`, `frontend/src/components/preview/PreviewSlide.vue`, `frontend/src/components/preview/FilePreviewViewer.vue`

**Interfaces:**
- Consumes: contrato de renderizador (Task 3); `usePreviewChrome().hold/release` (Task 4).
- Produces:
  - `createMediaResume(storage)` → `{ read(fileId), write(fileId, time, duration), prune() }`. `storage` é qualquer objeto com a interface de `localStorage` (injetável para teste).
  - Regra: `write` ignora quando faltam menos de 30 s para o fim; `read` devolve `0` para entrada inexistente; `prune` descarta entradas com mais de 90 dias.
  - `MediaRender` passa a emitir `ended`, que `PreviewSlide` repassa e `FilePreviewViewer` transforma em avanço automático.

- [ ] **Step 1: Escrever o teste que falha**

`frontend/test/useMediaResume.test.js`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { createMediaResume } from '../src/composables/useMediaResume.js';

function fakeStorage(initial = {}) {
	const data = { ...initial };
	return {
		getItem: (key) => (key in data ? data[key] : null),
		setItem: (key, value) => { data[key] = String(value); },
		removeItem: (key) => { delete data[key]; },
		dump: () => data,
	};
}

test('writes and reads back a playback position', () => {
	const storage = fakeStorage();
	const resume = createMediaResume(storage, { now: () => 1_000 });

	resume.write('file-1', 42, 600);
	assert.equal(resume.read('file-1'), 42);
});

test('does not store a position near the end of the media', () => {
	const storage = fakeStorage();
	const resume = createMediaResume(storage, { now: () => 1_000 });

	resume.write('file-1', 590, 600);
	assert.equal(resume.read('file-1'), 0, 'less than 30s left counts as finished');
});

test('reads zero for an unknown file', () => {
	const resume = createMediaResume(fakeStorage(), { now: () => 1_000 });
	assert.equal(resume.read('missing'), 0);
});

test('prune drops entries older than ninety days', () => {
	const day = 24 * 60 * 60 * 1000;
	const storage = fakeStorage({
		'omnicloud.resume.old': JSON.stringify({ time: 10, at: 0 }),
		'omnicloud.resume.fresh': JSON.stringify({ time: 20, at: 100 * day }),
		'unrelated.key': 'keep me',
	});
	const resume = createMediaResume(storage, { now: () => 100 * day });

	resume.prune();

	assert.equal(storage.getItem('omnicloud.resume.old'), null);
	assert.notEqual(storage.getItem('omnicloud.resume.fresh'), null);
	assert.equal(storage.getItem('unrelated.key'), 'keep me');
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npm --prefix frontend test -- --test-name-pattern="playback position"`
Expected: FAIL — módulo inexistente

- [ ] **Step 3: Implementar**

`frontend/src/composables/useMediaResume.js`:

```js
const PREFIX = 'omnicloud.resume.';
const TAIL_SECONDS = 30;
const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

export function createMediaResume(storage, { now = () => Date.now() } = {}) {
	function key(fileId) {
		return `${PREFIX}${fileId}`;
	}

	function read(fileId) {
		try {
			const raw = storage.getItem(key(fileId));
			if (!raw) return 0;
			return Number(JSON.parse(raw).time) || 0;
		} catch {
			return 0;
		}
	}

	function write(fileId, time, duration) {
		// Quem parou nos ultimos segundos terminou de assistir: retomar ali so
		// devolveria os creditos finais.
		if (!Number.isFinite(time) || time <= 0) return;
		if (Number.isFinite(duration) && duration - time < TAIL_SECONDS) {
			storage.removeItem(key(fileId));
			return;
		}
		try {
			storage.setItem(key(fileId), JSON.stringify({ time, at: now() }));
		} catch {
			// Cota cheia ou modo privado: retomar posicao nao vale um erro na tela.
		}
	}

	function prune() {
		const cutoff = now() - MAX_AGE_MS;
		const keys = Object.keys(storage.dump ? storage.dump() : storage);
		for (const item of keys) {
			if (!item.startsWith(PREFIX)) continue;
			try {
				const entry = JSON.parse(storage.getItem(item));
				if (Number(entry.at) < cutoff) storage.removeItem(item);
			} catch {
				storage.removeItem(item);
			}
		}
	}

	return { read, write, prune };
}

export function useMediaResume() {
	return createMediaResume(window.localStorage);
}
```

Nota: `prune` usa `storage.dump()` quando existe (o duplo de teste) e as chaves do próprio objeto no navegador. `Object.keys(localStorage)` funciona em todos os navegadores atuais.

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npm --prefix frontend test`
Expected: PASS

- [ ] **Step 5: `MediaRender.vue` completo**

```html
<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { IconPictureInPicture } from '@tabler/icons-vue';
import { useI18n } from 'vue-i18n';
import { api } from '../../../services/api';
import { useMediaResume } from '../../../composables/useMediaResume.js';

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

const props = defineProps({
	file: { type: Object, required: true },
	active: { type: Boolean, default: false },
});
const emit = defineEmits(['loaded', 'failed', 'ended', 'hold', 'release']);
const { t } = useI18n();

const mediaRef = ref(null);
const speed = ref(1);
const isVideo = computed(() => props.file.previewType === 'video');
const source = computed(() => api.previewUrl(props.file.id));
const supportsPip = typeof document !== 'undefined' && document.pictureInPictureEnabled;

const resume = useMediaResume();
let saveTimer = null;

function onLoaded() {
	const at = resume.read(props.file.id);
	if (at > 0 && mediaRef.value) mediaRef.value.currentTime = at;
	emit('loaded');
}

function startSaving() {
	stopSaving();
	saveTimer = window.setInterval(() => {
		const media = mediaRef.value;
		if (media && !media.paused) resume.write(props.file.id, media.currentTime, media.duration);
	}, 5000);
}

function stopSaving() {
	if (saveTimer) window.clearInterval(saveTimer);
	saveTimer = null;
}

function applySpeed(value) {
	speed.value = value;
	if (mediaRef.value) mediaRef.value.playbackRate = value;
}

async function togglePip() {
	const media = mediaRef.value;
	if (!media || !supportsPip) return;
	if (document.pictureInPictureElement) await document.exitPictureInPicture();
	else await media.requestPictureInPicture();
}

// Controles nao podem sumir com o video pausado: e exatamente quando o usuario
// esta olhando para eles.
function onPause() {
	stopSaving();
	emit('hold');
}

function onPlay() {
	startSaving();
	emit('release');
}

function onEnded() {
	resume.write(props.file.id, 0, 0);
	emit('ended');
}

watch(() => props.active, (active) => {
	if (!active) {
		mediaRef.value?.pause();
		stopSaving();
	}
});

onMounted(() => resume.prune());
onBeforeUnmount(() => {
	const media = mediaRef.value;
	if (media) resume.write(props.file.id, media.currentTime, media.duration);
	stopSaving();
});
</script>

<template>
	<div class="relative grid h-full place-items-center px-4">
		<video
			v-if="isVideo"
			ref="mediaRef"
			class="max-h-full w-full bg-black"
			controls
			playsinline
			:poster="api.thumbnailUrl(props.file)"
			@loadeddata="onLoaded"
			@error="emit('failed')"
			@play="onPlay"
			@pause="onPause"
			@ended="onEnded"
		>
			<source :src="source" :type="props.file.mime_type || 'video/mp4'" />
		</video>

		<audio
			v-else
			ref="mediaRef"
			class="w-full max-w-xl"
			controls
			@loadeddata="onLoaded"
			@error="emit('failed')"
			@play="onPlay"
			@pause="onPause"
			@ended="onEnded"
		>
			<source :src="source" :type="props.file.mime_type || 'audio/mpeg'" />
		</audio>

		<div class="absolute bottom-4 right-4 flex items-center gap-2" @click.stop>
			<select
				class="rounded-full bg-black/60 px-3 py-1.5 text-xs text-white outline-none"
				:title="t('preview.speed')"
				:value="speed"
				@change="applySpeed(Number($event.target.value))"
			>
				<option v-for="option in SPEEDS" :key="option" :value="option">{{ option }}×</option>
			</select>
			<button
				v-if="isVideo && supportsPip"
				type="button"
				class="grid size-9 place-items-center rounded-full bg-black/60 text-white hover:bg-black/80"
				:title="t('preview.pictureInPicture')"
				@click="togglePip"
			>
				<IconPictureInPicture :size="18" :stroke="2" />
			</button>
		</div>
	</div>
</template>
```

- [ ] **Step 6: Repassar os eventos**

Em `PreviewSlide.vue`, o `<component :is>` ganha `@ended="emit('ended')"`, `@hold="emit('hold')"` e `@release="emit('release')"`, e o `defineEmits` passa a ser `['download', 'ended', 'hold', 'release']`. Renderizadores que não emitem esses eventos simplesmente nunca os disparam.

Em `FilePreviewViewer.vue`:

```html
			<PreviewSlide
				...
				@ended="onSlideEnded(index)"
				@hold="chrome.hold()"
				@release="chrome.release()"
			/>
```

```js
function onSlideEnded(index) {
	if (index !== props.currentIndex || !props.hasNext) return;
	const next = props.files[index + 1];
	const type = next && props.previewTypeOf(next);
	// Auto-proximo so entre midias: pular de um mp3 para um docx no meio da fila
	// e mais irritante do que util.
	if (type === 'audio' || type === 'video') emit('next');
}
```

- [ ] **Step 7: Verificar**

Run: `npm --prefix frontend test && npm --prefix frontend run build`
Expected: PASS e build limpo.

- [ ] **Step 8: Verificação manual**

Abrir um vídeo: mudar velocidade, entrar em PiP, fechar e reabrir no meio (deve retomar), deixar terminar com outro vídeo/áudio em seguida (deve avançar sozinho), pausar e confirmar que os controles não somem.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/composables/useMediaResume.js frontend/test/useMediaResume.test.js frontend/src/components/preview
git commit -m "feat(preview): playback speed, PiP, resume and auto-advance"
```

---

### Task 10: HEIC e TIFF convertidos no backend

**Files:**
- Modify: `backend/src/services/previewService.js`, `backend/src/routes/fileRoutes.js`, `backend/test/previewService.test.js`

**Interfaces:**
- Consumes: `getPreviewKind` (Task 1), `writeStreamToFile`.
- Produces: `renderImageJpeg({ userId, file, openStream, cacheDir?, execute?, timeoutMs? }): Promise<string>` e `needsImageConversion(file): boolean`.

- [ ] **Step 1: Escrever o teste que falha**

Em `backend/test/previewService.test.js`:

```js
test('needsImageConversion targets only the formats browsers refuse', () => {
	assert.equal(needsImageConversion({ file_name: 'photo.heic' }), true);
	assert.equal(needsImageConversion({ file_name: 'scan.TIFF' }), true);
	assert.equal(needsImageConversion({ file_name: 'photo.jpg' }), false);
	assert.equal(needsImageConversion({ file_name: 'clip.mp4' }), false);
});
```

Adicionar `needsImageConversion` ao import do topo do arquivo.

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npm --prefix backend test -- --test-name-pattern="needsImageConversion"`
Expected: FAIL — export inexistente

- [ ] **Step 3: Implementar**

Em `backend/src/services/previewService.js`:

```js
const BROWSER_HOSTILE_IMAGES = new Set(['.heic', '.heif', '.tif', '.tiff']);

// Chrome e Firefox nao decodificam HEIC nem TIFF: sem conversao o preview e um
// icone de imagem quebrada.
export function needsImageConversion(file) {
	if (!file || getPreviewKind(file) !== 'image') return false;
	const { extension } = effectivePreviewSource(file);
	return BROWSER_HOSTILE_IMAGES.has(extension);
}

export async function renderImageJpeg({
	userId,
	file,
	openStream,
	cacheDir = env.previewCacheDir,
	execute = execFileAsync,
	maxBytes = DEFAULT_MAX_BYTES,
	timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
	if (!needsImageConversion(file)) throw previewError('Image conversion is not needed', 415);
	if (Number(file.size || 0) > maxBytes) throw previewError('File is too large for preview conversion', 415);

	await fs.mkdir(cacheDir, { recursive: true });
	const targetPath = path.join(cacheDir, `${getPreviewCacheKey(userId, file)}.jpg`);
	try {
		await fs.access(targetPath);
		return targetPath;
	} catch {
	}

	const tempDir = await fs.mkdtemp(path.join(cacheDir, '.tmp-image-'));
	try {
		const { extension } = effectivePreviewSource(file);
		const safeExtension = /^\.[a-z0-9]{1,8}$/.test(extension) ? extension : '.bin';
		const inputPath = path.join(tempDir, `source${safeExtension}`);
		const outputPath = path.join(tempDir, 'converted.jpg');
		await writeStreamToFile(await openStream(), inputPath, maxBytes);

		// ffmpeg ja e dependencia do thumbnail e decodifica os dois formatos.
		await execute('ffmpeg', ['-y', '-i', inputPath, '-frames:v', '1', '-q:v', '3', outputPath], {
			timeout: timeoutMs,
			windowsHide: true,
			maxBuffer: 1024 * 1024,
		});

		const output = await fs.stat(outputPath);
		if (!output.size) throw new Error('ffmpeg produced an empty image');

		await fs.rename(outputPath, targetPath);
		return targetPath;
	} catch (error) {
		if (error.statusCode === 415) throw error;
		throw previewError('Preview conversion failed', 422, error);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
}
```

- [ ] **Step 4: Ligar na rota**

Em `backend/src/routes/fileRoutes.js`, na rota `/files/:id/preview`, logo antes do bloco `if (kind === 'office')`:

```js
		if (needsImageConversion(context.file)) {
			const imagePath = await renderImageJpeg({
				userId: req.user.id,
				file: context.file,
				openStream: openPreviewStream(req, context),
			});
			res.setHeader('Content-Type', 'image/jpeg');
			return sendLocalPreview(req, res, imagePath);
		}
```

com os dois nomes adicionados ao import de `previewService.js`.

- [ ] **Step 5: Rodar tudo**

Run: `npm --prefix backend test && npm --prefix frontend test && npm --prefix shared test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/previewService.js backend/src/routes/fileRoutes.js backend/test/previewService.test.js
git commit -m "feat(preview): convert HEIC and TIFF to JPEG for the browser"
```

---

## Verificação final

- [ ] `npm --prefix shared test && npm --prefix backend test && npm --prefix frontend test`
- [ ] `npm --prefix frontend run build` — sem aviso de chunk grande novo; `highlight.js` e `marked` em chunks próprios
- [ ] `grep -rn "FilePreviewModal" frontend/src` — sem resultado
- [ ] Verificação manual no telefone, uma pasta com imagem, vídeo, áudio, PDF, docx, zip, md e um arquivo de código: swipe percorre todos; contador correto; miniaturas navegam; docx e PDF mostram páginas; controles somem e voltam; vídeo retoma onde parou
