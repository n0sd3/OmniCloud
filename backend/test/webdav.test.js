import assert from 'node:assert/strict';
import test from 'node:test';

const { parseRangeHeader, parseDavPath, buildPropfindXml, toHttpDate } = await import(
	'../src/services/webdav.js'
);

test('parseRangeHeader lê intervalo fechado', () => {
	assert.deepEqual(parseRangeHeader('bytes=0-499', 1000), { start: 0, end: 499 });
});

test('parseRangeHeader lê intervalo aberto no fim', () => {
	assert.deepEqual(parseRangeHeader('bytes=500-', 1000), { start: 500, end: 999 });
});

test('parseRangeHeader lê sufixo como bytes finais', () => {
	assert.deepEqual(parseRangeHeader('bytes=-500', 1000), { start: 500, end: 999 });
});

test('parseRangeHeader trunca fim maior que o arquivo', () => {
	assert.deepEqual(parseRangeHeader('bytes=0-99999', 1000), { start: 0, end: 999 });
});

test('parseRangeHeader devolve null para header ausente ou inválido', () => {
	assert.equal(parseRangeHeader(undefined, 1000), null);
	assert.equal(parseRangeHeader('items=0-10', 1000), null);
	assert.equal(parseRangeHeader('bytes=abc', 1000), null);
});

test('parseRangeHeader devolve null quando start passa do fim', () => {
	assert.equal(parseRangeHeader('bytes=2000-', 1000), null);
});

test('parseDavPath resolve a raiz', () => {
	assert.deepEqual(parseDavPath('/webdav/'), { parentPath: '/', name: null });
	assert.deepEqual(parseDavPath('/webdav'), { parentPath: '/', name: null });
});

test('parseDavPath resolve item na raiz', () => {
	assert.deepEqual(parseDavPath('/webdav/Fotos'), { parentPath: '/', name: 'Fotos' });
});

test('parseDavPath resolve item aninhado', () => {
	assert.deepEqual(parseDavPath('/webdav/Fotos/2024/a.jpg'), {
		parentPath: '/Fotos/2024/',
		name: 'a.jpg',
	});
});

test('parseDavPath decodifica percent-encoding', () => {
	assert.deepEqual(parseDavPath('/webdav/Minhas%20Fotos/f%C3%A9rias.jpg'), {
		parentPath: '/Minhas Fotos/',
		name: 'férias.jpg',
	});
});

test('parseDavPath ignora barra final de pasta', () => {
	assert.deepEqual(parseDavPath('/webdav/Fotos/2024/'), { parentPath: '/Fotos/', name: '2024' });
});

test('parseDavPath rejeita travessia de diretório', () => {
	assert.throws(() => parseDavPath('/webdav/../etc/passwd'), /Invalid WebDAV path/);
});

test('buildPropfindXml marca pasta como collection', () => {
	const xml = buildPropfindXml([
		{ href: '/webdav/Fotos/', isFolder: true, displayName: 'Fotos', modifiedTime: null },
	]);

	assert.match(xml, /<D:multistatus xmlns:D="DAV:">/);
	assert.match(xml, /<D:collection\/>/);
	assert.match(xml, /<D:href>\/webdav\/Fotos\/<\/D:href>/);
	assert.doesNotMatch(xml, /getcontentlength/);
});

test('buildPropfindXml emite tamanho e tipo para arquivo', () => {
	const xml = buildPropfindXml([
		{
			href: '/webdav/a.jpg',
			isFolder: false,
			displayName: 'a.jpg',
			size: 2048,
			mimeType: 'image/jpeg',
			modifiedTime: '2026-08-02T10:00:00.000Z',
		},
	]);

	assert.match(xml, /<D:getcontentlength>2048<\/D:getcontentlength>/);
	assert.match(xml, /<D:getcontenttype>image\/jpeg<\/D:getcontenttype>/);
	assert.match(xml, /<D:getlastmodified>Sun, 02 Aug 2026 10:00:00 GMT<\/D:getlastmodified>/);
	assert.doesNotMatch(xml, /<D:collection\/>/);
});

test('buildPropfindXml escapa caracteres especiais de XML', () => {
	const xml = buildPropfindXml([
		{ href: '/webdav/a%20&%20b.txt', isFolder: false, displayName: 'a & b.txt', size: 1 },
	]);

	assert.match(xml, /<D:displayname>a &amp; b\.txt<\/D:displayname>/);
	assert.match(xml, /<D:href>\/webdav\/a%20&amp;%20b\.txt<\/D:href>/);
});

test('toHttpDate converte ISO para formato HTTP', () => {
	assert.equal(toHttpDate('2026-08-02T10:00:00.000Z'), 'Sun, 02 Aug 2026 10:00:00 GMT');
});

test('toHttpDate usa epoch para valor ausente', () => {
	assert.equal(toHttpDate(null), 'Thu, 01 Jan 1970 00:00:00 GMT');
});
