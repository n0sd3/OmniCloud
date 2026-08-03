export function createGlobalPointerHandler({ contextMenu, activeFilterMenu, closeContextMenu, clearSelection }) {
	return (event) => {
		if (contextMenu.value.visible) closeContextMenu();
		activeFilterMenu.value = null;
		if (event.type !== 'scroll') clearSelection();
	};
}
