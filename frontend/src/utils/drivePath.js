// A pasta atual vive na URL (/my-drive/A/B), entao os segmentos sao a fonte da
// verdade e o botao voltar do sistema sobe um nivel em vez de sair do Drive.
// A codificacao percentual fica com o vue-router: aqui os segmentos sao crus.

export function pathToSegments(path) {
	return String(path || '').split('/').filter(Boolean);
}

export function segmentsToPath(segments) {
	const list = Array.isArray(segments) ? segments.filter(Boolean) : pathToSegments(segments);
	return list.length ? `/${list.join('/')}/` : '/';
}
