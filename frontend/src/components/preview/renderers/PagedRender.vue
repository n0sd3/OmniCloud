<script setup>
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../../../services/api';

const props = defineProps({
	file: { type: Object, required: true },
	active: { type: Boolean, default: false },
});
const emit = defineEmits(['loaded', 'failed']);
const { t } = useI18n();

const pageCount = ref(0);
let currentToken = null;

const pages = computed(() => Array.from({ length: pageCount.value }, (_, index) => index + 1));

async function load() {
	const token = props.file.id;
	currentToken = token;
	pageCount.value = 0;
	try {
		const { pageCount: count } = await api.previewPages(props.file.id);
		if (currentToken !== token) return;
		pageCount.value = Number(count) || 0;
		if (!pageCount.value) return emit('failed');
		emit('loaded');
	} catch {
		if (currentToken !== token) return;
		emit('failed');
	}
}

watch(() => props.file.id, load, { immediate: true });
</script>

<template>
	<div class="h-full w-full overflow-y-auto px-2 py-4">
		<!-- ponytail: paginas como <img> com lazy. Zoom e busca no texto exigiriam
		     pdf.js no bundle; entra so se alguem pedir. -->
		<img
			v-for="page in pages"
			:key="page"
			:src="api.previewPageUrl(props.file.id, page)"
			class="mx-auto mb-4 w-full max-w-3xl bg-white shadow-lg"
			loading="lazy"
			:alt="t('preview.pageOf', { page })"
		/>
	</div>
</template>
