<script setup>
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { IconLayoutSidebarRight, IconLayoutSidebarRightFilled } from '@tabler/icons-vue';
import FileListFilterBar from './FileListFilterBar.vue';
import FileListSelectionBar from './FileListSelectionBar.vue';
import FileListViewModeToggle from './FileListViewModeToggle.vue';
import FileListHeader from './FileListHeader.vue';
import FileListRow from './FileListRow.vue';
import FileListGridCard from './FileListGridCard.vue';
import FileListContextMenu from './FileListContextMenu.vue';
import FilePreviewModal from './FilePreviewModal.vue';
import FileInspector from './FileInspector.vue';
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
	selectedFiles,
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
	detailsFile,
	isInspectorOpen,
	toggleInspector,
	setOpenHandler,
	lastSelectedFileId,
} = props.view;

setOpenHandler((file) => emit('open', file));

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
			<div class="flex items-center gap-2">
				<FileListViewModeToggle v-model="isGridView" />
				<button type="button" class="grid size-10 place-items-center rounded-full text-[#5f6368] transition hover:bg-black/5 dark:text-slate-400 dark:hover:bg-white/10" :title="t('inspector.toggle')" :aria-pressed="isInspectorOpen" @click.stop="toggleInspector">
					<component :is="isInspectorOpen ? IconLayoutSidebarRightFilled : IconLayoutSidebarRight" :size="18" :stroke="isInspectorOpen ? 0 : 2" />
				</button>
			</div>
		</div>

		<div class="mb-3 flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
			<FileListSelectionBar v-if="selectedCount" :selected-count="selectedCount" :can-preview="canPreviewSelection" :can-toggle-star="canToggleStarSelection" :is-primary-starred="isPrimarySelectedStarred" :can-download="canDownloadSelection" :can-rename="canRename" :can-delete="allowDelete" :primary-file="primarySelectedFile" @clear="clearSelection" @preview="openPreview" @toggle-star="toggleSelectedFileStar" @download="downloadSelection" @rename="renameSelectedFile" @show-details="showSelectedFileDetails" @delete="deleteSelectedFile">
				<template #prefix="{ primary }">
					<slot v-if="selectedCount === 1" name="selection-prefix" :primary="primary" />
				</template>
			</FileListSelectionBar>
			<FileListFilterBar v-else :type-options="typeOptions" :owner-options="ownerOptions" :updated-options="updatedOptions" :selected-type-filter="selectedTypeFilter" :selected-owner-filter="selectedOwnerFilter" :selected-updated-filter="selectedUpdatedFilter" :active-filter-menu="activeFilterMenu" v-model:search-term="searchTerm" @toggle-filter-menu="toggleFilterMenu" @apply-filter="applyFilter" @clear-filter="clearFilter" />
		</div>

		<p v-if="errorMessage" class="mb-4 rounded-2xl bg-[#fce8e6] px-4 py-3 text-sm text-[#c5221f] dark:bg-red-950/40 dark:text-red-300">{{ errorMessage }}</p>

		<div class="grid gap-4" :class="isInspectorOpen ? 'lg:grid-cols-[minmax(0,1fr)_320px]' : 'grid-cols-1'">
			<div class="min-w-0">
				<div v-if="!isGridView" class="relative flex flex-col" :class="fillHeight ? 'flex-1' : ''">
					<div class="custom-scrollbar flex flex-col sm:overflow-x-auto rounded-2xl border border-[#e0e3e7] bg-white dark:border-slate-700 dark:bg-slate-800" :class="fillHeight ? 'flex-1' : ''">
						<div class="flex flex-col sm:min-w-[760px]" :class="fillHeight ? 'flex-1' : ''">
							<div class="custom-scrollbar overflow-y-auto overflow-x-hidden" :class="fillHeight ? 'min-h-0 flex-1' : listMaxHeightClass" @scroll="handleListScroll">
								<FileListHeader :sortable="sortable" :sort-by="sortBy" :sort-direction="sortDirection" @sort="setSort" />

								<template v-if="renderedGroups">
									<template v-for="group in renderedGroups" :key="group.key">
										<div class="sticky top-11 z-[1] bg-[#f8fafd] px-[18px] py-2 text-xs font-semibold uppercase tracking-[0.08em] text-[#5f6368] dark:bg-slate-900 dark:text-slate-400">{{ group.label }}</div>
										<FileListRow v-for="item in group.items" :key="item.id" :item="item" :selected="isSelected(item)" :highlighted="highlightedFileId === item.id" :focused="lastSelectedFileId === item.id && selectedCount > 1" :name-field="nameField" @select="(event) => selectItem(event, item)" @open="emit('open', item)" @contextmenu="(event) => openContextMenu(event, item)" />
									</template>
								</template>
								<template v-else>
									<FileListRow v-for="item in renderedFiles" :key="item.id" :item="item" :selected="isSelected(item)" :highlighted="highlightedFileId === item.id" :focused="lastSelectedFileId === item.id && selectedCount > 1" :name-field="nameField" @select="(event) => selectItem(event, item)" @open="emit('open', item)" @contextmenu="(event) => openContextMenu(event, item)" />
								</template>

								<div v-if="isEmpty" class="p-[18px] text-[#5f6368] dark:text-slate-400">{{ emptyMessage }}</div>
								<div v-if="loading" class="p-[18px]"><LoadingState /></div>
							</div>
						</div>
					</div>
					<LoadingState v-if="actionInProgress" variant="overlay" :message="actionLabel || t('drive.processing')" />
				</div>

				<div v-else class="relative">
					<div class="grid grid-cols-1 gap-4 sm:grid-cols-2" :class="isInspectorOpen ? 'xl:grid-cols-3' : 'xl:grid-cols-4 2xl:grid-cols-5'">
						<template v-if="renderedGroups">
							<template v-for="group in renderedGroups" :key="group.key">
								<div class="col-span-full rounded-2xl bg-[#f8fafd] px-4 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-[#5f6368] dark:bg-slate-900 dark:text-slate-400">{{ group.label }}</div>
								<FileListGridCard v-for="item in group.items" :key="item.id" :item="item" :selected="isSelected(item)" :highlighted="highlightedFileId === item.id" :focused="lastSelectedFileId === item.id && selectedCount > 1" :name-field="nameField" @select="(event) => selectItem(event, item)" @open="emit('open', item)" @contextmenu="(event) => openContextMenu(event, item)" />
							</template>
						</template>
						<template v-else>
							<FileListGridCard v-for="item in renderedFiles" :key="item.id" :item="item" :selected="isSelected(item)" :highlighted="highlightedFileId === item.id" :focused="lastSelectedFileId === item.id && selectedCount > 1" :name-field="nameField" @select="(event) => selectItem(event, item)" @open="emit('open', item)" @contextmenu="(event) => openContextMenu(event, item)" />
						</template>

						<div v-if="isEmpty" class="col-span-full rounded-2xl border border-dashed border-[#dadce0] bg-white px-5 py-8 text-center text-[#5f6368] dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400">{{ emptyMessage }}</div>
						<div v-if="loading" class="col-span-full rounded-2xl border border-dashed border-[#dadce0] bg-white px-5 py-8 text-center text-[#5f6368] dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400"><LoadingState /></div>
					</div>
					<LoadingState v-if="actionInProgress" variant="overlay" :message="actionLabel || t('drive.processing')" />
				</div>
			</div>
			<!-- ponytail: uma coluna abaixo de lg em vez de bottom sheet. Vira sheet se o painel atrapalhar no telefone. -->
			<FileInspector v-if="isInspectorOpen" :file="primarySelectedFile" :details-file="detailsFile" :selected-files="selectedFiles" :selected-count="selectedCount" :can-download="canDownloadSelection" :can-rename="canRename" :can-delete="allowDelete" :can-toggle-star="canToggleStarSelection" :is-starred="isPrimarySelectedStarred" :can-open-folder="canOpenFolder && canOpenSelection" @close="toggleInspector" @open="emit('open-selected')" @download="downloadSelection" @rename="renameSelectedFile" @delete="deleteSelectedFile" @toggle-star="toggleSelectedFileStar" />
		</div>

		<FileListContextMenu :context-menu-ref="contextMenuRef" :context-menu="contextMenu" :selected-count="selectedCount" :primary-selected-file="primarySelectedFile" :can-preview="canPreviewSelection" :can-toggle-star="canToggleStarSelection" :is-primary-starred="isPrimarySelectedStarred" :can-download="canDownloadSelection" :can-rename="canRename" :can-delete="allowDelete" :can-show-details="selectedCount === 1" :can-open-folder="canOpenFolder && canOpenSelection" @open-folder="emit('open-selected')" @preview="openPreview" @toggle-star="toggleSelectedFileStar" @download="downloadSelection" @rename="renameSelectedFile" @show-details="showSelectedFileDetails" @delete="deleteSelectedFile" @close="closeContextMenu" />

		<FilePreviewModal :file="previewFile" :is-open="isPreviewOpen" :is-loading="isPreviewLoading" :preview-text="previewText" :preview-error="previewError" :has-previous="hasPreviousPreview" :has-next="hasNextPreview" @close="closePreview" @loaded="handlePreviewLoaded" @failed="handlePreviewFailed" @previous="showPreviousPreview" @next="showNextPreview" @download="triggerDownload(previewFile)" />
	</div>
</template>
