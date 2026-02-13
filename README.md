# Call Transcript Merger

Merge call transcripts from **Gong**, **Grain**, and other call recording platforms into a single chronological Markdown document.

## Download

**Build the latest (v1.0.3)** on your Mac for best results:

```bash
git clone <this-repo>
cd Transcript-Project-
./scripts/build-mac.sh
```

**Pre-built downloads:**

- **[Linux (v1.0.3)](releases/Call-Transcript-Merger-1.0.3-linux.zip)** — Unzip, then run the `call-transcript-merger` executable.
- **[Mac (v1.0.2)](releases/Call-Transcript-Merger-1.0.2-mac.zip)** — Unzip and double-click the `.app` to run.

> **First launch on Mac:** macOS blocks unsigned apps. Open Terminal and run:
> ```
> xattr -cr ~/Downloads/Call\ Transcript\ Merger.app
> ```
> Then double-click the app. You only need to do this once.
>
> **To build a fully signed app** (no Gatekeeper warnings at all), clone the repo on your Mac and run `./scripts/build-mac.sh`. See [Building a signed Mac app](#building-a-signed-mac-app) below.

## Features

- **Gong integration** — Imports accounts, calls, transcripts, speaker info, and AI summaries via Gong API v2
- **Grain integration** — Imports recordings, transcripts, and intelligence notes via Grain Public API
- **Custom provider support** — Connect any call recording API through a setup wizard with field mapping
- **Company/account selection** — Checkboxes with alphabetical sort; select across platforms to handle duplicates
- **Chronological merge** — All calls sorted by date into one continuous Markdown document
- **Rich metadata** — Speaker info, call summaries, key points, and outlines above each transcript
- **Word count** — Displayed in UI and in the output filename
- **Pause/resume** — Sessions save progress; resume after API rate limits reset
- **Rate limiting** — Automatically uses the lowest per-second limit across all configured providers
- **Output** — Markdown file saved to your Downloads folder

## Quick Start

### Run in Chrome (web server mode)

```bash
npm install
npm start
```

Open http://localhost:3847 in Chrome.

### Run as Mac desktop app (Electron)

```bash
npm install
npx electron .
```

## Building a signed Mac app

For a Mac `.app` that opens without any Gatekeeper warnings, **build it on your Mac**:

```bash
git clone <this-repo>
cd Transcript-Project-
./scripts/build-mac.sh
```

This produces a `.dmg` and `.zip` in the `dist/` folder. The app will be ad-hoc signed so it works on your machine without the `xattr` workaround.

For full notarization (other people can open it without warnings too), set up a free [Apple Developer account](https://developer.apple.com) and run:

```bash
export APPLE_ID="you@icloud.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="XXXXXXXXXX"
./scripts/build-mac.sh
```

## Setup

### Gong
1. In Gong, go to **Admin Center > Settings > Ecosystem > API**
2. Click **Create** to generate an Access Key and Secret
3. Enter both in the app's Gong configuration

### Grain
1. In Grain, go to **Settings > Integrations**
2. Generate an API key / personal access token
3. Enter it in the app's Grain configuration

### Custom Provider
1. Click **+ Add Custom** in Step 1
2. Fill in the base URL, authentication, and rate limit
3. Map the API's response fields to the standard schema using dot-notation
4. Select whether to map to Gong or Grain field schema as the primary

## Architecture

```
src/
  main/
    server.js       Express backend (API routes, merge orchestration)
    electron.js     Electron wrapper for desktop mode
  api/
    base-provider.js    Base class all providers implement
    providers/
      gong.js           Gong API v2 integration
      grain.js          Grain Public API integration
      custom.js         Generic provider with field mapping
  services/
    merger.js           Chronological transcript merge + Markdown generation
    session.js          Pause/resume session state management
  utils/
    rate-limiter.js     Shared rate limiter (Bottleneck)
public/
  index.html            Single-page UI
  css/style.css         Styles
  js/app.js             Frontend logic
scripts/
  build-mac.sh          One-command Mac build with signing + notarization
  notarize.js           Electron-builder afterSign hook for Apple notarization
  generate-icons.py     Generates Noo-noo app icons in all formats
build/
  icon.png              App icon (512x512 PNG)
  icon.ico              App icon (Windows ICO)
  entitlements.mac.plist           macOS entitlements for hardened runtime
  entitlements.mac.inherit.plist   Inherited entitlements for child processes
```

## API Rate Limits

The app automatically detects the lowest rate limit across all configured providers and throttles all API calls to that rate:

| Provider | Per-second limit | Daily limit |
|----------|-----------------|-------------|
| Gong     | 1 req/sec       | ~10,000/day |
| Grain    | Not published   | ~5 req/sec (conservative) |
| Custom   | User-configured | User-configured |

When a 429 (rate limit) response is received, the session automatically pauses. You can save it and resume later when your limit resets.
