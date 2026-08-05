import { onBeforeUnmount, onMounted, ref } from 'vue';

const EDITABLE_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

function isEditableTarget(target) {
	if (!target) return false;
	if (EDITABLE_TAGS.has(target.tagName)) return true;
	return Boolean(target.isContentEditable);
}

export function useFileListKeyboard({
	sortedFiles,
	selectedFileIds,
	lastSelectedFileId,
	replaceSelection,
	clearSelection,
	isPreviewOpen,
	canPreview,
	openPreview,
	closePreview,
	renameSelectedFile,
	deleteSelectedFile,
	toggleInspector,
	isGridView,
	onCursorMove,
}) {
	const anchorId = ref(null);
	let openHandler = null;

	function setOpenHandler(handler) {
		openHandler = typeof handler === 'function' ? handler : null;
	}

	function cursorItem() {
		return sortedFiles.value.find((item) => item.id === lastSelectedFileId.value) || null;
	}

	function itemAt(index) {
		const items = sortedFiles.value;
		if (!items.length) return null;
		return items[Math.min(Math.max(index, 0), items.length - 1)];
	}

	function applyCursor(next, extend) {
		const items = sortedFiles.value;
		if (!next) return;

		if (extend) {
			// A ancora nao pode andar junto do cursor, senao shift repetido perde o inicio do intervalo.
			const anchor = anchorId.value || lastSelectedFileId.value || next.id;
			const start = items.findIndex((item) => item.id === anchor);
			const end = items.findIndex((item) => item.id === next.id);
			if (start !== -1 && end !== -1) {
				const [from, to] = start < end ? [start, end] : [end, start];
				selectedFileIds.value = new Set(items.slice(from, to + 1).map((item) => item.id));
				lastSelectedFileId.value = next.id;
				anchorId.value = anchor;
			}
		} else {
			replaceSelection(next);
			anchorId.value = next.id;
		}

		if (typeof onCursorMove === 'function') onCursorMove(next);
	}

	function moveCursor(offset, extend) {
		const items = sortedFiles.value;
		if (!items.length) return;
		const currentIndex = items.findIndex((item) => item.id === lastSelectedFileId.value);
		// Sem cursor, um passo para frente comeca no primeiro item e um passo para tras, no ultimo.
		const next = currentIndex === -1
			? (offset > 0 ? items[0] : items[items.length - 1])
			: itemAt(currentIndex + offset);
		applyCursor(next, extend);
	}

	function moveCursorTo(index, extend) {
		applyCursor(itemAt(index), extend);
	}

	function toggleQuickPreview() {
		if (isPreviewOpen.value) {
			closePreview();
			return;
		}
		const file = cursorItem();
		if (file && canPreview(file)) openPreview(file);
	}

	function handleKeydown(event) {
		if (isEditableTarget(event.target)) return;

		// Com o preview aberto, Escape e as setas pertencem ao FilePreviewViewer.
		if (isPreviewOpen.value && event.key !== ' ') return;

		const isHorizontal = event.key === 'ArrowLeft' || event.key === 'ArrowRight';
		if (isHorizontal && !isGridView?.value) return;

		switch (event.key) {
			case 'ArrowDown':
			case 'ArrowRight':
				event.preventDefault();
				moveCursor(1, event.shiftKey);
				return;
			case 'ArrowUp':
			case 'ArrowLeft':
				event.preventDefault();
				moveCursor(-1, event.shiftKey);
				return;
			case 'Home':
				event.preventDefault();
				moveCursorTo(0, event.shiftKey);
				return;
			case 'End':
				event.preventDefault();
				moveCursorTo(sortedFiles.value.length - 1, event.shiftKey);
				return;
			case ' ':
				event.preventDefault();
				toggleQuickPreview();
				return;
			case 'Enter': {
				const file = cursorItem();
				if (file && openHandler) openHandler(file);
				return;
			}
			case 'Escape':
				clearSelection();
				anchorId.value = null;
				return;
			case 'F2':
				if (lastSelectedFileId.value) renameSelectedFile();
				return;
			case 'Delete':
			case 'Backspace':
				if (selectedFileIds.value.size) deleteSelectedFile();
				return;
			case 'i':
			case 'I':
				if (!event.ctrlKey && !event.metaKey) toggleInspector();
				return;
			case 'a':
			case 'A':
				if (!event.ctrlKey && !event.metaKey) return;
				event.preventDefault();
				selectedFileIds.value = new Set(sortedFiles.value.map((item) => item.id));
				return;
			default:
		}
	}

	onMounted(() => window.addEventListener('keydown', handleKeydown));
	onBeforeUnmount(() => window.removeEventListener('keydown', handleKeydown));

	return { handleKeydown, setOpenHandler };
}
