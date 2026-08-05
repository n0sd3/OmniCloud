const PREFIX = 'omnicloud.resume.';
const TAIL_SECONDS = 30;
const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

export function createMediaResume(storage, { now = () => Date.now() } = {}) {
	function key(fileId) {
		return `${PREFIX}${fileId}`;
	}

	function read(fileId) {
		try {
			const raw = storage.getItem(key(fileId));
			if (!raw) return 0;
			return Number(JSON.parse(raw).time) || 0;
		} catch {
			return 0;
		}
	}

	function write(fileId, time, duration) {
		// Quem parou nos ultimos segundos terminou de assistir: retomar ali so
		// devolveria os creditos finais.
		if (!Number.isFinite(time) || time <= 0) return;
		if (Number.isFinite(duration) && duration - time < TAIL_SECONDS) {
			storage.removeItem(key(fileId));
			return;
		}
		try {
			storage.setItem(key(fileId), JSON.stringify({ time, at: now() }));
		} catch {
			// Cota cheia ou modo privado: retomar posicao nao vale um erro na tela.
		}
	}

	function clear(fileId) {
		storage.removeItem(key(fileId));
	}

	function prune() {
		const cutoff = now() - MAX_AGE_MS;
		const keys = Object.keys(storage.dump ? storage.dump() : storage);
		for (const item of keys) {
			if (!item.startsWith(PREFIX)) continue;
			try {
				const entry = JSON.parse(storage.getItem(item));
				if (Number(entry.at) < cutoff) storage.removeItem(item);
			} catch {
				storage.removeItem(item);
			}
		}
	}

	return { read, write, clear, prune };
}

export function useMediaResume() {
	return createMediaResume(window.localStorage);
}
