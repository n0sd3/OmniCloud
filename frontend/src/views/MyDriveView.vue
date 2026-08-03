<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useI18n } from 'vue-i18n';
import { IconChevronRight, IconFolder } from '@tabler/icons-vue';
import DriveShell from '../components/DriveShell.vue';
import FloatingProgressToast from '../components/FloatingProgressToast.vue';
import FileListSurface from '../components/FileListSurface.vue';
import { useFileListView } from '../composables/useFileListView';
import { getPreviewType } from '../composables/useFileType.js';
import { useAutoRefresh } from '../composables/useAutoRefresh.js';
import { useTrackedFileActions } from '../composables/useTrackedFileActions.js';
import { useFileTreeStore } from '../stores/fileTree';
import { useUploadQueueStore } from '../stores/uploadQueue';
import { api } from '../services/api';

const { t } = useI18n();

const fileTreeStore = useFileTreeStore();
const uploadQueueStore = useUploadQueueStore();
const { currentPath, breadcrumbs, searchTerm, isLoading } = storeToRefs(fileTreeStore);
const { uploads, totalProgress } = storeToRefs(uploadQueueStore);

const isDragActive = ref(false);
const dragDepth = ref(0);
const fileInputRef = ref(null);
const folderInputRef = ref(null);
const lastObservedSyncAt = ref('');
const highlightedFileId = ref(null);
const highlightTimeout = ref(null);

const view = useFileListView({
	getPreviewType,
	sourceFiles: computed(() => fileTreeStore.filteredFiles),
	loadFiles: () => fileTreeStore.loadFiles(fileTreeStore.currentPath).then(() => fileTreeStore.files),
	uploadQueueStore,
	autoRefresh: false,
	sortable: true,
	initialSortBy: 'updated_at',
	initialSortDirection: 'desc',
	actions: useTrackedFileActions({ uploadQueueStore, api }),
});

const surfaceRef = ref(null);
const {
	sortedFiles,
	clearSelection,
	primarySelectedFile,
	contextMenu,
	closeContextMenu,
	canPreview,
	openPreview,
} = view;

watch(searchTerm, (term) => {
	fileTreeStore.applySearch(term);
});

watch(() => fileTreeStore.files, consumePendingHighlight, { flush: 'post' });

function clearHighlightTimer() {
	if (!highlightTimeout.value) return;
	window.clearTimeout(highlightTimeout.value);
	highlightTimeout.value = null;
}

function hasHighlightedFile(targetId) {
	return Boolean(targetId) && fileTreeStore.files.some((file) => file.id === targetId);
}

function ensureHighlightedFileRendered(targetId) {
	const targetIndex = sortedFiles.value.findIndex((file) => file.id === targetId);
	const renderCount = surfaceRef.value?.renderCount;
	if (renderCount && targetIndex >= renderCount.value) {
		renderCount.value = targetIndex + 1;
	}
}

function scrollToFile(targetId) {
	document.querySelector(`[data-file-id="${CSS.escape(targetId)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function scheduleHighlightClear(targetId) {
	clearHighlightTimer();
	highlightTimeout.value = window.setTimeout(() => {
		if (highlightedFileId.value === targetId) {
			highlightedFileId.value = null;
		}
		highlightTimeout.value = null;
	}, 2400);
}

async function consumePendingHighlight() {
	const targetId = fileTreeStore.pendingHighlightId;
	if (!hasHighlightedFile(targetId)) return;

	fileTreeStore.pendingHighlightId = null;
	ensureHighlightedFileRendered(targetId);
	highlightedFileId.value = targetId;
	scheduleHighlightClear(targetId);

	await nextTick();
	scrollToFile(targetId);
}

function openItemOnDoubleClick(file) {
	if (file.is_folder) {
		openFolder(file);
		return;
	}
	if (canPreview(file)) {
		openPreview(file);
	}
}

function openFolder(file) {
	if (!file.is_folder) return;
	clearSelection();
	const basePath = file.virtual_path || (currentPath.value === '/' ? '/' : `${currentPath.value}/`);
	const nextPath = `${basePath}${file.file_name}/`;
	fileTreeStore.navigate(nextPath.startsWith('/') ? nextPath : `/${nextPath}`);
}

function openSelectedItem() {
	const file = primarySelectedFile.value || contextMenu.value.file;
	closeContextMenu();
	if (file?.is_folder) openFolder(file);
}

function resetFileInput(inputRef) {
	if (inputRef.value) inputRef.value.value = '';
}

async function refreshCurrentFolder() {
	await fileTreeStore.loadFiles(currentPath.value);
}

async function checkSyncStatus() {
	if (document.visibilityState !== 'visible') return;
	try {
		const { sync } = await api.getHealth();
		const nextSyncAt = sync?.lastRunAt || '';
		if (!lastObservedSyncAt.value) {
			lastObservedSyncAt.value = nextSyncAt;
			return;
		}
		if (nextSyncAt && nextSyncAt !== lastObservedSyncAt.value) {
			lastObservedSyncAt.value = nextSyncAt;
			await refreshCurrentFolder();
		}
	} catch {
	}
}

useAutoRefresh(checkSyncStatus, { intervalMs: 20000, immediate: false });

async function handleUploads(entries) {
	if (!entries.length) return;
	try {
		await uploadQueueStore.uploadFiles(entries, currentPath.value, refreshCurrentFolder);
		await refreshCurrentFolder();
	} catch {
	}
}

function openFilePicker() {
	resetFileInput(fileInputRef);
	fileInputRef.value?.click();
}

function openFolderPicker() {
	resetFileInput(folderInputRef);
	folderInputRef.value?.click();
}

async function onFileInputChange(event) {
	const files = Array.from(event.target.files || []);
	await handleUploads(files);
}

async function onFolderInputChange(event) {
	const entries = Array.from(event.target.files || []).map((file) => ({
		file,
		relativePath: file.webkitRelativePath || file.name,
	}));
	await handleUploads(entries);
}

async function readDirectoryEntry(entry, prefix = '') {
	const reader = entry.createReader();
	const children = await new Promise((resolve, reject) => {
		reader.readEntries(resolve, reject);
	});
	const nested = await Promise.all(
		children.map((child) => readDroppedEntry(child, prefix ? `${prefix}/${entry.name}` : entry.name)),
	);
	return nested.flat();
}

async function readFileEntry(entry, prefix = '') {
	return new Promise((resolve, reject) => {
		entry.file(
			(file) => resolve([{ file, relativePath: prefix ? `${prefix}/${file.name}` : file.name }]),
			reject,
		);
	});
}

async function readDroppedEntry(entry, prefix = '') {
	if (entry.isDirectory) return readDirectoryEntry(entry, prefix);
	return readFileEntry(entry, prefix);
}

async function collectDroppedEntries(dataTransfer) {
	const items = Array.from(dataTransfer.items || []);
	const entries = items.map((item) => item.webkitGetAsEntry?.()).filter(Boolean);
	if (!entries.length) return Array.from(dataTransfer.files || []);
	const collected = await Promise.all(entries.map((entry) => readDroppedEntry(entry)));
	return collected.flat();
}

function resetDragState() {
	dragDepth.value = 0;
	isDragActive.value = false;
}

function handleDragEnter() {
	dragDepth.value += 1;
	isDragActive.value = true;
}

function handleDragLeave(event) {
	if (!event.currentTarget.contains(event.relatedTarget)) {
		resetDragState();
		return;
	}
	dragDepth.value = Math.max(0, dragDepth.value - 1);
	if (dragDepth.value === 0) isDragActive.value = false;
}

async function handleDrop(event) {
	resetDragState();
	const entries = await collectDroppedEntries(event.dataTransfer);
	await handleUploads(entries);
}

async function createNewFolder() {
	const folderName = window.prompt(t('drive.newFolderName'));
	if (!folderName?.trim()) return;
	try {
		await uploadQueueStore.trackServerOperation(
			{ type: 'create-folder', name: folderName.trim(), targetKind: 'folder' },
			() => api.createFolder({ name: folderName.trim(), virtual_path: currentPath.value }),
		);
		await refreshCurrentFolder();
	} catch {
	}
}

function handleVisibilityChange() {
	resetDragState();
	if (document.visibilityState === 'visible') {
		refreshCurrentFolder();
		checkSyncStatus();
	}
}

onMounted(async () => {
	const initialPath = fileTreeStore.pendingPath || '/';
	fileTreeStore.pendingPath = null;
	await fileTreeStore.loadFiles(initialPath);
	consumePendingHighlight();
	window.addEventListener('dragend', resetDragState);
	window.addEventListener('drop', resetDragState);
	window.addEventListener('blur', resetDragState);
	document.addEventListener('visibilitychange', handleVisibilityChange);
});

onBeforeUnmount(() => {
	clearHighlightTimer();
	window.removeEventListener('dragend', resetDragState);
	window.removeEventListener('drop', resetDragState);
	window.removeEventListener('blur', resetDragState);
	document.removeEventListener('visibilitychange', handleVisibilityChange);
});
</script>

<template>
	<DriveShell current-section="drive" @new-folder="createNewFolder" @upload-files="openFilePicker" @upload-folder="openFolderPicker">
		<div class="contents" @dragenter.prevent="handleDragEnter" @dragover.prevent="handleDragEnter" @dragleave.prevent="handleDragLeave" @drop.prevent="handleDrop">
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
					<button v-if="primary?.is_folder" type="button" class="inline-flex size-9 items-center justify-center rounded-full transition enabled:hover:bg-[#d2e3fc] dark:enabled:hover:bg-sky-500/20" :title="t('common.open')" @click="openSelectedItem">
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
		</div>

		<FloatingProgressToast :uploads="uploads" :total-progress="totalProgress" @close="uploadQueueStore.clearOperations" @close-item="uploadQueueStore.closeOperation" />
	</DriveShell>
</template>
