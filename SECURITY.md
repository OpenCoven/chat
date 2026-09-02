# Security Policy

## Supported versions

OpenCoven Chat is pre-1.0 and ships from a single release line. Only the most
recent published release receives security fixes. Older tags are not patched;
upgrade to the latest release before reporting an issue.

| Version | Supported          |
| ------- | ------------------ |
| Latest published release | :white_check_mark: |
| Any earlier tag | :x: |

## Scope and related components

This policy covers the OpenCoven Chat client in this repository. Vulnerabilities
in the Coven Cave service or its canonical conversation APIs should be reported
to [OpenCoven/coven-cave](https://github.com/OpenCoven/coven-cave).

Chat does not write canonical conversations or messages to browser
`localStorage` or IndexedDB; the current client keeps those reads in memory and
uses native secure storage for credentials. Do not report the absence of a
plaintext browser database as a vulnerability in this release. Any future local
read cache must document its encryption and storage guarantees before shipping.

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
