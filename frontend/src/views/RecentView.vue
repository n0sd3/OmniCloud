<script setup>
import { storeToRefs } from 'pinia';
import { useI18n } from 'vue-i18n';
import DriveShell from '../components/DriveShell.vue';
import FloatingProgressToast from '../components/FloatingProgressToast.vue';
import FileListSurface from '../components/FileListSurface.vue';
import { useFileListView } from '../composables/useFileListView';
import { getPreviewType } from '../composables/useFileType.js';
import { useRecencyGroups } from '../composables/useRecencyGroups.js';
import { useUploadQueueStore } from '../stores/uploadQueue';
import { api } from '../services/api';

const { t } = useI18n();
const uploadQueueStore = useUploadQueueStore();
const { uploads, totalProgress } = storeToRefs(uploadQueueStore);

const view = useFileListView({
	getPreviewType,
	loadFiles: async () => {
		const { data } = await api.listRecentFiles();
		return Array.isArray(data) ? data : [];
	},
	uploadQueueStore,
	filterIncoming: (items) => items.filter((file) => !file.is_folder),
});

const { loading, sortedFiles, clearSelection, canPreview, openPreview } = view;
const { groups: groupedFiles } = useRecencyGroups(sortedFiles, t);

function openItemOnDoubleClick(file) {
	if (canPreview(file)) openPreview(file);
}
</script>

<template>
	<DriveShell current-section="recent">
		<FileListSurface :view="view" :loading="loading" :groups="groupedFiles" :empty-message="t('recent.empty')" :can-open-folder="false" @open="openItemOnDoubleClick">
			<template #header>
				<h1 class="m-0 text-2xl font-normal text-[#202124] dark:text-slate-100">{{ t('nav.recent') }}</h1>
			</template>
		</FileListSurface>

		<FloatingProgressToast :uploads="uploads" :total-progress="totalProgress" @close="uploadQueueStore.clearOperations" @close-item="uploadQueueStore.closeOperation" />
	</DriveShell>
</template>
