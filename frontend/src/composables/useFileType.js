import {
	IconArchiveFilled,
	IconFileDescription,
	IconFileDescriptionFilled,
	IconFileMusicFilled,
	IconFileText,
	IconFileTextFilled,
	IconFileZip,
	IconFolder,
	IconFolderFilled,
	IconMusic,
	IconPhoto,
	IconPhotoFilled,
	IconVideo,
	IconVideoFilled,
} from '@tabler/icons-vue';

const ICON_FACTORY = {
	folder: { filled: IconFolderFilled, outline: IconFolder },
	image: { filled: IconPhotoFilled, outline: IconPhoto },
	video: { filled: IconVideoFilled, outline: IconVideo },
	audio: { filled: IconFileMusicFilled, outline: IconMusic },
	archive: { filled: IconArchiveFilled, outline: IconFileZip },
	document: { filled: IconFileTextFilled, outline: IconFileText },
	other: { filled: IconFileDescriptionFilled, outline: IconFileDescription },
	all: { filled: IconFileDescriptionFilled, outline: IconFileDescription },
};

const IMAGE_EXTENSIONS = new Set(['avif', 'bmp', 'gif', 'heic', 'jpeg', 'jpg', 'png', 'svg', 'webp']);
const VIDEO_EXTENSIONS = new Set(['avi', 'm4v', 'mkv', 'mov', 'mp4', 'webm']);
const AUDIO_EXTENSIONS = new Set(['aac', 'flac', 'm4a', 'mp3', 'ogg', 'wav']);
const DOCUMENT_EXTENSIONS = new Set(['csv', 'doc', 'docx', 'json', 'odp', 'ods', 'odt', 'pdf', 'ppt', 'pptx', 'txt', 'xls', 'xlsx']);
const OFFICE_EXTENSIONS = new Set(['doc', 'docx', 'odp', 'ods', 'odt', 'ppt', 'pptx', 'xls', 'xlsx']);
const TEXT_EXTENSIONS = new Set(['csv', 'json', 'log', 'md', 'txt', 'xml', 'yaml', 'yml']);

// Nativos do Google chegam pela rota de preview ja convertidos (Docs viram PDF,
// Sheets/Slides viram Office e o backend converte para PDF, Drawings viram PNG,
// Scripts viram JSON).
const GOOGLE_PREVIEW_TYPES = {
	'application/vnd.google-apps.document': 'pdf',
	'application/vnd.google-apps.spreadsheet': 'pdf',
	'application/vnd.google-apps.presentation': 'pdf',
	'application/vnd.google-apps.drawing': 'image',
	'application/vnd.google-apps.script': 'text',
};

function getFileExtension(file) {
	const source = file.display_name || file.file_name || '';
	const parts = source.toLowerCase().split('.');
	return parts.length > 1 ? parts.at(-1) : '';
}

export function getFileCategory(file) {
	if (file.is_folder) return 'folder';
	const mimeType = (file.mime_type || file.mimeType || '').toLowerCase();
	const extension = getFileExtension(file);

	if (mimeType.startsWith('image/') || IMAGE_EXTENSIONS.has(extension)) return 'image';
	if (mimeType.startsWith('video/') || VIDEO_EXTENSIONS.has(extension)) return 'video';
	if (mimeType.startsWith('audio/') || AUDIO_EXTENSIONS.has(extension)) return 'audio';
	if (
		mimeType.includes('zip') ||
		mimeType.includes('rar') ||
		mimeType.includes('7z') ||
		mimeType.includes('tar') ||
		['zip', 'rar', '7z', 'tar', 'gz'].includes(extension)
	) {
		return 'archive';
	}
	if (
		mimeType === 'application/pdf' ||
		mimeType.startsWith('text/') ||
		mimeType.includes('document') ||
		mimeType.includes('word') ||
		mimeType.includes('sheet') ||
		mimeType.includes('excel') ||
		mimeType.includes('presentation') ||
		mimeType.includes('powerpoint') ||
		mimeType === 'application/json' ||
		DOCUMENT_EXTENSIONS.has(extension)
	) {
		return 'document';
	}

	return 'other';
}

export function getPreviewType(file) {
	if (!file || file.is_folder) return null;

	const mimeType = (file.mime_type || file.mimeType || '').toLowerCase();
	if (GOOGLE_PREVIEW_TYPES[mimeType]) return GOOGLE_PREVIEW_TYPES[mimeType];

	const extension = getFileExtension(file);
	if (mimeType.startsWith('image/') || IMAGE_EXTENSIONS.has(extension)) return 'image';
	if (mimeType.startsWith('video/') || VIDEO_EXTENSIONS.has(extension)) return 'video';
	if (mimeType.startsWith('audio/') || AUDIO_EXTENSIONS.has(extension)) return 'audio';
	if (mimeType === 'application/pdf' || extension === 'pdf') return 'pdf';
	if (
		OFFICE_EXTENSIONS.has(extension)
		|| mimeType.includes('officedocument')
		|| mimeType.includes('opendocument')
		|| mimeType.includes('msword')
		|| mimeType.includes('ms-excel')
		|| mimeType.includes('ms-powerpoint')
	) return 'pdf';
	if (mimeType.startsWith('text/') || mimeType === 'application/json' || TEXT_EXTENSIONS.has(extension)) return 'text';

	return null;
}

export function canShowGridThumbnail(file) {
	return Boolean(file && !file.is_folder && ['image', 'video', 'document'].includes(getFileCategory(file)));
}

export function getFileIcon(file, filled = false) {
	const category = file.is_folder ? 'folder' : getFileCategory(file);
	const entry = ICON_FACTORY[category] || ICON_FACTORY.document;
	return filled ? entry.filled : entry.outline;
}

export function getTypeFilterIcon(value, filled = false) {
	const entry = ICON_FACTORY[value] || ICON_FACTORY.all;
	return filled ? entry.filled : entry.outline;
}
