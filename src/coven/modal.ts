/**
 * Opens a `<dialog>` as a modal. Hosts without `showModal` (jsdom) get the
 * plain `open` attribute so the content still renders and can be closed.
 */
export function openModal(dialog: HTMLDialogElement) {
  if (dialog.hasAttribute('open')) return;
  if (typeof dialog.showModal === 'function') {
    try {
      dialog.showModal();
      return;
    } catch {
      // Not connected yet, or already open non-modally: fall through.
    }
  }
  dialog.setAttribute('open', '');
}

/** Closes a dialog opened by `openModal`, firing `close` where the host does not. */
export function closeModal(dialog: HTMLDialogElement) {
  if (!dialog.hasAttribute('open')) return;
  if (typeof dialog.close === 'function') {
    dialog.close();
    return;
  }
  dialog.removeAttribute('open');
  dialog.dispatchEvent(new Event('close'));
}
