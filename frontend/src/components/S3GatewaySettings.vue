<script setup>
import { ref, onMounted, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { s3GatewayApi } from '../services/api';
const { t } = useI18n();
const settings = ref(null);
const created = ref(null);
const busy = ref(false);
const error = ref('');
const message = ref('');
const cli = computed(() =>
	settings.value
		? `aws --profile omnicloud --endpoint-url ${settings.value.endpoint || 'http://localhost:8787'} s3 ls s3://${settings.value.bucket}/`
		: '',
);
async function load() {
	settings.value = (await s3GatewayApi.get()).data;
}
async function change(action) {
	busy.value = true;
	error.value = '';
	message.value = '';
	try {
		await action();
		await load();
	} catch (e) {
		error.value = e.message;
	} finally {
		busy.value = false;
	}
}
async function generate(key) {
	created.value = (await (key ? s3GatewayApi.rotate(key) : s3GatewayApi.create())).data;
}
async function copy(value) {
	try {
		await navigator.clipboard.writeText(value);
		message.value = t('s3Gateway.copied');
	} catch {
		error.value = t('s3Gateway.copyFailed');
	}
}
onMounted(() => change(load));
</script>

<template>
	<section
		class="rounded-2xl border border-[#e7edf6] bg-[#f8fafd] p-5 dark:border-slate-700 dark:bg-slate-800/70"
	>
		<h2 class="text-sm font-semibold">S3 Gateway</h2>
		<p class="mt-1 text-xs text-[#5f6368] dark:text-slate-400">{{ t('s3Gateway.description') }}</p>
		<template v-if="settings">
			<p v-if="!settings.available" class="mt-3 text-sm">{{ t('s3Gateway.unavailable') }}</p>
			<label class="mt-3 flex items-center gap-2 text-sm">
				<input
					type="checkbox"
					:checked="settings.enabled"
					:disabled="busy || !settings.available"
					@change="change(() => s3GatewayApi.update({ enabled: $event.target.checked }))"
				/>
				{{ t('s3Gateway.enabled') }}
			</label>
			<dl class="mt-3 space-y-2 text-sm">
				<div>
					<dt class="font-semibold">Endpoint</dt>
					<dd class="break-all font-mono">
						{{ settings.endpoint || t('s3Gateway.endpointHint') }}
						<button
							v-if="settings.endpoint"
							type="button"
							:disabled="busy"
							class="text-blue-600 dark:text-blue-300"
							@click="copy(settings.endpoint)"
						>
							{{ t('s3Gateway.copy') }}
						</button>
					</dd>
				</div>
				<div>
					<dt class="font-semibold">Bucket</dt>
					<dd class="font-mono">{{ settings.bucket }}</dd>
				</div>
				<div>
					<dt class="font-semibold">Region</dt>
					<dd class="font-mono">{{ settings.region }}</dd>
				</div>
			</dl>
			<h3 class="mt-4 text-sm font-semibold">Access Keys</h3>
			<ul class="mt-2 space-y-3">
				<li
					v-for="key in settings.keys"
					:key="key.access_key_id"
					class="rounded-xl border border-[#e7edf6] bg-white p-3 text-xs dark:border-slate-700 dark:bg-slate-900/80"
				>
					<p class="font-mono">{{ key.access_key_id.slice(0, 6) }}****************</p>
					<p>{{ t('s3Gateway.created') }}: {{ key.created_at }}</p>
					<p>{{ t('s3Gateway.lastUsed') }}: {{ key.last_used_at || '—' }} UTC</p>
					<div v-if="key.enabled" class="mt-2 flex gap-4">
						<button
							type="button"
							:disabled="busy"
							class="text-red-600 dark:text-red-300"
							@click="change(() => s3GatewayApi.revoke(key.access_key_id))"
						>
							{{ t('s3Gateway.revoke') }}
						</button>
						<button
							type="button"
							:disabled="busy"
							class="text-blue-600 dark:text-blue-300"
							@click="change(() => generate(key.access_key_id))"
						>
							{{ t('s3Gateway.rotate') }}
						</button>
					</div>
					<p v-else>{{ t('s3Gateway.revoked') }}</p>
				</li>
			</ul>
			<button
				type="button"
				:disabled="busy || !settings.available"
				class="mt-3 rounded-full bg-[#1a73e8] px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
				@click="change(() => generate())"
			>
				{{ t('s3Gateway.generate') }}
			</button>
			<div
				v-if="created"
				class="mt-4 space-y-2 rounded-xl border border-blue-300 bg-white p-3 text-sm dark:bg-slate-900"
			>
				<p>{{ t('s3Gateway.secretOnce') }}</p>
				<label class="block"
					>Access Key ID<input
						:value="created.accessKeyId"
						readonly
						class="mt-1 w-full rounded border p-2 font-mono dark:bg-slate-800"
				/></label>
				<label class="block"
					>Secret Access Key<input
						:value="created.secretAccessKey"
						readonly
						autocomplete="off"
						class="mt-1 w-full rounded border p-2 font-mono dark:bg-slate-800"
				/></label>
				<button
					type="button"
					class="mr-4 text-blue-600 dark:text-blue-300"
					@click="copy(created.secretAccessKey)"
				>
					{{ t('s3Gateway.copySecret') }}
				</button>
				<button type="button" class="text-blue-600 dark:text-blue-300" @click="created = null">
					{{ t('s3Gateway.dismiss') }}
				</button>
			</div>
			<p class="mt-4 text-xs">{{ t('s3Gateway.cli') }}</p>
			<pre class="mt-2 overflow-x-auto rounded-xl bg-white p-3 text-xs dark:bg-slate-900">
aws configure --profile omnicloud
{{ cli }}</pre
			>
		</template>
		<p v-if="error" role="alert" class="mt-2 text-sm text-red-600 dark:text-red-300">{{ error }}</p>
		<p v-if="message" role="status" class="mt-2 text-sm">{{ message }}</p>
	</section>
</template>
