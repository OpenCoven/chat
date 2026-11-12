# Unpublished v0.0.10 draft

- Chat looks up a familiar's saved conversation directly when the session list omits it. If the conversation is unavailable, other familiars can still receive messages.
- Chat launches Coven Code with Coven's managed engine home so it can find its goal database when the legacy home is unavailable.
- **Settings → Access** has a scrollable project list and a **Refresh project access** button. To edit grants, use the familiar's **Projects** tab in Coven Cave, then refresh in Chat.
- **Settings → Model → Every message** has a model dropdown with engine presets, the engine default, and a custom model ID option.

This was a local draft before the v0.1.0 release renumbering, not a published release. Use the current release notes and `SHA256SUMS` for downloads.

```sh
shasum -a 256 -c --ignore-missing SHA256SUMS
```

On Windows, the unsigned installers can trigger SmartScreen. After verifying the checksum, choose **More info**, then **Run anyway**.
