import { memo, type ReactNode } from 'react';
import Markdown, { type Components, defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import './formatted-message.css';
import { segmentToolCalls } from './tool-activity';

const components: Components = {
  a({ href, children, title }) {
    if (!href) return <span>{children}</span>;
    return href.startsWith('#') ? (
      <a href={href} title={title}>
        {children}
      </a>
    ) : (
      <a href={href} title={title} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  },
  img({ alt }) {
    return <span className="coven-markdown-image">{alt ? `[Image: ${alt}]` : '[Image]'}</span>;
  },
  table({ children }) {
    return (
      // biome-ignore lint/a11y/noNoninteractiveTabindex: Overflowing tables need keyboard scrolling.
      <section className="coven-markdown-table" aria-label="Table" tabIndex={0}>
        <table>{children}</table>
      </section>
    );
  },
};
const plugins = [remarkGfm];

function Prose({ text }: { text: string }) {
  return (
    <Markdown
      remarkPlugins={plugins}
      components={components}
      skipHtml
      urlTransform={(url, key) =>
        key === 'href' && /^(https?:\/\/|#)/i.test(url) ? defaultUrlTransform(url) : undefined
      }
    >
      {text}
    </Markdown>
  );
}

type ToolRow = Readonly<{ name: string; args: string }>;

function ToolActivity({ rows }: { rows: readonly ToolRow[] }) {
  return (
    <ul className="coven-tools" aria-label="Tool activity">
      {rows.map((row, index) => (
        <li className="coven-tool" key={`${index}-${row.name}`}>
          <span className="coven-tool-glyph" aria-hidden="true" />
          <code className="coven-tool-name">{row.name}</code>
          <span className="coven-tool-args" title={row.args}>
            {row.args}
          </span>
        </li>
      ))}
    </ul>
  );
}

export const FormattedMessage = memo(function FormattedMessage({ text }: { text: string }) {
  const segments = segmentToolCalls(text);
  const blocks: ReactNode[] = [];
  let pendingTools: ToolRow[] = [];
  const flushTools = () => {
    if (pendingTools.length) {
      blocks.push(<ToolActivity rows={pendingTools} key={`tools-${blocks.length}`} />);
      pendingTools = [];
    }
  };
  for (const segment of segments) {
    if (segment.kind === 'tool') {
      pendingTools.push({ name: segment.name, args: segment.args });
      continue;
    }
    flushTools();
    blocks.push(<Prose text={segment.text} key={`prose-${blocks.length}`} />);
  }
  flushTools();
  return <div className="coven-formatted">{blocks}</div>;
});
