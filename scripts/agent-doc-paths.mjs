#!/usr/bin/env node
// Checks that every repo path the agent docs name still exists.
//
// AGENTS.md, CLAUDE.md and the orientation skill are the first thing a new
// agent reads. When a file they name is renamed or deleted, the agent goes
// looking for it, fails, and starts grepping the wrong places. This check runs
// in the normal unit suite (src/agent-doc-paths.test.ts) so a rename that
// leaves the map behind fails CI, and on the command line before a docs push:
//
//   node scripts/agent-doc-paths.mjs

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Docs checked besides every Markdown file under docs/agents/. */
export const AGENT_DOCS = Object.freeze([
  'AGENTS.md',
  'CLAUDE.md',
  '.claude/skills/chat-app-orientation/SKILL.md',
  'docs/agent-notes.md',
  'docs/README.md',
]);

// Gitignored or machine-local locations that docs may name but CI never has.
const LOCAL_PREFIXES = [
  '.worktrees/',
  '.artifacts/',
  'artifacts/',
  'node_modules',
  'src-tauri/target',
];

// Code spans that contain a slash but name something other than a repo path:
// GitHub repos, and branch prefixes no top-level directory uses. (`docs/` is
// both a branch prefix and a directory, so docs branches stay out of backticks.)
const NON_PATH_PREFIXES = ['OpenCoven/', 'feat/', 'fix/', 'chore/', 'ci/', 'refactor/', 'test/'];

const PATH_EXTENSIONS = new Set([
  'css',
  'html',
  'js',
  'json',
  'md',
  'mjs',
  'mts',
  'ps1',
  'rs',
  'sh',
  'swift',
  'toml',
  'ts',
  'tsx',
  'yml',
  'yaml',
]);

/**
 * Returns the repo path a Markdown code span names, or null when the span is a
 * command, symbol, placeholder, home-directory path or sibling checkout.
 * A trailing `:line` or `:start-end` is dropped.
 */
export function codeSpanPath(span) {
  const text = span.trim().replace(/:\d+(?:-\d+)?$/, '');
  if (text === '' || /[\s<>*{}$|=?()'"`,;]/.test(text)) return null;
  if (/^(?:~|\/|-|\.\.\/|@|https?:)/.test(text)) return null;
  if (NON_PATH_PREFIXES.some((prefix) => text.startsWith(prefix))) return null;
  if (LOCAL_PREFIXES.some((prefix) => text.startsWith(prefix))) return null;
  const extension = /\.([A-Za-z0-9]+)$/.exec(text)?.[1]?.toLowerCase();
  if (text.includes('/')) return text;
  return extension && PATH_EXTENSIONS.has(extension) ? text : null;
}

/** Inline code spans and relative link targets outside fenced code blocks. */
export function extractReferences(markdown) {
  const references = [];
  let fenced = false;
  markdown.split('\n').forEach((line, index) => {
    if (/^\s*(?:```|~~~)/.test(line)) {
      fenced = !fenced;
      return;
    }
    if (fenced) return;
    for (const match of line.matchAll(/(?<!`)`([^`]+)`(?!`)/g)) {
      const path = codeSpanPath(match[1]);
      if (path) references.push({ kind: 'code', line: index + 1, path });
    }
    for (const match of line.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const target = match[1].split('#')[0];
      if (target === '' || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) continue;
      references.push({ kind: 'link', line: index + 1, path: target });
    }
  });
  return references;
}

function trackedFiles(root) {
  return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
}

/**
 * Lists every reference in the agent docs that does not resolve. Code spans
 * resolve from the repo root; a bare file name passes when some tracked file
 * has that name. Links resolve from the linking document's directory.
 */
export function checkAgentDocPaths(root = process.cwd()) {
  const tracked = trackedFiles(root);
  const basenames = new Set(tracked.map((file) => posix.basename(file)));
  const docs = [
    ...AGENT_DOCS,
    ...tracked.filter((file) => file.startsWith('docs/agents/') && file.endsWith('.md')),
  ];
  const problems = [];
  for (const doc of docs) {
    const at = (path) => posix.join(root, path);
    if (!existsSync(at(doc))) {
      problems.push({ doc, line: 0, path: doc, reason: 'agent doc is missing' });
      continue;
    }
    for (const ref of extractReferences(readFileSync(at(doc), 'utf8'))) {
      if (ref.kind === 'link') {
        const resolved = posix.normalize(posix.join(posix.dirname(doc), ref.path));
        if (!existsSync(at(resolved))) {
          problems.push({ doc, line: ref.line, path: ref.path, reason: 'link target not found' });
        }
      } else if (ref.path.includes('/')) {
        if (!existsSync(at(ref.path))) {
          problems.push({ doc, line: ref.line, path: ref.path, reason: 'path not found' });
        }
      } else if (!basenames.has(ref.path)) {
        problems.push({
          doc,
          line: ref.line,
          path: ref.path,
          reason: 'no tracked file has this name',
        });
      }
    }
  }
  return problems;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const problems = checkAgentDocPaths();
  for (const { doc, line, path, reason } of problems) {
    console.error(`${doc}:${line}: ${reason}: ${path}`);
  }
  if (problems.length > 0) {
    console.error(`\n${problems.length} stale reference(s). Fix the doc or restore the file.`);
    process.exit(1);
  }
  console.log('Agent docs: every named path exists.');
}
