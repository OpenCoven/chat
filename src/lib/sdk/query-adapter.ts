import {
  type AuthorityReference,
  type CaveCanonicalFamiliar,
  type CaveConversation,
  type CaveConversationMessage,
  type CaveProject,
  type NativeBoundary,
  NativeBoundaryError,
  type Page,
  type PageOptions,
} from './native-boundary';

const PAGE_LIMIT = 25;
const MAX_PAGES = 8;

type QueryStatus = 'idle' | 'loading' | 'ready' | 'error';

export type ListQueryState<T> = Readonly<{
  status: QueryStatus;
  data: readonly T[];
  hasMore: boolean;
  nextCursor?: string;
  pageCount: number;
  reconcileCount: number;
  authorityGeneration: number | null;
  code?: string;
}>;

export type DetailQueryState<T> = Readonly<{
  status: QueryStatus;
  data: T | null;
  reconcileCount: number;
  authorityGeneration: number | null;
  code?: string;
}>;

export type CanonicalQueryState = Readonly<{
  familiars: ListQueryState<CaveCanonicalFamiliar>;
  projects: ListQueryState<CaveProject>;
  conversations: ListQueryState<CaveConversation>;
}>;

export interface QueryAdapter {
  getState(): CanonicalQueryState;
  subscribe(listener: () => void): () => void;
  loadFamiliars(): Promise<void>;
  loadProjects(): Promise<void>;
  loadConversations(): Promise<void>;
  loadMoreConversations(): Promise<void>;
  loadConversation(conversationId: string): Promise<void>;
  loadMessages(conversationId: string): Promise<void>;
  loadMoreMessages(conversationId: string): Promise<void>;
  getConversationState(conversationId: string): DetailQueryState<CaveConversation>;
  getMessageState(conversationId: string): ListQueryState<CaveConversationMessage>;
  invalidateAuthority(): void;
}

type QueryAdapterOptions = Readonly<{
  authority: () => AuthorityReference | null;
  requestId?: () => string;
  onAuthorityFailure?: (error: NativeBoundaryError) => void;
}>;

type ListName = 'familiars' | 'projects' | 'conversations';
type ListEntryMap = {
  familiars: CaveCanonicalFamiliar;
  projects: CaveProject;
  conversations: CaveConversation;
};

function defaultRequestId(): string {
  return `query:${crypto.randomUUID()}`;
}

function emptyList<T>(reconcileCount = 0): ListQueryState<T> {
  return Object.freeze({
    status: 'idle',
    data: Object.freeze([]),
    hasMore: false,
    pageCount: 0,
    reconcileCount,
    authorityGeneration: null,
  });
}

function emptyDetail<T>(reconcileCount = 0): DetailQueryState<T> {
  return Object.freeze({
    status: 'idle',
    data: null,
    reconcileCount,
    authorityGeneration: null,
  });
}

function sameAuthority(left: AuthorityReference | null, right: AuthorityReference): boolean {
  return left !== null && left.handle === right.handle && left.generation === right.generation;
}

function errorCode(error: unknown): string {
  return error instanceof NativeBoundaryError ? error.code : 'invalid_response';
}

class DefaultQueryAdapter implements QueryAdapter {
  readonly #reads: NativeBoundary;
  readonly #authority: () => AuthorityReference | null;
  readonly #requestId: () => string;
  readonly #onAuthorityFailure: ((error: NativeBoundaryError) => void) | undefined;
  readonly #listeners = new Set<() => void>();
  readonly #requestGenerations = new Map<string, number>();
  readonly #seenCursors = new Map<string, Set<string>>();
  readonly #conversationDetails = new Map<string, DetailQueryState<CaveConversation>>();
  readonly #messagePages = new Map<string, ListQueryState<CaveConversationMessage>>();
  #authorityGeneration: number | null = null;
  #state: CanonicalQueryState = Object.freeze({
    familiars: emptyList<CaveCanonicalFamiliar>(),
    projects: emptyList<CaveProject>(),
    conversations: emptyList<CaveConversation>(),
  });

  constructor(reads: NativeBoundary, options: QueryAdapterOptions) {
    this.#reads = reads;
    this.#authority = options.authority;
    this.#requestId = options.requestId ?? defaultRequestId;
    this.#onAuthorityFailure = options.onAuthorityFailure;
  }

  getState(): CanonicalQueryState {
    return this.#state;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  loadFamiliars(): Promise<void> {
    return this.#loadList('familiars', false);
  }

  loadProjects(): Promise<void> {
    return this.#loadList('projects', false);
  }

  loadConversations(): Promise<void> {
    return this.#loadList('conversations', false);
  }

  loadMoreConversations(): Promise<void> {
    return this.#loadList('conversations', true);
  }

  loadConversation(conversationId: string): Promise<void> {
    return this.#loadDetail(conversationId, true);
  }

  loadMessages(conversationId: string): Promise<void> {
    return this.#loadMessagePage(conversationId, false, true);
  }

  loadMoreMessages(conversationId: string): Promise<void> {
    return this.#loadMessagePage(conversationId, true, true);
  }

  getConversationState(conversationId: string): DetailQueryState<CaveConversation> {
    return this.#conversationDetails.get(conversationId) ?? emptyDetail();
  }

  getMessageState(conversationId: string): ListQueryState<CaveConversationMessage> {
    return this.#messagePages.get(conversationId) ?? emptyList();
  }

  invalidateAuthority(): void {
    this.#authorityGeneration = null;
    this.#requestGenerations.clear();
    this.#seenCursors.clear();
    this.#conversationDetails.clear();
    this.#messagePages.clear();
    this.#state = Object.freeze({
      familiars: emptyList<CaveCanonicalFamiliar>(),
      projects: emptyList<CaveProject>(),
      conversations: emptyList<CaveConversation>(),
    });
    this.#emit();
  }

  async #loadList<K extends ListName>(
    name: K,
    append: boolean,
    allowReconcile = true,
  ): Promise<void> {
    const authority = this.#prepareAuthority();
    if (authority === null) {
      return;
    }
    const current = this.#state[name] as ListQueryState<ListEntryMap[K]>;
    if (append && (!current.hasMore || current.pageCount >= MAX_PAGES)) {
      return;
    }
    const cursor = append ? current.nextCursor : undefined;
    const options: PageOptions =
      cursor === undefined ? { limit: PAGE_LIMIT } : { limit: PAGE_LIMIT, cursor };
    const key = `list:${name}`;
    const requestGeneration = this.#nextRequestGeneration(key);
    const reconcileCount = append ? current.reconcileCount : current.reconcileCount;
    this.#setList(name, {
      ...current,
      status: 'loading',
      ...(append ? {} : { data: Object.freeze([]), pageCount: 0, hasMore: false }),
      authorityGeneration: authority.generation,
      reconcileCount,
    });
    try {
      const page = await this.#readList(name, authority, this.#requestId(), options);
      if (!this.#isCurrent(key, requestGeneration, authority)) {
        return;
      }
      this.#applyPage(name, page, cursor, append, authority);
    } catch (error) {
      if (!this.#isCurrent(key, requestGeneration, authority)) {
        return;
      }
      if (
        allowReconcile &&
        error instanceof NativeBoundaryError &&
        error.code === 'reconcile_required'
      ) {
        const nextReconcileCount = current.reconcileCount + 1;
        this.#seenCursors.delete(key);
        this.#setList(name, emptyList(nextReconcileCount));
        await this.#loadList(name, false, false);
        return;
      }
      this.#reportAuthorityFailure(error);
      this.#setList(name, {
        ...current,
        status: 'error',
        hasMore: false,
        authorityGeneration: authority.generation,
        code: errorCode(error),
      });
    }
  }

  #readList<K extends ListName>(
    name: K,
    authority: AuthorityReference,
    requestId: string,
    options: PageOptions,
  ): Promise<Page<ListEntryMap[K]>> {
    if (name === 'familiars') {
      return this.#reads.listFamiliars(authority, requestId, options) as Promise<
        Page<ListEntryMap[K]>
      >;
    }
    if (name === 'projects') {
      return this.#reads.listProjects(authority, requestId, options) as Promise<
        Page<ListEntryMap[K]>
      >;
    }
    return this.#reads.listConversations(authority, requestId, options) as Promise<
      Page<ListEntryMap[K]>
    >;
  }

  #applyPage<K extends ListName>(
    name: K,
    page: Page<ListEntryMap[K]>,
    requestedCursor: string | undefined,
    append: boolean,
    authority: AuthorityReference,
  ): void {
    const key = `list:${name}`;
    const current = this.#state[name] as ListQueryState<ListEntryMap[K]>;
    const seen = this.#seenCursors.get(key) ?? new Set<string>();
    if (requestedCursor !== undefined && page.cursor?.current !== requestedCursor) {
      this.#setListError(name, current, authority, 'invalid_response');
      return;
    }
    if (page.cursor?.current !== undefined) {
      seen.add(page.cursor.current);
    }
    const next = page.cursor?.hasMore === true ? page.cursor.next : undefined;
    if (
      page.cursor?.hasMore === true &&
      (next === undefined || next === page.cursor.current || seen.has(next))
    ) {
      this.#seenCursors.set(key, seen);
      this.#setListError(name, current, authority, 'invalid_response');
      return;
    }
    const pageCount = (append ? current.pageCount : 0) + 1;
    const hasMore = page.cursor?.hasMore === true && pageCount < MAX_PAGES;
    this.#seenCursors.set(key, seen);
    this.#setList(name, {
      status: 'ready',
      data: append ? Object.freeze([...current.data, ...page.data]) : page.data,
      hasMore,
      ...(hasMore && next !== undefined ? { nextCursor: next } : {}),
      pageCount,
      reconcileCount: current.reconcileCount,
      authorityGeneration: authority.generation,
    });
  }

  #setListError<K extends ListName>(
    name: K,
    current: ListQueryState<ListEntryMap[K]>,
    authority: AuthorityReference,
    queryCode: string,
  ): void {
    this.#setList(name, {
      ...current,
      status: 'error',
      hasMore: false,
      authorityGeneration: authority.generation,
      code: queryCode,
    });
  }

  async #loadDetail(conversationId: string, allowReconcile: boolean): Promise<void> {
    const authority = this.#prepareAuthority();
    if (authority === null) {
      return;
    }
    const key = `conversation:${conversationId}`;
    const requestGeneration = this.#nextRequestGeneration(key);
    const current = this.getConversationState(conversationId);
    this.#conversationDetails.set(
      conversationId,
      Object.freeze({
        ...current,
        status: 'loading',
        authorityGeneration: authority.generation,
      }),
    );
    this.#emit();
    try {
      const conversation = await this.#reads.getConversation(
        authority,
        this.#requestId(),
        conversationId,
      );
      if (!this.#isCurrent(key, requestGeneration, authority)) {
        return;
      }
      this.#conversationDetails.set(
        conversationId,
        Object.freeze({
          status: 'ready',
          data: conversation,
          reconcileCount: current.reconcileCount,
          authorityGeneration: authority.generation,
        }),
      );
      this.#emit();
    } catch (error) {
      if (!this.#isCurrent(key, requestGeneration, authority)) {
        return;
      }
      if (
        allowReconcile &&
        error instanceof NativeBoundaryError &&
        error.code === 'reconcile_required'
      ) {
        this.#conversationDetails.set(conversationId, emptyDetail(current.reconcileCount + 1));
        await this.#loadDetail(conversationId, false);
        return;
      }
      this.#reportAuthorityFailure(error);
      this.#conversationDetails.set(
        conversationId,
        Object.freeze({
          ...current,
          status: 'error',
          authorityGeneration: authority.generation,
          code: errorCode(error),
        }),
      );
      this.#emit();
    }
  }

  async #loadMessagePage(
    conversationId: string,
    append: boolean,
    allowReconcile: boolean,
  ): Promise<void> {
    const authority = this.#prepareAuthority();
    if (authority === null) {
      return;
    }
    const key = `messages:${conversationId}`;
    const current = this.getMessageState(conversationId);
    if (append && (!current.hasMore || current.pageCount >= MAX_PAGES)) {
      return;
    }
    const cursor = append ? current.nextCursor : undefined;
    const options: PageOptions =
      cursor === undefined ? { limit: PAGE_LIMIT } : { limit: PAGE_LIMIT, cursor };
    const requestGeneration = this.#nextRequestGeneration(key);
    this.#messagePages.set(
      conversationId,
      Object.freeze({
        ...current,
        status: 'loading',
        ...(append ? {} : { data: Object.freeze([]), pageCount: 0, hasMore: false }),
        authorityGeneration: authority.generation,
      }),
    );
    this.#emit();
    try {
      const page = await this.#reads.listConversationMessages(
        authority,
        this.#requestId(),
        conversationId,
        options,
      );
      if (!this.#isCurrent(key, requestGeneration, authority)) {
        return;
      }
      const latest = this.getMessageState(conversationId);
      const seen = this.#seenCursors.get(key) ?? new Set<string>();
      if (cursor !== undefined && page.cursor?.current !== cursor) {
        this.#setMessageError(conversationId, latest, authority, 'invalid_response');
        return;
      }
      if (page.cursor?.current !== undefined) {
        seen.add(page.cursor.current);
      }
      const next = page.cursor?.hasMore === true ? page.cursor.next : undefined;
      if (
        page.cursor?.hasMore === true &&
        (next === undefined || next === page.cursor.current || seen.has(next))
      ) {
        this.#seenCursors.set(key, seen);
        this.#setMessageError(conversationId, latest, authority, 'invalid_response');
        return;
      }
      const pageCount = (append ? current.pageCount : 0) + 1;
      const hasMore = page.cursor?.hasMore === true && pageCount < MAX_PAGES;
      this.#seenCursors.set(key, seen);
      this.#messagePages.set(
        conversationId,
        Object.freeze({
          status: 'ready',
          data: append ? Object.freeze([...current.data, ...page.data]) : page.data,
          hasMore,
          ...(hasMore && next !== undefined ? { nextCursor: next } : {}),
          pageCount,
          reconcileCount: current.reconcileCount,
          authorityGeneration: authority.generation,
        }),
      );
      this.#emit();
    } catch (error) {
      if (!this.#isCurrent(key, requestGeneration, authority)) {
        return;
      }
      if (
        allowReconcile &&
        error instanceof NativeBoundaryError &&
        error.code === 'reconcile_required'
      ) {
        this.#seenCursors.delete(key);
        this.#messagePages.set(conversationId, emptyList(current.reconcileCount + 1));
        await this.#loadMessagePage(conversationId, false, false);
        return;
      }
      this.#reportAuthorityFailure(error);
      this.#setMessageError(conversationId, current, authority, errorCode(error));
    }
  }

  #setMessageError(
    conversationId: string,
    current: ListQueryState<CaveConversationMessage>,
    authority: AuthorityReference,
    queryCode: string,
  ): void {
    this.#messagePages.set(
      conversationId,
      Object.freeze({
        ...current,
        status: 'error',
        hasMore: false,
        authorityGeneration: authority.generation,
        code: queryCode,
      }),
    );
    this.#emit();
  }

  #prepareAuthority(): AuthorityReference | null {
    const authority = this.#authority();
    if (authority === null) {
      return null;
    }
    if (this.#authorityGeneration !== null && this.#authorityGeneration !== authority.generation) {
      this.invalidateAuthority();
    }
    this.#authorityGeneration = authority.generation;
    return authority;
  }

  #nextRequestGeneration(key: string): number {
    const generation = (this.#requestGenerations.get(key) ?? 0) + 1;
    this.#requestGenerations.set(key, generation);
    return generation;
  }

  #isCurrent(key: string, requestGeneration: number, authority: AuthorityReference): boolean {
    return (
      this.#requestGenerations.get(key) === requestGeneration &&
      sameAuthority(this.#authority(), authority)
    );
  }

  #setList<K extends ListName>(name: K, value: ListQueryState<ListEntryMap[K]>): void {
    this.#state = Object.freeze({ ...this.#state, [name]: Object.freeze(value) });
    this.#emit();
  }

  #reportAuthorityFailure(error: unknown): void {
    if (error instanceof NativeBoundaryError && error.code !== 'reconcile_required') {
      this.#onAuthorityFailure?.(error);
    }
  }

  #emit(): void {
    for (const listener of this.#listeners) {
      listener();
    }
  }
}

export function createQueryAdapter(
  reads: NativeBoundary,
  options: QueryAdapterOptions,
): QueryAdapter {
  return new DefaultQueryAdapter(reads, options);
}

export const CANONICAL_PAGE_LIMIT = PAGE_LIMIT;
export const CANONICAL_MAX_PAGES = MAX_PAGES;
