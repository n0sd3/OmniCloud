import assert from 'node:assert/strict';
import test from 'node:test';
import { canShowGridThumbnail, getFileCategory } from '../src/composables/useFileType.js';
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
// funciona". PreviewThumbStrip e FileListGridCard roteiam por
// getFileCategory(file) === 'image' para api.previewUrl, e caem para
// api.thumbnailUrl (que so serve o que getThumbnailKind sabe gerar) em
// qualquer outro caso. Entao o invariante real e: toda fixture onde
// canShowGridThumbnail promete uma miniatura tem que ter uma dessas duas
// fontes de fato funcionando — nao basta ser imagem "de olho nu".
test('every file canShowGridThumbnail approves has a working thumbnail source', () => {
	for (const file of FIXTURES.filter((f) => canShowGridThumbnail(f))) {
		const routesToPreviewUrl = getFileCategory(file) === 'image';
		const backendSupportsThumbnail = Boolean(getThumbnailKind(file));
		assert.ok(routesToPreviewUrl || backendSupportsThumbnail, file.file_name);
	}
});

test('non-image files: canShowGridThumbnail agrees exactly with getThumbnailKind', () => {
	for (const file of FIXTURES.filter((file) => !isImage(file))) {
		const canShow = canShowGridThumbnail(file);
		const backendSupports = Boolean(getThumbnailKind(file));
		assert.equal(canShow, backendSupports, file.file_name);
	}
});
