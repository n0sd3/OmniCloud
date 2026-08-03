import assert from 'node:assert/strict';
import test from 'node:test';

const { BaseCloudAdapter, buildRangeHeader } = await import(
	'../src/adapters/BaseCloudAdapter.js'
);

test('buildRangeHeader monta intervalo fechado', () => {
	assert.equal(buildRangeHeader({ start: 0, end: 499 }), 'bytes=0-499');
});

test('buildRangeHeader monta intervalo aberto', () => {
	assert.equal(buildRangeHeader({ start: 500 }), 'bytes=500-');
});

test('buildRangeHeader devolve null sem range', () => {
	assert.equal(buildRangeHeader(null), null);
	assert.equal(buildRangeHeader({}), null);
});

test('BaseCloudAdapter declara supportsRange false', () => {
	const adapter = new BaseCloudAdapter({ provider: 'fake' });
	assert.equal(adapter.getCapabilities().supportsRange, false);
});

test('BaseCloudAdapter aceita options sem quebrar', async () => {
	const adapter = new BaseCloudAdapter({ provider: 'fake' });
	const stream = await adapter.getDownloadStream({ file_name: 'a.txt' }, { start: 0, end: 5 });
	const chunks = [];
	for await (const chunk of stream) chunks.push(chunk);
	assert.match(chunks.join(''), /Simulated download for a\.txt/);
});
