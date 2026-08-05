import { extensionOf } from '@omnicloud/shared';

const LANGUAGES = {
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
