# Security Policy

## Supported versions

OpenCoven Chat is pre-1.0 and ships from a single release line. Only the most
recent published release receives security fixes. Older tags are not patched;
upgrade to the latest release before reporting an issue.

| Version | Supported          |
| ------- | ------------------ |
| Latest release | :white_check_mark: |
| Any earlier tag | :x: |

## Scope

Report vulnerabilities in the OpenCoven Chat desktop client, its packaged
release artifacts, or this repository's build and release automation here.
Vulnerabilities in the Coven Cave service, daemon, or server-side data handling
belong in
[`OpenCoven/coven-cave`](https://github.com/OpenCoven/coven-cave/security);
use that repository's private vulnerability reporting channel rather than a
public issue.

OpenCoven Chat does not persist authenticated conversation bodies in
IndexedDB, `localStorage`, or `sessionStorage`. Canonical reads are held only in
bounded memory caches, while installation identity and credentials stay in the
operating system keyring. The explicit browser demos use canned data and do not
persist it. Reports showing that sensitive conversation data reaches browser
storage are in scope because that would violate the current security boundary.
Any future local read cache must document its encryption and storage guarantees
before shipping.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report vulnerabilities privately through GitHub's private vulnerability
reporting:

1. Go to the repository's **Security** tab.
2. Choose **Report a vulnerability** to open a private security advisory.

This creates a private channel visible only to you and the maintainers. If you
cannot use GitHub advisories, contact the maintainers through the security
contact listed on the OpenCoven organization profile.

Please include:

- affected version or commit,
- platform (macOS / Windows / Linux),
- a description of the impact,
- reproduction steps or a proof of concept.

## What to expect

- We aim to acknowledge a report within **3 business days**.
- We will confirm the issue, assess severity, and keep you updated as we work
  on a fix.
- Fixes ship in a new signed release; the advisory is published (crediting the
  reporter unless anonymity is requested) once a fix is available.

## Verifying releases

Every release is built and published by the tag-triggered release workflow.
Release assets are covered by a `SHA256SUMS` file — verify downloads before
running them:

    shasum -a 256 -c SHA256SUMS

Installers are code-signed where platform signing secrets are configured, and
auto-updates are verified against the Tauri updater signing key. Treat any
unsigned build, or any download whose checksum does not match `SHA256SUMS`, as
untrusted.
