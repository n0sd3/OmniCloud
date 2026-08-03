<script setup>
import { ref, onMounted } from 'vue';
import { storeToRefs } from 'pinia';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { IconMoon, IconSun, IconLanguage, IconCloud, IconLogout, IconChevronRight, IconUserPlus, IconServer } from '@tabler/icons-vue';
import DriveShell from '../components/DriveShell.vue';
import idFlag from '../assets/id.svg';
import usFlag from '../assets/us.svg';
import { useSettingsStore } from '../stores/settings';
import { useAuthStore } from '../stores/auth';
import { api } from '../services/api';

const { t } = useI18n();
const router = useRouter();
const settingsStore = useSettingsStore();
const authStore = useAuthStore();
const { user, isHosted } = storeToRefs(authStore);

const theme = ref('light');
const registrationEnabled = ref(true);
const registrationLoading = ref(false);

const smb = ref({ enabled: false, username: null, host: '', sharePath: null });
const smbPassword = ref('');
const smbLoading = ref(false);
const smbError = ref('');

async function saveSmbPassword() {
	if (smbPassword.value.length < 8) {
		smbError.value = t('settings.smb.passwordHint');
		return;
	}

	smbError.value = '';
	smbLoading.value = true;
	try {
		const { data } = await api.updateSmbAccess(smbPassword.value);
		smb.value = data;
		smbPassword.value = '';
	} catch (error) {
		smbError.value = error.message;
	} finally {
		smbLoading.value = false;
	}
}

async function disableSmb() {
	smbError.value = '';
	smbLoading.value = true;
	try {
		const { data } = await api.disableSmbAccess();
		smb.value = data;
	} catch (error) {
		smbError.value = error.message;
	} finally {
		smbLoading.value = false;
	}
}

const languages = [
	{ code: 'id', label: 'Bahasa Indonesia', flag: idFlag },
	{ code: 'en', label: 'English', flag: usFlag },
];

function applyTheme(nextTheme) {
	theme.value = nextTheme;
	document.documentElement.classList.toggle('dark', nextTheme === 'dark');
	window.localStorage.setItem('omnicloud-theme', nextTheme);
}

function selectTheme(nextTheme) {
	if (nextTheme !== theme.value) applyTheme(nextTheme);
}

async function selectLanguage(code) {
	await settingsStore.updateLanguage(code);
}

async function handleLogout() {
	await authStore.logout();
	router.replace('/login');
}

async function toggleRegistration() {
	const next = !registrationEnabled.value;
	registrationLoading.value = true;
	try {
		const { data } = await api.updateAppSettings({ registration_enabled: next });
		registrationEnabled.value = Boolean(data.registration_enabled);
	} finally {
		registrationLoading.value = false;
	}
}

onMounted(async () => {
	theme.value = document.documentElement.classList.contains('dark') ? 'dark' : 'light';
	if (isHosted.value) {
		const { data } = await api.getAppSettings();
		registrationEnabled.value = Boolean(data.registration_enabled);
	}
	const { data: smbData } = await api.getSmbAccess();
	smb.value = smbData;
});
</script>

<template>
	<DriveShell current-section="settings">
		<div class="relative min-h-[calc(100vh-84px)] rounded-[24px] bg-white px-4 py-[18px] pb-5 text-[#202124] dark:bg-slate-800 dark:text-slate-100 sm:px-6">
			<h1 class="mb-5 text-2xl font-normal text-[#202124] dark:text-slate-100">{{ t('common.settings') }}</h1>

			<div class="max-w-2xl space-y-4">
				<section class="rounded-2xl border border-[#e7edf6] bg-[#f8fafd] p-5 dark:border-slate-800 dark:bg-slate-800/70">
					<h2 class="text-sm font-semibold text-[#202124] dark:text-slate-100">{{ t('common.theme') }}</h2>
					<div class="mt-3 grid grid-cols-2 gap-2">
						<button type="button" class="flex items-center justify-center gap-2 rounded-2xl border border-[#e7edf6] bg-white p-3 text-sm font-medium transition dark:border-slate-700 dark:bg-slate-900/80" :class="theme === 'light' ? 'border-[#1a73e8] bg-[#e8f0fe] dark:border-blue-400/40 dark:bg-slate-800' : ''" @click="selectTheme('light')">
							<IconSun :size="18" :stroke="1.8" />
							{{ t('common.light') }}
						</button>
						<button type="button" class="flex items-center justify-center gap-2 rounded-2xl border border-[#e7edf6] bg-white p-3 text-sm font-medium transition dark:border-slate-700 dark:bg-slate-900/80" :class="theme === 'dark' ? 'border-[#1a73e8] bg-[#e8f0fe] dark:border-blue-400/40 dark:bg-slate-800' : ''" @click="selectTheme('dark')">
							<IconMoon :size="18" :stroke="1.8" />
							{{ t('common.dark') }}
						</button>
					</div>
				</section>

				<section class="rounded-2xl border border-[#e7edf6] bg-[#f8fafd] p-5 dark:border-slate-800 dark:bg-slate-800/70">
					<h2 class="flex items-center gap-2 text-sm font-semibold text-[#202124] dark:text-slate-100">
						<IconLanguage :size="18" :stroke="1.8" />
						{{ t('language.title') }}
					</h2>
					<div class="mt-3 grid gap-2 sm:grid-cols-2">
						<button v-for="lang in languages" :key="lang.code" type="button" class="flex items-center gap-3 rounded-2xl border border-[#e7edf6] bg-white p-3 text-left transition dark:border-slate-700 dark:bg-slate-900/80" :class="settingsStore.language === lang.code ? 'border-[#1a73e8] bg-[#e8f0fe] dark:border-blue-400/40 dark:bg-slate-800' : ''" @click="selectLanguage(lang.code)">
							<img :src="lang.flag" :alt="lang.label" class="h-7 w-7 rounded-full object-cover ring-1 ring-black/5 dark:ring-white/10" />
							<span class="text-sm font-medium text-[#202124] dark:text-slate-100">{{ lang.label }}</span>
						</button>
					</div>
				</section>

				<section class="rounded-2xl border border-[#e7edf6] bg-[#f8fafd] p-5 dark:border-slate-800 dark:bg-slate-800/70">
					<h2 class="text-sm font-semibold text-[#202124] dark:text-slate-100">{{ t('quota.integratedAccounts') }}</h2>
					<button type="button" class="mt-3 flex w-full items-center justify-between gap-3 rounded-2xl border border-[#e7edf6] bg-white p-3 text-left transition hover:border-[#1a73e8] dark:border-slate-700 dark:bg-slate-900/80" @click="router.push('/quota')">
						<span class="flex items-center gap-3 text-sm font-medium text-[#202124] dark:text-slate-100">
							<IconCloud :size="18" :stroke="1.8" />
							{{ t('quota.title') }}
						</span>
						<IconChevronRight :size="18" :stroke="1.8" class="text-[#5f6368] dark:text-slate-400" />
					</button>
				</section>

				<section class="rounded-2xl border border-[#e7edf6] bg-[#f8fafd] p-5 dark:border-slate-800 dark:bg-slate-800/70">
					<h2 class="flex items-center gap-2 text-sm font-semibold text-[#202124] dark:text-slate-100">
						<IconServer :size="18" :stroke="1.8" />
						{{ t('settings.smb.title') }}
					</h2>
					<p class="mt-1 text-xs text-[#5f6368] dark:text-slate-400">{{ t('settings.smb.description') }}</p>

					<div v-if="smb.enabled" class="mt-3 space-y-1 rounded-2xl border border-[#e7edf6] bg-white p-3 text-sm dark:border-slate-700 dark:bg-slate-900/80">
						<p class="text-[#202124] dark:text-slate-100">{{ t('settings.smb.username') }}: <span class="font-mono">{{ smb.username }}</span></p>
						<p class="text-[#202124] dark:text-slate-100">{{ t('settings.smb.sharePath') }}: <span class="font-mono">{{ smb.sharePath }}</span></p>
					</div>

					<div class="mt-3 flex flex-col gap-2 sm:flex-row">
						<input v-model="smbPassword" type="password" autocomplete="new-password" :placeholder="t('settings.smb.password')" class="flex-1 rounded-2xl border border-[#e7edf6] bg-white px-4 py-2 text-sm text-[#202124] outline-none focus:border-[#1a73e8] dark:border-slate-700 dark:bg-slate-900/80 dark:text-slate-100" />
						<button type="button" :disabled="smbLoading" class="rounded-full bg-[#1a73e8] px-4 py-2 text-sm font-semibold text-white transition disabled:opacity-60" @click="saveSmbPassword">
							{{ smb.enabled ? t('settings.smb.update') : t('settings.smb.enable') }}
						</button>
						<button v-if="smb.enabled" type="button" :disabled="smbLoading" class="rounded-full bg-[#fce8e6] px-4 py-2 text-sm font-semibold text-[#c5221f] transition disabled:opacity-60 dark:bg-red-950/40 dark:text-red-300" @click="disableSmb">
							{{ t('settings.smb.disable') }}
						</button>
					</div>

					<p v-if="smbError" class="mt-2 text-xs text-[#c5221f] dark:text-red-300">{{ smbError }}</p>
					<p v-else class="mt-2 text-xs text-[#5f6368] dark:text-slate-400">{{ t('settings.smb.passwordHint') }}</p>

					<div v-if="smb.enabled" class="mt-4 space-y-1 text-xs text-[#5f6368] dark:text-slate-400">
						<p class="font-semibold text-[#202124] dark:text-slate-100">{{ t('settings.smb.howToMount') }}</p>
						<p>macOS — {{ t('settings.smb.macos') }}</p>
						<p>Windows — {{ t('settings.smb.windows') }}</p>
						<p>iOS — {{ t('settings.smb.ios') }}</p>
						<p>Linux — <span class="font-mono">{{ t('settings.smb.linux') }}</span></p>
					</div>
				</section>

				<section v-if="isHosted" class="rounded-2xl border border-[#e7edf6] bg-[#f8fafd] p-5 dark:border-slate-800 dark:bg-slate-800/70">
					<div class="flex items-start justify-between gap-4">
						<div class="flex items-start gap-3">
							<IconUserPlus :size="18" :stroke="1.8" class="mt-0.5 shrink-0 text-[#5f6368] dark:text-slate-400" />
							<div>
								<h2 class="text-sm font-semibold text-[#202124] dark:text-slate-100">{{ t('settings.newAccounts') }}</h2>
								<p class="mt-1 text-xs text-[#5f6368] dark:text-slate-400">{{ t('settings.newAccountsDesc') }}</p>
							</div>
						</div>
						<button type="button" role="switch" :aria-checked="registrationEnabled" :disabled="registrationLoading" class="relative h-7 w-12 shrink-0 rounded-full transition disabled:opacity-60" :class="registrationEnabled ? 'bg-[#1a73e8]' : 'bg-[#dadce0] dark:bg-slate-700'" @click="toggleRegistration">
							<span class="absolute top-0.5 size-6 rounded-full bg-white shadow transition-transform" :class="registrationEnabled ? 'translate-x-5' : 'translate-x-0.5'" />
						</button>
					</div>
				</section>

				<section v-if="isHosted" class="rounded-2xl border border-[#e7edf6] bg-[#f8fafd] p-5 dark:border-slate-800 dark:bg-slate-800/70">
					<h2 class="text-sm font-semibold text-[#202124] dark:text-slate-100">{{ t('profile.title') }}</h2>
					<p v-if="user?.email" class="mt-2 text-sm text-[#5f6368] dark:text-slate-400">{{ user.email }}</p>
					<button type="button" class="mt-3 flex items-center gap-2 rounded-full bg-[#fce8e6] px-4 py-2 text-sm font-semibold text-[#c5221f] transition hover:bg-[#fadbd8] dark:bg-red-950/40 dark:text-red-300" @click="handleLogout">
						<IconLogout :size="16" :stroke="2" />
						{{ t('auth.logout') }}
					</button>
				</section>
			</div>
		</div>
	</DriveShell>
</template>
