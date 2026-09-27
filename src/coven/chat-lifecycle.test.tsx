import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ChatLifecycleControls } from './chat-lifecycle';

describe('ChatLifecycleControls', () => {
  it('describes deletion in terms of the saved local transcript only', () => {
    render(
      <ChatLifecycleControls
        id="one"
        title="First head"
        archived={false}
        disabled={false}
        pending={false}
        error=""
        onChange={() => {}}
      />,
    );
    const description = document.getElementById('coven-delete-description');
    expect(description).toHaveTextContent(/saved local transcript/i);
    expect(description).not.toHaveTextContent(/import/i);
  });

  it('keeps Restore in view for an archived chat and folds the rest into Chat actions', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <ChatLifecycleControls
        id="one"
        title="First head"
        archived={false}
        disabled={false}
        pending={false}
        error=""
        onChange={onChange}
      />,
    );
    expect(screen.queryByRole('button', { name: /Archive chat|Delete chat/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Chat actions' }));
    const menu = screen.getByRole('menu');
    expect(menu).toHaveTextContent('Archive chat');
    expect(menu).toHaveTextContent('Delete chat');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Archive chat' }));
    expect(onChange).toHaveBeenCalledWith('archived');
    rerender(
      <ChatLifecycleControls
        id="one"
        title="First head"
        archived
        disabled={false}
        pending={false}
        error=""
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Restore chat' }));
    expect(onChange).toHaveBeenLastCalledWith('active');
    fireEvent.click(screen.getByRole('button', { name: 'Chat actions' }));
    expect(screen.getByRole('menu')).not.toHaveTextContent('Archive chat');
    expect(screen.getByRole('menuitem', { name: 'Delete chat' })).toBeInTheDocument();
  });

  it('returns focus to Chat actions when the delete dialog closes', () => {
    const showModal = vi.fn();
    const close = vi.fn();
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
      configurable: true,
      value: showModal,
    });
    Object.defineProperty(HTMLDialogElement.prototype, 'close', {
      configurable: true,
      value: close,
    });
    try {
      render(
        <ChatLifecycleControls
          id="one"
          title="First head"
          archived={false}
          disabled={false}
          pending={false}
          error=""
          onChange={() => {}}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Chat actions' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Delete chat' }));
      expect(showModal).toHaveBeenCalledOnce();
      const dialog = screen.getByRole('dialog', { hidden: true });
      fireEvent(dialog, new Event('close'));
      expect(screen.getByRole('button', { name: 'Chat actions' })).toHaveFocus();
    } finally {
      Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
      Reflect.deleteProperty(HTMLDialogElement.prototype, 'close');
    }
  });
});
