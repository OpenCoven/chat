/**
 * Records every external address an activation would hand to the webview: a
 * click or middle click on a real link that nothing cancelled. The listener
 * runs last and cancels the default itself, so jsdom never tries to navigate.
 * In-page fragment links are not external and are left alone.
 */
export function watchNavigation() {
  const opened: string[] = [];
  const record = (event: MouseEvent) => {
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!(link instanceof HTMLAnchorElement) || link.getAttribute('href')?.startsWith('#')) return;
    if (!event.defaultPrevented) opened.push(link.getAttribute('href') ?? '');
    event.preventDefault();
  };
  window.addEventListener('click', record);
  window.addEventListener('auxclick', record);
  return {
    opened,
    stop() {
      window.removeEventListener('click', record);
      window.removeEventListener('auxclick', record);
    },
  };
}
