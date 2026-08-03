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
