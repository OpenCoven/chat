import { fireEvent, render, screen } from '@testing-library/react';
import { useRef, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Composer } from '../ui/composer';
import { ContextPicker } from './context-picker';

function Harness({ onSend = vi.fn() }: { onSend?: () => void }) {
  const [value, setValue] = useState('Ask this today');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  return (
    <Composer value={value} onValueChange={setValue} textareaRef={textareaRef} onSend={onSend}>
      <ContextPicker
        value={value}
        onValueChange={setValue}
        textareaRef={textareaRef}
        familiars={[
          {
            id: 'one',
            name: 'Astra (work)',
            projectAccess: [{ name: 'chat', path: '/work/chat', access: 'write' }],
          },
          { id: 'two', name: 'Astra (work)' },
        ]}
        familiarId="one"
      />
    </Composer>
  );
}

describe('ContextPicker', () => {
  it('restores the draft selection when Escape is pressed from an option', () => {
    render(<Harness />);
    const field = screen.getByRole('textbox') as HTMLTextAreaElement;
    field.focus();
    field.setSelectionRange(4, 8);
    fireEvent.click(screen.getByRole('button', { name: 'Add context' }));
    const option = screen.getByRole('option', { name: 'chat /work/chat' });
    option.focus();
    fireEvent.keyDown(option, { key: 'Escape', isComposing: true });
    expect(screen.getByRole('combobox')).toBeInTheDocument();
    fireEvent.keyDown(option, { key: 'Escape' });
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(field).toHaveFocus();
    expect([field.selectionStart, field.selectionEnd]).toEqual([4, 8]);
    expect(field).toHaveValue('Ask this today');
  });

  it('inserts a disambiguated reference in the selection without sending and restores focus', () => {
    const onSend = vi.fn();
    render(<Harness onSend={onSend} />);
    const field = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;
    field.focus();
    field.setSelectionRange(4, 8);
    fireEvent.click(screen.getByRole('button', { name: 'Add context' }));
    const search = screen.getByRole('combobox');
    expect(search).toHaveFocus();
    fireEvent.change(search, { target: { value: '@ast' } });
    expect(screen.getAllByRole('option')).toHaveLength(2);
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(field.value).toBe('Ask @{Astra (work)} (id: "two") today');
    expect(field).toHaveFocus();
    expect(field.value.slice(field.selectionStart)).toBe(' today');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('supports workspace search, empty results, IME and Escape without changing a draft', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Add context' }));
    const search = screen.getByRole('combobox');
    fireEvent.change(search, { target: { value: '#chat' } });
    expect(screen.getByRole('option')).toHaveTextContent('/work/chat');
    fireEvent.keyDown(search, { key: 'Enter', isComposing: true });
    expect(search).toBeInTheDocument();
    fireEvent.change(search, { target: { value: 'unknown' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(screen.getByRole('status')).toHaveTextContent('No known context matches');
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveValue('Ask this today');
  });

  it('selects by pointer and navigates up with wraparound', () => {
    render(<Harness />);
    const field = screen.getByRole('textbox') as HTMLTextAreaElement;
    field.setSelectionRange(field.value.length, field.value.length);
    fireEvent.click(screen.getByRole('button', { name: 'Add context' }));
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowUp' });
    expect(screen.getByRole('option', { name: 'chat /work/chat' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    fireEvent.click(screen.getByRole('option', { name: 'chat /work/chat' }));
    expect(screen.getByRole('textbox')).toHaveValue('Ask this today #{chat} (path: "/work/chat") ');
  });
});
