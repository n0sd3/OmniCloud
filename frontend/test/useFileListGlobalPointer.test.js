import assert from 'node:assert/strict';
import test from 'node:test';
import { ref } from 'vue';
import { createGlobalPointerHandler } from '../src/composables/useFileListGlobalPointer.js';

function setup() {
	const contextMenu = ref({ visible: true });
	const activeFilterMenu = ref('type');
	const calls = { clearSelection: 0, closeContextMenu: 0 };
	const handleGlobalPointer = createGlobalPointerHandler({
		contextMenu,
		activeFilterMenu,
		closeContextMenu: () => { calls.closeContextMenu += 1; },
		clearSelection: () => { calls.clearSelection += 1; },
	});
	return { activeFilterMenu, calls, handleGlobalPointer };
}

test('scroll fecha menus sem limpar a selecao', () => {
	const { activeFilterMenu, calls, handleGlobalPointer } = setup();

	handleGlobalPointer({ type: 'scroll' });

	assert.equal(calls.closeContextMenu, 1);
	assert.equal(activeFilterMenu.value, null);
	assert.equal(calls.clearSelection, 0);
});

test('clique global continua limpando a selecao', () => {
	const { calls, handleGlobalPointer } = setup();

	handleGlobalPointer({ type: 'click' });

	assert.equal(calls.clearSelection, 1);
});
