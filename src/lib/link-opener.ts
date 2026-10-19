import { invoke } from '@tauri-apps/api/core';

import { canUseTauriCommands, type InvokeCommand } from './desktop-host';

/**
 * Whether this window can ask the desktop host to open a reviewed link. In a
 * browser build, the review's Open stays an anchor the browser opens itself.
 */
export function canOpenReviewedLinks(): boolean {
  return canUseTauriCommands();
}

/**
 * Asks the host to hand one reviewed address to the system's default handler
 * (`open_reviewed_link`). Resolves once the system took it, which is not proof
 * that a page rendered. Rejects with the host's message, which names Copy
 * address, when it didn't.
 */
export async function openReviewedLink(
  address: string,
  call: InvokeCommand = invoke,
): Promise<void> {
  const result = await call('open_reviewed_link', { address });
  if (result !== null && result !== undefined)
    throw new Error('The desktop app gave an answer Chat can’t read. Use Copy address instead.');
}
