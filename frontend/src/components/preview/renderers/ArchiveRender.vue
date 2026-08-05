<script setup>
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../../../services/api';
import { formatBytes } from '../../../composables/useFormatFile.js';

const props = defineProps({
	file: { type: Object, required: true },
	active: { type: Boolean, default: false },
});
const emit = defineEmits(['loaded', 'failed']);
const { t } = useI18n();

const entries = ref([]);
const truncated = ref(false);
let currentToken = null;

async function load() {
	const token = props.file.id;
	currentToken = token;
	try {
		const listing = await api.previewEntries(props.file.id);
		if (currentToken !== token) return;
		entries.value = listing.entries || [];
		truncated.value = Boolean(listing.truncated);
		emit('loaded');
	} catch {
		if (currentToken !== token) return;
		emit('failed');
	}
}

watch(() => props.file.id, load, { immediate: true });
</script>

<template>
	<div class="h-full w-full overflow-y-auto px-4 py-6">
		<div class="mx-auto max-w-2xl rounded-2xl bg-white/5 p-4 text-slate-100">
			<p class="mb-3 text-sm text-slate-300">{{ t('preview.entries', { count: entries.length }) }}</p>
			<ul class="divide-y divide-white/10 text-sm">
				<li v-for="entry in entries" :key="entry.name" class="flex items-center justify-between gap-4 py-2">
					<span class="min-w-0 truncate font-mono text-xs">{{ entry.name }}</span>
					<span class="shrink-0 text-xs text-slate-400">{{ formatBytes(entry.size) }}</span>
				</li>
			</ul>
			<p v-if="truncated" class="mt-3 text-xs text-slate-400">{{ t('preview.truncatedEntries', { count: entries.length }) }}</p>
		</div>
	</div>
</template>
