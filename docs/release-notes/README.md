# Release notes

Each published release of the desktop app has one file here, named after its tag. The file is
the release's body on GitHub. Write it in the release's prep PR, and apply it once the release
publishes ([`docs/releasing.md`](../releasing.md) § 1, steps 3 and 10). To change published
notes, edit the file, land it, and apply it again. Don't edit the Releases page directly, or
the two drift apart.

`node scripts/release-notes.mjs` checks every file, and `node scripts/release-notes.mjs <tag>`
checks one. `src/release-notes.test.ts` runs the same check in CI.

## Releases

Newest first. Every release so far is a pre-release, because the major version is `0`.

| Release | Published | What changed | Verification record |
| --- | --- | --- | --- |
| [v0.1.2](v0.1.2.md) | not yet published | OpenCoven Chat becomes Coven Chat; a new composer, Esc stops a run, model and project-access controls in **Settings**, Windows clears old autofill entries | none yet |
| [v0.1.1](v0.1.1.md) | 2026-11-11 | Aligns the released source with its conformance authority; carries v0.1.0's full-access chats | none |
| [v0.1.0](v0.1.0.md) | 2026-11-11 | Familiar chats run with full access; **Settings › Access** explains it | none; native acceptance [run 43023336301](https://github.com/OpenCoven/chat/actions/runs/43023336301) |
| [v0.0.9](v0.0.9.md) | 2026-11-09 | Five fixes the native acceptance lane found in v0.0.8, including Windows autofill | [2026-11-09](../verification/2026-11-09-release-v0.0.9.md) |
| [v0.0.8](v0.0.8.md) | 2026-11-04 | Fixes the Linux AppImage on newer distributions | [2026-11-04](../verification/2026-11-04-release-v0.0.8.md) |
| [v0.0.7](v0.0.7.md) | 2026-10-25 | Rebuilt from current source; the app is unchanged from v0.0.6 | [2026-10-25](../verification/2026-10-25-release-v0.0.7.md) |
| [v0.0.6](v0.0.6.md) | 2026-10-20 | Adds **Settings › Model** | [2026-10-20](../verification/2026-10-20-release-v0.0.6.md) |
| [v0.0.5](v0.0.5.md) | 2026-10-14 | First Windows build; setup can create your first familiar | none |
| [v0.0.4](v0.0.4.md) | 2026-10-14 | Chat sets itself up: installs Coven and its engine, signs you in | none |
| [v0.0.3](v0.0.3.md) | 2026-10-11 | Easier-to-read replies, failure reasons kept in the chat, iPhone pairing | none |
| [v0.0.2](v0.0.2.md) | 2026-10-07 | The first public release | none |
| [v0.0.1-demo.1](v0.0.1-demo.1.md) | 2026-09-02 | A demo of the chat design with sample data; not the app, kept as published | none |

There is no v0.0.1 release. Its tag exists, but the release run stopped at the signing gate, so
nothing was published ([`docs/releasing.md`](../releasing.md)).

## Writing a release's notes

Write for the person deciding whether to install. Lead with what changes for them, use the
names they see in the window (in bold), and say what they have to do differently, if anything.
Leave out how it was built and tested unless it changes what they get; the verification record
holds that.

Start from this template. The check enforces the title, the **Before you install** section, the
`SHA256SUMS` instructions, that every installer filename carries this version, and the full
changelog line at the end. The rest is judgment.

```markdown
# Coven Chat vX.Y.Z

One or two sentences on what changes for someone who installs this. For a patch, name the
release it follows and say whether updating is optional.

## A heading people can scan, such as "Fixed: Windows kept typed text"

What's new or fixed, in the window's words. One section per change worth a heading; group
small fixes under "Also fixed".

## Before you install

- Platforms and installers: macOS (Apple silicon, Intel), Windows x64, Linux x64.
- Signing: macOS signed and notarized; Windows unsigned until #411, with the SmartScreen steps.
- Updates: whether this release updates itself. While the updater is off, say to download
  newer versions from the Releases page.
- Works with: the Coven and engine versions it was tested with, and the iPhone companion
  builds that work with it.
- Checking a download against `SHA256SUMS`, with an example filename for this version, such as
  `Coven.Chat_X.Y.Z_aarch64.dmg`.

**Full changelog:** [vA.B.C...vX.Y.Z](https://github.com/OpenCoven/chat/compare/vA.B.C...vX.Y.Z)
```

The full changelog line compares with the previous release that has notes here, and it is the
file's last line. The first public release, v0.0.2, has none.

## Historical drafts

The [unreleased v0.0.10 draft](../design-audits/2026-11-10-unpublished-v0.0.10-draft.md) is retained from earlier local work. Its wording is historical; it does not describe a published release or define a release target.
