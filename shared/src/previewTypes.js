// Mapa unico de tipo de preview. Front e back importam daqui: as duas listas
// separadas divergiam em silencio e era isso que fazia o docx abrir em branco.

export const IMAGE_EXTENSIONS = new Set(['avif', 'bmp', 'gif', 'heic', 'jpeg', 'jpg', 'png', 'svg', 'tif', 'tiff', 'webp']);
export const VIDEO_EXTENSIONS = new Set(['avi', 'm4v', 'mkv', 'mov', 'mp4', 'webm']);
export const AUDIO_EXTENSIONS = new Set(['aac', 'flac', 'm4a', 'mp3', 'ogg', 'wav']);
export const OFFICE_EXTENSIONS = new Set(['doc', 'docx', 'odp', 'ods', 'odt', 'ppt', 'pptx', 'xls', 'xlsx']);
export const TEXT_EXTENSIONS = new Set(['csv', 'json', 'log', 'md', 'txt', 'xml', 'yaml', 'yml']);

export function extensionOf(name) {
	const parts = String(name || '').toLowerCase().split('.');
	return parts.length > 1 ? parts.at(-1) : '';
}

export function previewTypeFor({ mimeType = '', extension = '' } = {}) {
	const mime = String(mimeType).toLowerCase();
	const ext = String(extension).toLowerCase().replace(/^\./, '');

	if (mime.startsWith('image/') || IMAGE_EXTENSIONS.has(ext)) return 'image';
	if (mime.startsWith('video/') || VIDEO_EXTENSIONS.has(ext)) return 'video';
	if (mime.startsWith('audio/') || AUDIO_EXTENSIONS.has(ext)) return 'audio';
	if (mime === 'application/pdf' || ext === 'pdf') return 'pdf';
	if (
		OFFICE_EXTENSIONS.has(ext)
		|| mime.includes('officedocument')
		|| mime.includes('opendocument')
		|| mime.includes('msword')
		|| mime.includes('ms-excel')
		|| mime.includes('ms-powerpoint')
	) return 'office';
	if (mime.startsWith('text/') || mime === 'application/json' || TEXT_EXTENSIONS.has(ext)) return 'text';

	return null;
}
