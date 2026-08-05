<script setup>
import { ref, watch } from 'vue';
import { api } from '../../../services/api';

const props = defineProps({
	file: { type: Object, required: true },
	active: { type: Boolean, default: false },
});
const emit = defineEmits(['loaded', 'failed']);

const zoom = ref(1);
watch(() => props.file.id, () => { zoom.value = 1; });

// ponytail: zoom por transform, sem lib de pan/pinch. Se precisar arrastar a
// imagem ampliada, ai sim vale uma biblioteca.
function toggleZoom() {
	zoom.value = zoom.value > 1 ? 1 : 2;
}

function onWheelZoom(event) {
	event.preventDefault();
	const next = zoom.value + (event.deltaY < 0 ? 0.25 : -0.25);
	zoom.value = Math.min(4, Math.max(1, Number(next.toFixed(2))));
}

defineExpose({ isZoomed: () => zoom.value > 1 });
</script>

<template>
	<div class="grid h-full place-items-center overflow-auto" @wheel="onWheelZoom">
		<img
			:src="api.previewUrl(props.file.id)"
			class="max-h-full max-w-full origin-center object-contain transition-transform"
			:style="{ transform: `scale(${zoom})`, cursor: zoom > 1 ? 'zoom-out' : 'zoom-in' }"
			:alt="props.file.display_name || props.file.file_name"
			@click.stop="toggleZoom"
			@load="emit('loaded')"
			@error="emit('failed')"
		/>
	</div>
</template>
