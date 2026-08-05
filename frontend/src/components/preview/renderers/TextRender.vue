<script setup>
import { onBeforeUnmount, ref, watch } from 'vue';
import { api } from '../../../services/api';

const MAX_TEXT_BYTES = 1024 * 1024;

const props = defineProps({
	file: { type: Object, required: true },
	active: { type: Boolean, default: false },
});
const emit = defineEmits(['loaded', 'failed']);

const body = ref('');
let currentToken = null;

async function load() {
	const token = props.file.id;
	currentToken = token;
	try {
		const text = await api.previewText(props.file.id);
		// Corrida: o usuario pode ter passado para outro arquivo antes da resposta.
		if (currentToken !== token) return;
		body.value = text.length > MAX_TEXT_BYTES ? text.slice(0, MAX_TEXT_BYTES) : text;
		emit('loaded');
	} catch {
		if (currentToken !== token) return;
		emit('failed');
	}
}

watch(() => props.file.id, load, { immediate: true });
onBeforeUnmount(() => { currentToken = null; });
</script>

<template>
	<pre class="h-full w-full overflow-auto whitespace-pre-wrap break-words px-5 py-4 font-mono text-xs leading-relaxed text-slate-100">{{ body }}</pre>
</template>
