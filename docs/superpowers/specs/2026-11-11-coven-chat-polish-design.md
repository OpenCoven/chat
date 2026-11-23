# Coven Chat desktop refinement

> **Status (2026-11-23):** Delivered. Implemented in `0be8482d` (2026-11-12), merged to `main` by
> PR #614 (`b06aae75`), and shipped in v0.1.2. The delivery record is
> [`docs/design-audits/2026-11-11-coven-chat-polish.md`](../../design-audits/2026-11-11-coven-chat-polish.md).
> Historical record; do not execute.

The user authorized implementation using the agent's judgment. Rename the desktop product to Coven Chat and refine its existing interface into a quiet, minimal desktop application. Keep the familiar list, conversation, composer, inspector, and Settings structure.

Use a coherent thin-stroke icon set, flat surfaces, restrained borders, generous click targets, clear hover and focus states, and a single strong primary action. Retain the approved crown path and outlined speech bubble; refine the desktop icon's outline and regenerate desktop exports. Preserve light and dark appearances, reduced motion, readable assistant text, Send/Stop behavior, keyboard access, and the app identifier `ai.opencoven.chat`.

Improve familiar search with a discoverable clear action, visible result feedback, and retained keyboard focus. Keep secondary header and Settings actions quiet without hiding them. Apply the name consistently to window titles, About, native packaging, release metadata, and current instructions; preserve historical release records and frozen external fixtures.

Use the existing React, CSS, Tauri, and Playwright stack without adding runtime dependencies. Browser e2e tests exercise real rendered application components through an explicit Tauri IPC fixture, covering desktop branding, search, keyboard navigation, sending and stopping, Settings, narrow layouts, and light/dark appearance. Run Chromium and WebKit where supported and record launch failures separately from application assertions. Build a native candidate; do not replace or quit an active installed application.

Considered approaches: a focused refinement preserves navigation and reduces regression risk; a full navigation redesign expands the change substantially. The agent selected the focused refinement under the user's explicit delegation.
