const TERMINAL_STATUSES = new Set(['completed', 'completed_with_errors', 'failed', 'cancelled']);

function isRetryable(error) {
	const status = Number(error?.status);
	return !status || status === 429 || status >= 500;
}

function errorMessage(error) {
	return error?.message || 'Google Photos import failed';
}

function failureLines(errors = []) {
	return errors.map((error) => {
		if (typeof error === 'string') return error;
		return [error?.fileName, error?.message].filter(Boolean).join(': ');
	}).filter(Boolean);
}

export function getGooglePhotosImportSummary(photoImport, messages) {
	if (photoImport.status === 'starting' || photoImport.status === 'waiting_for_selection') return messages.waiting();
	if (photoImport.status === 'importing') return messages.importing(photoImport);
	if (photoImport.status === 'completed') return messages.completed(photoImport);
	if (photoImport.status === 'cancelled') return messages.cancelled();
	const failures = failureLines(photoImport.errors);
	if (photoImport.status === 'failed') return failures.length ? failures.join('\n') : messages.failed();
	return [messages.partial(photoImport), ...failures].join('\n');
}

export function createGooglePhotosImportLifecycle({
	api,
	browser,
	onUpdate,
	onError,
	onRefresh,
	maxPollRetries = 3,
}) {
	const watches = new Map();
	let disposed = false;

	function close(watch) {
		if (watch.timer) browser.clearTimeout(watch.timer);
		watch.socket?.close();
		if (!watch.pickerWindow?.closed) watch.pickerWindow?.close();
	}

	function stop(accountId, { cancel = false } = {}) {
		const watch = watches.get(accountId);
		if (!watch) return;
		watches.delete(accountId);
		close(watch);
		if (cancel && watch.importId) api.cancelGooglePhotosImport(watch.importId).catch(() => {});
	}

	function update(watch, next) {
		if (watches.get(watch.account.id) !== watch || disposed) return false;
		watch.photoImport = { ...watch.photoImport, ...next };
		if (watch.photoImport.status !== 'waiting_for_selection') watch.closedWaitingPolls = 0;
		onUpdate(watch.account.id, watch.photoImport);
		if (!TERMINAL_STATUSES.has(watch.photoImport.status)) return true;

		stop(watch.account.id);
		if (watch.photoImport.status !== 'cancelled') onRefresh(watch.account.id);
		return false;
	}

	function fail(watch, error) {
		update(watch, { status: 'failed', errors: [errorMessage(error)] });
	}

	function schedulePoll(watch) {
		watch.timer = browser.setTimeout(() => poll(watch), watch.pollIntervalMs);
	}

	async function poll(watch) {
		if (watches.get(watch.account.id) !== watch || disposed) return;
		try {
			const { data } = await api.getGooglePhotosImport(watch.importId);
			if (Number.isFinite(Number(data.pollIntervalMs))) watch.pollIntervalMs = Number(data.pollIntervalMs);
			if (!update(watch, data)) return;

			if (data.status === 'waiting_for_selection' && watch.pickerWindow?.closed) {
				watch.closedWaitingPolls += 1;
				if (watch.closedWaitingPolls >= 2) {
					const { data: cancelled } = await api.cancelGooglePhotosImport(watch.importId);
					update(watch, cancelled);
					return;
				}
			} else {
				watch.closedWaitingPolls = 0;
			}
			watch.pollRetries = 0;
		} catch (error) {
			watch.closedWaitingPolls = 0;
			if (!isRetryable(error) || watch.pollRetries >= maxPollRetries) {
				fail(watch, error);
				return;
			}
			watch.pollRetries += 1;
		}

		if (watches.get(watch.account.id) === watch && !disposed) schedulePoll(watch);
	}

	function startWatch(watch) {
		watch.socket = api.createUploadSocket(watch.importId);
		watch.socket.onmessage = (event) => {
			try {
				const message = JSON.parse(event.data);
				if (!message.type?.startsWith('photos-import:')) return;
				if (TERMINAL_STATUSES.has(message.status)) {
					if (watch.timer) browser.clearTimeout(watch.timer);
					watch.timer = null;
					poll(watch);
					return;
				}
				update(watch, message);
			} catch {
				// Polling remains the fallback for malformed socket messages.
			}
		};
		schedulePoll(watch);
	}

	async function start(account) {
		if (disposed || watches.has(account.id)) return;
		const pickerWindow = browser.open('', '_blank');
		if (!pickerWindow) {
			onError(account.id, 'popup-blocked');
			return;
		}

		const watch = {
			account,
			pickerWindow,
			importId: null,
			pollIntervalMs: null,
			photoImport: { status: 'starting', total: 0, completed: 0, failed: 0, errors: [] },
			timer: null,
			socket: null,
			pollRetries: 0,
			closedWaitingPolls: 0,
		};
		watches.set(account.id, watch);
		onUpdate(account.id, watch.photoImport);

		try {
			const { data } = await api.startGooglePhotosImport(account.id);
			watch.importId = data.id;
			watch.pollIntervalMs = data.pollIntervalMs;
			if (disposed || watches.get(account.id) !== watch) {
				close(watch);
				api.cancelGooglePhotosImport(data.id).catch(() => {});
				return;
			}
			pickerWindow.location.replace(`${data.pickerUri}/autoclose`);
			if (update(watch, data)) startWatch(watch);
		} catch (error) {
			if (watches.get(account.id) !== watch || disposed) return;
			if (watch.importId) api.cancelGooglePhotosImport(watch.importId).catch(() => {});
			fail(watch, error);
			onError(account.id, error);
		}
	}

	function dispose() {
		disposed = true;
		for (const [accountId, watch] of watches) {
			stop(accountId, { cancel: ['starting', 'waiting_for_selection'].includes(watch.photoImport.status) });
		}
	}

	return { start, dispose };
}
