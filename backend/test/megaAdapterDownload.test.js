import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';

import { MegaAdapter } from '../src/adapters/MegaAdapter.js';
import { MegaBasterdError } from '../src/services/megaBasterdClient.js';
import { createMegaDownloadService } from '../src/services/megaDownloadService.js';

async function read(stream) {
	const chunks = [];
	for await (const chunk of stream) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks).toString('utf8');
}

function fixtureFile(overrides = {}) {
	return {
		directory: false,
		nodeId: 'node-1',
		name: 'private.bin',
		size: 36,
		key: Buffer.from([0xfb, 0xff, 0x00, 0x01]),
		api: {
			request: async (payload) => {
				assert.deepEqual(payload, { a: 'g', g: 1, ssl: 2, n: 'node-1' });
				return { g: 'https://signed.example/file', s: 36 };
			},
		},
		download: () => Readable.from(['fallback']),
		...overrides,
	};
}

test('private MEGA resolution exposes only signed transfer metadata and base64url key', async () => {
	const adapter = new MegaAdapter({}, {});
	adapter.findByRecord = async () => fixtureFile();

	assert.deepEqual(await adapter.resolvePrivateTransfer({ file_name: 'record.bin', size: 20 }), {
		downloadUrl: 'https://signed.example/file',
		fileKey: '-_8AAQ',
		fileName: 'private.bin',
		size: 36,
	});
});

test('private MEGA download forwards range and provides one direct megajs fallback', async () => {
	let serviceTransfer;
	let serviceOptions;
	let fallbackCalls = 0;
	const file = fixtureFile({
		download: (range) => {
			fallbackCalls += 1;
			assert.deepEqual(range, { start: 7, end: 15 });
			return Readable.from(['fallback']);
		},
	});
	const downloads = createMegaDownloadService({
		client: {
			streamResolved: async (transfer, options) => {
				serviceTransfer = transfer;
				serviceOptions = options;
				throw new MegaBasterdError('UNAVAILABLE', 'Sidecar unavailable', { fallbackEligible: true });
			},
		},
		logger: { warn() {} },
	});
	const adapter = new MegaAdapter({}, downloads);
	adapter.findByRecord = async () => file;

	const stream = await adapter.getDownloadStream({ file_name: 'record.bin' }, { start: 7, end: 15 });

	assert.equal(await read(stream), 'fallback');
	assert.equal(serviceTransfer.downloadUrl, 'https://signed.example/file');
	assert.deepEqual(serviceOptions.range, { start: 7, end: 15 });
	assert.equal(fallbackCalls, 1);
});

test('private MEGA resolution rejects folders, missing keys and unsafe signed URLs', async () => {
	for (const file of [
		fixtureFile({ directory: true }),
		fixtureFile({ key: null }),
		fixtureFile({ api: { request: async () => ({ g: 'http://signed.example/file', s: 36 }) } }),
	]) {
		const adapter = new MegaAdapter({}, {});
		adapter.findByRecord = async () => file;
		await assert.rejects(adapter.resolvePrivateTransfer({ file_name: 'record.bin' }), /MEGA/i);
	}
});
