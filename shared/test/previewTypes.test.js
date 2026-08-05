import assert from 'node:assert/strict';
import test from 'node:test';
import { extensionOf, previewTypeFor } from '../src/previewTypes.js';

test('extensionOf reads the last suffix, lowercased, without the dot', () => {
	assert.equal(extensionOf('Photo.JPG'), 'jpg');
	assert.equal(extensionOf('archive.tar.gz'), 'gz');
	assert.equal(extensionOf('Makefile'), '');
	assert.equal(extensionOf(''), '');
});

test('previewTypeFor classifies by mime first, extension second', () => {
	assert.equal(previewTypeFor({ mimeType: 'image/png' }), 'image');
	assert.equal(previewTypeFor({ extension: 'heic' }), 'image');
	assert.equal(previewTypeFor({ mimeType: 'video/mp4' }), 'video');
	assert.equal(previewTypeFor({ extension: 'mkv' }), 'video');
	assert.equal(previewTypeFor({ mimeType: 'audio/mpeg' }), 'audio');
	assert.equal(previewTypeFor({ mimeType: 'application/pdf' }), 'pdf');
	assert.equal(previewTypeFor({ extension: 'pdf' }), 'pdf');
	assert.equal(previewTypeFor({ extension: 'docx' }), 'office');
	assert.equal(previewTypeFor({ mimeType: 'application/msword' }), 'office');
	assert.equal(previewTypeFor({ mimeType: 'text/plain' }), 'text');
	assert.equal(previewTypeFor({ mimeType: 'application/json' }), 'text');
	assert.equal(previewTypeFor({ extension: 'yaml' }), 'text');
	assert.equal(previewTypeFor({}), null);
	assert.equal(previewTypeFor({ mimeType: 'application/octet-stream', extension: 'bin' }), null);
});

test('an office mime beats a generic octet-stream mime on the extension', () => {
	assert.equal(previewTypeFor({ mimeType: 'application/octet-stream', extension: 'xlsx' }), 'office');
});

test('tif/tiff are not classified as image yet, no backend conversion to render them', () => {
	assert.equal(previewTypeFor({ extension: 'tif' }), null);
	assert.equal(previewTypeFor({ mimeType: 'application/octet-stream', extension: 'tiff' }), null);
});
