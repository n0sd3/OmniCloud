import assert from 'node:assert/strict';
import test from 'node:test';
import { isCsv, isMarkdown, languageOf, parseCsv } from '../src/composables/useTextPreview.js';

test('languageOf maps known source extensions and ignores the rest', () => {
	assert.equal(languageOf('server.js'), 'javascript');
	assert.equal(languageOf('main.PY'), 'python');
	assert.equal(languageOf('query.sql'), 'sql');
	assert.equal(languageOf('notes.txt'), '');
	assert.equal(languageOf('README.md'), '');
});

test('isMarkdown and isCsv recognise their own files', () => {
	assert.equal(isMarkdown('README.md'), true);
	assert.equal(isMarkdown('readme.markdown'), true);
	assert.equal(isMarkdown('notes.txt'), false);
	assert.equal(isCsv('data.CSV'), true);
	assert.equal(isCsv('data.json'), false);
});

test('parseCsv splits rows and honours quoted fields', () => {
	const { header, rows } = parseCsv('name,city\n"Silva, Ana",Recife\nJoao,"Sao ""Paulo"""');

	assert.deepEqual(header, ['name', 'city']);
	assert.deepEqual(rows, [
		['Silva, Ana', 'Recife'],
		['Joao', 'Sao "Paulo"'],
	]);
});

test('parseCsv on empty input returns empty structures', () => {
	assert.deepEqual(parseCsv(''), { header: [], rows: [] });
});
