<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { IconPictureInPicture } from '@tabler/icons-vue';
import { useI18n } from 'vue-i18n';
import { api } from '../../../services/api';
import { useMediaResume } from '../../../composables/useMediaResume.js';

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

const props = defineProps({
	file: { type: Object, required: true },
	active: { type: Boolean, default: false },
});
const emit = defineEmits(['loaded', 'failed', 'ended', 'hold', 'release']);
const { t } = useI18n();

const mediaRef = ref(null);
const speed = ref(1);
const isVideo = computed(() => props.file.previewType === 'video');
const source = computed(() => api.previewUrl(props.file.id));
const supportsPip = typeof document !== 'undefined' && document.pictureInPictureEnabled;

const resume = useMediaResume();
let saveTimer = null;
// pause() dispara o evento 'pause' de forma assincrona; sem esta flag o
// desativar do slide vira um hold() sem release() correspondente (o slide
// nao vai tocar de novo para soltar).
let suppressPauseHold = false;

function onLoaded() {
	const at = resume.read(props.file.id);
	if (at > 0 && mediaRef.value) mediaRef.value.currentTime = at;
	emit('loaded');
}

function startSaving() {
	stopSaving();
	saveTimer = window.setInterval(() => {
		const media = mediaRef.value;
		if (media && !media.paused) resume.write(props.file.id, media.currentTime, media.duration);
	}, 5000);
}

function stopSaving() {
	if (saveTimer) window.clearInterval(saveTimer);
	saveTimer = null;
}

function applySpeed(value) {
	speed.value = value;
	if (mediaRef.value) mediaRef.value.playbackRate = value;
}

async function togglePip() {
	const media = mediaRef.value;
	if (!media || !supportsPip) return;
	if (document.pictureInPictureElement) await document.exitPictureInPicture();
	else await media.requestPictureInPicture();
}

// Controles nao podem sumir com o video pausado: e exatamente quando o usuario
// esta olhando para eles.
function onPause() {
	stopSaving();
	if (suppressPauseHold) {
		suppressPauseHold = false;
		return;
	}
	emit('hold');
}

function onPlay() {
	startSaving();
	emit('release');
}

function onEnded() {
	resume.write(props.file.id, 0, 0);
	// O elemento dispara 'pause' antes de 'ended' ao chegar no fim (fez o hold
	// la em onPause); sem este release o chrome fica preso para sempre.
	emit('release');
	emit('ended');
}

watch(() => props.active, (active) => {
	if (!active) {
		suppressPauseHold = true;
		mediaRef.value?.pause();
		stopSaving();
	}
});

onMounted(() => resume.prune());
onBeforeUnmount(() => {
	const media = mediaRef.value;
	if (media) resume.write(props.file.id, media.currentTime, media.duration);
	stopSaving();
});
</script>

<template>
	<div class="relative grid h-full place-items-center px-4">
		<video
			v-if="isVideo"
			ref="mediaRef"
			class="max-h-full w-full bg-black"
			controls
			playsinline
			:poster="api.thumbnailUrl(props.file)"
			@loadeddata="onLoaded"
			@error="emit('failed')"
			@play="onPlay"
			@pause="onPause"
			@ended="onEnded"
		>
			<source :src="source" :type="props.file.mime_type || 'video/mp4'" />
		</video>

		<audio
			v-else
			ref="mediaRef"
			class="w-full max-w-xl"
			controls
			@loadeddata="onLoaded"
			@error="emit('failed')"
			@play="onPlay"
			@pause="onPause"
			@ended="onEnded"
		>
			<source :src="source" :type="props.file.mime_type || 'audio/mpeg'" />
		</audio>

		<div class="absolute bottom-4 right-4 flex items-center gap-2" @click.stop>
			<select
				class="rounded-full bg-black/60 px-3 py-1.5 text-xs text-white outline-none"
				:title="t('preview.speed')"
				:value="speed"
				@change="applySpeed(Number($event.target.value))"
			>
				<option v-for="option in SPEEDS" :key="option" :value="option">{{ option }}×</option>
			</select>
			<button
				v-if="isVideo && supportsPip"
				type="button"
				class="grid size-9 place-items-center rounded-full bg-black/60 text-white hover:bg-black/80"
				:title="t('preview.pictureInPicture')"
				@click="togglePip"
			>
				<IconPictureInPicture :size="18" :stroke="2" />
			</button>
		</div>
	</div>
</template>
