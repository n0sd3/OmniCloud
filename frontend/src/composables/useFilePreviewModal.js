import { computed, ref } from 'vue';

const DEFAULT_MAX_TEXT_BYTES = 1024 * 1024;

function defaultCanPreview(file, getFileCategory) {
	return Boolean(
		file
			&& !file.is_folder
			&& ['image', 'video', 'audio', 'document'].includes(getFileCategory(file)),
	);
}

export function useFilePreviewModal({
	getFileCategory,
	buildPreviewUrl,
	getPreviewType,
	onUnsupported,
	sourceList,
	fetchText,
	textLoadErrorMessage = 'Preview failed to load.',
	loadErrorMessage = 'Preview failed to load.',
	maxTextBytes = DEFAULT_MAX_TEXT_BYTES,
} = {}) {
	if (typeof getFileCategory !== 'function') {
		throw new Error('useFilePreviewModal: getFileCategory is required');
	}
	if (typeof buildPreviewUrl !== 'function') {
		throw new Error('useFilePreviewModal: buildPreviewUrl is required');
	}

	const previewFile = ref(null);
	const isPreviewOpen = ref(false);
	const isPreviewLoading = ref(false);
	const previewError = ref(null);
	const previewText = ref(null);

	const previewTypeOf = typeof getPreviewType === 'function'
		? getPreviewType
		: (file) => getFileCategory(file);

	const canPreview = typeof getPreviewType === 'function'
		? (file) => Boolean(previewTypeOf(file))
		: (file) => defaultCanPreview(file, getFileCategory);

	const previewableFiles = computed(
		() => (sourceList?.value || []).filter((file) => canPreview(file)),
	);
	const currentIndex = computed(
		() => previewableFiles.value.findIndex((file) => file.id === previewFile.value?.id),
	);
	const hasPreviousPreview = computed(() => currentIndex.value > 0);
	const hasNextPreview = computed(
		() => currentIndex.value >= 0 && currentIndex.value < previewableFiles.value.length - 1,
	);

	async function loadText(file, url) {
		if (typeof fetchText !== 'function') return;
		const token = file.id;
		try {
			const body = await fetchText(url, file);
			// Corrida: o usuario pode ter navegado para outro arquivo antes da resposta.
			if (previewFile.value?.id !== token) return;
			previewText.value = body.length > maxTextBytes ? body.slice(0, maxTextBytes) : body;
			isPreviewLoading.value = false;
		} catch {
			if (previewFile.value?.id !== token) return;
			previewError.value = textLoadErrorMessage;
			isPreviewLoading.value = false;
		}
	}

	function openPreview(file) {
		if (!canPreview(file)) {
			if (typeof onUnsupported === 'function') onUnsupported(file);
			return false;
		}

		const previewType = previewTypeOf(file);
		const previewUrl = buildPreviewUrl(file);

		isPreviewLoading.value = true;
		previewError.value = null;
		previewText.value = null;
		previewFile.value = { ...file, previewType, previewUrl };
		isPreviewOpen.value = true;

		if (previewType === 'text') void loadText(file, previewUrl);
		return true;
	}

	function closePreview() {
		isPreviewOpen.value = false;
		previewFile.value = null;
		isPreviewLoading.value = false;
		previewError.value = null;
		previewText.value = null;
	}

	function step(offset) {
		const next = previewableFiles.value[currentIndex.value + offset];
		if (next) openPreview(next);
	}

	function showPreviousPreview() {
		if (hasPreviousPreview.value) step(-1);
	}

	function showNextPreview() {
		if (hasNextPreview.value) step(1);
	}

	function handlePreviewLoaded() {
		isPreviewLoading.value = false;
	}

	function handlePreviewFailed() {
		isPreviewLoading.value = false;
		previewError.value = loadErrorMessage;
	}

	return {
		previewFile,
		isPreviewOpen,
		isPreviewLoading,
		previewError,
		previewText,
		canPreview,
		hasPreviousPreview,
		hasNextPreview,
		openPreview,
		closePreview,
		showPreviousPreview,
		showNextPreview,
		handlePreviewLoaded,
		handlePreviewFailed,
	};
}
