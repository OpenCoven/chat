import { memo, type ReactNode, useState } from 'react';
import Markdown, { type Components, defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CopyButton } from './copy-button';
import './formatted-message.css';
import { segmentToolCalls } from './tool-activity';

/**
 * The shape of the syntax-tree node react-markdown hands a component. Typed
 * structurally so this file needs no `hast` dependency of its own.
 */
type TreeNode = Readonly<{
  type: string;
  value?: string | undefined;
  tagName?: string | undefined;
  properties?: Readonly<Record<string, unknown>> | undefined;
  children?: readonly TreeNode[] | undefined;
}>;

/** The text a fenced block would copy: its nodes' text, exactly as written. */
function treeText(node: TreeNode | undefined): string {
  if (!node) return '';
  if (node.type === 'text') return node.value ?? '';
  return (node.children ?? []).map(treeText).join('');
}

function codeLanguage(code: TreeNode | undefined): string | undefined {
  const classes = code?.properties?.className;
  const list = Array.isArray(classes) ? classes.map(String) : [];
  return list.find((name) => name.startsWith('language-'))?.slice('language-'.length);
}

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
  pre({ children, node }) {
    const tree: TreeNode | undefined = node;
    const code = tree?.children?.find(
      (child) => child.type === 'element' && child.tagName === 'code',
    );
    const language = codeLanguage(code);
    const text = treeText(code).replace(/\n$/, '');
    return (
      <div className="coven-code" data-language={language}>
        <div className="coven-code-bar">
          <span className="coven-code-lang">{language ?? 'code'}</span>
          <CopyButton text={text} label={language ? `Copy ${language} code` : 'Copy code'} />
        </div>
        <pre>{children}</pre>
      </div>
    );
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

/**
 * One tool call. Prose-derived rows carry only `name` and `args`; rows the
 * runtime reported as data may add the full input (`raw`) and, once the
 * harness reports it, the outcome.
 */
export type ToolRow = Readonly<{
  name: string;
  args: string;
  raw?: string | undefined;
  result?: string | undefined;
  isError?: boolean | undefined;
  /** The call the live run is executing right now. */
  running?: boolean | undefined;
}>;

/** A run of more than this many consecutive calls folds to its newest ones. */
export const TOOL_FOLD_AT = 10;
/** How many of the newest calls a folded run keeps in view. */
export const TOOL_FOLD_KEEP = 6;

/** The fold control's label, naming what it hides and how much of it failed. */
export function toolFoldLabel(hidden: number, failed: number): string {
  const calls = `${hidden} earlier tool ${hidden === 1 ? 'call' : 'calls'}`;
  return failed ? `Show ${calls} (${failed} failed)` : `Show ${calls}`;
}

/** How much a reported result holds, so a collapsed row says whether it is worth opening. */
export function resultSize(result: string): string {
  if (!result.trim()) return 'no output';
  const lines = result.replace(/\n$/, '').split('\n').length;
  return lines === 1 ? '1 line' : `${lines} lines`;
}

export function ToolActivity({ rows }: { rows: readonly ToolRow[] }) {
  const [expanded, setExpanded] = useState(false);
  const folded = !expanded && rows.length > TOOL_FOLD_AT;
  const first = folded ? rows.length - TOOL_FOLD_KEEP : 0;
  const hiddenFailed = folded ? rows.slice(0, first).filter((row) => row.isError).length : 0;
  return (
    <ul className="coven-tools" aria-label="Tool activity">
      {rows.length > TOOL_FOLD_AT ? (
        <li className="coven-tools-fold">
          <button
            type="button"
            className="coven-tools-fold-button"
            aria-expanded={expanded}
            onClick={() => setExpanded((open) => !open)}
          >
            {folded ? toolFoldLabel(first, hiddenFailed) : `Show only the latest ${TOOL_FOLD_KEEP}`}
          </button>
        </li>
      ) : null}
      {rows.slice(first).map((row, offset) => {
        const index = first + offset;
        return (
          <li
            className="coven-tool"
            key={`${index}-${row.name}`}
            data-error={row.isError || undefined}
            data-running={row.running || undefined}
          >
            <details className="coven-tool-details">
              <summary className="coven-tool-summary" aria-label={`${row.name} tool arguments`}>
                <span className="coven-tool-glyph" aria-hidden="true" />
                <code className="coven-tool-name">{row.name}</code>
                <span className="coven-tool-args">{row.args}</span>
                <span className="coven-tool-tail">
                  {row.running ? (
                    <span className="coven-tool-state coven-tool-state--running">running</span>
                  ) : row.isError ? (
                    <span className="coven-tool-state">failed</span>
                  ) : null}
                  {!row.running && row.result !== undefined ? (
                    <span className="coven-tool-size">{resultSize(row.result)}</span>
                  ) : null}
                  <span className="coven-tool-chevron" aria-hidden="true">
                    &#8250;
                  </span>
                </span>
              </summary>
              <section aria-label={`${row.name} raw arguments`}>
                <div className="coven-tool-section-bar">
                  <span className="coven-tool-section-label">Input</span>
                  <CopyButton text={row.raw ?? row.args} label={`Copy ${row.name} input`} />
                </div>
                <pre className="coven-tool-raw">
                  <code>{row.raw ?? row.args}</code>
                </pre>
              </section>
              {row.result !== undefined ? (
                <section className="coven-tool-result" aria-label={`${row.name} result`}>
                  <div className="coven-tool-section-bar">
                    <span className="coven-tool-section-label">Result</span>
                    <CopyButton text={row.result} label={`Copy ${row.name} result`} />
                  </div>
                  <pre className="coven-tool-raw">
                    <code>{row.result}</code>
                  </pre>
                </section>
              ) : null}
            </details>
          </li>
        );
      })}
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
