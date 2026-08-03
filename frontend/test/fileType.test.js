import assert from 'node:assert/strict';
import test from 'node:test';
import { canShowGridThumbnail } from '../src/composables/useFileType.js';

test('canShowGridThumbnail accepts browser and generated cover formats', () => {
	const supported = [
		{ file_name: 'photo.jpg', mime_type: 'image/jpeg' },
		{ file_name: 'clip.mp4', mime_type: 'application/octet-stream' },
		{ file_name: 'report.pdf', mime_type: 'application/octet-stream' },
		{ file_name: 'letter.docx', mime_type: 'application/octet-stream' },
		{ file_name: 'sheet.ods', mime_type: 'application/octet-stream' },
		{ file_name: 'notes.txt', mime_type: 'text/plain' },
		{ file_name: 'data.json', mime_type: 'application/json' },
	];

	for (const file of supported) {
		assert.equal(canShowGridThumbnail(file), true, file.file_name);
	}
});

test('canShowGridThumbnail keeps unsupported items on their icons', () => {
	const unsupported = [
		{ file_name: 'folder', is_folder: true },
		{ file_name: 'song.mp3', mime_type: 'audio/mpeg' },
		{ file_name: 'archive.zip', mime_type: 'application/zip' },
		{ file_name: 'unknown.bin', mime_type: 'application/octet-stream' },
	];

	for (const file of unsupported) {
		assert.equal(canShowGridThumbnail(file), false, file.file_name);
	}
});
