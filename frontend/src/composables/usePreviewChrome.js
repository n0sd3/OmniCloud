import { getCurrentInstance, onBeforeUnmount, ref } from 'vue';

export function usePreviewChrome({ timeoutMs = 3000 } = {}) {
	const visible = ref(true);
	let holds = 0;
	let timer = null;

	function clear() {
		// setTimeout/clearTimeout globais, nao window.*: node --test roda sem window.
		if (timer) clearTimeout(timer);
		timer = null;
	}

	function arm() {
		clear();
		if (holds > 0) return;
		timer = setTimeout(() => { visible.value = false; }, timeoutMs);
	}

	function show() {
		visible.value = true;
		arm();
	}

	function hide() {
		clear();
		visible.value = false;
	}

	function toggle() {
		if (visible.value) hide();
		else show();
	}

	// Contagem de referencia: video pausado e menu aberto podem segurar ao mesmo
	// tempo, e soltar um nao pode esconder os controles que o outro ainda usa.
	function hold() {
		holds += 1;
		visible.value = true;
		clear();
	}

	function release() {
		holds = Math.max(0, holds - 1);
		if (holds === 0) arm();
	}

	// Fora de um componente (testes) getCurrentInstance() e null e o registro e pulado.
	if (getCurrentInstance()) onBeforeUnmount(clear);

	return { visible, show, hide, toggle, hold, release };
}
