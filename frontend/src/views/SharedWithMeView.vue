<script setup>
import { computed, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { useI18n } from 'vue-i18n';
import { IconChevronRight, IconFolder } from '@tabler/icons-vue';
import DriveShell from '../components/DriveShell.vue';
import FloatingProgressToast from '../components/FloatingProgressToast.vue';
import FileListSurface from '../components/FileListSurface.vue';
import { useFileListView } from '../composables/useFileListView';
import { getPreviewType } from '../composables/useFileType.js';
import { useAutoRefresh } from '../composables/useAutoRefresh.js';
import { useRecencyGroups } from '../composables/useRecencyGroups.js';
import { useUploadQueueStore } from '../stores/uploadQueue';
import { api } from '../services/api';

const { t } = useI18n();
const uploadQueueStore = useUploadQueueStore();
const { uploads, totalProgress } = storeToRefs(uploadQueueStore);

const folderStack = ref([]);
const navigating = ref(false);

const view = useFileListView({
	getPreviewType,
	loadFiles: async () => {
		const { data } = await api.listSharedWithMeFiles();
		return Array.isArray(data) ? data : [];
	},
	uploadQueueStore,
});

const {
	loading,
	errorMessage,
	sortedFiles,
	primarySelectedFile,
	contextMenu,
	closeContextMenu,
	clearSelection,
	canPreview,
	openPreview,
} = view;

const breadcrumbItems = computed(() => [
	{ label: t('nav.shared'), index: -1 },
	...folderStack.value.map((item, index) => ({ label: item.file_name, index })),
]);

const { groups: groupedFiles } = useRecencyGroups(sortedFiles, t);

async function loadCurrentFolder(folder) {
	navigating.value = true;
	loading.value = true;
	errorMessage.value = '';
	view.files.value = [];
	try {
		const { data } = folder
			? await api.listSharedFolderChildren(folder.id)
			: await api.listSharedWithMeFiles();
		view.files.value = Array.isArray(data) ? data : [];
	} catch (error) {
		errorMessage.value = errorMessage.value || error.message;
	} finally {
		loading.value = false;
		navigating.value = false;
	}
}

async function refreshShared() {
	const currentFolder = folderStack.value.at(-1);
	await loadCurrentFolder(currentFolder);
}

async function openFolder(file) {
	if (!file?.is_folder) return;
	closeContextMenu();
	clearSelection();
	folderStack.value = [...folderStack.value, file];
	navigating.value = true;
	await loadCurrentFolder(file);
}

async function navigateToBreadcrumb(index) {
	closeContextMenu();
	clearSelection();
	if (index < 0) {
		folderStack.value = [];
		navigating.value = true;
		await loadCurrentFolder(null);
		return;
	}
	folderStack.value = folderStack.value.slice(0, index + 1);
	navigating.value = true;
	await loadCurrentFolder(folderStack.value.at(-1));
}

function openSelectedItem() {
	const file = primarySelectedFile.value || contextMenu.value.file;
	if (file?.is_folder) openFolder(file);
}

function openItemOnDoubleClick(file) {
	if (file.is_folder) {
		openFolder(file);
		return;
	}
	if (canPreview(file)) openPreview(file);
}

useAutoRefresh(refreshShared, { intervalMs: 30000 });
</script>

<template>
	<DriveShell current-section="shared">
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

		<FloatingProgressToast :uploads="uploads" :total-progress="totalProgress" @close="uploadQueueStore.clearOperations" @close-item="uploadQueueStore.closeOperation" />
	</DriveShell>
</template>
