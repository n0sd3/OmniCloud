import { Readable } from 'node:stream';

const FALLBACK_CODES = new Set(['UNAVAILABLE', 'TIMEOUT', 'UPSTREAM', 'UNSUPPORTED']);
const SAFE_CODES = new Set([
	'INVALID_INPUT',
	'NOT_FOUND',
	'QUOTA',
	'CANCELLED',
	'UNAUTHORIZED',
	'UNAVAILABLE',
	'TIMEOUT',
	'UPSTREAM',
	'UNSUPPORTED',
]);

const SAFE_MESSAGES = {
	INVALID_INPUT: 'Invalid MEGA transfer request',
	NOT_FOUND: 'MEGA file not found',
	QUOTA: 'MEGA quota exhausted',
	CANCELLED: 'MEGA transfer cancelled',
	UNAUTHORIZED: 'MegaBasterd authentication failed',
	UNAVAILABLE: 'MegaBasterd sidecar unavailable',
	TIMEOUT: 'MegaBasterd sidecar timed out',
	UPSTREAM: 'MegaBasterd upstream failure',
	UNSUPPORTED: 'MEGA transfer is unsupported',
};

export class MegaBasterdError extends Error {
	constructor(code, message = SAFE_MESSAGES[code] || SAFE_MESSAGES.UPSTREAM, { fallbackEligible = FALLBACK_CODES.has(code) } = {}) {
		super(message);
		this.name = 'MegaBasterdError';
		this.code = code;
		this.fallbackEligible = fallbackEligible;
	}
}

export function createMegaBasterdClient({
	baseUrl,
	secret,
	timeoutMs = 15000,
	fetchImpl = globalThis.fetch,
} = {}) {
	const normalizedSecret = String(secret || '').trim();

	async function request(path, { method = 'GET', body, signal, stream = false } = {}) {
		if (!normalizedSecret) {
			throw new MegaBasterdError('UNAVAILABLE');
		}

		const requestController = new AbortController();
		let timedOut = false;
		const abortFromCaller = () => requestController.abort(signal?.reason);
		if (signal?.aborted) abortFromCaller();
		else signal?.addEventListener('abort', abortFromCaller, { once: true });
		const timeout = setTimeout(() => {
			timedOut = true;
			requestController.abort();
		}, timeoutMs);
		timeout.unref?.();
		const cleanup = () => signal?.removeEventListener('abort', abortFromCaller);
		let response;
		try {
			response = await fetchImpl(new URL(path, baseUrl), {
				method,
				headers: {
					Authorization: `Bearer ${normalizedSecret}`,
					...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
				},
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: requestController.signal,
			});
		} catch (error) {
			clearTimeout(timeout);
			cleanup();
			if (signal?.aborted) throw new MegaBasterdError('CANCELLED');
			if (timedOut) throw new MegaBasterdError('TIMEOUT');
			throw new MegaBasterdError('UNAVAILABLE');
		}
		clearTimeout(timeout);

		if (!response.ok) {
			let payload = null;
			try {
				payload = await response.json();
			} catch {
				// Error bodies are optional; status mapping remains safe.
			}
			cleanup();
			if (signal?.aborted) throw new MegaBasterdError('CANCELLED');
			const responseCode = typeof payload?.code === 'string' && SAFE_CODES.has(payload.code)
				? payload.code
				: null;
			const code = responseCode || ({
				400: 'INVALID_INPUT',
				401: 'UNAUTHORIZED',
				404: 'NOT_FOUND',
				429: 'QUOTA',
			}[response.status] || 'UPSTREAM');
			throw new MegaBasterdError(code);
		}

		if (!stream) {
			try {
				return await response.json();
			} catch {
				if (signal?.aborted) throw new MegaBasterdError('CANCELLED');
				throw new MegaBasterdError('UPSTREAM');
			} finally {
				cleanup();
			}
		}
		if (!response.body) {
			cleanup();
			throw new MegaBasterdError('UPSTREAM');
		}
		const readable = Readable.fromWeb(response.body);
		readable.once('close', cleanup);
		return readable;
	}

	return {
		health: (options = {}) => request('/health', options),
		inspectPublic: (link, { signal } = {}) => request('/inspect', {
			method: 'POST',
			body: { link },
			signal,
		}),
		streamPublic: (link, { range = null, signal } = {}) => request('/stream', {
			method: 'POST',
			body: { source: 'public', link, range },
			signal,
			stream: true,
		}),
		streamResolved: (transfer, { range = null, signal } = {}) => request('/stream', {
			method: 'POST',
			body: {
				source: 'resolved',
				download_url: transfer.downloadUrl,
				file_key: transfer.fileKey,
				file_name: transfer.fileName,
				size: transfer.size,
				range,
			},
			signal,
			stream: true,
		}),
	};
}
