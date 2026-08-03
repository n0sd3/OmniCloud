import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';

const { googleDocsExport, exportedFileName } = await import('../src/utils/mime.js');
const { GoogleDriveAdapter } = await import('../src/adapters/GoogleDriveAdapter.js');

function createAdapter(driveCalls) {
	const adapter = new GoogleDriveAdapter({ provider: 'google_drive' });
	adapter.getDriveClient = async () => ({
		files: {
			async export(params) {
				driveCalls.push(['export', params]);
				return { data: Readable.from(['pdf-bytes']) };
			},
			async get(params) {
				driveCalls.push(['get', params]);
				return { data: Readable.from(['binary-bytes']) };
			},
		},
	});
	return adapter;
}

async function read(stream) {
	const chunks = [];
	for await (const chunk of stream) chunks.push(chunk);
	return chunks.join('');
}

test('googleDocsExport mapeia apenas tipos nativos do Google', () => {
	assert.deepEqual(googleDocsExport({ mime_type: 'application/vnd.google-apps.document' }), {
		mimeType: 'application/pdf',
		extension: 'pdf',
	});
	assert.equal(googleDocsExport({ mime_type: 'image/png' }), null);
	assert.equal(googleDocsExport({ mime_type: 'application/vnd.google-apps.folder' }), null);
	assert.equal(googleDocsExport(null), null);
});

test('exportedFileName nao duplica extensao existente', () => {
	assert.equal(exportedFileName('Contrato', 'pdf'), 'Contrato.pdf');
	assert.equal(exportedFileName('Contrato.PDF', 'pdf'), 'Contrato.PDF');
});

test('download de Google Doc usa files.export com o mime alvo', async () => {
	const calls = [];
	const adapter = createAdapter(calls);

	const stream = await adapter.getDownloadStream({
		remote_file_id: 'doc-1',
		mime_type: 'application/vnd.google-apps.document',
	});

	assert.equal(await read(stream), 'pdf-bytes');
	assert.deepEqual(calls, [['export', { fileId: 'doc-1', mimeType: 'application/pdf' }]]);
});

test('download de arquivo binario continua usando alt=media', async () => {
	const calls = [];
	const adapter = createAdapter(calls);

	const stream = await adapter.getDownloadStream({ remote_file_id: 'bin-1', mime_type: 'image/png' });

	assert.equal(await read(stream), 'binary-bytes');
	assert.equal(calls[0][0], 'get');
	assert.equal(calls[0][1].alt, 'media');
});
