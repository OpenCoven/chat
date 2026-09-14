import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { CovenRuntime, CovenSession } from '../lib/coven-runtime';
import { ChatApp } from './chat-app';

const importedId = `cave-import-${'a'.repeat(64)}`;
vi.mock('./cave-import', () => ({
  CaveImport: ({ onImported }: { onImported: (id: string) => Promise<void> }) => (
    <button type="button" onClick={() => void onImported(`cave-import-${'a'.repeat(64)}`)}>
      Confirm test Cave import
    </button>
  ),
}));
const imported: CovenSession = {
  id: importedId,
  title: 'Saved Cave conversation',
  status: 'imported',
  harness: 'cave-import',
  updatedAt: '2026-09-14',
  projectRoot: '',
};
function runtime(): CovenRuntime {
  return {
    status: vi.fn().mockResolvedValue({ available: true }),
    listFamiliars: vi.fn().mockResolvedValue([]),
    listSessions: vi.fn().mockResolvedValue([]),
    readSession: vi.fn().mockResolvedValue({
      session: imported,
      events: [
        {
          type: 'user',
          source: 'cave-import',
          message: { role: 'user', content: [{ type: 'text', text: 'Retained Cave text' }] },
        },
      ],
    }),
    send: vi.fn(),
    cancel: vi.fn(),
    changeChatLifecycle: vi.fn(),
  };
}

beforeEach(() => {
  localStorage.clear();
});

it('hides and persists removal of stale external navigation without reading it', async () => {
  localStorage.setItem(
    'opencoven.chat.navigation.v1',
    JSON.stringify({
      familiarId: '',
      sessionId: 'external-cli-session',
      drafts: {},
    }),
  );
  const api = runtime();
  render(<ChatApp runtime={api} />);
  await waitFor(() => expect(screen.getByRole('textbox')).toBeEnabled());
  expect(api.readSession).not.toHaveBeenCalled();
  expect(JSON.parse(localStorage.getItem('opencoven.chat.navigation.v1') ?? '{}').sessionId).toBe(
    '',
  );
});

it('explicit import refreshes, opens a read-only snapshot, and retains it after reload', async () => {
  const api = runtime();
  const mounted = render(<ChatApp runtime={api} />);
  await waitFor(() => expect(screen.getByRole('textbox')).toBeEnabled());
  vi.mocked(api.listSessions).mockResolvedValue([imported]);
  fireEvent.click(screen.getByRole('button', { name: 'Confirm test Cave import' }));
  expect(await screen.findByText('Retained Cave text')).toBeInTheDocument();
  expect(screen.getByRole('textbox')).toBeDisabled();
  expect(screen.getByText(/read-only snapshot/)).toBeInTheDocument();
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
  expect(api.send).not.toHaveBeenCalled();
  expect(JSON.parse(localStorage.getItem('opencoven.chat.navigation.v1') ?? '{}').sessionId).toBe(
    importedId,
  );
  mounted.unmount();
  await act(async () => {
    render(<ChatApp runtime={api} />);
  });
  expect(await screen.findByText('Retained Cave text')).toBeInTheDocument();
  expect(screen.getByRole('textbox')).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
  await waitFor(() => expect(screen.getByRole('textbox')).toBeEnabled());
});
