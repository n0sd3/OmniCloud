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

// canShowGridThumbnail promete "este arquivo tem uma fonte de imagem que
// funciona". Para imagens essa fonte e api.previewUrl (PreviewThumbStrip e
// FileListGridCard roteiam assim), nunca a rota /thumbnail — entao nao faz
// sentido comparar imagem contra getThumbnailKind, que nunca tem branch de
// imagem. Para o resto, a fonte e mesmo api.thumbnailUrl e por isso essa
// parte tem que bater exatamente com getThumbnailKind.
test('images can show a thumbnail without depending on getThumbnailKind', () => {
	for (const file of FIXTURES.filter(isImage)) {
		assert.equal(canShowGridThumbnail(file), true, file.file_name);
	}
});

test('non-image files: canShowGridThumbnail agrees exactly with getThumbnailKind', () => {
	for (const file of FIXTURES.filter((file) => !isImage(file))) {
		const canShow = canShowGridThumbnail(file);
		const backendSupports = Boolean(getThumbnailKind(file));
		assert.equal(canShow, backendSupports, file.file_name);
	}
});
