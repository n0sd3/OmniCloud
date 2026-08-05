import { computed, ref } from 'vue';

export function useFilePreviewModal({ getPreviewType, sourceList, onUnsupported } = {}) {
	if (typeof getPreviewType !== 'function') {
		throw new Error('useFilePreviewModal: getPreviewType is required');
	}

	const previewFile = ref(null);
	const isPreviewOpen = ref(false);

	const canPreview = (file) => Boolean(file && !file.is_folder && getPreviewType(file));

	const previewableFiles = computed(
		() => (sourceList?.value || []).filter((file) => canPreview(file)),
	);
	const total = computed(() => previewableFiles.value.length);
	const currentIndex = computed(
		() => previewableFiles.value.findIndex((file) => file.id === previewFile.value?.id),
	);
	const hasPreviousPreview = computed(() => currentIndex.value > 0);
	const hasNextPreview = computed(
		() => currentIndex.value >= 0 && currentIndex.value < total.value - 1,
	);

	function openPreview(file) {
		if (!canPreview(file)) {
			if (typeof onUnsupported === 'function') onUnsupported(file);
			return false;
		}
		previewFile.value = { ...file, previewType: getPreviewType(file) };
		isPreviewOpen.value = true;
		return true;
	}

	function closePreview() {
		isPreviewOpen.value = false;
		previewFile.value = null;
	}

	function goToIndex(index) {
		const next = previewableFiles.value[index];
		if (next) openPreview(next);
	}

	function showPreviousPreview() {
		if (hasPreviousPreview.value) goToIndex(currentIndex.value - 1);
	}

	function showNextPreview() {
		if (hasNextPreview.value) goToIndex(currentIndex.value + 1);
	}

	// Janela de montagem do carrossel: so o slide atual e os vizinhos imediatos
	// carregam conteudo, senao uma pasta com 200 videos monta 200 players.
	function isNear(index) {
		return currentIndex.value >= 0 && Math.abs(index - currentIndex.value) <= 1;
	}

	return {
		previewFile,
		isPreviewOpen,
		previewableFiles,
		currentIndex,
		total,
		canPreview,
		hasPreviousPreview,
		hasNextPreview,
		openPreview,
		closePreview,
		showPreviousPreview,
		showNextPreview,
		goToIndex,
		isNear,
	};
}
