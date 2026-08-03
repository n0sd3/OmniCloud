# Explorer: Inspector, Quick Preview e teclado — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dar ao explorer do OmniCloud um painel Inspector lateral, Quick Preview pela barra de espaço e navegação completa por teclado, nas quatro views de arquivo.

**Architecture:** Primeiro extrai o markup duplicado das quatro views para um `FileListSurface.vue`. Depois o Inspector e o teclado entram uma vez, dentro dessa superfície e dentro do `useFileListView`, e valem para todas as views de graça. Nenhuma mudança de backend.

**Tech Stack:** Vue 3 `<script setup>`, Pinia, Tailwind, vue-i18n, `@tabler/icons-vue`, testes com `node --test`.

**Spec:** `docs/superpowers/specs/2026-08-03-explorer-inspector-quick-preview-design.md`

## Global Constraints

- Diretório de trabalho do frontend: `/Volumes/ZimaOS-HD/AppData/OmniCloud/frontend`.
- Indentação com **tab**, aspas simples, ponto e vírgula — como todo o código atual.
- Toda string visível passa por `t()` e existe em `src/locales/en.json` **e** `src/locales/id.json`. As duas chaves devem ser adicionadas no mesmo commit.
- Nenhuma dependência nova. Sem `vitest`, sem `@vue/test-utils`, sem jsdom.
- Runner de teste: `npm run test` no diretório `frontend` (`node --test "test/*.test.js"`).
- Build de verificação: `npm run build` no diretório `frontend`.
- Nenhuma alteração em `backend/`.
- Comentários que marcam simplificação deliberada usam o prefixo `// ponytail:`, como já ocorre em `FilePreviewModal.vue:52`.

---

## Estrutura de arquivos

| Arquivo | Responsabilidade | Tarefa |
|---|---|---|
| `src/components/FileListSurface.vue` | criar — markup compartilhado das quatro views: barras, lista, grade, menu de contexto, preview, inspector | 1 |
| `src/views/MyDriveView.vue` | modificar — passa a usar a superfície | 1 |
| `src/views/StarredView.vue` | modificar — idem | 1 |
| `src/views/RecentView.vue` | modificar — idem, com grupos | 2 |
| `src/views/SharedWithMeView.vue` | modificar — idem, com grupos e permissões restritas | 2 |
| `src/components/FileInspector.vue` | criar — painel lateral de detalhes | 3 |
| `src/components/FileDetailsModal.vue` | deletar | 3 |
| `src/composables/useFileListView.js` | modificar — estado do inspector, enriquecimento de detalhes, ligação do teclado | 3, 4 |
| `src/composables/useFileListKeyboard.js` | criar — cursor e atalhos | 4 |
| `test/useFileListKeyboard.test.js` | criar — testes do teclado | 4 |
| `src/locales/en.json`, `src/locales/id.json` | modificar — chaves do inspector e dos atalhos | 3 |

---

### Task 1: `FileListSurface.vue` e migração de MyDrive e Starred

Refactor puro. Nenhuma mudança visível ao usuário — é esse o critério de aceite.

**Files:**
- Create: `frontend/src/components/FileListSurface.vue`
- Modify: `frontend/src/views/MyDriveView.vue`
- Modify: `frontend/src/views/StarredView.vue`

**Interfaces:**
- Consumes: o objeto devolvido por `useFileListView` (`frontend/src/composables/useFileListView.js:244-271`).
- Produces: componente `FileListSurface` com as props `view`, `loading`, `emptyMessage`, `nameField`, `fillHeight`, `listMaxHeightClass`, `groups`, `sortable`, `highlightedFileId`, `allowRename`, `allowDelete`, `canOpenFolder`; eventos `open(file)` e `open-selected()`; slots `header`, `selection-prefix`, `overlay`; expõe `renderCount` (ref numérico) via `defineExpose`.

- [ ] **Step 1: Criar `frontend/src/components/FileListSurface.vue`**

```vue
<script setup>
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import FileListFilterBar from './FileListFilterBar.vue';
import FileListSelectionBar from './FileListSelectionBar.vue';
import FileListViewModeToggle from './FileListViewModeToggle.vue';
import FileListHeader from './FileListHeader.vue';
import FileListRow from './FileListRow.vue';
import FileListGridCard from './FileListGridCard.vue';
import FileListContextMenu from './FileListContextMenu.vue';
import FilePreviewModal from './FilePreviewModal.vue';
import LoadingState from './LoadingState.vue';
import { useIncrementalRender } from '../composables/useIncrementalRender';

const props = defineProps({
	view: { type: Object, required: true },
	loading: { type: Boolean, default: false },
	emptyMessage: { type: String, required: true },
	nameField: { type: String, default: 'file_name' },
	fillHeight: { type: Boolean, default: false },
	listMaxHeightClass: { type: String, default: 'max-h-[min(70vh,780px)]' },
	groups: { type: Array, default: null },
	sortable: { type: Boolean, default: false },
	highlightedFileId: { type: String, default: null },
	allowRename: { type: Boolean, default: true },
	allowDelete: { type: Boolean, default: true },
	canOpenFolder: { type: Boolean, default: true },
});

const emit = defineEmits(['open', 'open-selected']);

const { t } = useI18n();

// A view e criada uma unica vez pelo componente pai, entao desestruturar aqui e seguro
// e faz os refs serem desempacotados automaticamente no template.
const {
	searchTerm,
	isGridView,
	activeFilterMenu,
	selectedTypeFilter,
	selectedOwnerFilter,
	selectedUpdatedFilter,
	typeOptions,
	ownerOptions,
	updatedOptions,
	sortBy,
	sortDirection,
	setSort,
	toggleFilterMenu,
	applyFilter,
	clearFilter,
	sortedFiles,
	errorMessage,
	selectedCount,
	primarySelectedFile,
	isSelected,
	selectItem,
	clearSelection,
	openContextMenu,
	contextMenu,
	contextMenuRef,
	closeContextMenu,
	canDownloadSelection,
	canRenameSelection,
	canToggleStarSelection,
	isPrimarySelectedStarred,
	canOpenSelection,
	canPreviewSelection,
	previewFile,
	isPreviewOpen,
	isPreviewLoading,
	previewError,
	previewText,
	hasPreviousPreview,
	hasNextPreview,
	openPreview,
	closePreview,
	showPreviousPreview,
	showNextPreview,
	handlePreviewLoaded,
	handlePreviewFailed,
	downloadSelection,
	triggerDownload,
	renameSelectedFile,
	deleteSelectedFile,
	toggleSelectedFileStar,
	showSelectedFileDetails,
	actionInProgress,
	actionLabel,
} = props.view;

const { renderCount, visibleItems: renderedFiles, handleScroll: handleListScroll } = useIncrementalRender(sortedFiles, {
	initialCount: 80,
	step: 80,
	threshold: 240,
});

const renderedGroups = computed(() => {
	if (!props.groups) return null;
	const visibleIds = new Set(renderedFiles.value.map((file) => file.id));
	return props.groups
		.map((group) => ({ ...group, items: group.items.filter((file) => visibleIds.has(file.id)) }))
		.filter((group) => group.items.length);
});

const isEmpty = computed(() => !sortedFiles.value.length && !props.loading);
const canRename = computed(() => props.allowRename && canRenameSelection.value);

defineExpose({ renderCount });
</script>

<template>
	<div class="relative flex min-h-[calc(100vh-84px)] scroll-mt-20 flex-col rounded-[24px] bg-white px-4 py-[18px] pb-5 text-[#202124] dark:bg-slate-800 dark:text-slate-100 sm:px-6" @click="clearSelection">
		<slot name="overlay" />

		<div class="mb-2 flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
			<slot name="header" />
			<FileListViewModeToggle v-model="isGridView" />
		</div>

		<div class="mb-3 flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
			<FileListSelectionBar v-if="selectedCount" :selected-count="selectedCount" :can-preview="canPreviewSelection" :can-toggle-star="canToggleStarSelection" :is-primary-starred="isPrimarySelectedStarred" :can-download="canDownloadSelection" :can-rename="canRename" :can-delete="allowDelete" :primary-file="primarySelectedFile" @clear="clearSelection" @preview="openPreview" @toggle-star="toggleSelectedFileStar" @download="downloadSelection" @rename="renameSelectedFile" @show-details="showSelectedFileDetails" @delete="deleteSelectedFile">
				<template #prefix="{ primary }">
					<slot name="selection-prefix" :primary="primary" />
				</template>
			</FileListSelectionBar>
			<FileListFilterBar v-else :type-options="typeOptions" :owner-options="ownerOptions" :updated-options="updatedOptions" :selected-type-filter="selectedTypeFilter" :selected-owner-filter="selectedOwnerFilter" :selected-updated-filter="selectedUpdatedFilter" :active-filter-menu="activeFilterMenu" v-model:search-term="searchTerm" @toggle-filter-menu="toggleFilterMenu" @apply-filter="applyFilter" @clear-filter="clearFilter" />
		</div>

		<p v-if="errorMessage" class="mb-4 rounded-2xl bg-[#fce8e6] px-4 py-3 text-sm text-[#c5221f] dark:bg-red-950/40 dark:text-red-300">{{ errorMessage }}</p>

		<div v-if="!isGridView" class="relative flex flex-col" :class="fillHeight ? 'flex-1' : ''">
			<div class="custom-scrollbar flex flex-col overflow-x-auto rounded-2xl border border-[#e0e3e7] bg-white dark:border-slate-700 dark:bg-slate-800" :class="fillHeight ? 'flex-1' : ''">
				<div class="flex min-w-[760px] flex-col" :class="fillHeight ? 'flex-1' : ''">
					<div class="custom-scrollbar overflow-y-auto overflow-x-hidden" :class="fillHeight ? 'min-h-0 flex-1' : listMaxHeightClass" @scroll="handleListScroll">
						<FileListHeader :sortable="sortable" :sort-by="sortBy" :sort-direction="sortDirection" @sort="setSort" />

						<template v-if="renderedGroups">
							<template v-for="group in renderedGroups" :key="group.key">
								<div class="sticky top-11 z-[1] bg-[#f8fafd] px-[18px] py-2 text-xs font-semibold uppercase tracking-[0.08em] text-[#5f6368] dark:bg-slate-900 dark:text-slate-400">{{ group.label }}</div>
								<FileListRow v-for="item in group.items" :key="item.id" :item="item" :selected="isSelected(item)" :highlighted="highlightedFileId === item.id" :name-field="nameField" @select="(event) => selectItem(event, item)" @open="emit('open', item)" @contextmenu="(event) => openContextMenu(event, item)" />
							</template>
						</template>
						<template v-else>
							<FileListRow v-for="item in renderedFiles" :key="item.id" :item="item" :selected="isSelected(item)" :highlighted="highlightedFileId === item.id" :name-field="nameField" @select="(event) => selectItem(event, item)" @open="emit('open', item)" @contextmenu="(event) => openContextMenu(event, item)" />
						</template>

						<div v-if="isEmpty" class="p-[18px] text-[#5f6368] dark:text-slate-400">{{ emptyMessage }}</div>
						<div v-if="loading" class="p-[18px]"><LoadingState /></div>
					</div>
				</div>
			</div>
			<LoadingState v-if="actionInProgress" variant="overlay" :message="actionLabel || t('drive.processing')" />
		</div>

		<div v-else class="relative">
			<div class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
				<template v-if="renderedGroups">
					<template v-for="group in renderedGroups" :key="group.key">
						<div class="col-span-full rounded-2xl bg-[#f8fafd] px-4 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-[#5f6368] dark:bg-slate-900 dark:text-slate-400">{{ group.label }}</div>
						<FileListGridCard v-for="item in group.items" :key="item.id" :item="item" :selected="isSelected(item)" :highlighted="highlightedFileId === item.id" :name-field="nameField" @select="(event) => selectItem(event, item)" @open="emit('open', item)" @contextmenu="(event) => openContextMenu(event, item)" />
					</template>
				</template>
				<template v-else>
					<FileListGridCard v-for="item in renderedFiles" :key="item.id" :item="item" :selected="isSelected(item)" :highlighted="highlightedFileId === item.id" :name-field="nameField" @select="(event) => selectItem(event, item)" @open="emit('open', item)" @contextmenu="(event) => openContextMenu(event, item)" />
				</template>

				<div v-if="isEmpty" class="col-span-full rounded-2xl border border-dashed border-[#dadce0] bg-white px-5 py-8 text-center text-[#5f6368] dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400">{{ emptyMessage }}</div>
				<div v-if="loading" class="col-span-full rounded-2xl border border-dashed border-[#dadce0] bg-white px-5 py-8 text-center text-[#5f6368] dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400"><LoadingState /></div>
			</div>
			<LoadingState v-if="actionInProgress" variant="overlay" :message="actionLabel || t('drive.processing')" />
		</div>

		<FileListContextMenu :context-menu-ref="contextMenuRef" :context-menu="contextMenu" :selected-count="selectedCount" :primary-selected-file="primarySelectedFile" :can-preview="canPreviewSelection" :can-toggle-star="canToggleStarSelection" :is-primary-starred="isPrimarySelectedStarred" :can-download="canDownloadSelection" :can-rename="canRename" :can-delete="allowDelete" :can-show-details="selectedCount === 1" :can-open-folder="canOpenFolder && canOpenSelection" @open-folder="emit('open-selected')" @preview="openPreview" @toggle-star="toggleSelectedFileStar" @download="downloadSelection" @rename="renameSelectedFile" @show-details="showSelectedFileDetails" @delete="deleteSelectedFile" @close="closeContextMenu" />

		<FilePreviewModal :file="previewFile" :is-open="isPreviewOpen" :is-loading="isPreviewLoading" :preview-text="previewText" :preview-error="previewError" :has-previous="hasPreviousPreview" :has-next="hasNextPreview" @close="closePreview" @loaded="handlePreviewLoaded" @failed="handlePreviewFailed" @previous="showPreviousPreview" @next="showNextPreview" @download="triggerDownload(previewFile)" />
	</div>
</template>
```

Note que `FileDetailsModal` **não** aparece aqui: ele ainda é renderizado pelas views nesta tarefa e some na Task 3.

- [ ] **Step 2: Confirmar que `FileListContextMenu` aceita `can-delete`**

Run: `grep -n "canDelete\|can-delete" frontend/src/components/FileListContextMenu.vue`

Se a prop não existir, adicioná-la em `defineProps` como `canDelete: { type: Boolean, default: true }` e envolver o botão de excluir com `v-if="canDelete"`, espelhando o que `FileListSelectionBar.vue:15` e `FileListSelectionBar.vue:61` já fazem.

- [ ] **Step 3: Migrar `MyDriveView.vue`**

No bloco `<script setup>`, remover os imports de `FileListFilterBar`, `FileListSelectionBar`, `FileListViewModeToggle`, `FileListHeader`, `FileListRow`, `FileListGridCard`, `FileListContextMenu`, `FilePreviewModal`, `LoadingState`, `useIncrementalRender` e `providerLabel`, e adicionar:

```js
import FileListSurface from '../components/FileListSurface.vue';
```

Remover a desestruturação gigante de `view` (linhas 55-111) e o bloco `useIncrementalRender` (linhas 113-117). Manter apenas o que o próprio arquivo usa:

```js
const surfaceRef = ref(null);
const { currentPath, breadcrumbs, searchTerm, isLoading } = storeToRefs(fileTreeStore);
const { sortedFiles, clearSelection, primarySelectedFile, contextMenu, closeContextMenu, canPreview, openPreview } = view;
```

Trocar `ensureHighlightedFileRendered` para usar o `renderCount` exposto pela superfície:

```js
function ensureHighlightedFileRendered(targetId) {
	const targetIndex = sortedFiles.value.findIndex((file) => file.id === targetId);
	const renderCount = surfaceRef.value?.renderCount;
	if (renderCount && targetIndex >= renderCount.value) {
		renderCount.value = targetIndex + 1;
	}
}
```

No template, substituir todo o conteúdo entre `<DriveShell ...>` e `<FloatingProgressToast ...>` por:

```vue
<FileListSurface ref="surfaceRef" :view="view" :loading="isLoading" :empty-message="t('drive.noFiles')" name-field="display_name" fill-height sortable :highlighted-file-id="highlightedFileId" @open="openItemOnDoubleClick" @open-selected="openSelectedItem">
	<template #header>
		<nav aria-label="Breadcrumb" class="m-0 flex flex-wrap items-center gap-1 text-2xl font-normal text-[#202124] dark:text-slate-100">
			<template v-for="(crumb, index) in breadcrumbs" :key="crumb.path">
				<button type="button" class="max-w-[220px] truncate text-left transition hover:text-[#1a73e8] dark:hover:text-sky-300" @click="fileTreeStore.navigate(crumb.path)">{{ crumb.label === 'Root' ? t('drive.title') : crumb.label }}</button>
				<IconChevronRight v-if="index < breadcrumbs.length - 1" :size="18" :stroke="2" class="mx-1 text-[#5f6368] dark:text-slate-400" />
			</template>
		</nav>
	</template>

	<template #selection-prefix="{ primary }">
		<button v-if="primary?.is_folder && primary" type="button" class="inline-flex size-9 items-center justify-center rounded-full transition enabled:hover:bg-[#d2e3fc] dark:enabled:hover:bg-sky-500/20" :title="t('common.open')" @click="openSelectedItem">
			<IconFolder :size="18" :stroke="2" />
		</button>
	</template>

	<template #overlay>
		<input ref="fileInputRef" class="hidden" type="file" multiple @change="onFileInputChange" />
		<input ref="folderInputRef" class="hidden" type="file" multiple webkitdirectory directory @change="onFolderInputChange" />
		<div v-if="isDragActive" class="pointer-events-none absolute inset-4 z-20 grid place-items-center rounded-[24px] border-2 border-dashed border-[#1a73e8] bg-[#e8f0fe]/90 text-center dark:bg-slate-900/90">
			<div>
				<p class="text-lg font-semibold text-[#1a73e8]">{{ t('drive.dropZoneTitle') }}</p>
				<p class="mt-2 text-sm text-[#5f6368] dark:text-slate-400">{{ t('drive.dropZoneDesc') }}</p>
			</div>
		</div>
	</template>
</FileListSurface>
```

Os handlers de drag (`@dragenter`, `@dragover`, `@dragleave`, `@drop`) ficavam na `div` raiz que agora é interna à superfície. Movê-los para um wrapper em volta do `<FileListSurface>`:

```vue
<div class="contents" @dragenter.prevent="handleDragEnter" @dragover.prevent="handleDragEnter" @dragleave.prevent="handleDragLeave" @drop.prevent="handleDrop">
```

`class="contents"` mantém o layout idêntico, porque o wrapper não gera caixa própria.

Manter no arquivo: `FileDetailsModal` (removido na Task 3), `FloatingProgressToast`, e todas as funções de upload, drag, sync e highlight.

- [ ] **Step 4: Migrar `StarredView.vue`**

Mesmos imports removidos e `FileListSurface` adicionado. Manter `openFolder`, `openSelectedItem`, `openItemOnDoubleClick`, `useAutoRefresh`. Template:

```vue
<FileListSurface :view="view" :loading="loading" :empty-message="t('drive.noFiles')" sortable list-max-height-class="max-h-[min(52vh,520px)]" @open="openItemOnDoubleClick" @open-selected="openSelectedItem">
	<template #header>
		<h1 class="m-0 text-2xl font-normal text-[#202124] dark:text-slate-100">{{ t('nav.starred') }}</h1>
	</template>
	<template #selection-prefix="{ primary }">
		<button v-if="primary?.is_folder" type="button" class="inline-flex size-9 items-center justify-center rounded-full transition enabled:hover:bg-[#d2e3fc] dark:enabled:hover:bg-sky-500/20" :title="t('common.open')" @click="openSelectedItem">
			<IconFolder :size="18" :stroke="2" />
		</button>
	</template>
</FileListSurface>
```

Manter `FileDetailsModal` e `FloatingProgressToast` no arquivo.

- [ ] **Step 5: Verificar o build**

Run: `cd frontend && npm run build`
Expected: build conclui sem erro. Qualquer `[vue/compiler-sfc]` ou variável não definida é falha da migração — corrigir antes de seguir.

- [ ] **Step 6: Verificação manual**

Run: `cd frontend && npm run dev`

Abrir `/my-drive` e `/starred` e confirmar, comparando com o comportamento anterior:
- lista e grade renderizam, alternância pelo toggle funciona;
- clique seleciona, Ctrl+clique alterna, Shift+clique estende;
- duplo clique abre pasta no My Drive e preview em arquivo;
- menu de contexto abre e as ações funcionam;
- ordenação por coluna funciona nas duas telas;
- no My Drive: arrastar arquivo mostra o dropzone e o upload completa;
- no My Drive: buscar no header e clicar num resultado rola até o arquivo e o destaca em âmbar.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/FileListSurface.vue frontend/src/components/FileListContextMenu.vue frontend/src/views/MyDriveView.vue frontend/src/views/StarredView.vue
git commit -m "refactor: extract the shared file list surface from the drive views"
```

---

### Task 2: Migrar Recent e SharedWithMe

**Files:**
- Modify: `frontend/src/views/RecentView.vue`
- Modify: `frontend/src/views/SharedWithMeView.vue`

**Interfaces:**
- Consumes: `FileListSurface` da Task 1, com as props `groups`, `allowRename`, `allowDelete`, `canOpenFolder`.
- Produces: nada novo para tarefas seguintes.

- [ ] **Step 1: Migrar `RecentView.vue`**

Remover os mesmos imports da Task 1, mais `useIncrementalRender` e `providerLabel`, e o `renderedGroupedFiles` local (linhas 103-111) — a superfície faz esse recorte agora. Manter `useRecencyGroups`.

Script resultante, além do `useFileListView` já existente:

```js
import FileListSurface from '../components/FileListSurface.vue';
import { useRecencyGroups } from '../composables/useRecencyGroups.js';

const { loading, sortedFiles, clearSelection, canPreview, openPreview } = view;
const { groups: groupedFiles } = useRecencyGroups(sortedFiles, t);

function openItemOnDoubleClick(file) {
	if (canPreview(file)) openPreview(file);
}
```

Template entre `<DriveShell current-section="recent">` e `<FloatingProgressToast ...>`:

```vue
<FileListSurface :view="view" :loading="loading" :groups="groupedFiles" :empty-message="t('recent.empty')" :can-open-folder="false" @open="openItemOnDoubleClick">
	<template #header>
		<h1 class="m-0 text-2xl font-normal text-[#202124] dark:text-slate-100">{{ t('nav.recent') }}</h1>
	</template>
</FileListSurface>
```

Manter `FileDetailsModal` e `FloatingProgressToast`.

- [ ] **Step 2: Migrar `SharedWithMeView.vue`**

Remover os mesmos imports e o `renderedGroupedFiles` local (linhas 113-121). Manter `folderStack`, `loadCurrentFolder`, `refreshShared`, `openFolder`, `navigateToBreadcrumb`, `openSelectedItem`, `openItemOnDoubleClick`, `breadcrumbItems`, `useAutoRefresh` e `useRecencyGroups`.

Template:

```vue
<FileListSurface :view="view" :loading="loading" :groups="groupedFiles" :empty-message="t('shared.empty')" :allow-rename="false" :allow-delete="false" @open="openItemOnDoubleClick" @open-selected="openSelectedItem">
	<template #header>
		<h1 class="m-0">
			<nav aria-label="Breadcrumb" class="flex flex-wrap items-center gap-1 text-2xl font-normal text-[#202124] dark:text-slate-100">
				<template v-for="(crumb, breadcrumbIndex) in breadcrumbItems" :key="`${crumb.index}:${crumb.label}`">
					<button type="button" class="max-w-[220px] truncate leading-tight transition hover:text-[#1a73e8] dark:hover:text-sky-300" @click="navigateToBreadcrumb(crumb.index)">{{ crumb.label }}</button>
					<IconChevronRight v-if="breadcrumbIndex < breadcrumbItems.length - 1" :size="18" :stroke="2" class="mx-1 text-[#5f6368] dark:text-slate-400" />
				</template>
			</nav>
		</h1>
	</template>
	<template #selection-prefix="{ primary }">
		<button v-if="primary?.is_folder" type="button" class="inline-flex size-9 items-center justify-center rounded-full transition enabled:hover:bg-[#d2e3fc] dark:enabled:hover:bg-sky-500/20" :title="t('common.open')" @click="openSelectedItem">
			<IconFolder :size="18" :stroke="2" />
		</button>
	</template>
</FileListSurface>
```

`loading` e `errorMessage` continuam sendo mutados por `loadCurrentFolder` através de `view.loading` e `view.errorMessage` — não mudar essa parte.

- [ ] **Step 3: Verificar o build**

Run: `cd frontend && npm run build`
Expected: build conclui sem erro.

- [ ] **Step 4: Verificação manual**

Run: `cd frontend && npm run dev`

Abrir `/recent` e `/shared-with-me`:
- headers de recência aparecem em lista e grade, e ficam sticky ao rolar;
- rolar até o fim carrega mais itens (renderização incremental);
- em Shared: abrir pasta empilha o breadcrumb, clicar no breadcrumb volta;
- em Shared: os botões de renomear e excluir estão desabilitados ou ausentes;
- em Recent: nenhuma coluna é clicável para ordenar, e o menu de contexto não oferece "abrir pasta".

- [ ] **Step 5: Commit**

```bash
git add frontend/src/views/RecentView.vue frontend/src/views/SharedWithMeView.vue
git commit -m "refactor: move the recent and shared views onto the file list surface"
```

---

### Task 3: `FileInspector.vue` e remoção do modal de detalhes

**Files:**
- Create: `frontend/src/components/FileInspector.vue`
- Delete: `frontend/src/components/FileDetailsModal.vue`
- Modify: `frontend/src/composables/useFileListView.js`
- Modify: `frontend/src/components/FileListSurface.vue`
- Modify: `frontend/src/views/MyDriveView.vue`, `StarredView.vue`, `RecentView.vue`, `SharedWithMeView.vue`
- Modify: `frontend/src/locales/en.json`, `frontend/src/locales/id.json`

**Interfaces:**
- Consumes: `useFileDetailsModal` (`openDetails`, `closeDetails`, `detailsFile`) já exposto por `useFileActions` (`frontend/src/composables/useFileActions.js:244-247`); `api.thumbnailUrl(file)` (`frontend/src/services/api.js:264`).
- Produces: `useFileListView` passa a devolver `isInspectorOpen` (ref booleano) e `toggleInspector()` (função). O componente `FileInspector` recebe as props `file`, `detailsFile`, `selectedFiles`, `selectedCount`, `canDownload`, `canRename`, `canDelete`, `canToggleStar`, `isStarred`, `canOpenFolder` e emite `close`, `open`, `download`, `rename`, `delete`, `toggle-star`.

- [ ] **Step 1: Adicionar as chaves de tradução**

Em `frontend/src/locales/en.json`, no nível raiz:

```json
"inspector": {
	"title": "Details",
	"toggle": "Toggle the details panel",
	"emptyTitle": "Nothing selected",
	"emptyDescription": "Select an item to see its details.",
	"itemsSelected": "{count} items selected",
	"totalSize": "Total size"
}
```

Em `frontend/src/locales/id.json`, no nível raiz:

```json
"inspector": {
	"title": "Detail",
	"toggle": "Tampilkan atau sembunyikan panel detail",
	"emptyTitle": "Belum ada yang dipilih",
	"emptyDescription": "Pilih item untuk melihat detailnya.",
	"itemsSelected": "{count} item dipilih",
	"totalSize": "Ukuran total"
}
```

- [ ] **Step 2: Criar `frontend/src/components/FileInspector.vue`**

```vue
<script setup>
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { IconDownload, IconEdit, IconFolder, IconStar, IconStarFilled, IconTrash, IconX } from '@tabler/icons-vue';
import { api } from '../services/api.js';
import { getFileIcon, canShowGridThumbnail } from '../composables/useFileType.js';
import { formatBytes, formatDate, getCreatedTime, getModifiedTime, providerLabel } from '../composables/useFormatFile.js';

const props = defineProps({
	file: { type: Object, default: null },
	detailsFile: { type: Object, default: null },
	selectedFiles: { type: Array, default: () => [] },
	selectedCount: { type: Number, default: 0 },
	canDownload: { type: Boolean, default: false },
	canRename: { type: Boolean, default: false },
	canDelete: { type: Boolean, default: true },
	canToggleStar: { type: Boolean, default: false },
	isStarred: { type: Boolean, default: false },
	canOpenFolder: { type: Boolean, default: false },
});

const emit = defineEmits(['close', 'open', 'download', 'rename', 'delete', 'toggle-star']);

const { t } = useI18n();
const thumbnailFailed = ref(false);

// Os detalhes vindos do backend so valem para o arquivo que ainda esta selecionado.
const enriched = computed(() => (
	props.detailsFile && props.file && props.detailsFile.id === props.file.id ? props.detailsFile : null
));

const displayName = computed(() => props.file?.display_name || props.file?.file_name || '—');
const thumbnailUrl = computed(() => (props.file ? api.thumbnailUrl(props.file) : ''));
const showThumbnail = computed(() => Boolean(props.file) && canShowGridThumbnail(props.file) && !thumbnailFailed.value);

const totalSize = computed(() => props.selectedFiles.reduce((sum, file) => sum + Number(file.size || 0), 0));

const fields = computed(() => {
	const file = props.file;
	if (!file) return [];
	const detail = enriched.value;
	return [
		{ key: 'type', label: t('drive.type'), value: detail?.mime_type || file.mime_type || (file.is_folder ? t('drive.folder') : '—') },
		{ key: 'size', label: t('drive.size'), value: file.is_folder ? '—' : formatBytes(file.size) },
		{ key: 'owner', label: t('drive.owner'), value: detail?.owner_email || file.email || '—' },
		{ key: 'provider', label: t('drive.provider'), value: providerLabel(file.provider) || '—' },
		{ key: 'created', label: t('drive.created'), value: formatDate(getCreatedTime(detail || file)) },
		{ key: 'modified', label: t('drive.modified'), value: formatDate(getModifiedTime(detail || file)) },
		{ key: 'location', label: t('drive.location'), value: file.virtual_path || '—' },
		{ key: 'remoteId', label: t('drive.remoteId'), value: detail?.remote_file_id || '—' },
	];
});

watch(thumbnailUrl, () => {
	thumbnailFailed.value = false;
});
</script>

<template>
	<aside class="custom-scrollbar flex h-full flex-col gap-4 overflow-y-auto rounded-2xl border border-[#e0e3e7] bg-white p-4 dark:border-slate-700 dark:bg-slate-800" @click.stop>
		<div class="flex items-center justify-between gap-3">
			<h2 class="text-sm font-semibold uppercase tracking-[0.08em] text-[#5f6368] dark:text-slate-400">{{ t('inspector.title') }}</h2>
			<button type="button" class="grid size-8 place-items-center rounded-full text-[#5f6368] transition hover:bg-black/5 dark:text-slate-400 dark:hover:bg-white/10" :title="t('common.close')" @click="emit('close')">
				<IconX :size="16" :stroke="2" />
			</button>
		</div>

		<div v-if="!selectedCount" class="rounded-2xl border border-dashed border-[#dadce0] px-4 py-8 text-center dark:border-slate-700">
			<p class="text-sm font-medium text-[#202124] dark:text-slate-100">{{ t('inspector.emptyTitle') }}</p>
			<p class="mt-1 text-xs text-[#5f6368] dark:text-slate-400">{{ t('inspector.emptyDescription') }}</p>
		</div>

		<div v-else-if="selectedCount > 1" class="flex flex-col gap-3">
			<p class="text-sm font-semibold text-[#202124] dark:text-slate-100">{{ t('inspector.itemsSelected', { count: selectedCount }) }}</p>
			<dl class="grid grid-cols-[110px_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
				<dt class="text-[#5f6368] dark:text-slate-400">{{ t('inspector.totalSize') }}</dt>
				<dd class="break-words">{{ formatBytes(totalSize) }}</dd>
			</dl>
			<div class="flex flex-wrap gap-2">
				<button type="button" class="inline-flex size-9 items-center justify-center rounded-full transition disabled:cursor-not-allowed disabled:opacity-45 enabled:hover:bg-[#e8f0fe] dark:enabled:hover:bg-sky-500/20" :title="t('common.download')" :disabled="!canDownload" @click="emit('download')">
					<IconDownload :size="18" :stroke="2" />
				</button>
				<button v-if="canDelete" type="button" class="inline-flex size-9 items-center justify-center rounded-full text-[#c5221f] transition hover:bg-[#fce8e6] dark:text-red-300 dark:hover:bg-red-950/30" :title="t('common.delete')" @click="emit('delete')">
					<IconTrash :size="18" :stroke="2" />
				</button>
			</div>
		</div>

		<div v-else class="flex flex-col gap-4">
			<div class="overflow-hidden rounded-2xl bg-[#f1f3f4] dark:bg-slate-700">
				<img v-if="showThumbnail" :src="thumbnailUrl" :alt="displayName" class="aspect-video w-full object-cover" loading="lazy" @error="thumbnailFailed = true" />
				<div v-else class="grid aspect-video place-items-center text-[#5f6368] dark:text-slate-300">
					<component :is="getFileIcon(file, false)" :size="42" :stroke="1.4" />
				</div>
			</div>

			<p class="break-words text-sm font-semibold text-[#202124] dark:text-slate-100">{{ displayName }}</p>

			<div class="flex flex-wrap gap-2">
				<button v-if="canOpenFolder" type="button" class="inline-flex size-9 items-center justify-center rounded-full transition hover:bg-[#e8f0fe] dark:hover:bg-sky-500/20" :title="t('common.open')" @click="emit('open')">
					<IconFolder :size="18" :stroke="2" />
				</button>
				<button type="button" class="inline-flex size-9 items-center justify-center rounded-full transition disabled:cursor-not-allowed disabled:opacity-45 enabled:hover:bg-[#e8f0fe] dark:enabled:hover:bg-sky-500/20" :title="t('common.download')" :disabled="!canDownload" @click="emit('download')">
					<IconDownload :size="18" :stroke="2" />
				</button>
				<button v-if="canToggleStar" type="button" class="inline-flex size-9 items-center justify-center rounded-full transition hover:bg-[#e8f0fe] dark:hover:bg-sky-500/20" :title="isStarred ? t('drive.unstar') : t('drive.star')" @click="emit('toggle-star')">
					<component :is="isStarred ? IconStarFilled : IconStar" :size="18" :stroke="isStarred ? 0 : 2" />
				</button>
				<button type="button" class="inline-flex size-9 items-center justify-center rounded-full transition disabled:cursor-not-allowed disabled:opacity-45 enabled:hover:bg-[#e8f0fe] dark:enabled:hover:bg-sky-500/20" :title="t('common.rename')" :disabled="!canRename" @click="emit('rename')">
					<IconEdit :size="18" :stroke="2" />
				</button>
				<button v-if="canDelete" type="button" class="inline-flex size-9 items-center justify-center rounded-full text-[#c5221f] transition hover:bg-[#fce8e6] dark:text-red-300 dark:hover:bg-red-950/30" :title="t('common.delete')" @click="emit('delete')">
					<IconTrash :size="18" :stroke="2" />
				</button>
			</div>

			<dl class="grid grid-cols-[110px_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
				<template v-for="field in fields" :key="field.key">
					<dt class="text-[#5f6368] dark:text-slate-400">{{ field.label }}</dt>
					<dd class="break-words">{{ field.value }}</dd>
				</template>
			</dl>
		</div>
	</aside>
</template>
```

- [ ] **Step 3: Adicionar o estado do inspector em `useFileListView.js`**

Depois da criação de `actionsApi` (linha 181-191), inserir:

```js
const INSPECTOR_STORAGE_KEY = 'omnicloud-inspector-open';
const hasWindow = typeof window !== 'undefined';
const isInspectorOpen = ref(hasWindow && window.localStorage.getItem(INSPECTOR_STORAGE_KEY) === '1');

function toggleInspector() {
	isInspectorOpen.value = !isInspectorOpen.value;
}

watch(isInspectorOpen, (open) => {
	if (hasWindow) window.localStorage.setItem(INSPECTOR_STORAGE_KEY, open ? '1' : '0');
});

// ponytail: um unico timer de debounce. Se um dia houver mais de um inspector por
// pagina, cada instancia precisa do seu.
let detailsDebounce = null;

watch([actionsApi.primarySelectedFile, isInspectorOpen], ([file, open]) => {
	if (detailsDebounce) window.clearTimeout(detailsDebounce);
	if (!open || !file || actionsApi.selectedCount.value !== 1) return;
	if (actionsApi.detailsFile.value?.id === file.id) return;
	detailsDebounce = window.setTimeout(async () => {
		const targetId = file.id;
		await actionsApi.openDetails(file);
		if (actionsApi.primarySelectedFile.value?.id !== targetId) actionsApi.closeDetails();
	}, 300);
});
```

Substituir a chamada direta de `showSelectedFileDetails` por uma versão que abre o painel. Junto de `renameSelectedFile` e `deleteSelectedFile` (linhas 196-210), adicionar:

```js
async function showSelectedFileDetails() {
	isInspectorOpen.value = true;
	await actionsApi.showSelectedFileDetails();
}
```

No `return` (linha 244), adicionar `isInspectorOpen`, `toggleInspector` e `showSelectedFileDetails` **depois** do spread `...actionsApi`, para que a versão nova vença:

```js
		...actionsApi,
		renameSelectedFile,
		deleteSelectedFile,
		showSelectedFileDetails,
		isInspectorOpen,
		toggleInspector,
```

Em `onBeforeUnmount` (linha 229), limpar o timer:

```js
		if (detailsDebounce) window.clearTimeout(detailsDebounce);
```

- [ ] **Step 4: Ligar o inspector no `FileListSurface.vue`**

Adicionar ao import block:

```js
import FileInspector from './FileInspector.vue';
import { IconLayoutSidebarRight, IconLayoutSidebarRightFilled } from '@tabler/icons-vue';
```

Adicionar à desestruturação de `props.view`: `isInspectorOpen`, `toggleInspector`, `detailsFile`, `selectedFiles`, `openDetails` não é necessário.

Trocar o cabeçalho para incluir o botão de alternância, ao lado do toggle de modo:

```vue
<div class="flex items-center gap-2">
	<FileListViewModeToggle v-model="isGridView" />
	<button type="button" class="grid size-10 place-items-center rounded-full text-[#5f6368] transition hover:bg-black/5 dark:text-slate-400 dark:hover:bg-white/10" :title="t('inspector.toggle')" :aria-pressed="isInspectorOpen" @click.stop="toggleInspector">
		<component :is="isInspectorOpen ? IconLayoutSidebarRightFilled : IconLayoutSidebarRight" :size="18" :stroke="isInspectorOpen ? 0 : 2" />
	</button>
</div>
```

Envolver a área de lista e grade num grid de duas colunas quando o painel está aberto. Substituir os dois blocos `<div v-if="!isGridView" ...>` e `<div v-else ...>` por um wrapper:

```vue
<div class="grid gap-4" :class="isInspectorOpen ? 'lg:grid-cols-[minmax(0,1fr)_320px]' : 'grid-cols-1'">
	<div class="min-w-0">
		<!-- os dois blocos existentes de lista e grade entram aqui, sem alteracao -->
	</div>
	<FileInspector v-if="isInspectorOpen" :file="primarySelectedFile" :details-file="detailsFile" :selected-files="selectedFiles" :selected-count="selectedCount" :can-download="canDownloadSelection" :can-rename="canRename" :can-delete="allowDelete" :can-toggle-star="canToggleStarSelection" :is-starred="isPrimarySelectedStarred" :can-open-folder="canOpenFolder && canOpenSelection" @close="toggleInspector" @open="emit('open-selected')" @download="downloadSelection" @rename="renameSelectedFile" @delete="deleteSelectedFile" @toggle-star="toggleSelectedFileStar" />
</div>
```

Abaixo de `lg` o grid vira uma coluna só e o painel aparece embaixo da lista — comportamento aceitável para o primeiro corte, sem bottom sheet dedicado.

`// ponytail: uma coluna abaixo de lg em vez de bottom sheet. Vira sheet se o painel atrapalhar no telefone.`

- [ ] **Step 5: Remover `FileDetailsModal` das quatro views e deletar o componente**

Em cada uma de `MyDriveView.vue`, `StarredView.vue`, `RecentView.vue`, `SharedWithMeView.vue`: remover o import de `FileDetailsModal`, a linha `<FileDetailsModal ... />` do template, e quaisquer referências restantes a `detailsFile`, `isDetailsOpen`, `closeDetails` e `providerLabel` que só existiam para o modal.

Run: `rm frontend/src/components/FileDetailsModal.vue`

- [ ] **Step 6: Confirmar que não restou referência ao modal**

Run: `grep -rn "FileDetailsModal\|isDetailsOpen\|closeDetails" frontend/src`
Expected: apenas `frontend/src/composables/useFileDetailsModal.js` e `frontend/src/composables/useFileActions.js`. Nenhum `.vue`.

- [ ] **Step 7: Verificar o build**

Run: `cd frontend && npm run build`
Expected: build conclui sem erro.

- [ ] **Step 8: Verificação manual**

Run: `cd frontend && npm run dev`

Nas quatro views:
- o botão de alternância abre e fecha o painel, e o estado sobrevive a um reload;
- sem seleção, o painel mostra o texto de vazio;
- com um arquivo selecionado, aparece thumbnail (ou ícone), nome e os oito campos; o mime type completo e o remote ID chegam pouco depois, sem o layout saltar;
- com vários selecionados, aparece a contagem e o tamanho somado;
- os botões do painel executam download, renomear, excluir e favoritar;
- em Shared, renomear e excluir não aparecem ou estão desabilitados;
- clicar em "Detalhes" no menu de contexto abre o painel se ele estiver fechado.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/components/FileInspector.vue frontend/src/components/FileListSurface.vue frontend/src/composables/useFileListView.js frontend/src/views frontend/src/locales
git rm frontend/src/components/FileDetailsModal.vue
git commit -m "feat: replace the file details modal with a side inspector panel"
```

---

### Task 4: `useFileListKeyboard.js`, Quick Preview e testes

**Files:**
- Create: `frontend/src/composables/useFileListKeyboard.js`
- Create: `frontend/test/useFileListKeyboard.test.js`
- Modify: `frontend/src/composables/useFileListView.js`
- Modify: `frontend/src/components/FileListSurface.vue`

**Interfaces:**
- Consumes: `useFileSelection` (`selectedFileIds`, `lastSelectedFileId`, `replaceSelection`, `clearSelection`), `useFilePreviewModal` (`openPreview`, `closePreview`, `isPreviewOpen`, `canPreview`), `isInspectorOpen`/`toggleInspector` da Task 3.
- Produces: `useFileListKeyboard(options)` devolve `{ handleKeydown, setOpenHandler }`. `useFileListView` passa a devolver `setOpenHandler`, que a superfície chama para informar como abrir um item.

- [ ] **Step 1: Escrever o teste que falha**

Criar `frontend/test/useFileListKeyboard.test.js`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { ref } from 'vue';
import { useFileListKeyboard } from '../src/composables/useFileListKeyboard.js';

const FILES = [
	{ id: 'a', file_name: 'a.txt' },
	{ id: 'b', file_name: 'b.txt' },
	{ id: 'c', file_name: 'c.txt' },
];

function keyEvent(key, extra = {}) {
	return {
		key,
		shiftKey: false,
		ctrlKey: false,
		metaKey: false,
		target: { tagName: 'DIV', isContentEditable: false },
		preventDefault() { this.defaultPrevented = true; },
		defaultPrevented: false,
		...extra,
	};
}

function setup(overrides = {}) {
	const sortedFiles = ref(FILES);
	const selectedFileIds = ref(new Set());
	const lastSelectedFileId = ref(null);
	const isPreviewOpen = ref(false);
	const opened = [];
	const calls = { rename: 0, remove: 0, inspector: 0 };

	const keyboard = useFileListKeyboard({
		sortedFiles,
		selectedFileIds,
		lastSelectedFileId,
		replaceSelection: (file) => {
			selectedFileIds.value = new Set([file.id]);
			lastSelectedFileId.value = file.id;
		},
		clearSelection: () => {
			selectedFileIds.value = new Set();
			lastSelectedFileId.value = null;
		},
		isPreviewOpen,
		canPreview: () => true,
		openPreview: (file) => { opened.push(file.id); isPreviewOpen.value = true; },
		closePreview: () => { isPreviewOpen.value = false; },
		renameSelectedFile: () => { calls.rename += 1; },
		deleteSelectedFile: () => { calls.remove += 1; },
		toggleInspector: () => { calls.inspector += 1; },
		...overrides,
	});

	return { keyboard, sortedFiles, selectedFileIds, lastSelectedFileId, isPreviewOpen, opened, calls };
}

test('a seta para baixo comeca no primeiro item e avanca', () => {
	const { keyboard, lastSelectedFileId } = setup();
	keyboard.handleKeydown(keyEvent('ArrowDown'));
	assert.equal(lastSelectedFileId.value, 'a');
	keyboard.handleKeydown(keyEvent('ArrowDown'));
	assert.equal(lastSelectedFileId.value, 'b');
});

test('o cursor para no ultimo item', () => {
	const { keyboard, lastSelectedFileId } = setup();
	keyboard.handleKeydown(keyEvent('ArrowDown'));
	keyboard.handleKeydown(keyEvent('ArrowDown'));
	keyboard.handleKeydown(keyEvent('ArrowDown'));
	keyboard.handleKeydown(keyEvent('ArrowDown'));
	assert.equal(lastSelectedFileId.value, 'c');
});

test('shift mais seta estende a selecao a partir da ancora', () => {
	const { keyboard, selectedFileIds } = setup();
	keyboard.handleKeydown(keyEvent('ArrowDown'));
	keyboard.handleKeydown(keyEvent('ArrowDown', { shiftKey: true }));
	keyboard.handleKeydown(keyEvent('ArrowDown', { shiftKey: true }));
	assert.deepEqual([...selectedFileIds.value].sort(), ['a', 'b', 'c']);
});

test('ctrl mais A seleciona tudo', () => {
	const { keyboard, selectedFileIds } = setup();
	keyboard.handleKeydown(keyEvent('a', { ctrlKey: true }));
	assert.equal(selectedFileIds.value.size, 3);
});

test('evento vindo de um input e ignorado', () => {
	const { keyboard, lastSelectedFileId } = setup();
	keyboard.handleKeydown(keyEvent('ArrowDown', { target: { tagName: 'INPUT', isContentEditable: false } }));
	assert.equal(lastSelectedFileId.value, null);
});

test('espaco abre o preview e fecha quando ja esta aberto', () => {
	const { keyboard, opened, isPreviewOpen } = setup();
	keyboard.handleKeydown(keyEvent('ArrowDown'));
	keyboard.handleKeydown(keyEvent(' '));
	assert.deepEqual(opened, ['a']);
	assert.equal(isPreviewOpen.value, true);
	keyboard.handleKeydown(keyEvent(' '));
	assert.equal(isPreviewOpen.value, false);
});

test('escape com preview aberto e ignorado pelo teclado da lista', () => {
	const { keyboard, selectedFileIds, isPreviewOpen } = setup();
	keyboard.handleKeydown(keyEvent('ArrowDown'));
	isPreviewOpen.value = true;
	keyboard.handleKeydown(keyEvent('Escape'));
	assert.equal(selectedFileIds.value.size, 1);
});

test('escape sem preview limpa a selecao', () => {
	const { keyboard, selectedFileIds } = setup();
	keyboard.handleKeydown(keyEvent('ArrowDown'));
	keyboard.handleKeydown(keyEvent('Escape'));
	assert.equal(selectedFileIds.value.size, 0);
});

test('F2 renomeia, Delete exclui e I alterna o inspector', () => {
	const { keyboard, calls } = setup();
	keyboard.handleKeydown(keyEvent('ArrowDown'));
	keyboard.handleKeydown(keyEvent('F2'));
	keyboard.handleKeydown(keyEvent('Delete'));
	keyboard.handleKeydown(keyEvent('i'));
	assert.deepEqual(calls, { rename: 1, remove: 1, inspector: 1 });
});
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `cd frontend && npm run test`
Expected: FAIL — `Cannot find module '../src/composables/useFileListKeyboard.js'`.

- [ ] **Step 3: Implementar `frontend/src/composables/useFileListKeyboard.js`**

```js
import { onBeforeUnmount, onMounted, ref } from 'vue';

const EDITABLE_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

function isEditableTarget(target) {
	if (!target) return false;
	if (EDITABLE_TAGS.has(target.tagName)) return true;
	return Boolean(target.isContentEditable);
}

export function useFileListKeyboard({
	sortedFiles,
	selectedFileIds,
	lastSelectedFileId,
	replaceSelection,
	clearSelection,
	isPreviewOpen,
	canPreview,
	openPreview,
	closePreview,
	renameSelectedFile,
	deleteSelectedFile,
	toggleInspector,
	isGridView,
	onCursorMove,
}) {
	const anchorId = ref(null);
	let openHandler = null;

	function setOpenHandler(handler) {
		openHandler = typeof handler === 'function' ? handler : null;
	}

	function cursorItem() {
		return sortedFiles.value.find((item) => item.id === lastSelectedFileId.value) || null;
	}

	function itemAt(index) {
		const items = sortedFiles.value;
		if (!items.length) return null;
		return items[Math.min(Math.max(index, 0), items.length - 1)];
	}

	function applyCursor(next, extend) {
		const items = sortedFiles.value;
		if (!next) return;

		if (extend) {
			// A ancora nao pode andar junto do cursor, senao shift repetido perde o inicio do intervalo.
			const anchor = anchorId.value || lastSelectedFileId.value || next.id;
			const start = items.findIndex((item) => item.id === anchor);
			const end = items.findIndex((item) => item.id === next.id);
			if (start !== -1 && end !== -1) {
				const [from, to] = start < end ? [start, end] : [end, start];
				selectedFileIds.value = new Set(items.slice(from, to + 1).map((item) => item.id));
				lastSelectedFileId.value = next.id;
				anchorId.value = anchor;
			}
		} else {
			replaceSelection(next);
			anchorId.value = next.id;
		}

		if (typeof onCursorMove === 'function') onCursorMove(next);
	}

	function moveCursor(offset, extend) {
		const items = sortedFiles.value;
		if (!items.length) return;
		const currentIndex = items.findIndex((item) => item.id === lastSelectedFileId.value);
		// Sem cursor, um passo para frente comeca no primeiro item e um passo para tras, no ultimo.
		const next = currentIndex === -1
			? (offset > 0 ? items[0] : items[items.length - 1])
			: itemAt(currentIndex + offset);
		applyCursor(next, extend);
	}

	function moveCursorTo(index, extend) {
		applyCursor(itemAt(index), extend);
	}

	function toggleQuickPreview() {
		if (isPreviewOpen.value) {
			closePreview();
			return;
		}
		const file = cursorItem();
		if (file && canPreview(file)) openPreview(file);
	}

	function handleKeydown(event) {
		if (isEditableTarget(event.target)) return;

		// Com o preview aberto, Escape e as setas pertencem ao FilePreviewModal.
		if (isPreviewOpen.value && event.key !== ' ') return;

		const isHorizontal = event.key === 'ArrowLeft' || event.key === 'ArrowRight';
		if (isHorizontal && !isGridView?.value) return;

		switch (event.key) {
			case 'ArrowDown':
			case 'ArrowRight':
				event.preventDefault();
				moveCursor(1, event.shiftKey);
				return;
			case 'ArrowUp':
			case 'ArrowLeft':
				event.preventDefault();
				moveCursor(-1, event.shiftKey);
				return;
			case 'Home':
				event.preventDefault();
				moveCursorTo(0, event.shiftKey);
				return;
			case 'End':
				event.preventDefault();
				moveCursorTo(sortedFiles.value.length - 1, event.shiftKey);
				return;
			case ' ':
				event.preventDefault();
				toggleQuickPreview();
				return;
			case 'Enter': {
				const file = cursorItem();
				if (file && openHandler) openHandler(file);
				return;
			}
			case 'Escape':
				clearSelection();
				anchorId.value = null;
				return;
			case 'F2':
				if (lastSelectedFileId.value) renameSelectedFile();
				return;
			case 'Delete':
			case 'Backspace':
				if (selectedFileIds.value.size) deleteSelectedFile();
				return;
			case 'i':
			case 'I':
				if (!event.ctrlKey && !event.metaKey) toggleInspector();
				return;
			case 'a':
			case 'A':
				if (!event.ctrlKey && !event.metaKey) return;
				event.preventDefault();
				selectedFileIds.value = new Set(sortedFiles.value.map((item) => item.id));
				return;
			default:
		}
	}

	onMounted(() => window.addEventListener('keydown', handleKeydown));
	onBeforeUnmount(() => window.removeEventListener('keydown', handleKeydown));

	return { handleKeydown, setOpenHandler };
}
```

`onMounted` e `onBeforeUnmount` fora de um componente apenas emitem um aviso do Vue e não quebram; os testes chamam `handleKeydown` direto.

- [ ] **Step 4: Rodar os testes e confirmar que passam**

Run: `cd frontend && npm run test`
Expected: PASS em todos os arquivos de teste, incluindo os três já existentes.

- [ ] **Step 5: Ligar o teclado em `useFileListView.js`**

Adicionar o import:

```js
import { useFileListKeyboard } from './useFileListKeyboard.js';
```

Depois do bloco do inspector criado na Task 3:

```js
const keyboard = useFileListKeyboard({
	sortedFiles,
	selectedFileIds: actionsApi.selectedFileIds,
	lastSelectedFileId: actionsApi.lastSelectedFileId,
	replaceSelection: actionsApi.replaceSelection,
	clearSelection: actionsApi.clearSelection,
	isPreviewOpen: actionsApi.isPreviewOpen,
	canPreview: actionsApi.canPreview,
	openPreview: actionsApi.openPreview,
	closePreview: actionsApi.closePreview,
	renameSelectedFile,
	deleteSelectedFile,
	toggleInspector,
	isGridView,
	onCursorMove: (file) => {
		if (typeof document === 'undefined') return;
		document.querySelector(`[data-file-id="${CSS.escape(file.id)}"]`)?.scrollIntoView({ block: 'nearest' });
	},
});
```

No `return`, adicionar `setOpenHandler: keyboard.setOpenHandler`.

Atenção ao `handleGlobalPointer` (linha 212-216): ele limpa a seleção a cada clique na janela. Isso continua valendo — o teclado não interfere.

- [ ] **Step 6: Informar o handler de abertura pela superfície**

Em `FileListSurface.vue`, adicionar `setOpenHandler` à desestruturação de `props.view` e registrá-lo:

```js
setOpenHandler((file) => emit('open', file));
```

Isso faz Enter disparar o mesmo caminho do duplo clique em cada view, sem que a view precise saber que existe teclado.

- [ ] **Step 7: Anel de foco no item sob o cursor**

Em `FileListRow.vue` e `FileListGridCard.vue`, adicionar a prop:

```js
	focused: { type: Boolean, default: false },
```

E acrescentar ao `:class` da div raiz de cada um, depois das classes de seleção:

```
focused ? 'ring-2 ring-inset ring-[#1a73e8] dark:ring-sky-400' : ''
```

Em `FileListSurface.vue`, passar `:focused="lastSelectedFileId === item.id && selectedCount > 1"` nas quatro ocorrências de `FileListRow` e `FileListGridCard` (lista plana, lista agrupada, grade plana, grade agrupada). Com um item só selecionado o fundo azul já indica onde está o cursor; o anel serve para distinguir cursor de seleção quando há vários.

Adicionar `lastSelectedFileId` à desestruturação de `props.view` em `FileListSurface.vue`.

- [ ] **Step 8: Grade mais larga quando o inspector está fechado**

Em `FileListSurface.vue`, trocar a classe do grid de cards:

```vue
<div class="grid grid-cols-1 gap-4 sm:grid-cols-2" :class="isInspectorOpen ? 'xl:grid-cols-3' : 'xl:grid-cols-4 2xl:grid-cols-5'">
```

- [ ] **Step 9: Verificar build e testes**

Run: `cd frontend && npm run test && npm run build`
Expected: testes PASS e build sem erro.

- [ ] **Step 10: Verificação manual**

Run: `cd frontend && npm run dev`

Em `/my-drive`, com a lista carregada e sem clicar em nenhum campo de texto:
- ↑ e ↓ movem o cursor e rolam a lista quando o item sai da área visível;
- no modo grade, ← e → também movem;
- Shift+↓ repetido acumula a seleção sem perder o item inicial;
- Espaço abre o preview do item sob o cursor e Espaço de novo fecha;
- com o preview aberto, ← e → trocam de arquivo e Esc fecha (comportamento do modal);
- Enter abre a pasta sob o cursor;
- Ctrl/⌘+A seleciona todos os itens e o painel mostra a contagem e o tamanho somado;
- F2 abre o prompt de renomear, Delete abre a confirmação de exclusão;
- `i` alterna o painel;
- clicar na busca do header e digitar "a", espaço, setas: o texto é digitado normalmente e a lista **não** reage.

- [ ] **Step 11: Commit**

```bash
git add frontend/src/composables/useFileListKeyboard.js frontend/test/useFileListKeyboard.test.js frontend/src/composables/useFileListView.js frontend/src/components/FileListSurface.vue frontend/src/components/FileListRow.vue frontend/src/components/FileListGridCard.vue
git commit -m "feat: add keyboard navigation and space bar quick preview to the explorer"
```

---

## Auto-revisão

**Cobertura da spec:**

| Requisito da spec | Tarefa |
|---|---|
| `FileListSurface.vue` com props, slots e eventos | 1 |
| Grupos sticky vindos de `useRecencyGroups` | 1 (implementação), 2 (uso) |
| Recorte incremental compartilhado, `renderCount` exposto | 1 |
| Migração das quatro views | 1, 2 |
| `FileInspector.vue` com os três estados de seleção | 3 |
| Enriquecimento por `openDetails` com debounce de 300 ms e guarda de corrida | 3 |
| Persistência do painel em `localStorage` | 3 |
| Remoção do `FileDetailsModal.vue` | 3 |
| Chaves de tradução em en e id | 3 |
| `useFileListKeyboard.js` com a tabela completa de atalhos | 4 |
| Guarda de campos editáveis e de modal aberto | 4 |
| Quick Preview pela barra de espaço | 4 |
| Scroll do cursor e anel de foco | 4 |
| Grade mais larga com o painel fechado | 4 |
| Testes de teclado no runner `node --test` | 4 |

**Nomes usados de forma consistente entre tarefas:** `isInspectorOpen`, `toggleInspector` e `showSelectedFileDetails` são criados na Task 3 e consumidos na Task 4; `setOpenHandler` é criado na Task 4 e consumido no mesmo commit; `renderCount` é exposto na Task 1 e consumido pelo `MyDriveView` na mesma tarefa.

**Divergência conhecida em relação à spec:** a spec descrevia o painel como bottom sheet abaixo de `lg`. O plano entrega uma coluna empilhada, marcada com comentário `ponytail:` na Task 3 Step 4. Vira sheet se atrapalhar no uso real.
