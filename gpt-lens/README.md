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
  <a href="#features">Features</a> •
  <a href="#development">Development</a>
</p>

## Install

```bash
./sync-to-cache.command
```

Then open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select:

```text
/Users/celes/Documents/Personal/AppConfig/cache/gpt-lens
```

## Features

- Observe the model requested by the ChatGPT web client.
- Report server-exposed model metadata when available; otherwise show **Unverified**.
- Track local usage and rolling quota estimates.
- Sync usage data through Google Drive `appDataFolder`.
- Export selected ChatGPT turns to Markdown.

## Development

GPT Lens is a Manifest V3 extension with no build step. Edit the source, rerun `./sync-to-cache.command`, then reload the extension in Chrome.

The extension never treats the visible ChatGPT model label as proof of the backend model.

