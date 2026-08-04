import { ref } from 'vue';

const QUERY = '(pointer: coarse)';

// Em ponteiro grosso o duplo toque e gesto de zoom do navegador, entao um toque
// precisa abrir o item. Tablet com teclado acoplado troca de modo em runtime.
// Singleton de modulo: cada linha da lista consome o mesmo ref em vez de
// registrar o proprio listener.
const media = window.matchMedia?.(QUERY) || null;
const isCoarsePointer = ref(media?.matches ?? false);

media?.addEventListener('change', (event) => {
	isCoarsePointer.value = event.matches;
});

export function usePointerCoarse() {
	return isCoarsePointer;
}
