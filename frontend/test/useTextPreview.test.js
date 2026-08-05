import assert from 'node:assert/strict';
import test from 'node:test';
import { LANGUAGES, isCsv, isMarkdown, languageOf, parseCsv, renderMarkdown } from '../src/composables/useTextPreview.js';

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

test('parseCsv on a ragged row keeps the row shorter than the header (cells misalign under the wrong column)', () => {
	const { header, rows } = parseCsv('name,city,age\nAna,Recife');

	assert.deepEqual(header, ['name', 'city', 'age']);
	assert.deepEqual(rows, [['Ana', 'Recife']]);
});

test('parseCsv on a trailing newline does not emit a trailing empty row', () => {
	const { header, rows } = parseCsv('name,city\nAna,Recife\n');

	assert.deepEqual(header, ['name', 'city']);
	assert.deepEqual(rows, [['Ana', 'Recife']]);
});

test('renderMarkdown neutralizes a javascript: link', async () => {
	const { marked } = await import('marked');
	const html = renderMarkdown("[Open report](javascript:fetch('/api/files'))", marked.parse);

	assert.doesNotMatch(html, /javascript:/i);
	assert.match(html, /<a href="#">Open report<\/a>/);
});

test('renderMarkdown neutralizes a javascript: image src', async () => {
	const { marked } = await import('marked');
	const html = renderMarkdown('![a](javascript:alert(1))', marked.parse);

	assert.doesNotMatch(html, /javascript:/i);
	assert.match(html, /src="#"/);
});

test('renderMarkdown keeps an https: link intact', async () => {
	const { marked } = await import('marked');
	const html = renderMarkdown('[Site](https://example.com)', marked.parse);

	assert.match(html, /href="https:\/\/example\.com"/);
});

test('renderMarkdown renders a script tag as visible text, not an element', async () => {
	const { marked } = await import('marked');
	const html = renderMarkdown('<script>alert(1)</script>', marked.parse);

	assert.doesNotMatch(html, /<script>/i);
	assert.match(html, /&lt;script&gt;/);
});

test('renderMarkdown still renders a blockquote', async () => {
	const { marked } = await import('marked');
	const html = renderMarkdown('> quoted', marked.parse);

	assert.match(html, /<blockquote>/);
});

test('every mapped language is registered in highlight.js/lib/common', async () => {
	const hljs = (await import('highlight.js/lib/common')).default;
	const supported = new Set(hljs.listLanguages());

	for (const value of Object.values(LANGUAGES)) {
		assert.ok(supported.has(value), `${value} is missing from highlight.js/lib/common`);
	}
});
