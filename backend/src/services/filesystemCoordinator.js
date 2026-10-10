import { AsyncLocalStorage } from 'node:async_hooks';

const context = new AsyncLocalStorage();
const tails = new Map();

// One process owns SQLite/provider mutations; nested upload/sync calls reuse its lock.
export async function withFilesystemLock(userId, work) {
	if (context.getStore()?.active && context.getStore().userId === userId) return work();
	const previous = tails.get(userId) || Promise.resolve();
	let release;
	const current = new Promise((resolve) => {
		release = resolve;
	});
	tails.set(userId, current);
	await previous;
	const owner = { userId, active: true };
	try {
		return await context.run(owner, work);
	} finally {
		owner.active = false;
		release();
		if (tails.get(userId) === current) tails.delete(userId);
	}
}

export function filesystemRoute(userOf, handler) {
	return (req, res, next) =>
		withFilesystemLock(userOf(req), async () => {
			if (res.destroyed) return;
			const finished = new Promise((resolve) => {
				res.once('finish', resolve);
				res.once('close', resolve);
			});
			// Client disconnect must not release the mutation lock before the handler finishes.
			await Promise.all([finished, handler(req, res, next)]);
		}).catch(next);
}
