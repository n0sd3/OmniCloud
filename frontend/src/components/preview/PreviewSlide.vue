<script setup>
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import ImageRender from './renderers/ImageRender.vue';
import MediaRender from './renderers/MediaRender.vue';
import TextRender from './renderers/TextRender.vue';
import FallbackRender from './renderers/FallbackRender.vue';
import PagedRender from './renderers/PagedRender.vue';
import ArchiveRender from './renderers/ArchiveRender.vue';

const props = defineProps({
	file: { type: Object, required: true },
	active: { type: Boolean, default: false },
	near: { type: Boolean, default: false },
});
const emit = defineEmits(['download']);
const { t } = useI18n();

// Tipo novo custa uma linha aqui e um arquivo em renderers/, nunca mais um
// elo na cadeia de v-else-if que existia antes.
const RENDERERS = {
	image: ImageRender,
	video: MediaRender,
	audio: MediaRender,
	text: TextRender,
	pdf: PagedRender,
	office: PagedRender,
	archive: ArchiveRender,
};

const renderer = computed(() => RENDERERS[props.file.previewType] || FallbackRender);
const state = ref('loading');

watch(() => props.file.id, () => { state.value = 'loading'; });
</script>

<template>
	<div class="relative flex h-full w-full shrink-0 snap-center items-center justify-center" :style="{ width: '100%' }">
		<template v-if="props.near">
			<component
				:is="renderer"
				:file="props.file"
				:active="props.active"
				@loaded="state = 'ready'"
				@failed="state = 'error'"
			/>

			<div v-if="state === 'loading'" class="pointer-events-none absolute inset-0 grid place-items-center text-sm text-slate-300">
				{{ t('preview.loading') }}
			</div>

			<div v-if="state === 'error'" class="absolute inset-0 grid place-items-center bg-black/80 px-6 text-center text-sm text-slate-300">
				<div>
					<p>{{ t('preview.failed') }}</p>
					<button type="button" class="mt-4 rounded-full bg-[#1a73e8] px-5 py-2 text-sm font-medium text-white" @click.stop="emit('download', props.file)">
						{{ t('common.download') }}
					</button>
				</div>
			</div>
		</template>
	</div>
</template>
