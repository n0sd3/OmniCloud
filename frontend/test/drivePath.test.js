import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToSegments, segmentsToPath } from '../src/utils/drivePath.js';

test('drive path handles root in both directions', () => {
	assert.deepEqual(pathToSegments('/'), []);
	assert.equal(segmentsToPath([]), '/');
	assert.equal(segmentsToPath(undefined), '/');
});

test('drive path round-trips a deep folder path', () => {
	const path = '/Fotos/2025/Viagem/';
	assert.deepEqual(pathToSegments(path), ['Fotos', '2025', 'Viagem']);
	assert.equal(segmentsToPath(pathToSegments(path)), path);
});

test('drive path preserves spaces and accents in folder names', () => {
	const path = '/Documentos Antigos/Não Lidos/';
	assert.deepEqual(pathToSegments(path), ['Documentos Antigos', 'Não Lidos']);
	assert.equal(segmentsToPath(pathToSegments(path)), path);
});

test('drive path normalizes duplicated and missing trailing slashes', () => {
	assert.equal(segmentsToPath(pathToSegments('//A//B')), '/A/B/');
	assert.equal(segmentsToPath(pathToSegments('/A/B')), '/A/B/');
});

test('drive path accepts a raw string in segmentsToPath', () => {
	assert.equal(segmentsToPath('/A/B/'), '/A/B/');
});
