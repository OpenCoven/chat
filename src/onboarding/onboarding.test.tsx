import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Setup, SetupReport } from '../lib/setup';
import { Onboarding } from './onboarding';

const CURL = 'curl -fsSL https://claude.ai/install.sh | bash';
const IRM = 'irm https://claude.ai/install.ps1 | iex';

function report(overrides: Partial<SetupReport> = {}): SetupReport {
  return {
    platform: { ok: true, os: 'macos' },
    coven: { ok: true, version: 'coven 0.4.9' },
    engine: { ok: true },
    signIn: {
      ok: true,
      engine: 'signed-out',
      claude: 'signed-in',
      chatgpt: 'signed-out',
      claudeInstaller: CURL,
    },
    familiar: { ok: true, count: 2 },
    ...overrides,
  };
}

function setupReturning(...results: (SetupReport | null | Error)[]): Setup & { calls: number } {
  const queue = [...results];
  const setup = {
    calls: 0,
    async check() {
      setup.calls++;
      const next = queue.length > 1 ? queue.shift() : queue[0];
      if (next instanceof Error) throw next;
      return next ?? null;
    },
  };
  return setup;
}

async function renderWith(setup: Setup) {
  await act(async () => {
    render(
      <Onboarding setup={setup}>
        <p>The chat</p>
      </Onboarding>,
    );
  });
}

const step = (title: string) => screen.getByRole('region', { name: title });

describe('first-run setup', () => {
  it('shows the chat straight away when every step is done', async () => {
    await renderWith(setupReturning(report()));
    expect(screen.getByText('The chat')).toBeInTheDocument();
    expect(screen.queryByText('Set up Coven Chat')).not.toBeInTheDocument();
  });

  it('shows the chat outside the desktop app, where there is nothing to set up', async () => {
    await renderWith(setupReturning(null));
    expect(screen.getByText('The chat')).toBeInTheDocument();
  });

  it('holds the chat back while Coven is missing and names the command', async () => {
    await renderWith(
      setupReturning(
        report({
          coven: { ok: false },
          engine: { ok: false },
          signIn: {
            ok: false,
            engine: 'missing',
            claude: 'missing',
            chatgpt: 'missing',
            claudeInstaller: CURL,
          },
          familiar: { ok: false, count: 0 },
        }),
      ),
    );
    expect(screen.queryByText('The chat')).not.toBeInTheDocument();
    expect(within(step('Coven')).getByText('npm install -g @opencoven/cli')).toBeInTheDocument();
    expect(within(step('Coven engine')).getByText('Install Coven first.')).toBeInTheDocument();
    expect(within(step('Model sign-in')).getByText(CURL)).toBeInTheDocument();
    expect(within(step('Model sign-in')).getByText('claude auth login')).toBeInTheDocument();
    // Coven is required: there is no way past this step yet.
    expect(screen.queryByRole('button', { name: 'Continue to Chat' })).not.toBeInTheDocument();
  });

  it('names the engine command once Coven is installed', async () => {
    await renderWith(setupReturning(report({ engine: { ok: false } })));
    expect(within(step('Coven')).getByText('Installed: coven 0.4.9.')).toBeInTheDocument();
    expect(within(step('Coven engine')).getByText('coven engine install')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Continue to Chat' })).not.toBeInTheDocument();
  });

  it('offers the Windows installer for Claude Code on Windows', async () => {
    await renderWith(
      setupReturning(
        report({
          platform: { ok: true, os: 'windows' },
          signIn: {
            ok: false,
            engine: 'signed-out',
            claude: 'missing',
            chatgpt: 'signed-out',
            claudeInstaller: IRM,
          },
        }),
      ),
    );
    expect(within(step('Model sign-in')).getByText(IRM)).toBeInTheDocument();
  });

  it('lets a person continue when only sign-in or a familiar is missing', async () => {
    await renderWith(
      setupReturning(
        report({
          signIn: {
            ok: false,
            engine: 'unknown',
            claude: 'signed-out',
            chatgpt: 'signed-out',
            claudeInstaller: CURL,
          },
          familiar: { ok: false, count: 0 },
        }),
      ),
    );
    expect(within(step('Model sign-in')).getByText('claude auth login')).toBeInTheDocument();
    expect(within(step('A familiar')).getByText(/do not have a familiar yet/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Continue to Chat' }));
    expect(screen.getByText('The chat')).toBeInTheDocument();
  });

  it('re-checks on demand and opens the chat once everything is in place', async () => {
    const setup = setupReturning(report({ engine: { ok: false } }), report());
    await renderWith(setup);
    expect(screen.queryByText('The chat')).not.toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    });
    expect(setup.calls).toBe(2);
    expect(screen.getByText('The chat')).toBeInTheDocument();
  });

  it('reports a failed check and still lets a person continue', async () => {
    await renderWith(setupReturning(new Error('Local Coven is busy. Retry shortly.')));
    expect(screen.getByRole('alert')).toHaveTextContent('Local Coven is busy. Retry shortly.');
    expect(screen.getByRole('button', { name: 'Check again' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Continue to Chat' }));
    expect(screen.getByText('The chat')).toBeInTheDocument();
  });

  it('names the route a person is signed in with', async () => {
    const check = vi.fn().mockResolvedValue(
      report({
        familiar: { ok: false, count: 0 },
        signIn: {
          ok: true,
          engine: 'signed-out',
          claude: 'signed-out',
          chatgpt: 'signed-in',
          claudeInstaller: CURL,
        },
      }),
    );
    await renderWith({ check });
    expect(within(step('Model sign-in')).getByText('Signed in with ChatGPT.')).toBeInTheDocument();
  });
});
