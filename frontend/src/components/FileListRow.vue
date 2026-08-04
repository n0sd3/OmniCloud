<script setup>
import { computed } from 'vue';
import { IconStarFilled } from '@tabler/icons-vue';
import TruncateMarquee from './TruncateMarquee.vue';
import { formatBytes, formatDate, getModifiedTime, providerIcon, providerLabel } from '../composables/useFormatFile.js';
import { getFileIcon } from '../composables/useFileType.js';
import { usePointerCoarse } from '../composables/usePointerCoarse.js';

const props = defineProps({
	item: { type: Object, required: true },
	selected: { type: Boolean, default: false },
	nameField: { type: String, default: 'file_name' },
	showStar: { type: Boolean, default: true },
	highlighted: { type: Boolean, default: false },
	focused: { type: Boolean, default: false },
});

const emit = defineEmits(['select', 'open', 'contextmenu']);

const isCoarsePointer = usePointerCoarse();

const displayName = computed(() => {
	if (props.nameField === 'display_name') {
		return props.item.display_name || props.item.file_name || '';
	}
	return props.item[props.nameField] || '';
});

const subtitle = computed(() => [
	props.item.email,
	props.item.is_folder ? null : formatBytes(props.item.size),
	formatDate(getModifiedTime(props.item)),
].filter(Boolean).join(' · '));

function handleClick(event) {
	emit(isCoarsePointer.value ? 'open' : 'select', event);
}

function handleDblClick(event) {
	emit('open', event);
}

function handleContextMenu(event) {
	emit('contextmenu', event);
}
</script>

<template>
	<div class="group grid min-h-[60px] cursor-default select-none grid-cols-[minmax(0,1fr)] items-center gap-3 border-t border-[#eceff1] px-[18px] transition [-webkit-touch-callout:none] first:border-t-0 dark:border-slate-700 sm:min-h-[52px] sm:grid-cols-[minmax(260px,2fr)_minmax(180px,1.1fr)_minmax(150px,1fr)_140px]" :class="[selected ? 'bg-gradient-to-r from-[#e8f0fe] to-[#f8fbff] shadow-[inset_4px_0_0_#1a73e8] dark:from-sky-500/15 dark:to-slate-800 dark:shadow-[inset_4px_0_0_#38bdf8]' : highlighted ? 'bg-gradient-to-r from-amber-50 to-[#fffdf5] shadow-[inset_4px_0_0_#f59e0b] dark:from-amber-400/15 dark:to-slate-800 dark:shadow-[inset_4px_0_0_#fbbf24]' : 'hover:bg-black/[0.02] dark:hover:bg-white/6', focused ? 'ring-2 ring-inset ring-[#1a73e8] dark:ring-sky-400' : '']" :data-file-id="item.id" @click="handleClick" @dblclick="handleDblClick" @contextmenu="handleContextMenu">
		<div class="flex min-w-0 items-center gap-2.5 text-[#202124] dark:text-slate-100">
			<component :is="getFileIcon(item, selected || highlighted)" :size="18" :stroke="selected || highlighted ? 0 : 1.8" class="transition-transform duration-200 group-hover:scale-110" :class="selected ? 'text-[#1a73e8] drop-shadow-sm dark:text-sky-300' : highlighted ? 'text-amber-500 drop-shadow-sm dark:text-amber-300' : 'text-[#5f6368] dark:text-slate-400'" />
			<div class="flex min-w-0 flex-1 flex-col justify-center">
				<div class="flex min-w-0 items-center gap-2">
					<TruncateMarquee :text="displayName" />
					<IconStarFilled v-if="showStar && item.is_starred && item.capabilities?.starred" :size="14" :stroke="0" class="shrink-0 text-amber-400" />
				</div>
				<!-- As colunas viram uma linha so no telefone, senao a tabela exige scroll horizontal. -->
				<span class="truncate text-xs text-[#5f6368] dark:text-slate-400 sm:hidden">{{ subtitle }}</span>
			</div>
		</div>
		<div class="hidden min-w-0 items-center gap-2 text-[#5f6368] dark:text-slate-400 sm:flex">
			<div v-if="providerIcon(item.provider)" class="flex size-6 shrink-0 items-center justify-center rounded-full bg-white dark:bg-slate-900/70">
				<img :src="providerIcon(item.provider)" :alt="providerLabel(item.provider)" class="size-3.5 object-contain" />
			</div>
			<TruncateMarquee class="min-w-0" :text="item.email" />
		</div>
		<span class="hidden text-[#5f6368] dark:text-slate-400 sm:block">{{ formatDate(getModifiedTime(item)) }}</span>
		<span class="hidden text-[#5f6368] dark:text-slate-400 sm:block">{{ item.is_folder ? '—' : formatBytes(item.size) }}</span>
	</div>
</template>
