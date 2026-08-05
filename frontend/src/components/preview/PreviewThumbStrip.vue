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
