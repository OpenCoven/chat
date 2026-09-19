import { act, fireEvent, render, screen } from '@testing-library/react';
import { useRef, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { CovenProjectAccess } from '../lib/coven-runtime';
import { Composer } from '../ui/composer';
import type { ContextFamiliar } from './context-references';
import { useMentionCompletion } from './mention-completion';

const familiars = [
  { id: 'astra-one', name: 'Astra Work', workspace: '/work/chat' },
  { id: 'astra-two', name: 'Astra Work', workspace: '/other/chat' },
];

function Harness({
  disabled = false,
  people = familiars,
  projects = [
    { name: 'chat', path: '/work/chat', access: 'write' },
    { name: 'chat', path: '/other/chat', access: 'read' },
    { name: 'project', path: '/sessions/project', access: 'write' },
  ],
  onSend = vi.fn(),
}: {
  disabled?: boolean;
  people?: readonly ContextFamiliar[];
  projects?: readonly CovenProjectAccess[];
  onSend?: () => void;
}) {
  const [value, onValueChange] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const completion = useMentionCompletion({
    value,
    onValueChange,
    textareaRef,
    familiars: people.map((person, index) =>
      index === 0 ? { ...person, projectAccess: projects } : person,
    ),
    familiarId: people[0]?.id ?? '',
    disabled,
  });
  return (
    <Composer
      value={value}
      onValueChange={onValueChange}
      textareaRef={textareaRef}
      textareaProps={completion.textareaProps}
      onKeyDown={completion.onKeyDown}
      onSend={onSend}
    >
      {completion.suggestions}
    </Composer>
  );
}

function draft(value: string, caret = value.length, end = caret) {
  const field = screen.getByRole('textbox') as HTMLTextAreaElement;
  act(() => field.focus());
  fireEvent.change(field, { target: { value, selectionStart: caret, selectionEnd: end } });
  field.setSelectionRange(caret, end);
  fireEvent.select(field);
  return field;
}

describe('useMentionCompletion', () => {
  it('supports the layout familiar, project wraparound, and Local middle-token flows', () => {
    render(
      <Harness
        people={[
          { id: 'familiar-1', name: 'Familiar 1', workspace: '/work/one' },
          { id: 'local', name: 'Local', workspace: '/work/two' },
        ]}
        projects={[
          { name: 'one', path: '/work/one', access: 'write' },
          { name: 'two', path: '/work/two', access: 'read' },
          { name: 'three', path: '/work/three', access: 'write' },
        ]}
      />,
    );
    const field = draft('@Familiar 1');
    fireEvent.keyDown(field, { key: 'Tab' });
    expect(field).toHaveValue('@{Familiar 1} (id: "familiar-1") ');
    expect(field).toHaveFocus();
    draft('#work');
    expect(screen.getAllByRole('option')).toHaveLength(3);
    fireEvent.keyDown(field, { key: 'ArrowUp' });
    fireEvent.keyDown(field, { key: 'Tab' });
    expect(field).toHaveValue('#{three} (path: "/work/three") ');
    expect(field).toHaveFocus();
    draft('@{Local');
    fireEvent.keyDown(field, { key: 'Tab' });
    expect(field).toHaveValue('@{Local} (id: "local") ');
    draft('Ask @Local later', 10);
    fireEvent.keyDown(field, { key: 'Tab' });
    expect(field).toHaveValue('Ask @{Local} (id: "local") later');
    expect(field.value.slice(field.selectionStart)).toBe(' later');
    expect(field).toHaveFocus();
  });

  it('keeps the native textbox and inserts the active full familiar reference without sending', () => {
    const onSend = vi.fn();
    render(<Harness onSend={onSend} />);
    const field = draft('Ask @Ast');
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(field).toHaveAttribute('aria-controls', screen.getByRole('listbox').id);
    fireEvent.keyDown(field, { key: 'ArrowUp' });
    const option = screen.getByRole('option', { name: 'Astra Work astra-two' });
    expect(field).toHaveAttribute('aria-activedescendant', option.id);
    expect(option).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(field).toHaveValue('Ask @{Astra Work} (id: "astra-two") ');
    expect(field.selectionStart).toBe(field.value.length);
    expect(field).toHaveFocus();
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('matches braced name queries and preserves a suffix when replacing a middle token', () => {
    render(<Harness />);
    const field = draft('Ask @{Astra Wo today', 14);
    fireEvent.keyDown(field, { key: 'Tab' });
    expect(field).toHaveValue('Ask @{Astra Work} (id: "astra-one") today');
    expect(field.value.slice(field.selectionStart)).toBe(' today');
    draft('Use #chat later', 7);
    fireEvent.keyDown(field, { key: 'ArrowDown' });
    fireEvent.keyDown(field, { key: 'Tab' });
    expect(field).toHaveValue('Use #{chat} (path: "/other/chat") later');
  });

  it('uses configured accessible projects and pointer selection retains textarea focus', () => {
    render(<Harness />);
    const field = draft('#pro');
    const option = screen.getByRole('option', { name: 'project /sessions/project' });
    expect(fireEvent.pointerDown(option)).toBe(false);
    fireEvent.click(option);
    expect(field).toHaveFocus();
    expect(field).toHaveValue('#{project} (path: "/sessions/project") ');
  });

  it.each([
    'a@Ast',
    'https://host/#chat',
    'https://host/@Ast',
    '# heading',
    '##',
    '@{Astra Work}',
    '#{chat} (path: "/work/chat")',
    'Ask @missing',
  ])('does not offer completions for %s', (value) => {
    render(<Harness />);
    const field = draft(value);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(fireEvent.keyDown(field, { key: 'Tab' })).toBe(true);
  });

  it('does not complete selected ranges or the inside of closed references', () => {
    render(<Harness />);
    draft('@Ast', 1, 4);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    draft('@{Astra Work}', 5);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('tracks caret moves and dismisses only the current token', () => {
    render(<Harness />);
    const field = draft('@Ast and #chat', 4);
    expect(screen.getAllByRole('option')).toHaveLength(2);
    fireEvent.keyDown(field, { key: 'Escape' });
    fireEvent.select(field);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    field.setSelectionRange(field.value.length, field.value.length);
    fireEvent.select(field);
    expect(screen.getByRole('option', { name: 'chat /work/chat' })).toBeInTheDocument();
    draft('@Astra');
    expect(screen.getByRole('option', { name: 'Astra Work astra-one' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('closes while disabled or blurred and resets active selection when inventory changes', () => {
    const { rerender } = render(<Harness />);
    const field = draft('@Ast');
    fireEvent.keyDown(field, { key: 'ArrowDown' });
    rerender(<Harness people={familiars.slice(0, 1)} />);
    expect(screen.getByRole('option')).toHaveAttribute('aria-selected', 'true');
    rerender(<Harness disabled />);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    rerender(<Harness />);
    act(() => field.blur());
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('ignores IME and never sends modified Enter while suggestions are visible', () => {
    const onSend = vi.fn();
    render(<Harness onSend={onSend} />);
    const field = draft('@Ast');
    fireEvent.keyDown(field, { key: 'Enter', isComposing: true });
    expect(field).toHaveValue('@Ast');
    fireEvent.compositionStart(field);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    fireEvent.keyDown(field, { key: 'Enter', keyCode: 229 });
    fireEvent.keyDown(field, { key: 'Enter' });
    fireEvent.compositionEnd(field);
    fireEvent.keyDown(field, { key: 'Enter', ctrlKey: true });
    expect(field).toHaveValue('@{Astra Work} (id: "astra-one") ');
    expect(onSend).not.toHaveBeenCalled();
  });
});
