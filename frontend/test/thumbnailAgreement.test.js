import assert from 'node:assert/strict';
import test from 'node:test';
import { canShowGridThumbnail } from '../src/composables/useFileType.js';
import { getThumbnailKind } from '../../backend/src/services/thumbnailService.js';

const FIXTURES = [
	{ file_name: 'photo.jpg', mime_type: 'image/jpeg' },
	{ file_name: 'clip.mp4', mime_type: 'video/mp4' },
	{ file_name: 'report.pdf', mime_type: 'application/pdf' },
	{ file_name: 'letter.docx', mime_type: 'application/octet-stream' },
	{ file_name: 'sheet.ods', mime_type: 'application/vnd.oasis.opendocument.spreadsheet' },
	{ file_name: 'notes.txt', mime_type: 'text/plain' },
	{ file_name: 'data.json', mime_type: 'application/json' },
	// Regressao I3: mime generico + extensao que so o front classificava como
	// "documento" (DOCUMENT_EXTENSIONS local inclui csv, getThumbnailKind nao).
	{ file_name: 'data.csv', mime_type: 'application/octet-stream' },
	{ file_name: 'song.mp3', mime_type: 'audio/mpeg' },
	{ file_name: 'archive.zip', mime_type: 'application/zip' },
	{ file_name: 'setup.exe', mime_type: 'application/x-msdownload' },
	{ file_name: 'folder', is_folder: true },
];

function isImage(file) {
	const mimeType = (file.mime_type || '').toLowerCase();
	return mimeType.startsWith('image/');
}

test('canShowGridThumbnail never claims a thumbnail the backend refuses', () => {
	for (const file of FIXTURES) {
		const canShow = canShowGridThumbnail(file);
		// Imagens nao passam por getThumbnailKind: o consumidor real usa
		// api.previewUrl para elas, nunca a rota /thumbnail.
		const backendSupports = isImage(file) || Boolean(getThumbnailKind(file));
		assert.equal(canShow, backendSupports, file.file_name);
	}
});
