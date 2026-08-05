<script setup>
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { IconChevronLeft, IconChevronRight, IconDownload, IconX } from '@tabler/icons-vue';
import { useI18n } from 'vue-i18n';
import PreviewSlide from './PreviewSlide.vue';
import PreviewThumbStrip from './PreviewThumbStrip.vue';
import { usePreviewChrome } from '../../composables/usePreviewChrome.js';

const props = defineProps({
	files: { type: Array, default: () => [] },
	currentIndex: { type: Number, default: -1 },
	total: { type: Number, default: 0 },
	isOpen: { type: Boolean, default: false },
	hasPrevious: { type: Boolean, default: false },
	hasNext: { type: Boolean, default: false },
	isNear: { type: Function, required: true },
	previewTypeOf: { type: Function, required: true },
});

const emit = defineEmits(['close', 'previous', 'next', 'goto', 'download']);
const { t } = useI18n();

const chrome = usePreviewChrome();
const dragStartY = ref(null);

function onTouchStart(event) {
	dragStartY.value = event.touches[0]?.clientY ?? null;
}

function onTouchEnd(event) {
	const start = dragStartY.value;
	dragStartY.value = null;
	if (start === null) return;
	const end = event.changedTouches[0]?.clientY ?? start;
	// Imagem ampliada usa o arrasto para pan; fechar so quando o gesto e claro
	// e vertical o bastante para nao competir com o swipe lateral.
	if (end - start > 120) emit('close');
}

const trackRef = ref(null);
let observer = null;
// Rolagem programatica dispara o observer e ele reemitiria 'goto' para o
// indice que acabamos de pedir: o flag corta esse eco.
let scrollingToIndex = false;

function scrollToCurrent(behavior = 'smooth') {
	const track = trackRef.value;
	const slide = track?.children?.[props.currentIndex];
	if (!slide) return;
	scrollingToIndex = true;
	slide.scrollIntoView({ behavior, block: 'nearest', inline: 'center' });
	window.setTimeout(() => { scrollingToIndex = false; }, 400);
}

function observeSlides() {
	observer?.disconnect();
	const track = trackRef.value;
	if (!track) return;
	observer = new IntersectionObserver((entries) => {
		if (scrollingToIndex) return;
		for (const entry of entries) {
			if (!entry.isIntersecting || entry.intersectionRatio < 0.6) continue;
			const index = Number(entry.target.dataset.index);
			if (index !== props.currentIndex) emit('goto', index);
		}
	}, { root: track, threshold: [0.6] });
	for (const child of track.children) observer.observe(child);
}

function onKeydown(event) {
	if (event.key === 'Escape') return emit('close');
	if (event.target instanceof HTMLMediaElement) return;
	if (event.key === 'ArrowLeft' && props.hasPrevious) emit('previous');
	if (event.key === 'ArrowRight' && props.hasNext) emit('next');
	if (event.key === 'Home') emit('goto', 0);
	if (event.key === 'End') emit('goto', props.total - 1);
}

watch(() => props.isOpen, async (open) => {
	if (!open) {
		observer?.disconnect();
		window.removeEventListener('keydown', onKeydown);
		document.body.style.overflow = '';
		return;
	}
	window.addEventListener('keydown', onKeydown);
	document.body.style.overflow = 'hidden';
	await nextTick();
	scrollToCurrent('auto');
	observeSlides();
});

watch(() => props.files.length, async () => {
	if (!props.isOpen) return;
	await nextTick();
	observeSlides();
});

watch(() => props.currentIndex, () => {
	if (props.isOpen) scrollToCurrent();
	chrome.show();
});

onBeforeUnmount(() => {
	observer?.disconnect();
	window.removeEventListener('keydown', onKeydown);
	document.body.style.overflow = '';
});

function onSlideEnded(index) {
	if (index !== props.currentIndex || !props.hasNext) return;
	const next = props.files[index + 1];
	const type = next && props.previewTypeOf(next);
	// Auto-proximo so entre midias: pular de um mp3 para um docx no meio da fila
	// e mais irritante do que util.
	if (type === 'audio' || type === 'video') emit('next');
}

function displayName(file) {
	return file?.display_name || file?.file_name || file?.name || '';
}
</script>

<template>
	<div
		v-if="props.isOpen && props.total"
		class="fixed inset-0 z-50 bg-black/95"
		@click="chrome.toggle()"
		@mousemove="chrome.show()"
		@touchstart="onTouchStart"
		@touchend="onTouchEnd"
	>
		<div v-show="chrome.visible.value" class="absolute inset-x-0 top-0 z-20 flex items-center gap-3 bg-gradient-to-b from-black/70 to-transparent px-4 py-3 text-white transition-opacity">
			<div class="min-w-0 flex-1">
				<p class="truncate text-sm font-semibold">{{ displayName(props.files[props.currentIndex]) }}</p>
				<p class="text-xs text-slate-300">{{ t('preview.position', { current: props.currentIndex + 1, total: props.total }) }}</p>
			</div>
			<button type="button" class="grid size-10 shrink-0 place-items-center rounded-full hover:bg-white/10" :title="t('common.download')" @click.stop="emit('download', props.files[props.currentIndex])">
				<IconDownload :size="20" :stroke="2" />
			</button>
			<button type="button" class="grid size-10 shrink-0 place-items-center rounded-full hover:bg-white/10" :title="t('common.close')" @click.stop="emit('close')">
				<IconX :size="20" :stroke="2" />
			</button>
		</div>

		<!-- ponytail: scroll-snap nativo no lugar de lib de gestos. Swipe, momentum
		     e scroll de trackpad saem de graca. -->
		<div ref="trackRef" class="flex h-full w-full snap-x snap-mandatory overflow-x-auto overflow-y-hidden overscroll-x-contain">
			<PreviewSlide
				v-for="(file, index) in props.files"
				:key="file.id"
				:data-index="index"
				:file="{ ...file, previewType: props.previewTypeOf(file) }"
				:active="index === props.currentIndex"
				:near="props.isNear(index)"
				class="h-full w-full shrink-0"
				@download="emit('download', $event)"
				@ended="onSlideEnded(index)"
				@hold="chrome.hold()"
				@release="chrome.release()"
			/>
		</div>

		<button v-show="chrome.visible.value" v-if="props.hasPrevious" type="button" class="absolute left-4 top-1/2 z-20 hidden size-12 -translate-y-1/2 place-items-center rounded-full bg-black/50 text-white transition-opacity hover:bg-black/70 sm:grid" :title="t('preview.previous')" @click.stop="emit('previous')">
			<IconChevronLeft :size="24" :stroke="2" />
		</button>
		<button v-show="chrome.visible.value" v-if="props.hasNext" type="button" class="absolute right-4 top-1/2 z-20 hidden size-12 -translate-y-1/2 place-items-center rounded-full bg-black/50 text-white transition-opacity hover:bg-black/70 sm:grid" :title="t('preview.next')" @click.stop="emit('next')">
			<IconChevronRight :size="24" :stroke="2" />
		</button>

		<div v-show="chrome.visible.value" class="absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-black/80 to-transparent transition-opacity">
			<PreviewThumbStrip :files="props.files" :current-index="props.currentIndex" @goto="emit('goto', $event)" />
		</div>
	</div>
</template>
