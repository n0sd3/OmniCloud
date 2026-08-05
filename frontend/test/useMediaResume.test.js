import assert from 'node:assert/strict';
import test from 'node:test';
import { createMediaResume } from '../src/composables/useMediaResume.js';

function fakeStorage(initial = {}) {
	const data = { ...initial };
	return {
		getItem: (key) => (key in data ? data[key] : null),
		setItem: (key, value) => { data[key] = String(value); },
		removeItem: (key) => { delete data[key]; },
		dump: () => data,
	};
}

test('writes and reads back a playback position', () => {
	const storage = fakeStorage();
	const resume = createMediaResume(storage, { now: () => 1_000 });

	resume.write('file-1', 42, 600);
	assert.equal(resume.read('file-1'), 42);
});

test('does not store a position near the end of the media', () => {
	const storage = fakeStorage();
	const resume = createMediaResume(storage, { now: () => 1_000 });

	resume.write('file-1', 590, 600);
	assert.equal(resume.read('file-1'), 0, 'less than 30s left counts as finished');
});

test('reads zero for an unknown file', () => {
	const resume = createMediaResume(fakeStorage(), { now: () => 1_000 });
	assert.equal(resume.read('missing'), 0);
});

test('prune drops entries older than ninety days', () => {
	const day = 24 * 60 * 60 * 1000;
	const storage = fakeStorage({
		'omnicloud.resume.old': JSON.stringify({ time: 10, at: 0 }),
		'omnicloud.resume.fresh': JSON.stringify({ time: 20, at: 100 * day }),
		'unrelated.key': 'keep me',
	});
	const resume = createMediaResume(storage, { now: () => 100 * day });

	resume.prune();

	assert.equal(storage.getItem('omnicloud.resume.old'), null);
	assert.notEqual(storage.getItem('omnicloud.resume.fresh'), null);
	assert.equal(storage.getItem('unrelated.key'), 'keep me');
});
