import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Composer } from './composer';
import { rowsFor } from './textarea';

/**
 * The vendored OpenCoven/ui composer, held to the library's own contract
 * (one filled action, labelled progress, non-colour state) plus the keyboard
 * model it leaves to the consumer.
 */

function renderComposer(overrides: Partial<Parameters<typeof Composer>[0]> = {}) {
  const props = {
    value: '',
    onValueChange: vi.fn(),
    onSend: vi.fn(),
    onStop: vi.fn(),
    label: 'Message Astra',
    ...overrides,
  };
  const view = render(<Composer {...props} />);

  return { ...view, props };
}

describe('Composer', () => {
  it('keeps to one filled action control, disabled until there is a draft', () => {
    const { container, rerender, props } = renderComposer();

    expect(container.querySelectorAll('[data-slot="send-control"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-variant="primary"]')).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();

    rerender(<Composer {...props} value="Map the evidence" />);
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(props.onSend).toHaveBeenCalledOnce();
  });

  it('names its field after who is addressed', () => {
    renderComposer();

    expect(screen.getByRole('textbox', { name: 'Message Astra' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Message composer' })).toBeInTheDocument();
  });

  it('sends on Enter and ⌘Enter, breaks a line on Shift+Enter', () => {
    const { props } = renderComposer({ value: 'Ready' });
    const field = screen.getByRole('textbox', { name: 'Message Astra' });

    fireEvent.keyDown(field, { key: 'Enter', shiftKey: true });
    expect(props.onSend).not.toHaveBeenCalled();

    fireEvent.keyDown(field, { key: 'Enter' });
    expect(props.onSend).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(field, { key: 'Enter', metaKey: true });
    expect(props.onSend).toHaveBeenCalledTimes(2);
  });

  it('does not send an empty draft on Enter, and lets the host claim keys first', () => {
    const onKeyDown = vi.fn((event: { key: string; preventDefault: () => void }) => {
      if (event.key === 'Tab') {
        event.preventDefault();
      }
    });
    const { props } = renderComposer({ value: '', onKeyDown });
    const field = screen.getByRole('textbox', { name: 'Message Astra' });

    fireEvent.keyDown(field, { key: 'Enter' });
    expect(props.onSend).not.toHaveBeenCalled();

    fireEvent.keyDown(field, { key: 'Tab' });
    expect(onKeyDown).toHaveBeenCalled();
  });

  it('swaps Send for Stop while a run is in flight, without a second filled action', () => {
    const { container, props } = renderComposer({ value: 'Working', running: true });

    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();
    const stop = screen.getByRole('button', { name: 'Stop run' });
    expect(stop).toHaveAttribute('data-variant', 'destructive');
    expect(container.querySelectorAll('[data-variant="presence"]')).toHaveLength(0);

    fireEvent.click(stop);
    expect(props.onStop).toHaveBeenCalledOnce();

    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Message Astra' }), { key: 'Enter' });
    expect(props.onSend).not.toHaveBeenCalled();
  });

  it('shows attachments with labelled progress and non-colour failure', () => {
    const onRemoveAttachment = vi.fn();
    renderComposer({
      attachments: [
        { id: 'a', name: 'vendor-a.md', meta: '12 KB', state: 'ready' },
        { id: 'b', name: 'evidence-map.png', state: 'uploading', progress: 55 },
        { id: 'c', name: 'q3-deck.key', meta: 'Too large — 212 MB', state: 'failed' },
      ],
      onRemoveAttachment,
    });
    const row = within(screen.getByRole('region', { name: 'Message composer' }));

    expect(row.getByRole('progressbar', { name: 'Uploading evidence-map.png' })).toHaveAttribute(
      'aria-valuenow',
      '55',
    );
    expect(row.queryByRole('button', { name: 'Remove evidence-map.png' })).not.toBeInTheDocument();
    expect(
      row.getByText('Too large — 212 MB').closest('[data-slot="attachment-chip"]'),
    ).toHaveAttribute('data-state', 'failed');

    fireEvent.click(row.getByRole('button', { name: 'Remove vendor-a.md' }));
    expect(onRemoveAttachment).toHaveBeenCalledWith('a');
  });

  it('surfaces a boundary warning as an action, and marks its tone', () => {
    const onClick = vi.fn();
    renderComposer({
      value: 'Publish it',
      warning: { label: 'Held for approval', title: 'publish is must-ask', onClick },
    });

    expect(screen.getByRole('region', { name: 'Message composer' })).toHaveAttribute(
      'data-tone',
      'warning',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Held for approval' }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('opens the command palette from the options caret, even with an empty draft', () => {
    const onSelectCommand = vi.fn();
    renderComposer({
      commands: [
        { id: '/image', label: '/image', description: 'Generate an image', meta: 'may act' },
        {
          id: '/publish',
          label: '/publish',
          description: 'Publish a finding',
          meta: 'must ask',
          metaTone: 'warning',
        },
      ],
      onSelectCommand,
    });

    const caret = screen.getByRole('button', { name: 'Send options' });
    expect(caret).toBeEnabled();
    fireEvent.click(caret);

    const menu = screen.getByRole('menu');
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(2);
    expect(within(menu).getByText('must ask')).toHaveClass('oc-palette-meta--warning');

    fireEvent.click(within(menu).getByRole('menuitem', { name: /\/publish/ }));
    expect(onSelectCommand).toHaveBeenCalledWith(expect.objectContaining({ id: '/publish' }));
  });

  it('grows with the draft between two and eight rows', () => {
    expect(rowsFor('', 2, 8)).toBe(2);
    expect(rowsFor('one\ntwo\nthree', 2, 8)).toBe(3);
    expect(rowsFor('x'.repeat(120), 2, 8)).toBe(2);
    expect(rowsFor('a\n'.repeat(20), 2, 8)).toBe(8);
  });
});
