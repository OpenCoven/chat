#!/usr/bin/env node
// Checks the release notes in docs/release-notes/ before a release is tagged.
//
// Each published release's GitHub body is its notes file, applied after the
// release publishes (docs/releasing.md § 1, step 10). Nothing in the release
// workflow reads these files, so a missing or malformed one used to surface
// only on the Releases page. This check runs in the normal unit suite
// (src/release-notes.test.ts) and, for the release being prepared, on the
// command line before the prep PR (docs/releasing.md § 1, step 3):
//
//   node scripts/release-notes.mjs            # every notes file
//   node scripts/release-notes.mjs v0.1.2     # one release; fails if it has no file

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const NOTES_DIR = 'docs/release-notes';
export const INDEX = `${NOTES_DIR}/README.md`;
export const COMPARE_URL = 'https://github.com/OpenCoven/chat/compare';

/**
 * Published before the notes template existed. Kept exactly as published, so
 * they need only an index row; no other release compares against them.
 */
export const HISTORICAL = Object.freeze(['v0.0.1-demo.1']);

const TAG = /^v(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
// The template's own placeholders (vX.Y.Z, vA.B.C) count too.
const PLACEHOLDER = /\b(TODO|TBD|FIXME)\b|X\.Y\.Z|A\.B\.C/;
const INSTALLER_VERSION = /OpenCoven\.Chat_([0-9][^_\s`]*)_/g;

/** Orders tags by version; a prerelease sorts before its release. */
export function compareTags(a, b) {
  const [, ...pa] = TAG.exec(a) ?? [];
  const [, ...pb] = TAG.exec(b) ?? [];
  for (let i = 0; i < 3; i++) {
    const diff = Number(pa[i]) - Number(pb[i]);
    if (diff !== 0) return diff;
  }
  if (pa[3] === pb[3]) return 0;
  if (pa[3] === undefined) return 1;
  if (pb[3] === undefined) return -1;
  return pa[3].localeCompare(pb[3], 'en', { numeric: true });
}

/** Tags that have a notes file, oldest first. */
export function listNotes(root = process.cwd()) {
  return readdirSync(join(root, NOTES_DIR))
    .filter((name) => name.endsWith('.md') && TAG.test(name.slice(0, -3)))
    .map((name) => name.slice(0, -3))
    .sort(compareTags);
}

/** The release a tag's full changelog starts from, or null for the first. */
export function previousTag(tag, tags) {
  const earlier = tags
    .filter((t) => !HISTORICAL.includes(t) && t !== tag && compareTags(t, tag) < 0)
    .sort(compareTags);
  return earlier.at(-1) ?? null;
}

/** The line that ends every notes file after the first public release. */
export function changelogLine(previous, tag) {
  return `**Full changelog:** [${previous}...${tag}](${COMPARE_URL}/${previous}...${tag})`;
}

/**
 * Problems with one release's notes, as sentences that say what to change.
 * `previous` is the tag it follows (null for the first public release).
 */
export function checkNotes(tag, markdown, { previous, index }) {
  const problems = [];
  const indexed = index.includes(`](${tag}.md)`);
  if (!indexed) problems.push(`add a row for ${tag} to ${INDEX}`);
  if (HISTORICAL.includes(tag)) return problems;

  const title = `# OpenCoven Chat ${tag}`;
  if (markdown.split('\n', 1)[0] !== title) {
    problems.push(`start the file with the line "${title}"`);
  }
  if (!/^## Before you install$/m.test(markdown)) {
    problems.push('add a "## Before you install" section (see the template in the index)');
  }
  if (!markdown.includes('SHA256SUMS')) {
    problems.push('say how to check a download against SHA256SUMS');
  }
  const version = tag.slice(1);
  for (const [, named] of markdown.matchAll(INSTALLER_VERSION)) {
    if (named !== version) {
      problems.push(`an installer filename names version ${named}; this release is ${version}`);
    }
  }
  const placeholder = PLACEHOLDER.exec(markdown);
  if (placeholder) problems.push(`replace the placeholder "${placeholder[0]}"`);
  if (previous) {
    const line = changelogLine(previous, tag);
    if (!markdown.trimEnd().endsWith(line)) {
      problems.push(`end the file with the line: ${line}`);
    }
  }
  return problems;
}

/**
 * Checks every notes file, or only `tag`'s. Returns { file, problem } pairs;
 * an empty list means the notes are ready.
 */
export function checkReleaseNotes(root = process.cwd(), tag = undefined) {
  const index = existsSync(join(root, INDEX)) ? readFileSync(join(root, INDEX), 'utf8') : '';
  const tags = listNotes(root);
  const results = [];
  if (tag !== undefined) {
    if (!TAG.test(tag)) return [{ file: tag, problem: 'not a release tag such as v0.1.2' }];
    if (!tags.includes(tag)) {
      return [
        { file: `${NOTES_DIR}/${tag}.md`, problem: `write it from the template in ${INDEX}` },
      ];
    }
  }
  for (const t of tag === undefined ? tags : [tag]) {
    const file = `${NOTES_DIR}/${t}.md`;
    const markdown = readFileSync(join(root, file), 'utf8');
    for (const problem of checkNotes(t, markdown, { previous: previousTag(t, tags), index })) {
      results.push({ file, problem });
    }
  }
  if (tag === undefined) {
    for (const [, linked] of index.matchAll(/\]\((v[^)\s]+)\.md\)/g)) {
      if (!tags.includes(linked)) {
        results.push({ file: INDEX, problem: `links ${linked}.md, which does not exist` });
      }
    }
  }
  return results;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const tag = process.argv[2];
  const results = checkReleaseNotes(process.cwd(), tag);
  for (const { file, problem } of results) console.error(`${file}: ${problem}`);
  if (results.length > 0) {
    console.error(`\n${results.length} problem(s). The template is in ${INDEX}.`);
    process.exit(1);
  }
  console.log(tag ? `Release notes for ${tag} are ready.` : 'Every release has ready notes.');
}
