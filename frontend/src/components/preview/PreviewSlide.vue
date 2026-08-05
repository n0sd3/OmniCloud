<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue';
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
const emit = defineEmits(['download', 'ended', 'hold', 'release']);
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

// I4: um video com codec que o browser nao decodifica pode nao disparar nem
// 'loadeddata' nem 'error' - sem isso o slide gira para sempre em vez de
// cair no cartao de download que o spec promete.
const LOAD_TIMEOUT_MS = 20_000;
let loadTimer = null;

function clearLoadTimer() {
	if (loadTimer) clearTimeout(loadTimer);
	loadTimer = null;
}

function armLoadTimer() {
	clearLoadTimer();
	loadTimer = setTimeout(() => {
		if (state.value === 'loading') state.value = 'error';
	}, LOAD_TIMEOUT_MS);
}

// So conta o tempo enquanto o slide de fato monta um renderer (near) e ainda
// esta carregando; um evento terminal ou o slide sair da janela cancela.
watch([() => props.near, state], ([near, value]) => {
	if (near && value === 'loading') armLoadTimer();
	else clearLoadTimer();
}, { immediate: true });

onBeforeUnmount(clearLoadTimer);
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
				@ended="emit('ended')"
				@hold="emit('hold')"
				@release="emit('release')"
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
