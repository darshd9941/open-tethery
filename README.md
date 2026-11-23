# Open Tethery

Live preview of what you are editing in Adobe apps, on any phone, tablet or
laptop on the same Wi-Fi. The panel shows a QR code; scan it and the phone
shows the editor's output live.

Status: early. See [docs/plan.md](docs/plan.md) for the full plan and phases.

## What is in here

| Folder | What it is | State |
|---|---|---|
| `apps/photoshop/` | Photoshop UXP panel + Node relay + phone viewer | Working |
| `apps/premiere-ae/` | Premiere Pro / After Effects CEP panel + relay + viewer (still frames only) | Partial, to be replaced by native capture |
| `native/transmit/` | Our own Mercury Transmit plugin for Premiere (real-time frames + audio) | Phase 1, in progress |
| `docs/` | Plan and design notes | |
| `sdk/` | **Not committed.** Put the Adobe Premiere Pro C++ SDK here | Local only |

## Adobe SDK

The Premiere Pro C++ SDK is licensed by Adobe and is never committed. Unzip it
so this path exists:

```
sdk/Premiere Pro 27.0 C++ SDK/Examples/Headers
```

or set the `PREMIERE_SDK` environment variable to the SDK's `Examples` folder.

## Quick start (Photoshop)

1. Install Node.js LTS.
2. Run `apps/photoshop/Start Live Preview.bat`.
3. Load `apps/photoshop/plugin` in UXP Developer Tool, open the panel, scan the QR.

## Run everything locally

Needs Node 22. No Adobe apps are needed to try the pieces together.

```
npm run install:all        # npm install in every component
npm run test:all           # unit tests of every component + the end-to-end test
```

Run it by hand:

```
cd helper
OT_VIEWER_DIR=../viewer node bin/open-tethery-helper.js   # prints the session code, serves the phone viewer on :47825
node tools/fake-transmit.js                               # second terminal: fake Premiere frames
```

Open `http://127.0.0.1:47825/c/<code>` (code from `http://127.0.0.1:47825/api/session`) in a browser, or on a phone
on the same Wi-Fi via the PC LAN address. `panels/cep/client/index.html` also opens in plain Chromium for a look at the panel.

`e2e/run.test.js` starts the real helper, a fake Transmit, the CEP panel (stubbed CSInterface) and an iPhone 13 viewer in
Playwright Chromium, then checks pairing, picture, play control, "Allow control", the Photoshop source path and the
wrong-code lockout. Screenshots land in `e2e/screenshots/`.
