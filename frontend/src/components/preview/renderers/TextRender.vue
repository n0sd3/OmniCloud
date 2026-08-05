<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../../../services/api';
import { isCsv, isMarkdown, languageOf, parseCsv, renderMarkdown } from '../../../composables/useTextPreview.js';

const MAX_TEXT_BYTES = 1024 * 1024;

const props = defineProps({
	file: { type: Object, required: true },
	active: { type: Boolean, default: false },
});
const emit = defineEmits(['loaded', 'failed']);
const { t } = useI18n();

const body = ref('');
const html = ref('');
const showSource = ref(false);
let currentToken = null;

const name = computed(() => props.file.display_name || props.file.file_name || '');
const language = computed(() => languageOf(name.value));
const asMarkdown = computed(() => isMarkdown(name.value) && !showSource.value);
const asCsv = computed(() => isCsv(name.value) && !showSource.value);
const table = computed(() => (asCsv.value ? parseCsv(body.value) : { header: [], rows: [] }));

// Highlight e markdown chegam por import() dinamico: quem so ve fotos nao
// baixa nenhum dos dois.
async function decorate(token) {
	if (isMarkdown(name.value)) {
		const { marked } = await import('marked');
		if (currentToken !== token) return;
		html.value = renderMarkdown(body.value, marked.parse);
		return;
	}
	if (language.value) {
		const hljs = (await import('highlight.js/lib/common')).default;
		if (currentToken !== token) return;
		html.value = hljs.highlight(body.value, { language: language.value, ignoreIllegals: true }).value;
	}
}

async function load() {
	const token = props.file.id;
	currentToken = token;
	body.value = '';
	html.value = '';
	showSource.value = false;
	try {
		const text = await api.previewText(props.file.id);
		if (currentToken !== token) return;
		body.value = text.length > MAX_TEXT_BYTES ? text.slice(0, MAX_TEXT_BYTES) : text;
		emit('loaded');
		// Highlight e markdown sao cosmeticos: se o chunk nao carregar, o arquivo
		// continua legivel como texto puro em vez de virar tela de erro.
		try {
			await decorate(token);
		} catch {
		}
	} catch {
		if (currentToken !== token) return;
		emit('failed');
	}
}

watch(() => props.file.id, load, { immediate: true });
onBeforeUnmount(() => { currentToken = null; });
</script>

<template>
	<div class="h-full w-full overflow-auto px-4 py-4 text-slate-100">
		<button
			v-if="isMarkdown(name) || isCsv(name)"
			type="button"
			class="mb-3 rounded-full bg-white/10 px-4 py-1.5 text-xs font-medium hover:bg-white/20"
			@click.stop="showSource = !showSource"
		>
			{{ showSource ? t('preview.openRendered') : t('preview.openSource') }}
		</button>

		<table v-if="asCsv" class="w-full border-collapse text-left text-xs">
			<thead>
				<tr>
					<th v-for="(cell, index) in table.header" :key="index" class="border border-white/15 bg-white/10 px-2 py-1 font-semibold">{{ cell }}</th>
				</tr>
			</thead>
			<tbody>
				<tr v-for="(row, rowIndex) in table.rows" :key="rowIndex">
					<td v-for="(cell, cellIndex) in row" :key="cellIndex" class="border border-white/10 px-2 py-1">{{ cell }}</td>
				</tr>
			</tbody>
		</table>

		<!-- eslint-disable-next-line vue/no-v-html -->
		<div v-else-if="asMarkdown && html" class="prose prose-invert max-w-3xl" v-html="html"></div>

		<!-- eslint-disable-next-line vue/no-v-html -->
		<pre v-else-if="html && !showSource" class="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed"><code v-html="html"></code></pre>

		<pre v-else class="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">{{ body }}</pre>
	</div>
</template>
