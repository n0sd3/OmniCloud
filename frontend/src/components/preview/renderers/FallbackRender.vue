<script setup>
import { IconFileDescription } from '@tabler/icons-vue';
import { onMounted } from 'vue';
import { useI18n } from 'vue-i18n';

defineProps({ file: { type: Object, required: true } });
const emit = defineEmits(['loaded', 'failed']);
const { t } = useI18n();

onMounted(() => emit('loaded'));
</script>

<template>
	<div class="grid h-full place-items-center px-6 text-center text-sm text-slate-300">
		<div>
			<div class="mx-auto grid size-16 place-items-center rounded-full bg-white/10 text-white">
				<IconFileDescription :size="28" :stroke="1.8" />
			</div>
			<p class="mt-4">{{ t('preview.notAvailable') }}</p>
		</div>
	</div>
</template>
