/**
 * Puts text on the clipboard and reports whether it got there. The async
 * clipboard API is the normal path; the legacy `execCommand` path covers a
 * webview that withholds it. A `false` is shown to the reader as a failure,
 * never as "Copied".
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the legacy path.
  }
  if (typeof document === 'undefined' || typeof document.execCommand !== 'function') return false;
  const host = document.createElement('textarea');
  host.value = text;
  host.setAttribute('readonly', '');
  host.setAttribute('aria-hidden', 'true');
  host.style.position = 'fixed';
  host.style.top = '0';
  host.style.left = '0';
  host.style.opacity = '0';
  const active = document.activeElement;
  document.body.appendChild(host);
  try {
    host.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    host.remove();
    if (active instanceof HTMLElement) active.focus();
  }
}
