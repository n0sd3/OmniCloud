const uploadSockets = new Map();
const uploadEvents = new Map();
const EVENT_TTL_MS = 5 * 60 * 1000;

function rememberEvent(uploadId, event) {
	const previous = uploadEvents.get(uploadId);
	const events = previous?.events || [];
	const next = event.type === 'upload:started'
		? [event, ...events.filter((item) => item.type !== 'upload:started')].slice(0, 2)
		: [...events.filter((item) => item.type === 'upload:started'), event].slice(-2);
	if (previous?.timer) clearTimeout(previous.timer);
	const timer = setTimeout(() => uploadEvents.delete(uploadId), EVENT_TTL_MS);
	timer.unref?.();
	uploadEvents.set(uploadId, { events: next, timer });
}

export function registerUploadSocket(uploadId, socket) {
	if (!uploadSockets.has(uploadId)) {
		uploadSockets.set(uploadId, new Set());
	}

	uploadSockets.get(uploadId).add(socket);
	for (const event of uploadEvents.get(uploadId)?.events || []) {
		socket.send(JSON.stringify(event));
	}
}

export function unregisterUploadSocket(uploadId, socket) {
	const sockets = uploadSockets.get(uploadId);
	if (!sockets) return;
	sockets.delete(socket);
	if (!sockets.size) {
		uploadSockets.delete(uploadId);
	}
}

export function emitUploadEvent(uploadId, event) {
	rememberEvent(uploadId, event);
	const sockets = uploadSockets.get(uploadId);
	if (!sockets) return;

	for (const socket of sockets) {
		if (socket.readyState === 1) {
			socket.send(JSON.stringify(event));
		}
	}
}
