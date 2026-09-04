import type { QueryAdapter } from '../sdk/query-adapter';
import { type ChatStore, openChatStore } from './chat-store';
import { type ChatWriter, createLocalChatWriter, createReadOnlyChatWriter } from './chat-writer';
import { createLocalQueryAdapter, LOCAL_FAMILIAR_ID } from './local-query-adapter';

export type ChatSourceKind = 'local' | 'cave';

/**
 * A source is the pair the shell needs to be useful: somewhere to read from and
 * somewhere to write to. Keeping them together is what lets Cave stay read-only
 * while local stays writable, without either one pretending to be the other.
 */
export type ChatSource = Readonly<{
  kind: ChatSourceKind;
  label: string;
  adapter: QueryAdapter;
  writer: ChatWriter;
  isDurable: boolean;
}>;

export type LocalChatSource = ChatSource &
  Readonly<{
    kind: 'local';
    store: ChatStore;
  }>;

export async function createLocalChatSource(
  options: Parameters<typeof openChatStore>[0] = { familiarId: LOCAL_FAMILIAR_ID },
): Promise<LocalChatSource> {
  const store = await openChatStore(options);

  return Object.freeze({
    kind: 'local',
    label: 'This device',
    adapter: createLocalQueryAdapter(store),
    writer: createLocalChatWriter(store),
    isDurable: store.isDurable(),
    store,
  });
}

export function createCaveChatSource(adapter: QueryAdapter): ChatSource {
  return Object.freeze({
    kind: 'cave',
    label: 'Coven Cave',
    adapter,
    writer: createReadOnlyChatWriter(),
    isDurable: true,
  });
}
