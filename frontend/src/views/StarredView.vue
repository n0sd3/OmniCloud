<script setup>
import { storeToRefs } from 'pinia';
import { useI18n } from 'vue-i18n';
import { IconFolder } from '@tabler/icons-vue';
import DriveShell from '../components/DriveShell.vue';
import FloatingProgressToast from '../components/FloatingProgressToast.vue';
import FileListSurface from '../components/FileListSurface.vue';
import { useFileListView } from '../composables/useFileListView';
import { getPreviewType } from '../composables/useFileType.js';
import { useAutoRefresh } from '../composables/useAutoRefresh.js';
import { useFileTreeStore } from '../stores/fileTree';
import { useUploadQueueStore } from '../stores/uploadQueue';
import { api } from '../services/api';

const { t } = useI18n();
const fileTreeStore = useFileTreeStore();
const uploadQueueStore = useUploadQueueStore();
const { uploads, totalProgress } = storeToRefs(uploadQueueStore);

const view = useFileListView({
	getPreviewType,
	loadFiles: async () => {
		const { data } = await api.listStarredFiles();
		return Array.isArray(data) ? data : [];
	},
	uploadQueueStore,
	sortable: true,
	initialSortBy: 'updated_at',
	initialSortDirection: 'desc',
});

const {
	loading,
	clearSelection,
	primarySelectedFile,
	contextMenu,
	closeContextMenu,
	openPreview,
	refresh,
} = view;

function openFolder(file) {
	if (!file?.is_folder) return;
	clearSelection();
	const parent = file.virtual_path || '/';
	const inside = `${parent === '/' ? '' : parent}${file.file_name}/`;
	const targetPath = inside.startsWith('/') ? inside : `/${inside}`;
	fileTreeStore.navigate(targetPath);
}

function openSelectedItem() {
	const file = primarySelectedFile.value || contextMenu.value.file;
	closeContextMenu();
	if (file?.is_folder) openFolder(file);
}

function openItemOnDoubleClick(file) {
	if (file.is_folder) {
		openFolder(file);
		return;
	}
	if (view.canPreview(file)) openPreview(file);
}

useAutoRefresh(() => refresh(), { intervalMs: 30000 });
</script>

<template>
	<DriveShell current-section="starred">
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

		<FloatingProgressToast :uploads="uploads" :total-progress="totalProgress" @close="uploadQueueStore.clearOperations" @close-item="uploadQueueStore.closeOperation" />
	</DriveShell>
</template>
