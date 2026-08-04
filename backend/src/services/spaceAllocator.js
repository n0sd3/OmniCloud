import { randomUUID } from 'node:crypto';
import {
	getAllocationConfig,
	getOrderedActiveAccounts,
	getRoundRobinCursor,
	setRoundRobinCursor,
	getSwrrState,
	setSwrrState,
} from './allocationService.js';

const reservations = new Map();
const reservedByAccount = new Map();

function codedError(code, message) {
	return Object.assign(new Error(message), { code });
}

function withFreeSpace(account) {
	const total = Number(account.total_space) || 0;
	const used = Number(account.used_space) || 0;
	const reserved = reservedByAccount.get(account.id) || 0;
	return {
		...account,
		freeSpace: Math.max(0, total - used - reserved),
		usedRatio: total > 0 ? (used + reserved) / total : 1,
	};
}

function buildResult(selected, allAccounts) {
	if (!selected) {
		throw new Error('No active cloud account available');
	}

	const fallbackChain = allAccounts
		.filter((account) => account.id !== selected.id)
		.sort((a, b) => b.freeSpace - a.freeSpace);

	return { selected, fallbackChain };
}

function selectRoundRobin(userId, accounts, requiredBytes) {
	const count = accounts.length;
	const start = getRoundRobinCursor(userId) % count;

	let chosenIndex = -1;
	for (let step = 0; step < count; step += 1) {
		const index = (start + step) % count;
		if (accounts[index].freeSpace >= requiredBytes) {
			chosenIndex = index;
			break;
		}
	}

	if (chosenIndex === -1) {
		chosenIndex = start;
	}

	setRoundRobinCursor(userId, (chosenIndex + 1) % count);
	return accounts[chosenIndex];
}

function selectWeightedRoundRobin(userId, accounts, requiredBytes) {
	const eligible = accounts.filter((account) => account.freeSpace >= requiredBytes);
	const pool = eligible.length ? eligible : accounts;

	const weights = pool.map((account) => Math.max(1, Number(account.total_space) || 1));
	const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);

	const state = getSwrrState(userId);
	const current = {};
	let chosen = pool[0];
	let chosenIndex = 0;
	let maxCurrent = -Infinity;

	pool.forEach((account, index) => {
		const previous = Number(state[account.id]) || 0;
		const value = previous + weights[index];
		current[account.id] = value;
		if (value > maxCurrent) {
			maxCurrent = value;
			chosen = account;
			chosenIndex = index;
		}
	});

	current[pool[chosenIndex].id] -= totalWeight;

	setSwrrState(userId, current);
	return chosen;
}

function selectLeastUsed(accounts, requiredBytes) {
	const eligible = accounts.filter((account) => account.freeSpace >= requiredBytes);
	const pool = eligible.length ? eligible : accounts;
	return [...pool].sort((a, b) => a.usedRatio - b.usedRatio)[0];
}

function selectMostFree(accounts) {
	return [...accounts].sort((a, b) => b.freeSpace - a.freeSpace)[0];
}

function selectManual(accounts, requiredBytes) {
	return accounts.find((account) => account.freeSpace >= requiredBytes) || accounts[0];
}

export function selectBestAccount(userId, requiredBytes = 0, { excludeProviders = [] } = {}) {
	const required = Number(requiredBytes) || 0;
	const { strategy } = getAllocationConfig(userId);
	const excluded = new Set(excludeProviders);
	const accounts = getOrderedActiveAccounts(userId)
		.filter((account) => !excluded.has(account.provider))
		.map(withFreeSpace);

	if (!accounts.length) {
		if (excluded.size) {
			throw codedError('NO_STREAMING_DESTINATION', 'No streaming-capable cloud account available');
		}
		throw new Error('No active cloud account available');
	}

	let selected;
	switch (strategy) {
		case 'round_robin':
			selected = selectRoundRobin(userId, accounts, required);
			break;
		case 'weighted_round_robin':
			selected = selectWeightedRoundRobin(userId, accounts, required);
			break;
		case 'least_used':
			selected = selectLeastUsed(accounts, required);
			break;
		case 'manual':
			selected = selectManual(accounts, required);
			break;
		case 'most_free':
		default:
			selected = selectMostFree(accounts);
			break;
	}

	return buildResult(selected, accounts);
}

export function reserveBestAccount(userId, requiredBytes = 0, options = {}) {
	const required = Math.max(0, Number(requiredBytes) || 0);
	const allocation = selectBestAccount(userId, required, options);
	if (allocation.selected.freeSpace < required) {
		throw codedError('NO_SPACE', 'Not enough cloud storage space');
	}
	const reservationId = randomUUID();
	reservations.set(reservationId, { accountId: allocation.selected.id, bytes: required });
	reservedByAccount.set(
		allocation.selected.id,
		(reservedByAccount.get(allocation.selected.id) || 0) + required,
	);
	return { ...allocation, reservationId };
}

export function releaseAccountReservation(reservationId) {
	const reservation = reservations.get(reservationId);
	if (!reservation) return false;
	reservations.delete(reservationId);
	const remaining = (reservedByAccount.get(reservation.accountId) || 0) - reservation.bytes;
	if (remaining > 0) reservedByAccount.set(reservation.accountId, remaining);
	else reservedByAccount.delete(reservation.accountId);
	return true;
}
