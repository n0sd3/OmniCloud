import assert from 'node:assert/strict';
import test from 'node:test';
import { ref } from 'vue';
import { useFilePreviewModal } from '../src/composables/useFilePreviewModal.js';

const IMAGE = { id: 'a', file_name: 'a.jpg', mime_type: 'image/jpeg' };
const ZIP = { id: 'b', file_name: 'b.zip', mime_type: 'application/zip' };
const PDF = { id: 'c', file_name: 'c.pdf', mime_type: 'application/pdf' };
const TEXT = { id: 'd', file_name: 'd.txt', mime_type: 'text/plain' };

function setup(overrides = {}) {
	const sourceList = ref([IMAGE, ZIP, PDF, TEXT]);
	return useFilePreviewModal({
		getPreviewType: (file) => ({ a: 'image', c: 'pdf', d: 'text' })[file?.id] ?? null,
		sourceList,
		...overrides,
	});
}

test('navigation walks only over previewable files', () => {
	const modal = setup();

	modal.openPreview(IMAGE);
	assert.equal(modal.hasPreviousPreview.value, false);
	assert.equal(modal.hasNextPreview.value, true);

	modal.showNextPreview();
	assert.equal(modal.previewFile.value.id, 'c', 'skips the zip');

	modal.showNextPreview();
	assert.equal(modal.previewFile.value.id, 'd');
	assert.equal(modal.hasNextPreview.value, false);

	modal.showNextPreview();
	assert.equal(modal.previewFile.value.id, 'd', 'stops at the end');
});

test('currentIndex and total describe the position in the previewable list', () => {
	const modal = setup();
	assert.equal(modal.total.value, 3);
	assert.equal(modal.currentIndex.value, -1);

	modal.openPreview(PDF);
	assert.equal(modal.currentIndex.value, 1);
});

test('goToIndex jumps and ignores out-of-range values', () => {
	const modal = setup();
	modal.openPreview(IMAGE);

	modal.goToIndex(2);
	assert.equal(modal.previewFile.value.id, 'd');

	modal.goToIndex(9);
	assert.equal(modal.previewFile.value.id, 'd', 'ignores an index past the end');

	modal.goToIndex(-1);
	assert.equal(modal.previewFile.value.id, 'd', 'ignores a negative index');
});

test('isNear covers the current slide and its two neighbours', () => {
	const modal = setup();
	modal.openPreview(PDF);

	assert.equal(modal.isNear(0), true);
	assert.equal(modal.isNear(1), true);
	assert.equal(modal.isNear(2), true);

	modal.openPreview(IMAGE);
	assert.equal(modal.isNear(2), false);
});

test('opening an unsupported file reports instead of opening', () => {
	let reported = null;
	const modal = setup({ onUnsupported: (file) => { reported = file; } });

	assert.equal(modal.openPreview(ZIP), false);
	assert.equal(modal.isPreviewOpen.value, false);
	assert.equal(reported.id, 'b');
});

test('closePreview clears the current file', () => {
	const modal = setup();
	modal.openPreview(IMAGE);
	modal.closePreview();

	assert.equal(modal.isPreviewOpen.value, false);
	assert.equal(modal.previewFile.value, null);
});
