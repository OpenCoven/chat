import { act, fireEvent, render, screen, within } from '@testing-library/react';

import { MinimalMacOS } from './minimal-macos';
import { chatInScope, MINIMAL_CHATS, projectsOf } from './minimal-mock';

/**
 * Guards for the Minimal (macOS) surface.
 *
 * The design makes claims that are checkable, so they are checked. That a push
 * waits for a decision and then records which one was made; that a familiar's
 * limits are stated in words rather than in colour; that dismissing a question
 * is not an answer to it.
 *
 * Layout is deliberately not asserted. Pixel positions are what the design file
 * is for. What a test can usefully hold is the behaviour underneath.
 */

beforeAll(() => {
  // jsdom implements no layout, so it has no scrollIntoView. The surface
  // scrolls the transcript after every append, which is real behaviour worth
  // keeping; it is simply not what any of these tests are about.
  Element.prototype.scrollIntoView = vi.fn();
});

function openChat(name: RegExp) {
  fireEvent.click(screen.getByRole('button', { name }));
}

function openApproval() {
  fireEvent.click(screen.getByRole('button', { name: /Needs your approval/ }));
}

function openScope() {
  fireEvent.click(
    screen.getByRole('button', { name: /All projects|selected|No projects|Quick chats/ }),
  );
}

function chatTitles(): string[] {
  const list = screen.getByRole('heading', { name: 'Chats' }).parentElement;

  return within(list as HTMLElement)
    .queryAllByRole('button')
    .map((button) => button.textContent ?? '');
}

function openSettings() {
  fireEvent.click(screen.getByRole('button', { name: /Settings…/ }));
}

function type(field: HTMLElement, value: string) {
  fireEvent.change(field, { target: { value } });
}

describe('Minimal (macOS) surface', () => {
  it('opens on the chat that is waiting, and says what it is waiting for', () => {
    render(<MinimalMacOS />);

    expect(screen.getByRole('button', { name: /Attention centre wiring/ })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByText('Cody is waiting for your approval to push the branch.')).toBeVisible();
    expect(screen.getByRole('button', { name: /Needs your approval/ })).toBeVisible();
  });

  it('states in words what a push would do before asking for it', () => {
    render(<MinimalMacOS />);
    openApproval();

    const sheet = screen.getByRole('dialog', { name: 'Approval needed' });

    expect(within(sheet).getByText('Let Cody push this branch?')).toBeVisible();
    expect(within(sheet).getByText('What it sends')).toBeVisible();
    expect(within(sheet).getByText('The code changes and a commit message')).toBeVisible();
    expect(within(sheet).getByText('Can be undone')).toBeVisible();

    // Both answers are offered, as buttons of the same weight. A sheet whose
    // only real control is "Allow" is a sheet that has already decided.
    expect(within(sheet).getByRole('button', { name: "Don't allow" })).toBeVisible();
    expect(within(sheet).getByRole('button', { name: 'Allow once' })).toBeVisible();
  });

  it('shows the changed files only when they are asked for', () => {
    render(<MinimalMacOS />);
    openApproval();

    expect(screen.queryByText('src/lib/attention.ts')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show the 6 changed files' }));

    expect(screen.getByText('src/lib/attention.ts')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Hide the changes' })).toBeVisible();
  });

  it('records a refusal in the transcript rather than letting it disappear', () => {
    render(<MinimalMacOS />);
    openApproval();
    fireEvent.click(screen.getByRole('button', { name: "Don't allow" }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText('You didn’t allow the push. Nothing left this machine.')).toBeVisible();
    // And the request is gone, so nothing can be decided twice by accident.
    expect(screen.queryByRole('button', { name: /Needs your approval/ })).not.toBeInTheDocument();
  });

  it('records an approval, and says what it produced', () => {
    render(<MinimalMacOS />);
    openApproval();
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }));

    expect(screen.getByText('You allowed the push. Draft PR #412 is open.')).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('Pushed. Draft PR #412 is open.');
  });

  it('scopes a standing permission to the project it was granted in', () => {
    render(<MinimalMacOS />);
    openApproval();
    fireEvent.click(screen.getByRole('button', { name: 'Always allow in coven-cave' }));

    expect(screen.getByRole('status')).toHaveTextContent(
      'Always allowed in coven-cave — only there.',
    );
  });

  it('closes a sheet on Escape without deciding anything', () => {
    render(<MinimalMacOS />);
    openApproval();
    fireEvent.keyDown(window, { key: 'Escape' });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText('Cody is waiting for your approval to push the branch.')).toBeVisible();
    expect(screen.getByRole('button', { name: /Needs your approval/ })).toBeVisible();
  });

  it('names a familiar’s limits in words, not only in colour', () => {
    render(<MinimalMacOS />);
    openChat(/^Cody/);

    const sheet = screen.getByRole('dialog', { name: 'Cody' });

    expect(within(sheet).getByText('Push a branch or open a PR')).toBeVisible();
    expect(within(sheet).getAllByText('Asks you').length).toBeGreaterThan(0);
    expect(within(sheet).getByText('Belongs to you · cody.familiar')).toBeVisible();
  });

  it('says plainly when a familiar keeps no memory', () => {
    render(<MinimalMacOS />);
    openChat(/^Echo/);

    const sheet = screen.getByRole('dialog', { name: 'Echo' });

    expect(within(sheet).getByText('Memory')).toBeVisible();
    expect(within(sheet).getByText(/Nothing is kept between chats yet\./)).toBeVisible();
    expect(within(sheet).getByText('Off')).toBeVisible();
  });

  it('marks a quick chat as saving nothing, in the header and at the composer', () => {
    render(<MinimalMacOS />);
    openChat(/Quick chat/);

    expect(screen.getByText('No project · Astra · nothing saved')).toBeVisible();
    expect(screen.getByText('No project context — nothing here is saved')).toBeVisible();
    expect(screen.getByLabelText('Message')).toHaveAttribute(
      'placeholder',
      'Ask anything — nothing is saved…',
    );
  });

  it('sends on Return, and answers in the shape the mode asks for', () => {
    vi.useFakeTimers();

    try {
      render(<MinimalMacOS />);

      const composer = screen.getByLabelText('Message');

      type(composer, 'Ship it');
      fireEvent.keyDown(composer, { key: 'Enter' });

      expect(screen.getByText('Ship it')).toBeVisible();

      act(() => {
        vi.advanceTimersByTime(1000);
      });

      // The composer is in "Plan first", so the reply plans rather than acts.
      expect(
        screen.getByText(
          'Got it. I’ll plan it out first and show you the steps before touching anything.',
        ),
      ).toBeVisible();
    } finally {
      vi.useRealTimers();
    }
  });

  it('offers all three composer modes at once and marks the chosen one', () => {
    // This used to cycle through a single button, which meant two of the three
    // choices were invisible and "what will this do next" was something you
    // found out by clicking. All three are now present and directly
    // selectable, so the test asserts the choice rather than the rotation.
    render(<MinimalMacOS />);

    const plan = screen.getByRole('button', { name: 'Plan first' });
    const answer = screen.getByRole('button', { name: 'Just answer' });
    const ahead = screen.getByRole('button', { name: 'Go ahead' });

    // Exactly one is pressed, and it is the one naming itself.
    expect(plan).toHaveAttribute('aria-pressed', 'true');
    expect(answer).toHaveAttribute('aria-pressed', 'false');
    expect(ahead).toHaveAttribute('aria-pressed', 'false');
    expect(plan).toHaveTextContent('Plan');

    fireEvent.click(ahead);

    expect(ahead).toHaveAttribute('aria-pressed', 'true');
    expect(plan).toHaveAttribute('aria-pressed', 'false');
    expect(ahead).toHaveTextContent('Build');

    // The full phrase stays the accessible name. "Build" does not say that the
    // familiar is about to act without checking first; "Go ahead" does.
    expect(ahead).toHaveAccessibleName('Go ahead');
  });

  it('closes a sheet when the backdrop is clicked', () => {
    render(<MinimalMacOS />);

    openSettings();
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument();

    // Queried by class rather than by role: the backdrop is deliberately
    // hidden from assistive technology and out of the tab order, because a
    // full-bleed tab stop between a dialog and its contents is not a
    // courtesy. Escape is the keyboard path, and it has its own test above.
    const backdrop = document.querySelector('.mm-scrim-close');

    expect(backdrop).not.toBeNull();
    fireEvent.click(backdrop as Element);
    expect(screen.queryByRole('dialog', { name: 'Settings' })).not.toBeInTheDocument();
  });

  it('closes the project picker on Escape', () => {
    // The surface teaches Escape as "close the thing on top". A menu that
    // ignored it would be the one exception a user has to learn.
    render(<MinimalMacOS />);

    openScope();
    expect(screen.getByRole('menuitemradio', { name: 'All projects' })).toBeVisible();

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(screen.queryByRole('menuitemradio', { name: 'All projects' })).not.toBeInTheDocument();
  });

  it('filters both chats and familiars from one search field', () => {
    render(<MinimalMacOS />);
    type(screen.getByLabelText('Search chats and familiars'), 'astra');

    expect(screen.getByRole('button', { name: /^Astra/ })).toBeVisible();
    expect(screen.queryByRole('button', { name: /Release note draft/ })).not.toBeInTheDocument();
  });

  it('keeps the run steps behind a disclosure, with a way to stop it', () => {
    render(<MinimalMacOS />);

    expect(screen.queryByText('Added the mapper (+82 −4)')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Running tests/ }));

    expect(screen.getByText('Added the mapper (+82 −4)')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));

    expect(screen.getByRole('status')).toHaveTextContent(
      'Stopped after step 5. Nothing was pushed.',
    );
  });

  it('opens settings from the keyboard shortcut this platform uses', () => {
    render(<MinimalMacOS />);
    fireEvent.keyDown(window, { key: ',', metaKey: true });

    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  });

  it('keeps the ask-first promise above whatever the settings say', () => {
    render(<MinimalMacOS />);
    openSettings();
    fireEvent.click(screen.getByRole('tab', { name: 'Familiars' }));

    expect(
      screen.getByText(
        'Anything that leaves this Mac or can’t be undone asks you first, whatever these say.',
      ),
    ).toBeVisible();
  });

  it('offers the appearance choice as a real radio group', () => {
    render(<MinimalMacOS />);
    openSettings();
    fireEvent.click(screen.getByRole('tab', { name: 'Appearance' }));

    expect(screen.getByRole('radio', { name: 'Dark' })).toBeChecked();

    fireEvent.click(screen.getByRole('radio', { name: 'Light' }));

    expect(screen.getByRole('radio', { name: 'Light' })).toBeChecked();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Light mode ships too — this prototype shows dark.',
    );
  });

  it('reports a switch state to assistive technology, not only to the eye', () => {
    render(<MinimalMacOS />);
    openSettings();

    const startup = screen.getByRole('switch', { name: 'Open at login' });

    expect(startup).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(startup);

    expect(startup).toHaveAttribute('aria-checked', 'true');
  });

  it('opens a generated image into a viewer that closes again', () => {
    render(<MinimalMacOS />);
    openChat(/Quick chat/);
    fireEvent.click(screen.getByRole('button', { name: 'Open image in viewer' }));

    const viewer = screen.getByRole('button', { name: /Close A purple cat/ });

    expect(viewer).toBeVisible();

    fireEvent.click(viewer);

    expect(screen.queryByRole('button', { name: /Close A purple cat/ })).not.toBeInTheDocument();
  });

  it('hides and restores the sidebar', () => {
    render(<MinimalMacOS />);
    fireEvent.click(screen.getByRole('button', { name: 'Hide sidebar' }));

    expect(screen.queryByLabelText('Search chats and familiars')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show sidebar' }));

    expect(screen.getByLabelText('Search chats and familiars')).toBeVisible();
  });

  it('shows what a familiar is doing right now in the activity panel', () => {
    render(<MinimalMacOS />);
    fireEvent.click(screen.getByRole('button', { name: 'Show activity' }));

    const panel = screen.getByRole('complementary', { name: 'Activity' });

    expect(within(panel).getByText('Waiting to push the branch')).toBeVisible();
    expect(within(panel).getByText('src/lib/attention.ts')).toBeVisible();
  });

  it('derives the project list from the chats, and copes with there being none', () => {
    // The empty case is the one worth pinning: a surface with no projects yet
    // is the state every new install is in, and it must not be a special
    // branch nobody exercised.
    expect(projectsOf([])).toEqual([]);
    expect(projectsOf(MINIMAL_CHATS)).toEqual(['coven-cave', 'grimoire']);
  });

  it('treats an empty scope as everything rather than as nothing', () => {
    // Deselecting the last project has to return you to all of them. The
    // alternative is a blank list with no visible way back out of it.
    const nothingSelected = new Set<string | null>();

    for (const chat of MINIMAL_CHATS) {
      expect(chatInScope(chat, nothingSelected)).toBe(true);
    }
  });

  it('scopes chats to a selected project, and to several at once', () => {
    render(<MinimalMacOS />);

    expect(chatTitles().join(' ')).toContain('Release note draft');

    openScope();
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'coven-cave' }));

    // grimoire's chat is gone; coven-cave's remain.
    expect(chatTitles().join(' ')).not.toContain('Release note draft');
    expect(chatTitles().join(' ')).toContain('Attention centre wiring');

    // Multiselect: adding grimoire brings its chat back alongside.
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'grimoire' }));
    expect(chatTitles().join(' ')).toContain('Release note draft');
    expect(chatTitles().join(' ')).toContain('Attention centre wiring');
  });

  it('keeps quick chats selectable on their own terms', () => {
    // A quick chat belongs to no project, so filtering by project would drop
    // it entirely. It is offered as its own entry instead of being silently
    // swept in or out.
    render(<MinimalMacOS />);

    openScope();
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Quick chats' }));

    expect(chatTitles().join(' ')).toContain('Quick chat');
    expect(chatTitles().join(' ')).not.toContain('Release note draft');
  });

  it('never hides the chat you are reading, whatever the scope', () => {
    // Filtering the sidebar must not contradict the transcript beside it.
    render(<MinimalMacOS />);

    openChat(/Release note draft/);

    openScope();
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'coven-cave' }));

    expect(chatTitles().join(' ')).toContain('Release note draft');
  });

  it('returns to everything when the scope is cleared', () => {
    render(<MinimalMacOS />);

    openScope();
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'coven-cave' }));
    expect(chatTitles().join(' ')).not.toContain('Release note draft');

    fireEvent.click(screen.getByRole('menuitemradio', { name: 'All projects' }));
    expect(chatTitles().join(' ')).toContain('Release note draft');
  });
});
