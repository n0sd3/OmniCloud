<script setup>
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { IconStarFilled } from '@tabler/icons-vue';
import TruncateMarquee from './TruncateMarquee.vue';
import { formatBytes, formatDate, getModifiedTime, providerIcon, providerLabel } from '../composables/useFormatFile.js';
import { canShowGridThumbnail, getFileCategory, getFileIcon } from '../composables/useFileType.js';
import { api } from '../services/api.js';

const { t } = useI18n();

const props = defineProps({
	item: { type: Object, required: true },
	selected: { type: Boolean, default: false },
	nameField: { type: String, default: 'file_name' },
	showStar: { type: Boolean, default: true },
	highlighted: { type: Boolean, default: false },
	focused: { type: Boolean, default: false },
});

const emit = defineEmits(['select', 'open', 'contextmenu']);
const thumbnailFailed = ref(false);

const displayName = computed(() => {
	if (props.nameField === 'display_name') {
		return props.item.display_name || props.item.file_name || '';
	}
	return props.item[props.nameField] || '';
});

const thumbnailUrl = computed(() => (
	getFileCategory(props.item) === 'image'
		? api.previewUrl(props.item.id)
		: api.thumbnailUrl(props.item)
));
const showThumbnail = computed(() => canShowGridThumbnail(props.item) && !thumbnailFailed.value);

watch(thumbnailUrl, () => {
	thumbnailFailed.value = false;
});

function handleClick(event) {
	emit('select', event);
}

function handleDblClick(event) {
	emit('open', event);
}

function handleContextMenu(event) {
	emit('contextmenu', event);
}
</script>

<template>
	<div class="group select-none rounded-[22px] border p-4 transition hover:-translate-y-0.5 hover:border-[#d2e3fc] hover:shadow-[0_10px_30px_rgba(32,33,36,0.08)] dark:hover:border-slate-500" :class="[selected ? 'border-[#1a73e8] bg-gradient-to-br from-[#e8f0fe] to-[#f8fbff] shadow-[0_14px_34px_rgba(26,115,232,0.14)] dark:border-sky-400 dark:from-sky-500/15 dark:to-slate-800' : highlighted ? 'border-amber-400 bg-gradient-to-br from-amber-50 to-[#fffdf5] shadow-[0_14px_34px_rgba(245,158,11,0.14)] dark:border-amber-300 dark:from-amber-400/15 dark:to-slate-800' : 'border-[#e0e3e7] bg-white dark:border-slate-700 dark:bg-slate-800', focused ? 'ring-2 ring-inset ring-[#1a73e8] dark:ring-sky-400' : '']" :data-file-id="item.id" @click="handleClick" @dblclick="handleDblClick" @contextmenu="handleContextMenu">
		<button type="button" class="flex w-full flex-col items-start gap-4 text-left">
			<div class="relative w-full">
				<img v-if="showThumbnail" :src="thumbnailUrl" :alt="displayName" class="aspect-video w-full rounded-2xl bg-[#f1f3f4] object-cover dark:bg-slate-700" loading="lazy" @error="thumbnailFailed = true" />
				<div v-else class="flex w-full items-start justify-between gap-3">
					<div class="grid size-12 place-items-center rounded-2xl transition" :class="selected ? 'bg-[#d3e3fd] text-[#1a73e8] shadow-inner dark:bg-sky-500/20 dark:text-sky-300' : highlighted ? 'bg-amber-100 text-amber-500 shadow-inner dark:bg-amber-400/20 dark:text-amber-300' : 'bg-[#f1f3f4] text-[#5f6368] dark:bg-slate-700 dark:text-slate-300'">
						<component :is="getFileIcon(item, selected || highlighted)" :size="22" :stroke="selected || highlighted ? 0 : 1.8" class="transition-transform duration-200 group-hover:scale-110" />
					</div>
					<IconStarFilled v-if="showStar && item.is_starred && item.capabilities?.starred" :size="16" :stroke="0" class="shrink-0 text-amber-400" />
				</div>
				<IconStarFilled v-if="showThumbnail && showStar && item.is_starred && item.capabilities?.starred" :size="24" :stroke="0" class="absolute right-2 top-2 rounded-full bg-white/90 p-1 text-amber-400 shadow dark:bg-slate-900/90" />
			</div>
			<div class="w-full min-w-0">
				<TruncateMarquee as="p" class="text-sm font-semibold text-[#202124] dark:text-slate-100" :text="displayName" />
				<div class="mt-1 flex min-w-0 items-center gap-2 text-xs text-[#5f6368] dark:text-slate-400">
					<div v-if="providerIcon(item.provider)" class="flex size-6 shrink-0 items-center justify-center rounded-full bg-white dark:bg-slate-900/70">
						<img :src="providerIcon(item.provider)" :alt="providerLabel(item.provider)" class="size-3.5 object-contain" />
					</div>
					<TruncateMarquee as="p" class="min-w-0" :text="item.email || t('drive.noOwner')" />
				</div>
			</div>
			<div class="flex w-full items-center justify-between text-xs text-[#5f6368] dark:text-slate-400">
				<span>{{ formatDate(getModifiedTime(item)) }}</span>
				<span>{{ item.is_folder ? t('drive.folder') : formatBytes(item.size) }}</span>
			</div>
		</button>
	</div>
</template>
