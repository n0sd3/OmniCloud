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
	async function request(path, { method = 'GET', body, signal, stream = false } = {}) {
		if (!secret) {
			throw new MegaBasterdError('UNAVAILABLE');
		}

		const timeoutSignal = AbortSignal.timeout(timeoutMs);
		const requestSignal = AbortSignal.any([signal, timeoutSignal].filter(Boolean));
		let response;
		try {
			response = await fetchImpl(new URL(path, baseUrl), {
				method,
				headers: {
					Authorization: `Bearer ${secret}`,
					...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
				},
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: requestSignal,
			});
		} catch (error) {
			if (signal?.aborted) throw new MegaBasterdError('CANCELLED');
			if (timeoutSignal.aborted) throw new MegaBasterdError('TIMEOUT');
			throw new MegaBasterdError('UNAVAILABLE');
		}

		if (!response.ok) {
			let payload = null;
			try {
				payload = await response.json();
			} catch {
				// Error bodies are optional; status mapping remains safe.
			}
			const responseCode = typeof payload?.code === 'string' && SAFE_CODES.has(payload.code)
				? payload.code
				: null;
			const code = response.status >= 500 ? responseCode || 'UPSTREAM' : responseCode || 'UPSTREAM';
			throw new MegaBasterdError(code, undefined, {
				fallbackEligible: response.status >= 500 || FALLBACK_CODES.has(code),
			});
		}

		if (!stream) return response.json();
		if (!response.body) throw new MegaBasterdError('UPSTREAM');
		return Readable.fromWeb(response.body);
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
