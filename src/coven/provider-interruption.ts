import type { CovenRunEvent } from '../lib/coven-runtime';

const EXIT = 'coven-code exited with code 1: ';
const PROVIDER = "API error: Provider 'anthropic' stream error (success): ";
const LIMIT =
  /^You've hit your 5-hour limit · resets ((?:1[0-2]|[1-9]):[0-5]\d[ap]m \([A-Za-z_+-]+(?:\/[A-Za-z0-9_+-]+)*\))$/;

type Interruption = { notices: Set<string>; reset?: string; first: number };

/** Match only a provider-authored interruption or a recognized legacy terminal report. */
export function providerInterruptions(events: readonly CovenRunEvent[]) {
  const bySession = new Map<string, Interruption>();
  for (const [index, event] of events.entries()) {
    const session = event.session_id;
    if (!session || typeof session !== 'string') continue;
    let notice: string | undefined;
    let reset: string | undefined;
    if (event.type === 'provider_limit' && event.version === 1) {
      const info = event.limit;
      if (
        !info ||
        typeof info !== 'object' ||
        !('provider_session_id' in info) ||
        typeof info.provider_session_id !== 'string' ||
        !info.provider_session_id
      )
        continue;
      if ('notice' in info && typeof info.notice === 'string') notice = info.notice;
      if (
        'resets_at' in info &&
        typeof info.resets_at === 'number' &&
        Number.isSafeInteger(info.resets_at) &&
        info.resets_at > 0 &&
        info.resets_at <= 253402300799
      ) {
        reset = new Date(info.resets_at * 1000)
          .toISOString()
          .replace('T', ' ')
          .replace('.000Z', ' UTC');
      }
    } else {
      if (
        event.type !== 'result' ||
        event.is_error !== true ||
        typeof event.error !== 'string' ||
        !event.error.startsWith(EXIT)
      )
        continue;
      try {
        const inner = JSON.parse(event.error.slice(EXIT.length));
        if (
          inner?.type !== 'error' ||
          typeof inner.error !== 'string' ||
          !inner.error.startsWith(PROVIDER)
        )
          continue;
        const message = inner.error.slice(PROVIDER.length);
        if (!LIMIT.test(message)) continue;
        notice = message;
      } catch {
        continue;
      }
    }
    const record: Interruption = bySession.get(session) ?? { notices: new Set(), first: index };
    if (notice) {
      record.notices.add(notice);
      const local = LIMIT.exec(notice.replace(/^API Error: Request rejected \(429\) · /, ''))?.[1];
      if (local && !record.reset) record.reset = local;
    }
    if (reset) record.reset = reset;
    bySession.set(session, record);
  }
  return bySession;
}
