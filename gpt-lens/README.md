# GPT Lens for ChatGPT

A small Manifest V3 Chrome extension for ChatGPT that:

- observes the model slug sent by ChatGPT in `POST /backend-api/conversation` or `POST /backend-api/f/conversation`;
- passively looks for server-returned model identifiers such as `model_slug`, `backend_model`, or `served_model` in conversation JSON, fetch responses, EventSource, and WebSocket frames;
- shows **Normal / Mismatch / Unverified** rather than claiming an unverifiable backend model;
- stores usage history locally and displays rolling quota estimates;
- supports the requested **Pro ×5** and **Pro ×20** quota profiles;
- can sync its data through a private Google Drive `appDataFolder` file;
- lets you multi-select current ChatGPT user/assistant turns and export them to Markdown.

## Important model-detection semantics

`frontendModel` is the model requested by the ChatGPT web client (`payload.model`). This is reliable evidence of the client-side route request, but it is not proof of the physical inference deployment.

`backendModel` is only filled when the browser actually receives a model-like server metadata field. If ChatGPT returns only `ok` and never exposes model metadata, GPT Lens displays **Unverified**. It does **not** fabricate a backend model and does not treat the UI label as backend evidence.

Frontend request-model detection uses Manifest V3 `chrome.webRequest.onBeforeRequest` with read-only `requestBody` access. It does not replace, delay, clone, consume, retry, cancel, or modify ChatGPT's outgoing request. A small MAIN-world observer is used only to clone already-returned fetch responses and passively inspect EventSource/WebSocket messages for server-exposed model metadata.

## Install locally

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this `gpt-lens` folder.
5. Reload `https://chatgpt.com/`.

## Google Drive sync setup

Chrome's `chrome.identity.getAuthToken()` requires an OAuth client ID configured for the extension. The manifest currently contains a placeholder so the extension can be developed before the OAuth client is created.

1. Load the unpacked extension once and copy its Extension ID from `chrome://extensions`.
2. In Google Cloud Console, create/configure an OAuth client for a Chrome Extension and associate it with that extension ID.
3. Enable the **Google Drive API**.
4. Replace the placeholder `oauth2.client_id` in `manifest.json` with your OAuth client ID.
5. Reload the extension.
6. Open GPT Lens → **Settings → Sign in**.

The extension requests only `drive.appdata` for its sync file plus `userinfo.email` to show which account is connected. `appDataFolder` is app-private and is not visible in the normal Drive UI.

## Quota profiles

The built-in Free / Go / Plus / Team / Pro values are adapted from the reference extension you supplied and are best treated as configurable display estimates, not authoritative billing enforcement.

Requested custom profiles:

- **Pro ×5:** GPT-6 Pro + GPT-5.6 Sol Pro combined: 50 / rolling 7 days.
- **Pro ×20:** GPT-6 Pro: 200 / rolling 7 days; GPT-5.6 Sol Pro: 170 / rolling 24 hours; GPT-6 Pro + GPT-5.6 Sol Pro combined: 200 / rolling 24 hours.

## Files

- `src/page-bridge.js` — MAIN-world passive response / stream metadata observer.
- `src/content.js` — panel UI, local persistence bridge, Markdown selection/export.
- `src/model-utils.js` — model canonicalization and quota profiles.
- `src/service-worker.js` — non-blocking `webRequest` request-model observer plus Google Identity + Drive appData sync.
- `src/ui.css` — light/dark macOS-style UI.

## Privacy

All usage data stays in `chrome.storage.local` unless you explicitly sign into Google and press sync (or leave sync enabled for the periodic sync). Conversation text is only read from the current DOM when you open/use Select · Export; it is not stored as part of model usage history.

## Manual usage correction

Settings now includes a **Manual usage correction** section. Each model has `−` and `+` controls:

- `+` adds one local synthetic call at the current time.
- `−` offsets one existing positive call in the active quota window. The correction is timestamped to the call it offsets, so both leave rolling quota windows together.
- Manual corrections are ordinary sync events and are included in Google Drive `appDataFolder` synchronization.

## Load-unpacked cache location (macOS)

The extension has no build step and the `gpt-lens` directory itself is the Chrome **Load unpacked** directory. A helper `sync-to-cache.command` is included. Running it copies the extension to:

`/Users/celes/Documents/Personal/AppConfig/cache/gpt-lens`

Then choose that directory in `chrome://extensions` → **Load unpacked**. Re-run the helper after replacing the source directory with a newer version.
