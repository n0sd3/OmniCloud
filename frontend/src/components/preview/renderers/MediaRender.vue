<script setup>
import { computed, ref, watch } from 'vue';
import { api } from '../../../services/api';

const props = defineProps({
	file: { type: Object, required: true },
	active: { type: Boolean, default: false },
});
const emit = defineEmits(['loaded', 'failed']);

const mediaRef = ref(null);
const isVideo = computed(() => props.file.previewType === 'video');
const source = computed(() => api.previewUrl(props.file.id));

// Sair do slide para sempre, com o video tocando em background, e o pior tipo
// de surpresa sonora.
watch(() => props.active, (active) => {
	if (!active) mediaRef.value?.pause();
});
</script>

<template>
	<div class="grid h-full place-items-center px-4">
		<video
			v-if="isVideo"
			ref="mediaRef"
			class="max-h-full w-full bg-black"
			controls
			playsinline
			:poster="api.thumbnailUrl(props.file)"
			@loadeddata="emit('loaded')"
			@error="emit('failed')"
		>
			<source :src="source" :type="props.file.mime_type || 'video/mp4'" />
		</video>
		<audio
			v-else
			ref="mediaRef"
			class="w-full max-w-xl"
			controls
			@loadeddata="emit('loaded')"
			@error="emit('failed')"
		>
			<source :src="source" :type="props.file.mime_type || 'audio/mpeg'" />
		</audio>
	</div>
</template>
