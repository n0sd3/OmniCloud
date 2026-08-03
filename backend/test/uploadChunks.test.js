import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

process.env.DATABASE_PATH = path.join(os.tmpdir(), `omnicloud-test-${process.pid}.db`);

const { handleChunk, needsChunkedUpload } = await import('../src/services/uploadService.js');
const { createUploadSession } = await import('../src/services/uploadSessionService.js');

const USER_ID = 'test-user';

function fakeRequest(body) {
	const stream = Readable.from([Buffer.from(body)]);
	stream.user = { id: USER_ID };
	stream.headers = {};
	return stream;
}

function newSession(size) {
	return createUploadSession({
		user_id: USER_ID,
		file_name: 'big.bin',
		size,
		mime_type: 'application/octet-stream',
		virtual_path: '/',
		remote_parent_id: null,
		cloud_account_id: 'account-1',
		fallback_chain: [],
	});
}

// Coleta o stream que o adapter receberia e devolve o conteúdo remontado.
function collectingUpload() {
	return ({ stream, fileName }) => new Promise((resolve, reject) => {
		const parts = [];
		stream.on('data', (part) => parts.push(part));
		stream.on('end', () => resolve({ fileName, body: Buffer.concat(parts).toString() }));
		stream.on('error', reject);
	});
}

test('chunks sequenciais remontam o arquivo original', async () => {
	const chunks = ['alpha-', 'beta-', 'gamma'];
	const session = newSession(chunks.join('').length);
	const upload = collectingUpload();
	let result = null;

	for (const [index, chunk] of chunks.entries()) {
		result = await handleChunk(fakeRequest(chunk), session.id, {
			index,
			isLast: index === chunks.length - 1,
			fileName: 'big.bin',
			mimeType: 'application/octet-stream',
			upload,
		});
	}

	assert.deepEqual(await result, { fileName: 'big.bin', body: 'alpha-beta-gamma' });
});

test('chunk fora de ordem aborta o upload', async () => {
	const session = newSession(10);
	const upload = collectingUpload();

	await handleChunk(fakeRequest('alpha-'), session.id, { index: 0, isLast: false, upload });

	await assert.rejects(
		handleChunk(fakeRequest('gamma'), session.id, { index: 2, isLast: true, upload }),
		/Invalid chunk order: expected 1, received 2/,
	);
});

test('primeiro chunk com índice diferente de zero é recusado', async () => {
	const session = newSession(10);

	await assert.rejects(
		handleChunk(fakeRequest('beta-'), session.id, { index: 1, isLast: false, upload: collectingUpload() }),
		/upload was not started/,
	);
});

test('sessão inexistente é recusada', async () => {
	await assert.rejects(
		handleChunk(fakeRequest('alpha-'), 'no-such-session', { index: 0, isLast: true }),
		/Upload session not found/,
	);
});

test('needsChunkedUpload só dispara atrás da Cloudflare', () => {
	const big = 200 * 1024 * 1024;
	assert.equal(needsChunkedUpload({ headers: { 'cf-ray': 'abc' } }, big), true);
	assert.equal(needsChunkedUpload({ headers: {} }, big), false);
	assert.equal(needsChunkedUpload({ headers: { 'cf-ray': 'abc' } }, 1024), false);
});
