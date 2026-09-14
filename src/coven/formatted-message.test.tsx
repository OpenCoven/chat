import { render, screen } from '@testing-library/react';
import { FormattedMessage } from './formatted-message';

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
  expect(rows[0]).toHaveTextContent('gh auth status 2>&1 | head -30; echo "---ORGS---"; gh api user/orgs ...');
  expect(rows[1]).toHaveTextContent('find . -iname "*.html" 2>/dev/null ...');
  expect(rows[2]).toHaveTextContent('Read');
  expect(rows[2]).toHaveTextContent('src/index.html');
  const paragraphs = Array.from(document.querySelectorAll('.coven-formatted p')).map(
    (node) => node.textContent,
  );
  expect(paragraphs).toEqual(['I will check access first.', 'Then I will build the site.', 'Done.']);
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
