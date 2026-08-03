import { defineStore } from 'pinia';
import { authApi } from '../services/api';

export const useAuthStore = defineStore('auth', {
	state: () => ({
		mode: 'local',
		requiresAuth: false,
		authenticated: false,
		registrationEnabled: true,
		user: null,
		initialized: false,
		loading: false,
		error: null,
	}),
	getters: {
		isHosted: (state) => state.mode === 'hosted',
		canAccessApp: (state) => !state.requiresAuth || state.authenticated,
	},
	actions: {
		applySummary(summary = {}) {
			this.mode = summary.mode || 'local';
			this.requiresAuth = Boolean(summary.requiresAuth);
			this.authenticated = Boolean(summary.authenticated);
			this.registrationEnabled = summary.registrationEnabled !== false;
			this.user = summary.user || null;
		},
		async bootstrap() {
			if (this.initialized) {
				return;
			}
			try {
				const { data } = await authApi.me();
				this.applySummary(data);
			} catch {
				this.applySummary({ mode: 'hosted', requiresAuth: true, authenticated: false });
			} finally {
				this.initialized = true;
			}
		},
		async login(credentials) {
			this.loading = true;
			this.error = null;
			try {
				const { data } = await authApi.login(credentials);
				this.applySummary(data);
				return true;
			} catch (error) {
				this.error = error.message;
				return false;
			} finally {
				this.loading = false;
			}
		},
		async register(credentials) {
			this.loading = true;
			this.error = null;
			try {
				const { data } = await authApi.register(credentials);
				this.applySummary(data);
				return true;
			} catch (error) {
				this.error = error.message;
				return false;
			} finally {
				this.loading = false;
			}
		},
		async logout() {
			try {
				const { data } = await authApi.logout();
				this.applySummary(data);
			} catch {
				this.authenticated = false;
				this.user = null;
			}
		},
	},
});
