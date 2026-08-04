<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { activateFocusTrap } from '../utils/focusTrap.js';
import { looksLikeMegaFileLink } from '../utils/megaLink.js';

const props = defineProps({
	open: { type: Boolean, default: false },
	busy: { type: Boolean, default: false },
	error: { type: String, default: '' },
});

const emit = defineEmits(['close', 'download', 'import']);
const { t } = useI18n();
const dialogRef = ref(null);
const inputRef = ref(null);
const link = ref('');
const touched = ref(false);
const trimmedLink = computed(() => link.value.trim());
const isValid = computed(() => looksLikeMegaFileLink(trimmedLink.value));
const validationMessage = computed(() => {
	if (!touched.value || isValid.value) return '';
	return trimmedLink.value ? t('megaLink.invalid') : t('megaLink.required');
});

let deactivateFocusTrap = null;

watch(() => props.open, async (open) => {
	deactivateFocusTrap?.();
	deactivateFocusTrap = null;
	if (!open) return;
	link.value = '';
	touched.value = false;
	await nextTick();
	if (!props.open) return;
	deactivateFocusTrap = activateFocusTrap(dialogRef.value, {
		initialFocus: inputRef.value,
		onEscape: close,
	});
});

onBeforeUnmount(() => deactivateFocusTrap?.());

function close() {
	if (!props.busy) emit('close');
}

function submit(action) {
	touched.value = true;
	if (props.busy || !isValid.value) return;
	emit(action, trimmedLink.value);
}
</script>

<template>
	<div v-if="open" class="fixed inset-0 z-50 grid place-items-center bg-slate-950/40 px-4 backdrop-blur-sm" @mousedown.self="close">
		<section ref="dialogRef" role="dialog" aria-modal="true" aria-labelledby="mega-link-title" aria-describedby="mega-link-description" class="w-full max-w-lg rounded-[28px] border border-[#e0e3e7] bg-white p-6 text-[#202124] shadow-[0_24px_70px_rgba(15,23,42,0.24)] dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100">
			<h2 id="mega-link-title" class="text-xl font-medium">{{ t('megaLink.title') }}</h2>
			<p id="mega-link-description" class="mt-2 text-sm leading-6 text-[#5f6368] dark:text-slate-400">{{ t('megaLink.description') }}</p>

			<p v-if="error" id="mega-link-server-error" role="alert" class="mt-4 rounded-2xl bg-[#fce8e6] px-4 py-3 text-sm text-[#c5221f] dark:bg-red-950/40 dark:text-red-300">{{ error }}</p>

			<div class="mt-5">
				<label for="mega-link-url" class="mb-1.5 block text-sm text-[#5f6368] dark:text-slate-400">{{ t('megaLink.label') }}</label>
				<input id="mega-link-url" ref="inputRef" v-model="link" type="url" inputmode="url" autocomplete="url" :placeholder="t('megaLink.placeholder')" :aria-invalid="Boolean(validationMessage)" :aria-describedby="validationMessage ? 'mega-link-validation' : (error ? 'mega-link-server-error' : undefined)" class="h-12 w-full rounded-2xl border bg-white px-4 outline-none placeholder:text-[#9aa0a6] focus:border-[#1a73e8] dark:bg-slate-800 dark:placeholder:text-slate-500" :class="validationMessage ? 'border-red-500' : 'border-[#dadce0] dark:border-slate-700'" @blur="touched = true" @keydown.enter.prevent="submit('import')" />
				<p v-if="validationMessage" id="mega-link-validation" class="mt-2 text-sm text-[#c5221f] dark:text-red-300">{{ validationMessage }}</p>
			</div>

			<p v-if="busy" role="status" class="mt-4 text-sm text-[#5f6368] dark:text-slate-400">{{ t('megaLink.inspecting') }}</p>

			<div class="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end">
				<button type="button" class="h-10 rounded-full px-4 text-[#5f6368] hover:bg-[#f1f3f4] disabled:opacity-60 dark:text-slate-300 dark:hover:bg-slate-800" :disabled="busy" @click="close">{{ t('megaLink.cancel') }}</button>
				<button type="button" class="h-10 rounded-full border border-[#dadce0] px-5 font-medium text-[#1a73e8] hover:bg-[#f8fafd] disabled:opacity-60 dark:border-slate-700 dark:text-blue-300 dark:hover:bg-slate-800" :disabled="busy || !isValid" @click="submit('download')">{{ t('megaLink.download') }}</button>
				<button type="button" class="h-10 rounded-full bg-[#1a73e8] px-5 font-medium text-white disabled:opacity-60" :disabled="busy || !isValid" @click="submit('import')">{{ t('megaLink.import') }}</button>
			</div>
		</section>
	</div>
</template>
