import type { OperationOptions, Page, PageOptions } from '@opencoven/sdk-core/browser';

export const MAX_CHAPTER_PAGE_LIMIT = 50;

export type ConversationChapter = Readonly<{
  id: string;
  conversationId: string;
  day: string;
  firstTurnId: string;
  lastTurnId: string;
  turnCount: number;
}>;

export type ConversationChapterPage = Page<ConversationChapter> &
  Readonly<{
    conversationId: string;
    rule: 'utc-day-v1';
    contextStatus: 'context-unverified';
    sourceRevision: string;
    status: 'complete' | 'partial' | 'unavailable';
  }>;

/** Typed DEVELOPMENT source port, not an alternative HTTP/native bridge. */
export type DevelopmentChapterReadClient = {
  listConversationChapters?(
    conversationId: string,
    options?: PageOptions & OperationOptions,
  ): Promise<ConversationChapterPage>;
};

export function hasValidChapterHeaders(
  page: ConversationChapterPage,
  conversationId: string,
  previous: readonly ConversationChapter[] = [],
): boolean {
  if (
    page.conversationId !== conversationId ||
    page.rule !== 'utc-day-v1' ||
    page.contextStatus !== 'context-unverified' ||
    typeof page.sourceRevision !== 'string' ||
    !page.sourceRevision ||
    !['complete', 'partial', 'unavailable'].includes(page.status) ||
    !Array.isArray(page.data) ||
    page.data.length > MAX_CHAPTER_PAGE_LIMIT
  )
    return false;
  const ids = new Set(previous.map((chapter) => chapter.id));
  const anchors = new Set(previous.map((chapter) => chapter.firstTurnId));
  for (const chapter of page.data) {
    if (
      !chapter ||
      chapter.conversationId !== conversationId ||
      typeof chapter.id !== 'string' ||
      !chapter.id ||
      ids.has(chapter.id) ||
      typeof chapter.firstTurnId !== 'string' ||
      !chapter.firstTurnId ||
      anchors.has(chapter.firstTurnId) ||
      typeof chapter.lastTurnId !== 'string' ||
      !chapter.lastTurnId ||
      typeof chapter.day !== 'string' ||
      utcChapterDay(`${chapter.day}T00:00:00Z`) !== chapter.day ||
      !Number.isSafeInteger(chapter.turnCount) ||
      chapter.turnCount < 1
    )
      return false;
    ids.add(chapter.id);
    anchors.add(chapter.firstTurnId);
  }
  return true;
}

/** Producer utc-day-v1 accepts UTC seconds or exactly three fractional digits. */
export function utcChapterDay(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, milliseconds] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return null;
  const instant = new Date(0);
  instant.setUTCFullYear(year, month - 1, day);
  instant.setUTCHours(hour, minute, second, Number(milliseconds ?? 0));
  const iso = instant.toISOString();
  const canonical = milliseconds === undefined ? iso.replace('.000Z', 'Z') : iso;
  return canonical === value ? iso.slice(0, 10) : null;
}

/** utc-day-v1: consecutive runs in canonical branch order, never a time sort. */
export function loadedConversationChapters(
  conversationId: string,
  turns: readonly { id: string; conversationId: string; createdAt: string }[],
): readonly ConversationChapter[] | null {
  if (!conversationId || !turns.length) return null;
  const chapters: ConversationChapter[] = [];
  const seen = new Set<string>();
  let chapter: ConversationChapter | undefined;
  for (const turn of turns) {
    const day = utcChapterDay(turn.createdAt);
    if (!day || !turn.id || seen.has(turn.id) || turn.conversationId !== conversationId)
      return null;
    seen.add(turn.id);
    if (chapter?.day === day) {
      chapter = { ...chapter, lastTurnId: turn.id, turnCount: chapter.turnCount + 1 };
      chapters[chapters.length - 1] = chapter;
    } else {
      chapter = {
        id: JSON.stringify(['utc-day-v1', conversationId, turn.id]),
        conversationId,
        day,
        firstTurnId: turn.id,
        lastTurnId: turn.id,
        turnCount: 1,
      };
      chapters.push(chapter);
    }
  }
  return chapters;
}

export function chapterTurnElementId(conversationId: string, turnId: string): string {
  return `chapter-turn-${encodeURIComponent(JSON.stringify([conversationId, turnId]))}`;
}
