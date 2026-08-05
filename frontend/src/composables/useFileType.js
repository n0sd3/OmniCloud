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
import {
	extensionOf, previewTypeFor, IMAGE_EXTENSIONS, VIDEO_EXTENSIONS, AUDIO_EXTENSIONS,
	THUMBNAIL_DOCUMENT_EXTENSIONS, THUMBNAIL_TEXT_EXTENSIONS, THUMBNAIL_VIDEO_EXTENSIONS,
} from '@omnicloud/shared';

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

const DOCUMENT_EXTENSIONS = new Set(['csv', 'doc', 'docx', 'json', 'odp', 'ods', 'odt', 'pdf', 'ppt', 'pptx', 'txt', 'xls', 'xlsx']);

// Nativos do Google chegam pela rota de preview ja convertidos (Docs viram PDF,
// Sheets/Slides viram Office e o backend converte para PDF, Drawings viram PNG,
// Scripts viram JSON).
const GOOGLE_PREVIEW_TYPES = {
	'application/vnd.google-apps.document': 'pdf',
	'application/vnd.google-apps.spreadsheet': 'office',
	'application/vnd.google-apps.presentation': 'office',
	'application/vnd.google-apps.drawing': 'image',
	'application/vnd.google-apps.script': 'text',
};

export function getFileCategory(file) {
	if (file.is_folder) return 'folder';
	const mimeType = (file.mime_type || file.mimeType || '').toLowerCase();
	const extension = extensionOf(file.display_name || file.file_name || '');

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

	return previewTypeFor({ mimeType, extension: extensionOf(file.display_name || file.file_name || '') });
}

// I3: nao usa getFileCategory/DOCUMENT_EXTENSIONS (mais amplo, inclui csv por
// exemplo) porque isso oferecia miniatura para tipos que o backend recusa com
// 415. Imagem continua liberada porque o consumidor com imagem real usa
// api.previewUrl, nunca api.thumbnailUrl; os demais tem que bater exatamente
// com o que getThumbnailKind sabe gerar.
export function canShowGridThumbnail(file) {
	if (!file || file.is_folder) return false;
	const mimeType = (file.mime_type || file.mimeType || '').toLowerCase();
	const extension = extensionOf(file.display_name || file.file_name || '');

	if (mimeType.startsWith('image/') || IMAGE_EXTENSIONS.has(extension)) return true;
	if (mimeType.startsWith('video/') || THUMBNAIL_VIDEO_EXTENSIONS.has(extension)) return true;
	if (mimeType === 'application/pdf' || extension === 'pdf') return true;
	if (
		THUMBNAIL_DOCUMENT_EXTENSIONS.has(extension)
		|| mimeType.includes('document')
		|| mimeType.includes('word')
		|| mimeType.includes('sheet')
		|| mimeType.includes('excel')
		|| mimeType.includes('presentation')
		|| mimeType.includes('powerpoint')
		|| mimeType.includes('opendocument')
	) return true;
	if (mimeType.startsWith('text/') || mimeType === 'application/json' || THUMBNAIL_TEXT_EXTENSIONS.has(extension)) return true;

	return false;
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
