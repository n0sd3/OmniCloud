const MEGA_HOSTS = new Set(['mega.nz', 'www.mega.nz', 'mega.co.nz', 'www.mega.co.nz']);

export function looksLikeMegaFileLink(value) {
	try {
		const url = new URL(String(value || '').trim());
		if (url.protocol !== 'https:' || url.username || url.password || !MEGA_HOSTS.has(url.hostname.toLowerCase())) {
			return false;
		}

		return (/^\/file\/[^/]+$/.test(url.pathname) && url.hash.length > 1)
			|| /^#![^!]+![^!]+$/.test(url.hash);
	} catch {
		return false;
	}
}
