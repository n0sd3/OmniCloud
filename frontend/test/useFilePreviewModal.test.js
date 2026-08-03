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
		getFileCategory: () => 'other',
		getPreviewType: (file) => ({ a: 'image', c: 'pdf', d: 'text' })[file?.id] ?? null,
		buildPreviewUrl: (file) => `/preview/${file.id}`,
		sourceList,
		fetchText: async () => 'file body',
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
	assert.equal(modal.hasPreviousPreview.value, true);

	modal.showNextPreview();
	assert.equal(modal.previewFile.value.id, 'd');
	assert.equal(modal.hasNextPreview.value, false);

	modal.showNextPreview();
	assert.equal(modal.previewFile.value.id, 'd', 'stops at the end');

	modal.showPreviousPreview();
	assert.equal(modal.previewFile.value.id, 'c');
});

test('opening a text file loads its body and truncates at the limit', async () => {
	const modal = setup({ fetchText: async () => 'x'.repeat(10), maxTextBytes: 4 });

	modal.openPreview(TEXT);
	await new Promise((resolve) => setTimeout(resolve, 0));

	assert.equal(modal.previewText.value, 'xxxx');
	assert.equal(modal.isPreviewLoading.value, false);
});

test('failures surface as previewError instead of a blank pane', () => {
	const modal = setup();

	modal.openPreview(IMAGE);
	modal.handlePreviewFailed();
	assert.equal(modal.isPreviewLoading.value, false);
	assert.ok(modal.previewError.value);

	modal.openPreview(PDF);
	assert.equal(modal.previewError.value, null, 'reopening clears the error');
});

test('failing to load text reports the configured message', async () => {
	const modal = setup({
		fetchText: async () => { throw new Error('network down'); },
		textLoadErrorMessage: 'could not load',
	});

	modal.openPreview(TEXT);
	await new Promise((resolve) => setTimeout(resolve, 0));

	assert.equal(modal.previewError.value, 'could not load');
	assert.equal(modal.isPreviewLoading.value, false);
});
