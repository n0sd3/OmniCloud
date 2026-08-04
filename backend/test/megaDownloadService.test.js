import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import test from 'node:test';

import { MegaBasterdError } from '../src/services/megaBasterdClient.js';
import { createMegaDownloadService, normalizeMegaFileLink } from '../src/services/megaDownloadService.js';
import { env, redactEnv } from '../src/config/env.js';

async function read(stream) {
	const chunks = [];
	for await (const chunk of stream) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks).toString('utf8');
}

test('MEGA file link normalization accepts modern and legacy links', () => {
	assert.equal(
		normalizeMegaFileLink(' https://www.mega.co.nz/file/abc_123#key-456 '),
		'https://mega.nz/file/abc_123#key-456',
	);
	assert.equal(
		normalizeMegaFileLink('https://mega.nz/#!abc_123!key-456'),
		'https://mega.nz/#!abc_123!key-456',
	);
});

test('MEGA file link normalization rejects unsafe and unsupported URLs', () => {
	for (const value of [
		'http://mega.nz/file/id#key',
		'https://user:password@mega.nz/file/id#key',
		'https://mega.nz.evil.test/file/id#key',
		'https://example.test/file/id#key',
		'https://mega.nz/folder/id#key',
		'https://mega.nz/file/id',
		'https://mega.nz/file/id/extra#key',
		'https://mega.nz/#F!id!key',
	]) {
		assert.throws(() => normalizeMegaFileLink(value), (error) => {
			assert.equal(error.code, 'INVALID_INPUT');
			assert.doesNotMatch(error.message, /key/);
			return true;
		});
	}
});

test('sidecar unavailability falls back exactly once', async () => {
	let fallbackCalls = 0;
	const service = createMegaDownloadService({
		client: {
			streamResolved: async () => {
				throw new MegaBasterdError('UNAVAILABLE', 'Sidecar unavailable', { fallbackEligible: true });
			},
		},
		fallbackEnabled: true,
	});
	const stream = await service.streamResolved({ downloadUrl: 'https://signed.example/file' }, {
		fallback: async () => {
			fallbackCalls += 1;
			return Readable.from(['fallback']);
		},
	});

	assert.equal(await read(stream), 'fallback');
	assert.equal(fallbackCalls, 1);
});

test('quota is terminal', async () => {
	const service = createMegaDownloadService({
		client: {
			streamResolved: async () => {
				throw new MegaBasterdError('QUOTA', 'MEGA quota exhausted', { fallbackEligible: false });
			},
		},
	});

	await assert.rejects(service.streamResolved({}, {
		fallback: async () => { throw new Error('fallback must not run'); },
	}), /quota/i);
});

test('fallback can be disabled for eligible initial sidecar errors', async () => {
	let fallbackCalls = 0;
	const unavailable = new MegaBasterdError('UNAVAILABLE', 'Sidecar unavailable', { fallbackEligible: true });
	const service = createMegaDownloadService({
		client: { streamResolved: async () => { throw unavailable; } },
		fallbackEnabled: false,
	});

	await assert.rejects(service.streamResolved({}, {
		fallback: async () => { fallbackCalls += 1; },
	}), unavailable);
	assert.equal(fallbackCalls, 0);
});

test('a primary stream error after return never opens fallback', async () => {
	let fallbackCalls = 0;
	const primary = new Readable({ read() {} });
	const service = createMegaDownloadService({
		client: { streamResolved: async () => primary },
	});
	const stream = await service.streamResolved({}, {
		fallback: async () => {
			fallbackCalls += 1;
			return Readable.from(['fallback']);
		},
	});
	const errorEvent = once(stream, 'error');
	stream.destroy(new Error('mid-stream failure'));
	const [error] = await errorEvent;

	assert.match(error.message, /mid-stream/);
	assert.equal(fallbackCalls, 0);
});

test('public fallback uses canonical URL, metadata and requested byte range', async () => {
	let receivedUrl;
	let downloadRange;
	const file = {
		name: 'notes.txt',
		size: 12,
		loadAttributes: async () => file,
		download: (range) => {
			downloadRange = range;
			return Readable.from(['hello']);
		},
	};
	class FakeMegaFile {
		static fromURL(url) {
			receivedUrl = url;
			return file;
		}
	}
	const unavailable = new MegaBasterdError('UNAVAILABLE', 'Sidecar unavailable', { fallbackEligible: true });
	const service = createMegaDownloadService({
		client: {
			inspectPublic: async () => { throw unavailable; },
			streamPublic: async () => { throw unavailable; },
		},
		MegaFile: FakeMegaFile,
		logger: { warn() {} },
	});

	assert.deepEqual(await service.inspectPublic('https://www.mega.co.nz/file/id#secret'), {
		file_name: 'notes.txt',
		size: 12,
		mime_type: 'text/plain',
	});
	assert.equal(receivedUrl, 'https://mega.nz/file/id#secret');
	assert.equal(await read(await service.streamPublic('https://mega.nz/file/id#secret', {
		range: { start: 2, end: 6 },
	})), 'hello');
	assert.deepEqual(downloadRange, { start: 2, end: 6 });
});

test('sidecar public metadata derives MIME type from the file name', async () => {
	const service = createMegaDownloadService({
		client: {
			inspectPublic: async () => ({
				file_name: 'archive.zip',
				size: 99,
				mime_type: 'application/octet-stream',
			}),
		},
	});

	assert.deepEqual(await service.inspectPublic('https://mega.nz/file/id#secret'), {
		file_name: 'archive.zip',
		size: 99,
		mime_type: 'application/zip',
	});
});

test('MegaBasterd environment exposes only safe configuration status', () => {
	assert.equal(env.megaBasterdUrl, process.env.MEGABASTERD_URL || 'http://megabasterd:8788');
	assert.ok(env.megaBasterdTimeoutMs >= 1000);
	assert.equal(env.megaBasterdFallbackEnabled, process.env.MEGABASTERD_FALLBACK_ENABLED !== 'false');
	assert.deepEqual(
		{
			url: redactEnv().megaBasterdUrl,
			timeout: redactEnv().megaBasterdTimeoutMs,
			fallback: redactEnv().megaBasterdFallbackEnabled,
			secret: redactEnv().megaBasterdSecret,
		},
		{
			url: env.megaBasterdUrl,
			timeout: env.megaBasterdTimeoutMs,
			fallback: env.megaBasterdFallbackEnabled,
			secret: env.megaBasterdSecret ? '[configured]' : '[missing]',
		},
	);
});

test('MegaBasterd environment redaction treats whitespace-only secret as missing', () => {
	const previous = env.megaBasterdSecret;
	try {
		env.megaBasterdSecret = '   ';
		assert.equal(redactEnv().megaBasterdSecret, '[missing]');
	} finally {
		env.megaBasterdSecret = previous;
	}
});
