import type { ChatWriter } from './local/chat-writer';
import type { BringBackInput } from './local/side-conversations';

export type DraftSnapshot = Readonly<{
  text: string;
  pending: boolean;
  error: string;
  writes: number;
}>;

export function createDraft() {
  let snapshot: DraftSnapshot = { text: '', pending: false, error: '', writes: 0 };
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    update(next: Partial<DraftSnapshot>) {
      snapshot = { ...snapshot, ...next };
      for (const listener of listeners) listener();
    },
  };
}

type SideReviewSnapshot = Readonly<{
  selected: readonly string[];
  review: BringBackInput | null;
  phase: 'idle' | 'preparing' | 'editing' | 'sending' | 'uncertain' | 'rejected';
  notice: string;
  writes: number;
}>;

export function createSideReview() {
  let snapshot: SideReviewSnapshot = {
    selected: [],
    review: null,
    phase: 'idle',
    notice: '',
    writes: 0,
  };
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    update(next: Partial<SideReviewSnapshot>) {
      snapshot = { ...snapshot, ...next };
      for (const listener of listeners) listener();
    },
  };
}

export type ContinuityMemory = {
  id: number;
  familiarId: string | null;
  conversations: Map<string, string>;
  anchors: Map<string, string>;
  drafts: Map<string, ReturnType<typeof createDraft>>;
  sideReviews: Map<string, ReturnType<typeof createSideReview>>;
};

const memories = new WeakMap<object, Map<ChatWriter | null, ContinuityMemory>>();
let sequence = 0;

/** Object identity, not names/URLs, scopes references and unsaved drafts to a live source. */
export function continuityMemory(source: object, writer: ChatWriter | null): ContinuityMemory {
  let writers = memories.get(source);
  if (!writers) {
    writers = new Map();
    memories.set(source, writers);
  }
  let memory = writers.get(writer);
  if (!memory) {
    memory = {
      id: ++sequence,
      familiarId: null,
      conversations: new Map(),
      anchors: new Map(),
      drafts: new Map(),
      sideReviews: new Map(),
    };
    writers.set(writer, memory);
  }
  return memory;
}

export function sideReviewMemory(
  memory: ContinuityMemory,
  familiarId: string,
  parentId: string,
  sideId: string,
) {
  const key = JSON.stringify([familiarId, parentId, sideId]);
  let entry = memory.sideReviews.get(key);
  if (!entry) {
    entry = createSideReview();
    memory.sideReviews.set(key, entry);
  }
  return entry;
}

export function exactThreadKey(familiarId: string, conversationId: string): string {
  return JSON.stringify([familiarId, conversationId]);
}
