import { extensionOf } from '@omnicloud/shared';

export const LANGUAGES = {
	bash: 'bash', c: 'c', cc: 'cpp', cpp: 'cpp', cs: 'csharp', css: 'css', go: 'go',
	h: 'c', hpp: 'cpp', html: 'xml', ini: 'ini', java: 'java', js: 'javascript',
	json: 'json', jsx: 'javascript', kt: 'kotlin', lua: 'lua', php: 'php', pl: 'perl',
	py: 'python', rb: 'ruby', rs: 'rust', scss: 'scss', sh: 'bash', sql: 'sql',
	swift: 'swift', toml: 'ini', ts: 'typescript', tsx: 'typescript', vue: 'xml',
	xml: 'xml', yaml: 'yaml', yml: 'yaml', zsh: 'bash',
};

export function languageOf(name) {
	return LANGUAGES[extensionOf(name)] || '';
}

export function isMarkdown(name) {
	return ['md', 'markdown'].includes(extensionOf(name));
}

export function isCsv(name) {
	return extensionOf(name) === 'csv';
}

const SAFE_URL_PROTOCOL = /^(https?:|mailto:)/i;

function isSafeUrl(value) {
	// Caracteres de controle (tab, newline) escondem "java\nscript:" do regex:
	// remove-los antes de checar o protocolo.
	const cleaned = String(value || '').replace(/[\x00-\x20]+/g, '');
	return cleaned.startsWith('#') || SAFE_URL_PROTOCOL.test(cleaned);
}

function sanitizeAttr(html, attr) {
	return html.replace(new RegExp(`${attr}="([^"]*)"`, 'gi'), (match, value) => (
		isSafeUrl(value) ? match : `${attr}="#"`
	));
}

// C1: marked v5+ nao filtra mais o protocolo javascript: em href/src, e o
// escape de & e < so deixa tags inertes, nao limpa atributos que o proprio
// parser gera a partir de um link/imagem markdown. Extraida do componente
// porque logica de seguranca dentro de .vue nao e testavel.
export function renderMarkdown(body, parse) {
	// So < precisa ser escapado para inutilizar tags: > sobrando nao abre nada
	// e escapa-lo desativava blockquote (`> texto`) a toa.
	const escaped = String(body || '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
	const html = parse(escaped, { breaks: true });
	return sanitizeAttr(sanitizeAttr(html, 'href'), 'src');
}

// ponytail: parser proprio de ~20 linhas em vez de dependencia de CSV. Se
// aparecer separador ponto-e-virgula ou encoding exotico, trocar por papaparse.
export function parseCsv(text) {
	const body = String(text || '').trim();
	if (!body) return { header: [], rows: [] };

	const table = [];
	let row = [];
	let field = '';
	let quoted = false;

	for (let i = 0; i < body.length; i += 1) {
		const char = body[i];
		if (quoted) {
			if (char === '"' && body[i + 1] === '"') { field += '"'; i += 1; continue; }
			if (char === '"') { quoted = false; continue; }
			field += char;
			continue;
		}
		if (char === '"') { quoted = true; continue; }
		if (char === ',') { row.push(field); field = ''; continue; }
		if (char === '\n') { row.push(field); table.push(row); row = []; field = ''; continue; }
		if (char === '\r') continue;
		field += char;
	}
	row.push(field);
	table.push(row);

	return { header: table[0] || [], rows: table.slice(1) };
}
