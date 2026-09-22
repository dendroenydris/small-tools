<h1 align="center">
  <br>
  <img src="./icons/icon128.png" width="128">
  <br>
  GPT Lens
  <br>
</h1>

<h4 align="center">A small Chrome extension for observing ChatGPT model requests, server-exposed model metadata, and local usage.</h4>

<p align="center">
  <a href="#install">Install</a> •
  <a href="#build">Build</a> •
  <a href="#features">Features</a> •
  <a href="#development">Development</a>
</p>

## Install

Download the ZIP attached to the latest GitHub Release, extract it, then open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select the extracted extension directory.

For Chrome Web Store distribution, upload the release ZIP directly.

## Build

GPT Lens has no compile-time dependencies. Build the Chrome extension with:

```bash
./build.command
```

This creates:

```text
dist/gpt-lens/                 # load with "Load unpacked"
dist/gpt-lens-vX.Y.Z.zip      # Chrome Web Store / GitHub Release package
```

The ZIP is reproducible: files are sorted and stored with fixed timestamps.

### Google Drive sync

The source manifest intentionally contains a placeholder OAuth client ID. To build with a real Google OAuth client ID:

```bash
GPT_LENS_GOOGLE_CLIENT_ID="your-client-id.apps.googleusercontent.com" ./build.command
```

or:

```bash
./build.command --oauth-client-id "your-client-id.apps.googleusercontent.com"
```

Without a configured OAuth client ID, the rest of GPT Lens works normally but Google Drive sync cannot authenticate.

## Features

- Observe the model requested by the ChatGPT web client.
- Report server-exposed route/model metadata when available; otherwise show **Unverified**.
- Correlate HTTP streaming and WebSocket handoffs for route detection.
- Track local usage and rolling quota estimates.
- Sync usage data through Google Drive `appDataFolder` when OAuth is configured.
- Export selected ChatGPT turns to Markdown.

## Development

Edit the source and run:

```bash
./build.command
```

Then load or reload `dist/gpt-lens/` from `chrome://extensions`.

The release package contains only the files required by the extension; tests, build scripts, and repository metadata are excluded.

The extension never treats the visible ChatGPT model label as proof of the backend model.

