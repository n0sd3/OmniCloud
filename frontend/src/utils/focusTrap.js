const FOCUSABLE = [
	'a[href]',
	'button:not([disabled])',
	'input:not([disabled])',
	'select:not([disabled])',
	'textarea:not([disabled])',
	'[tabindex]:not([tabindex="-1"])',
].join(',');

export function activateFocusTrap(container, { initialFocus, onEscape } = {}) {
	const previousFocus = document.activeElement;
	const focusable = () => Array.from(container?.querySelectorAll(FOCUSABLE) || [])
		.filter((element) => !element.disabled);

	function onKeydown(event) {
		if (event.key === 'Escape') {
			event.preventDefault();
			onEscape?.();
			return;
		}
		if (event.key !== 'Tab') return;

		const elements = focusable();
		if (!elements.length) {
			event.preventDefault();
			return;
		}
		const first = elements[0];
		const last = elements.at(-1);
		const active = document.activeElement;
		if (event.shiftKey && (active === first || !container.contains(active))) {
			event.preventDefault();
			last.focus();
		} else if (!event.shiftKey && (active === last || !container.contains(active))) {
			event.preventDefault();
			first.focus();
		}
	}

	document.addEventListener('keydown', onKeydown);
	(initialFocus || focusable()[0])?.focus();

	let active = true;
	return () => {
		if (!active) return;
		active = false;
		document.removeEventListener('keydown', onKeydown);
		previousFocus?.focus?.();
	};
}
