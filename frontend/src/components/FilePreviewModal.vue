<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { IconChevronLeft, IconChevronRight, IconDownload, IconPlayerPlay, IconX } from '@tabler/icons-vue';
import { useI18n } from 'vue-i18n';

const props = defineProps({
	file: { type: Object, default: null },
	isOpen: { type: Boolean, default: false },
	isLoading: { type: Boolean, default: false },
	previewText: { type: String, default: null },
	previewError: { type: String, default: null },
	hasPrevious: { type: Boolean, default: false },
	hasNext: { type: Boolean, default: false },
});

const emit = defineEmits(['close', 'loaded', 'failed', 'previous', 'next', 'download']);

const { t } = useI18n();

const zoom = ref(1);

const displayName = computed(() => {
	if (!props.file) return '';
	return props.file.display_name || props.file.file_name || props.file.name || '';
});

const isVisible = computed(() => Boolean(props.isOpen && props.file));

function onKeydown(event) {
	if (event.key === 'Escape') {
		emit('close');
		return;
	}
	// As setas pertencem aos controles de midia quando o foco esta neles.
	if (event.target instanceof HTMLMediaElement) return;
	if (event.key === 'ArrowLeft' && props.hasPrevious) emit('previous');
	if (event.key === 'ArrowRight' && props.hasNext) emit('next');
}

watch(isVisible, (visible) => {
	zoom.value = 1;
	if (visible) window.addEventListener('keydown', onKeydown);
	else window.removeEventListener('keydown', onKeydown);
});

watch(() => props.file?.id, () => {
	zoom.value = 1;
});

onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));

// ponytail: zoom por transform, sem lib de pan/pinch. Se precisar arrastar a imagem
// ampliada, ai sim vale uma biblioteca.
function toggleZoom() {
	zoom.value = zoom.value > 1 ? 1 : 2;
}

function onWheelZoom(event) {
	event.preventDefault();
	const next = zoom.value + (event.deltaY < 0 ? 0.25 : -0.25);
	zoom.value = Math.min(4, Math.max(1, Number(next.toFixed(2))));
}
</script>

<template>
	<div v-if="isVisible" class="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 px-4 py-8" @click="emit('close')">
		<div class="flex max-h-full w-full max-w-5xl flex-col overflow-hidden rounded-[28px] bg-white text-[#202124] shadow-[0_24px_60px_rgba(32,33,36,0.28)] dark:bg-slate-900 dark:text-slate-100" @click.stop>
			<div class="flex items-center justify-between gap-4 border-b border-[#e8eaed] px-5 py-4 dark:border-slate-800">
				<div class="min-w-0">
					<p class="truncate text-base font-semibold">{{ displayName }}</p>
				</div>
				<div class="flex items-center gap-2">
					<button type="button" class="grid size-10 place-items-center rounded-full text-[#5f6368] hover:bg-black/5 disabled:opacity-40 dark:text-slate-400 dark:hover:bg-white/8" :disabled="!props.hasPrevious" :title="t('preview.previous')" @click="emit('previous')">
						<IconChevronLeft :size="18" :stroke="2" />
					</button>
					<button type="button" class="grid size-10 place-items-center rounded-full text-[#5f6368] hover:bg-black/5 disabled:opacity-40 dark:text-slate-400 dark:hover:bg-white/8" :disabled="!props.hasNext" :title="t('preview.next')" @click="emit('next')">
						<IconChevronRight :size="18" :stroke="2" />
					</button>
					<button type="button" class="grid size-10 place-items-center rounded-full text-[#5f6368] hover:bg-black/5 dark:text-slate-400 dark:hover:bg-white/8" :title="t('common.download')" @click="emit('download')">
						<IconDownload :size="18" :stroke="2" />
					</button>
					<button type="button" class="grid size-10 place-items-center rounded-full text-[#5f6368] hover:bg-black/5 dark:text-slate-400 dark:hover:bg-white/8" @click="emit('close')">
						<IconX :size="18" :stroke="2" />
					</button>
				</div>
			</div>
			<div class="relative min-h-[420px] flex-1 overflow-auto bg-[#f8fafd] dark:bg-slate-950">
				<div v-if="props.isLoading && !props.previewError" class="absolute inset-0 z-10 grid place-items-center text-sm text-[#5f6368] dark:text-slate-400">
					{{ t('preview.loading') }}
				</div>

				<div v-if="props.previewError" class="grid min-h-[420px] place-items-center px-6 text-center text-sm text-[#5f6368] dark:text-slate-400">
					<div>
						<p>{{ props.previewError }}</p>
						<button type="button" class="mt-4 rounded-full bg-[#1a73e8] px-5 py-2 text-sm font-medium text-white" @click="emit('download')">
							{{ t('common.download') }}
						</button>
					</div>
				</div>

				<div v-else-if="props.file?.previewType === 'image'" class="grid min-h-[420px] place-items-center overflow-auto" :title="t('preview.zoomHint')" @wheel="onWheelZoom">
					<img :src="props.file?.previewUrl" class="max-h-[75vh] w-full origin-center object-contain transition-transform" :style="{ transform: `scale(${zoom})`, cursor: zoom > 1 ? 'zoom-out' : 'zoom-in' }" alt="Preview file" @click="toggleZoom" @load="emit('loaded')" @error="emit('failed')" />
				</div>

				<video v-else-if="props.file?.previewType === 'video'" class="max-h-[75vh] w-full bg-black" controls playsinline @loadeddata="emit('loaded')" @error="emit('failed')">
					<source :src="props.file?.previewUrl" :type="props.file?.mime_type || 'video/mp4'" />
				</video>

				<div v-else-if="props.file?.previewType === 'audio'" class="grid min-h-[420px] place-items-center px-6">
					<audio class="w-full max-w-xl" controls @loadeddata="emit('loaded')" @error="emit('failed')">
						<source :src="props.file?.previewUrl" :type="props.file?.mime_type || 'audio/mpeg'" />
					</audio>
				</div>

				<iframe v-else-if="props.file?.previewType === 'pdf'" :src="props.file?.previewUrl" class="h-[75vh] w-full border-0" :title="t('preview.document')" @load="emit('loaded')" />

				<pre v-else-if="props.file?.previewType === 'text'" class="h-[75vh] w-full overflow-auto whitespace-pre-wrap break-words px-5 py-4 font-mono text-xs leading-relaxed">{{ props.previewText }}</pre>

				<div v-else class="grid min-h-[420px] place-items-center px-6 text-center text-sm text-[#5f6368] dark:text-slate-400">
					<div>
						<div class="mx-auto grid size-16 place-items-center rounded-full bg-[#e8f0fe] text-[#1a73e8] dark:bg-slate-800">
							<IconPlayerPlay :size="28" :stroke="1.8" />
						</div>
						<p class="mt-4">{{ t('preview.notAvailable') }}</p>
					</div>
				</div>
			</div>
		</div>
	</div>
</template>
