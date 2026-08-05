import assert from 'node:assert/strict';
import test from 'node:test';
import { usePreviewChrome } from '../src/composables/usePreviewChrome.js';

test('hides on its own after the timeout', async () => {
	const chrome = usePreviewChrome({ timeoutMs: 10 });
	chrome.show();
	assert.equal(chrome.visible.value, true);

	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(chrome.visible.value, false);
});

test('hold keeps it visible until every hold is released', async () => {
	const chrome = usePreviewChrome({ timeoutMs: 10 });
	chrome.show();
	chrome.hold();
	chrome.hold();

	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(chrome.visible.value, true, 'stays visible while held');

	chrome.release();
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(chrome.visible.value, true, 'one hold is still active');

	chrome.release();
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(chrome.visible.value, false);
});

test('toggle flips visibility and showing again restarts the timer', async () => {
	const chrome = usePreviewChrome({ timeoutMs: 40 });
	chrome.show();

	await new Promise((resolve) => setTimeout(resolve, 25));
	chrome.show();
	await new Promise((resolve) => setTimeout(resolve, 25));
	assert.equal(chrome.visible.value, true, 'the second show restarted the countdown');

	chrome.toggle();
	assert.equal(chrome.visible.value, false);
	chrome.toggle();
	assert.equal(chrome.visible.value, true);
});
