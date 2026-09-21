import { fireEvent, render, screen } from '@testing-library/react';
import {
  FormattedMessage,
  resultSize,
  TOOL_FOLD_KEEP,
  ToolActivity,
  toolFoldLabel,
} from './formatted-message';

test('renders headings, emphasis, lists, quotes, and fenced code as formatted text', () => {
  const { container } = render(
    <FormattedMessage
      text={
        '## Summary\n\n**Strong** and *gentle* with `inline()`.\n\n1. First\n2. Second\n\n- Item\n\n> Quoted\n\n```ts\nconst result = "<safe>";\n```'
      }
    />,
  );
  expect(screen.getByRole('heading', { name: 'Summary', level: 2 })).toBeInTheDocument();
  expect(container.querySelector('strong')).toHaveTextContent('Strong');
  expect(container.querySelector('em')).toHaveTextContent('gentle');
  expect(container.querySelector('ol')).toHaveTextContent('First');
  expect(container.querySelector('ul')).toHaveTextContent('Item');
  expect(container.querySelector('blockquote')).toHaveTextContent('Quoted');
  expect(container.querySelector('pre code.language-ts')).toHaveTextContent(
    'const result = "<safe>";',
  );
  expect(container.querySelector('p code')).toHaveTextContent('inline()');
});

test('renders GitHub tables, strikethrough, and noninteractive task lists', () => {
  const { container } = render(
    <FormattedMessage
      text={
        '| Name | State |\n| --- | --- |\n| Item | **Ready** |\n\n~~Old~~\n\n- [x] Completed\n- [ ] Pending'
      }
    />,
  );
  expect(screen.getByRole('columnheader', { name: 'Name' })).toBeInTheDocument();
  expect(screen.getByRole('cell', { name: 'Ready' })).toBeInTheDocument();
  expect(container.querySelector('del')).toHaveTextContent('Old');
  const checkboxes = screen.getAllByRole('checkbox');
  expect(checkboxes[0]).toBeChecked();
  expect(checkboxes[1]).not.toBeChecked();
  for (const checkbox of checkboxes) expect(checkbox).toBeDisabled();
});

test('keeps external links separate from the app and blocks active markup or tracking images', () => {
  const { container } = render(
    <FormattedMessage
      text={
        '[Docs](https://example.com/docs)\n\n[unsafe](javascript:alert%281%29)\n\n[local](file:///etc/passwd)\n\n[relative](/settings)\n\n![Tracking image](https://example.com/pixel.png)\n\n<script>alert("bad")</script>\n\n<iframe src="https://example.com"></iframe>'
      }
    />,
  );
  const link = screen.getByRole('link', { name: 'Docs' });
  expect(link).toHaveAttribute('href', 'https://example.com/docs');
  expect(link).toHaveAttribute('target', '_blank');
  expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  expect(screen.getAllByRole('link')).toHaveLength(1);
  expect(container.querySelector('script, iframe, img')).toBeNull();
  expect(screen.getByText(/Tracking image/)).toBeInTheDocument();
});

test('handles incomplete streamed Markdown and updates to the complete message', () => {
  const view = render(<FormattedMessage text={'### Progress\n\n```js\nconst value ='} />);
  expect(view.container.querySelector('pre code')).toHaveTextContent('const value =');
  view.rerender(
    <FormattedMessage text={'### Progress\n\n```js\nconst value = 1;\n```\n\n**Done**'} />,
  );
  expect(screen.getAllByRole('heading', { name: 'Progress' })).toHaveLength(1);
  expect(view.container.querySelectorAll('pre')).toHaveLength(1);
  expect(view.container.querySelector('strong')).toHaveTextContent('Done');
});

test('lifts tool activity summaries out of prose into labelled rows', () => {
  render(
    <FormattedMessage
      text={
        'I will check access first.✶ Bash(gh auth status 2>&1 | head -30; echo "---ORGS---"; gh api user/orgs ...)✶ Bash(find . -iname "*.html" 2>/dev/null ...)Then I will build the site.\n✶ Read(src/index.html)\nDone.'
      }
    />,
  );
  const lists = screen.getAllByRole('list', { name: 'Tool activity' });
  const rows = screen.getAllByRole('listitem');
  expect(lists).toHaveLength(2);
  expect(rows).toHaveLength(3);
  expect(lists[0]).toContainElement(rows[1] as HTMLElement);
  expect(lists[1]).toContainElement(rows[2] as HTMLElement);
  expect(rows[0]).toHaveTextContent('Bash');
  expect(rows[0]).toHaveTextContent(
    'gh auth status 2>&1 | head -30; echo "---ORGS---"; gh api user/orgs ...',
  );
  expect(rows[1]).toHaveTextContent('find . -iname "*.html" 2>/dev/null ...');
  expect(rows[2]).toHaveTextContent('Read');
  expect(rows[2]).toHaveTextContent('src/index.html');
  const paragraphs = Array.from(document.querySelectorAll('.coven-formatted p')).map(
    (node) => node.textContent,
  );
  expect(paragraphs).toEqual([
    'I will check access first.',
    'Then I will build the site.',
    'Done.',
  ]);
  expect(document.body.textContent).not.toContain('✶');
});

test('leaves ordinary prose, parenthesised asides, and code untouched when no tool marker is present', () => {
  const { container } = render(
    <FormattedMessage text={'Check the tooling (GitHub org, hosting) and `run(x)` twice.'} />,
  );
  expect(screen.queryByRole('list')).not.toBeInTheDocument();
  expect(container.querySelector('p')).toHaveTextContent(
    'Check the tooling (GitHub org, hosting) and run(x) twice.',
  );
});

test('crossed-tools calls have concise, independently expandable native argument details', () => {
  const args = '  echo "<script>alert(1)</script>" && printf \'[link](https://example.com)\'  ';
  const { container } = render(
    <FormattedMessage text={`Before.⚒ Bash(${args})⚒\uFE0F Read(src/app.ts)After.`} />,
  );
  expect(screen.getAllByRole('listitem')).toHaveLength(2);
  const summary = screen.getByLabelText('Bash tool arguments');
  const details = summary.parentElement;
  expect(summary.tagName).toBe('SUMMARY');
  expect(details?.tagName).toBe('DETAILS');
  expect(details).not.toHaveAttribute('open');
  expect(summary.querySelector('.coven-tool-args')?.textContent).toBe(args);
  expect(screen.getByLabelText('Bash raw arguments').querySelector('pre')?.textContent).toBe(args);
  expect(screen.getByLabelText('Bash raw arguments')).not.toBeVisible();

  fireEvent.click(summary);
  expect(details).toHaveAttribute('open');
  expect(screen.getByLabelText('Bash raw arguments')).toBeVisible();
  expect(screen.getByLabelText('Read tool arguments').parentElement).not.toHaveAttribute('open');
  expect(container.querySelector('script, a')).toBeNull();
  fireEvent.click(summary);
  expect(details).not.toHaveAttribute('open');
  expect(Array.from(container.querySelectorAll('p'), (node) => node.textContent)).toEqual([
    'Before.',
    'After.',
  ]);
});

test('raw details retain multiline, empty, and truncated arguments without formatting them', () => {
  const args = ' \tfirst\nsecond  ';
  render(<FormattedMessage text={`⚒ Edit(${args})✳ Read()✶ Bash(echo "unfinished`} />);
  expect(screen.getByLabelText('Edit raw arguments').querySelector('pre')?.textContent).toBe(args);
  expect(screen.getByLabelText('Read raw arguments').querySelector('pre')?.textContent).toBe('');
  expect(screen.getByLabelText('Bash raw arguments').querySelector('pre')?.textContent).toBe(
    'echo "unfinished',
  );
});

test('keeps crossed-tools examples inside fenced code out of activity rows', () => {
  const { container } = render(
    <FormattedMessage text={'```sh\n⚒ Bash(echo "example")\n```\n\n⚒ Read(real.ts)'} />,
  );
  expect(container.querySelector('pre code.language-sh')).toHaveTextContent(
    '⚒ Bash(echo "example")',
  );
  expect(screen.getAllByRole('listitem')).toHaveLength(1);
  expect(screen.getByLabelText('Read tool arguments')).toBeInTheDocument();
});

test('structured rows show the full input and the result once reported, and mark failures', () => {
  const raw = JSON.stringify({ command: 'ls -la', description: 'List' }, null, 2);
  const { container } = render(
    <div className="coven-formatted">
      <ToolActivity
        rows={[
          { name: 'Bash', args: 'ls -la', raw },
          { name: 'Read', args: 'src/app.ts', result: 'file body' },
          { name: 'Grep', args: 'false', result: 'exit 1', isError: true },
        ]}
      />
    </div>,
  );
  expect(screen.getAllByRole('listitem')).toHaveLength(3);
  expect(screen.getByLabelText('Bash raw arguments').querySelector('pre')?.textContent).toBe(raw);
  expect(screen.getByRole('button', { name: 'Copy Bash input' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Copy Bash result' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Copy Read result' })).toBeInTheDocument();
  expect(screen.getByLabelText('Read result')).toHaveTextContent(/^Result/);
  expect(screen.queryByLabelText('Bash result')).toBeNull();
  expect(screen.getByLabelText('Read result')).toHaveTextContent('file body');
  expect(screen.getByLabelText('Read result')).not.toBeVisible();
  fireEvent.click(screen.getByLabelText('Read tool arguments'));
  expect(screen.getByLabelText('Read result')).toBeVisible();
  const failed = container.querySelectorAll('.coven-tool[data-error]');
  expect(failed).toHaveLength(1);
  expect(failed[0]).toHaveTextContent('failed');
  expect(failed[0]?.querySelector('.coven-tool-result')).toHaveTextContent('exit 1');
});

test('fenced code names its language and copies the block without the trailing newline', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  try {
    const { container } = render(
      <FormattedMessage text={'Run:\n\n```sh\necho "hi"\nls\n```\n\n```\nplain\n```'} />,
    );
    expect(container.querySelectorAll('.coven-code')).toHaveLength(2);
    expect(container.querySelector('.coven-code-lang')).toHaveTextContent('sh');
    expect(container.querySelectorAll('.coven-code-lang')[1]).toHaveTextContent('code');
    fireEvent.click(screen.getByRole('button', { name: 'Copy sh code' }));
    expect(writeText).toHaveBeenCalledWith('echo "hi"\nls');
    await screen.findByText('Copied');
    fireEvent.click(screen.getByRole('button', { name: 'Copy code' }));
    expect(writeText).toHaveBeenLastCalledWith('plain');
    // The copy control never becomes part of the code a reader selects.
    expect(container.querySelector('pre')?.textContent).toBe('echo "hi"\nls\n');
  } finally {
    if (original) Object.defineProperty(navigator, 'clipboard', original);
    else Reflect.deleteProperty(navigator, 'clipboard');
  }
});

test('marks the call a live run is executing as running', () => {
  render(
    <ToolActivity
      rows={[
        { name: 'Read', args: 'a.ts', result: 'ok' },
        { name: 'Bash', args: 'ls', running: true },
      ]}
    />,
  );
  const rows = screen.getAllByRole('listitem');
  expect(rows[0]).not.toHaveAttribute('data-running');
  expect(rows[1]).toHaveAttribute('data-running', 'true');
  expect(rows[1]).toHaveTextContent('running');
  expect(screen.queryByText('failed')).not.toBeInTheDocument();
});

test('folds a long run of calls to its newest, naming what it hides and how much failed', () => {
  const rows = Array.from({ length: 14 }, (_, index) => ({
    name: index % 2 ? 'Read' : 'Bash',
    args: `step ${index}`,
    result: 'ok',
    ...(index === 1 || index === 4 ? { isError: true } : {}),
  }));
  render(<ToolActivity rows={rows} />);
  const calls = () =>
    screen.getAllByRole('listitem').filter((item) => item.classList.contains('coven-tool'));
  expect(calls()).toHaveLength(TOOL_FOLD_KEEP);
  // Each call's args appear in its summary and its raw block, so count matches.
  expect(screen.queryAllByText('step 0')).toHaveLength(0);
  expect(screen.getAllByText('step 13').length).toBeGreaterThan(0);
  const fold = screen.getByRole('button', { name: 'Show 8 earlier tool calls (2 failed)' });
  expect(fold).toHaveAttribute('aria-expanded', 'false');
  fireEvent.click(fold);
  expect(calls()).toHaveLength(14);
  expect(screen.getAllByText('step 0').length).toBeGreaterThan(0);
  expect(
    screen.getByRole('button', { name: `Show only the latest ${TOOL_FOLD_KEEP}` }),
  ).toHaveAttribute('aria-expanded', 'true');
  expect(toolFoldLabel(1, 0)).toBe('Show 1 earlier tool call');
});

test('does not fold a short run of calls', () => {
  const rows = Array.from({ length: 10 }, (_, index) => ({ name: 'Bash', args: `step ${index}` }));
  render(<ToolActivity rows={rows} />);
  expect(screen.getAllByRole('listitem')).toHaveLength(10);
  expect(screen.queryByRole('button', { name: /earlier tool/ })).not.toBeInTheDocument();
});

test('a collapsed row says how much its result holds, and nothing while it is running', () => {
  expect(resultSize('')).toBe('no output');
  expect(resultSize('   \n')).toBe('no output');
  expect(resultSize('one')).toBe('1 line');
  expect(resultSize('a\nb\nc\n')).toBe('3 lines');
  render(
    <ToolActivity
      rows={[
        { name: 'Read', args: 'a.ts', result: 'a\nb\nc' },
        { name: 'Grep', args: 'x', result: '', isError: true },
        { name: 'Bash', args: 'ls', running: true },
        { name: 'Write', args: 'b.ts' },
      ]}
    />,
  );
  const rows = screen.getAllByRole('listitem');
  expect(rows[0]).toHaveTextContent('3 lines');
  expect(rows[1]).toHaveTextContent('failed');
  expect(rows[1]).toHaveTextContent('no output');
  expect(rows[2]).not.toHaveTextContent(/line|output/);
  expect(rows[3]).not.toHaveTextContent(/line|output/);
});

test('external links show their address on hover unless the author gave a title', () => {
  render(
    <FormattedMessage
      text={'See [docs](https://example.com/docs) and [titled](https://example.com/t "The title").'}
    />,
  );
  expect(screen.getByRole('link', { name: 'docs' })).toHaveAttribute(
    'title',
    'https://example.com/docs',
  );
  expect(screen.getByRole('link', { name: 'titled' })).toHaveAttribute('title', 'The title');
});
