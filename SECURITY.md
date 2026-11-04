# Security policy

## Supported versions

OpenCoven Chat is pre-1.0 and ships from a single release line. Only the most recent published
release receives security fixes. Older tags aren't patched, so upgrade to the latest release before
you report an issue.

| Version | Supported |
| --- | --- |
| Latest release | :white_check_mark: |
| Any earlier tag | :x: |

## Scope

Report vulnerabilities in the OpenCoven Chat desktop client, its packaged release artifacts, or
this repository's build and release automation here. Chat runs your installed Coven CLI, and
first-run setup installs it from `OpenCoven/coven`.

- Vulnerabilities in the Coven CLI, its daemon, or the engine it installs belong in
  [`OpenCoven/coven`](https://github.com/OpenCoven/coven/security).
- Cave is a separate app: report its vulnerabilities in
  [`OpenCoven/coven-cave`](https://github.com/OpenCoven/coven-cave/security).

In either repository, use its private vulnerability reporting rather than a public issue.

OpenCoven Chat does not persist authenticated conversation bodies in IndexedDB, `localStorage`,
or `sessionStorage`. The window keeps only your selected familiar and your Settings choices in
`localStorage`: display preferences, and the harness, model, reasoning and speed your messages ask
for. Unsent drafts stay in memory. The desktop host keeps the following in Chat's
local app data folder (on macOS, `~/Library/Application Support/ai.opencoven.chat`):

- **Transcripts.** Chat saves one transcript per message you send, as
  `coven-transcripts/<session-id>.jsonl`, so your history survives restarts.
  On macOS and Linux each file is readable and writable only by your user
  account. **Delete chat** removes every transcript the chat is made of.
  Chats deleted in v0.0.5 or earlier left the transcripts of their earlier
  messages behind; Chat removes those once per launch.
- **Attachments.** Files you attach, and the message sent with them, are kept
  in `coven-attachments/`, up to 64 MiB in total. On macOS and Linux only your
  user account can read them. **Delete chat** removes the attachments of the
  chat's messages. Once per launch, Chat also removes staged folders that no
  saved message names, such as copies left by earlier versions. Your chats
  keep the attached text; only the staged copy goes.
- **Companion credentials.** The iPhone companion's certificate and key, its
  bearer token, and its send receipts live in a private `iphone-companion/`
  folder.
- **Missions.** For each mission you send from Chat, a private `coven-missions/`
  folder keeps the keys Chat needs to learn its outcome after a restart: the
  mission's id, the familiar it was sent to and that familiar's revision, and the
  Coven owner that accepted it. It keeps no title, prompt, project path or
  result; Chat reads those from Coven. On macOS and Linux only your user account
  can read it. Removing a finished mission removes its record.

The window can't reach the operating system keyring. Only the Cave adapter and the
installation-identity commands use it, and the window can call neither
(`src-tauri/capabilities/default.json`). Reports showing that conversation data reaches browser
storage, or that these files are readable by other user accounts, are in scope.

The window can ask the host to open a web address only through the link review's **Open**
(`open_reviewed_link`). The host checks the address again: it must be an `http` or `https` address
that names a site, at most 8,192 bytes of printable ASCII, with no sign-in name. The host then passes
it, as one argument and never through a shell, to the system's URL handler. Reports of an address
that reaches anything other than the default browser, or of a link that opens without the review,
are in scope.

## Reporting a vulnerability

> **Warning:** Don't open a public issue for a security problem.

Report vulnerabilities privately through GitHub's private vulnerability reporting:

1. Go to the repository's **Security** tab.
2. Choose **Report a vulnerability** to open a private security advisory.

This creates a private channel visible only to you and the maintainers. If you can't use GitHub
advisories, contact the maintainers through the security contact listed on the OpenCoven
organization profile.

Include:

- the affected version or commit
- your platform (macOS, Windows, or Linux)
- a description of the impact
- reproduction steps or a proof of concept

## What to expect

- We aim to acknowledge a report within **3 business days**.
- We'll confirm the issue, assess its severity, and keep you updated as we work on a fix.
- Fixes ship in a new release. Once a fix is available, we publish the advisory, crediting you
  unless you ask to stay anonymous.

## Verifying releases

The tag-triggered release workflow builds and publishes every release. Download installers only
from the [Releases page](https://github.com/OpenCoven/chat/releases). Each release includes a
`SHA256SUMS` file that lists every asset by the exact name GitHub serves it under, such as
`OpenCoven.Chat_0.0.5_x64-setup.exe`. If your browser renamed a download, rename it back first.
Then, in the folder that holds the installer and `SHA256SUMS`, run:

```bash
shasum -a 256 -c --ignore-missing SHA256SUMS
```

On Windows, run `Get-FileHash -Algorithm SHA256 <installer>` in PowerShell and
compare the hash with that file's line in `SHA256SUMS`.

- **macOS:** the app and disk images are signed and notarized.
- **Windows:** the `.msi` and `.exe` installers are not code-signed yet, so
  Windows SmartScreen shows **Windows protected your PC** the first time one
  runs. Check the hash first, then choose **More info** and **Run anyway**.
- **Linux:** the `.AppImage` and `.deb` are not signed.

On Windows and Linux, the matching `SHA256SUMS` line is your integrity check.

> **Warning:** Treat a macOS build that isn't signed and notarized, or any download whose hash
> doesn't match its `SHA256SUMS` line, as untrusted.

The app updates itself only when you choose **Restart to update** under **Settings › About**. It reads one feed, the `latest.json` on the `updater` release of this repository, over HTTPS. It installs only an update whose signature verifies against the public key built into the app, and it waits while a reply is running. Versions without the updater (0.0.6 and earlier) don't update themselves; install a newer release by hand.

## iPhone companion boundary

The optional companion listener is off when the desktop app launches, and stays off until you
explicitly enable it on the desktop. It exposes a narrow, authenticated HTTPS API on a private IPv4
interface.

- The listener refuses browser Origin requests and redirects.
- The phone pins the paired certificate before it sends its random bearer, keeps the pairing in the
  device-only Keychain, and stores no transcript or draft on disk.
- Desktop credentials and durable idempotency receipts use private app storage.
- Revoking phones rotates the bearer and closes existing connections.
- Discovery records contain only a candidate endpoint and a public fingerprint, never a token.
- The test-only `companion-fixture` Cargo feature is not enabled in releases.
