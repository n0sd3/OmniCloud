import assert from 'node:assert/strict';
import test from 'node:test';
import { ref } from 'vue';
import { useFileListKeyboard } from '../src/composables/useFileListKeyboard.js';

const FILES = [
	{ id: 'a', file_name: 'a.txt' },
	{ id: 'b', file_name: 'b.txt' },
	{ id: 'c', file_name: 'c.txt' },
];

function keyEvent(key, extra = {}) {
	return {
		key,
		shiftKey: false,
		ctrlKey: false,
		metaKey: false,
		target: { tagName: 'DIV', isContentEditable: false },
		preventDefault() { this.defaultPrevented = true; },
		defaultPrevented: false,
		...extra,
	};
}

function setup(overrides = {}) {
	const sortedFiles = ref(FILES);
	const selectedFileIds = ref(new Set());
	const lastSelectedFileId = ref(null);
	const isPreviewOpen = ref(false);
	const opened = [];
	const calls = { rename: 0, remove: 0, inspector: 0 };

	const keyboard = useFileListKeyboard({
		sortedFiles,
		selectedFileIds,
		lastSelectedFileId,
		replaceSelection: (file) => {
			selectedFileIds.value = new Set([file.id]);
			lastSelectedFileId.value = file.id;
		},
		clearSelection: () => {
			selectedFileIds.value = new Set();
			lastSelectedFileId.value = null;
		},
		isPreviewOpen,
		canPreview: () => true,
		openPreview: (file) => { opened.push(file.id); isPreviewOpen.value = true; },
		closePreview: () => { isPreviewOpen.value = false; },
		renameSelectedFile: () => { calls.rename += 1; },
		deleteSelectedFile: () => { calls.remove += 1; },
		toggleInspector: () => { calls.inspector += 1; },
		...overrides,
	});

	return { keyboard, sortedFiles, selectedFileIds, lastSelectedFileId, isPreviewOpen, opened, calls };
}

test('a seta para baixo comeca no primeiro item e avanca', () => {
	const { keyboard, lastSelectedFileId } = setup();
	keyboard.handleKeydown(keyEvent('ArrowDown'));
	assert.equal(lastSelectedFileId.value, 'a');
	keyboard.handleKeydown(keyEvent('ArrowDown'));
	assert.equal(lastSelectedFileId.value, 'b');
});

test('o cursor para no ultimo item', () => {
	const { keyboard, lastSelectedFileId } = setup();
	keyboard.handleKeydown(keyEvent('ArrowDown'));
	keyboard.handleKeydown(keyEvent('ArrowDown'));
	keyboard.handleKeydown(keyEvent('ArrowDown'));
	keyboard.handleKeydown(keyEvent('ArrowDown'));
	assert.equal(lastSelectedFileId.value, 'c');
});

test('shift mais seta estende a selecao a partir da ancora', () => {
	const { keyboard, selectedFileIds } = setup();
	keyboard.handleKeydown(keyEvent('ArrowDown'));
	keyboard.handleKeydown(keyEvent('ArrowDown', { shiftKey: true }));
	keyboard.handleKeydown(keyEvent('ArrowDown', { shiftKey: true }));
	assert.deepEqual([...selectedFileIds.value].sort(), ['a', 'b', 'c']);
});

test('ctrl mais A seleciona tudo', () => {
	const { keyboard, selectedFileIds } = setup();
	keyboard.handleKeydown(keyEvent('a', { ctrlKey: true }));
	assert.equal(selectedFileIds.value.size, 3);
});

test('evento vindo de um input e ignorado', () => {
	const { keyboard, lastSelectedFileId } = setup();
	keyboard.handleKeydown(keyEvent('ArrowDown', { target: { tagName: 'INPUT', isContentEditable: false } }));
	assert.equal(lastSelectedFileId.value, null);
});

test('espaco abre o preview e fecha quando ja esta aberto', () => {
	const { keyboard, opened, isPreviewOpen } = setup();
	keyboard.handleKeydown(keyEvent('ArrowDown'));
	keyboard.handleKeydown(keyEvent(' '));
	assert.deepEqual(opened, ['a']);
	assert.equal(isPreviewOpen.value, true);
	keyboard.handleKeydown(keyEvent(' '));
	assert.equal(isPreviewOpen.value, false);
});

test('escape com preview aberto e ignorado pelo teclado da lista', () => {
	const { keyboard, selectedFileIds, isPreviewOpen } = setup();
	keyboard.handleKeydown(keyEvent('ArrowDown'));
	isPreviewOpen.value = true;
	keyboard.handleKeydown(keyEvent('Escape'));
	assert.equal(selectedFileIds.value.size, 1);
});

test('escape sem preview limpa a selecao', () => {
	const { keyboard, selectedFileIds } = setup();
	keyboard.handleKeydown(keyEvent('ArrowDown'));
	keyboard.handleKeydown(keyEvent('Escape'));
	assert.equal(selectedFileIds.value.size, 0);
});

test('F2 renomeia, Delete exclui e I alterna o inspector', () => {
	const { keyboard, calls } = setup();
	keyboard.handleKeydown(keyEvent('ArrowDown'));
	keyboard.handleKeydown(keyEvent('F2'));
	keyboard.handleKeydown(keyEvent('Delete'));
	keyboard.handleKeydown(keyEvent('i'));
	assert.deepEqual(calls, { rename: 1, remove: 1, inspector: 1 });
});
