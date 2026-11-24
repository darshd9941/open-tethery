# Pocket Monitor CEP panel (Premiere Pro + After Effects)

Window > Extensions > Pocket Monitor. Shows the pairing QR and code, the live
sequence, connected phones, and runs playback commands from phones. It talks
to the helper on `127.0.0.1:47825` as role `panel` (docs/PROTOCOL.md section 8).

## Layout

- `CSXS/manifest.xml`, `.debug`: bundle `com.pocketmonitor.panel`, extension `com.pocketmonitor.panel.main`, PPRO/AEFT `[24.0,99.9]`, CSXS 11, Node + mixed context.
- `client/js/state-format.js`, `panel-client.js`, `control-bridge.js`, `helper-launcher.js`: pure UMD modules (tested in Node). `main.js` is the DOM wiring.
- `client/lib/CSInterface.js`: Adobe's public CSInterface, carried over from `apps/premiere-ae`.
- `client/config.json`: `devHelperPath` = absolute path to `helper/bin/open-tethery-helper.js` for dev; `helperHost`.
- `host/host.jsx`: ExtendScript (ES3). `otGetHostState()`, `otControl(cmd, arg)`.

## Install (Windows, dev)

1. Copy this folder to `%APPDATA%\Adobe\CEP\extensions\com.pocketmonitor.panel` (without `node_modules`/`test`).
2. Unsigned panels need debug mode, for each of `CSXS.11` and `CSXS.12` (add the others if your Adobe version needs it):
   `reg add HKCU\Software\Adobe\CSXS.11 /v PlayerDebugMode /t REG_SZ /d 1 /f`
3. Restart Premiere/After Effects. Remote debugging: open `http://localhost:8099` (Premiere) or `:8100` (AE) in Chrome.

Helper launch order when `/health` does not answer: `%LOCALAPPDATA%\PocketMonitor\start-helper.vbs` (via wscript), then `PocketMonitorHelper.exe`, then `node <devHelperPath>`. The panel retries with backoff (0.5 s up to 5 s).

## Tests

`npm install && npm test` (node --test, tests incl. a fake-ExtendScript vm for both hosts).
Layout screenshots: `NODE_PATH=$(npm root -g) node test/screenshot.js` -> `test/screenshots/`.

## Connection and report (M7)

The Connection dropdown lists the helper's `connections` (Wi-Fi, Ethernet, Phone hotspot, USB cable, Tailscale, ...) with
2-3 lines of help; picking one sends `panel-settings {connection}` and the QR reloads. "Send report" calls
`POST /api/report` and shows the saved path; "Open folder" runs `explorer.exe /select,<zip>` (falls back to
`openURLInDefaultBrowser` on the folder). Logic is in `client/js/connections.js` (tested).

## Control limits

- Premiere: no ExtendScript "isPlaying". `playing` is our own flag (set by play/pause) corrected by whether the playhead advances in real time between polls (stops after 2 still polls). Playback uses undocumented QE `qe.startPlayback()/stopPlayback()`. Starting playback from Premiere's own keys is detected only by the playhead moving.
- After Effects: no playback API. play/pause/toggle run a menu command found with `app.findMenuCommandId` ("Play/Pause", "Play", "RAM Preview"); if none is found they return `{ok:false, code:"unsupported"}`. `playing` is only our own flag.
- Everything else (seek, step, jump start/end) is supported on both. Unknown or bad commands return `unsupported` / `bad-args`.

## Needs PC test

- Panel loads in Premiere 2024/2025/2026+ and AE 2024+ with PlayerDebugMode; icon, menu name, min size.
- `window.cep_node.require('child_process')` works; helper starts via vbs, exe and dev node path; no console window flashes.
- QR image from `http://127.0.0.1:47825/api/qr.svg` loads from the `file://` panel page (mixed content) ; Copy button (`execCommand('copy')`) works.
- `qe.startPlayback/stopPlayback` actually play and stop the active sequence; playhead-based playing detection; seek with a ticks string; step/jump at ends.
- AE menu command name for play/pause on the user's AE version and language (likely needs a different name or command id); comp.time seek.
- host-state polling at 500 ms does not stall the Premiere UI; `app.project.activeSequence` is correct when the timeline is not focused.
- evalScript reply for sequence names with non-ASCII characters.
- Engine warning appears/disappears when toggling Pocket Monitor in Preferences, and "Check again" refreshes it.
- Connection dropdown: picking Phone hotspot / USB / Tailscale re-renders the QR with that address and a phone can open it.
- Send report: the `fetch` POST from the `file://` panel page is accepted (CORS), the zip is written, and "Open folder" opens Explorer with the file selected (`cep_node` child_process).
