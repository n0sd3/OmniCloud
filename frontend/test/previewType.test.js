import assert from 'node:assert/strict';
import test from 'node:test';
import { getPreviewType } from '../src/composables/useFileType.js';
import { getPreviewKind } from '../../backend/src/services/previewService.js';

const FIXTURES = [
	{ file_name: 'photo.jpg', mime_type: 'image/jpeg' },
	{ file_name: 'photo.heic', mime_type: 'application/octet-stream' },
	{ file_name: 'clip.mp4', mime_type: 'video/mp4' },
	{ file_name: 'song.mp3', mime_type: 'audio/mpeg' },
	{ file_name: 'report.pdf', mime_type: 'application/pdf' },
	{ file_name: 'letter.docx', mime_type: 'application/octet-stream' },
	{ file_name: 'sheet.ods', mime_type: 'application/vnd.oasis.opendocument.spreadsheet' },
	{ file_name: 'notes.txt', mime_type: 'text/plain' },
	{ file_name: 'data.json', mime_type: 'application/json' },
	{ file_name: 'archive.zip', mime_type: 'application/zip' },
	{ file_name: 'folder', is_folder: true },
	{ file_name: 'Doc', mime_type: 'application/vnd.google-apps.document' },
	{ file_name: 'Budget', mime_type: 'application/vnd.google-apps.spreadsheet' },
	{ file_name: 'Deck', mime_type: 'application/vnd.google-apps.presentation' },
	{ file_name: 'Sketch', mime_type: 'application/vnd.google-apps.drawing' },
	{ file_name: 'Macro', mime_type: 'application/vnd.google-apps.script' },
];

test('getPreviewType agrees with the backend, mapping office to pdf', () => {
	for (const file of FIXTURES) {
		// office chega ao cliente ja convertido em PDF pela rota de preview.
		const kind = getPreviewKind(file);
		const expected = kind === 'office' ? 'pdf' : kind;
		assert.equal(getPreviewType(file), expected, file.file_name);
	}
});

test('getPreviewType rejects what has no renderer', () => {
	assert.equal(getPreviewType({ file_name: 'archive.zip', mime_type: 'application/zip' }), null);
	assert.equal(getPreviewType({ file_name: 'setup.exe', mime_type: 'application/x-msdownload' }), null);
	assert.equal(getPreviewType(null), null);
});
