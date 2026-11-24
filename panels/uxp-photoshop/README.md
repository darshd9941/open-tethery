# Pocket Monitor - Photoshop UXP plugin

Plugins > **Pocket Monitor**. It is a "source" for the Pocket Monitor helper
(`ws://127.0.0.1:47825/ws`, role `source`, see `docs/PROTOCOL.md` sections 3, 5, 9).
It sends the open document as JPEG frames; the helper serves phones.

The panel shows a big QR code, the 4-letter code, the phone URL, IDLE/LIVE,
the document name and size, how many phones are connected, and a **New code**
button. If the helper is not running it shows a "Helper not running" card
(UXP plugins cannot start programs; the helper starts with Windows when set up by
the installer, or use the Start Live Preview shortcut).

## Layout

| File | Purpose |
| --- | --- |
| `manifest.json`, `index.html`, `panel.css`, `main.js` | Panel UI and glue |
| `js/otv1.js` | OTV1 kind-1 frame packer (24-byte header + 8-byte meta + JPEG) |
| `js/source-client.js` | Protocol client (hello, source-state, binary frames, reconnect) with injected WebSocket |
| `js/ps-capture.js` | **All Photoshop API calls**: document watching, `imaging.getPixels` + `encodeImageData`, colour profile |
| `js/icc.js`, `js/icc-profiles.js` | Injects sRGB / Display P3 ICC profile into the JPEG (ported from the old relay, CC0 profiles) |
| `js/format.js`, `js/helper-api.js` | Pure helpers, `/api/session` calls |
| `lib/qrcode.js` | QR generator (MIT); the QR is drawn locally from `primaryUrl`, no SVG needed |

A source stays live while connected after its first frame (PROTOCOL.md), so no
keep-alive is sent. After a reconnect the client replays the last frame and
source-state. The phone count comes from `state.viewers` over the WebSocket;
`/api/session` is polled every 5 s (and when `state.code` changes) for the code and URL only.

## Network permission

`manifest.json` allows only `ws://127.0.0.1:47825` and `http://127.0.0.1:47825`
(not `"all"`). No file-system permission is needed (ICC profiles are embedded).
If Photoshop refuses the connection, check that entry first; `"domains": "all"`
is the fallback.

## Test (Linux/macOS/Windows, no Photoshop)

```
cd panels/uxp-photoshop
npm install        # only the ws devDependency, for the fake helper in tests
npm test           # node --test "test/*.test.js"
```

## Load in Photoshop

- Development: Creative Cloud > UXP Developer Tool > Add Plugin > pick
  `panels/uxp-photoshop/manifest.json` > Load.
- Package: `node panels/uxp-photoshop/tools/pack-ccx.js` (any OS) or
  `powershell -ExecutionPolicy Bypass -File panels\uxp-photoshop\tools\pack-ccx.ps1`
  creates `build/photoshop/com.pocketmonitor.photoshop.ccx`; double-click it to install.

The packers leave out: `test/`, `tools/`, `node_modules/`, `package.json`,
`package-lock.json`, `README.md` and dotfiles.

## Needs PC test

- Real canvas capture: `imaging.getPixels` with `targetSize`, `colorProfile`, `applyAlpha` and
  `encodeImageData({base64:true})` returning a JPEG (only faked in tests).
- Colour: sRGB and Display P3 on a phone; ICC tag actually honoured by the phone browser.
- Performance on big documents (multi-layer 10k px PSDs): modal capture time, UI freezing, Photoshop
  "busy" retries, the 12 MP cap and picture size setting.
- Network permission: Photoshop's prompt (or silent block) for `ws://` and `http://` on 127.0.0.1:47825,
  and `fetch` + `WebSocket` working from the panel.
- `binaryType = "arraybuffer"` and sending an `ArrayBuffer` through the UXP WebSocket.
- Photoshop 24.0 to 2027: manifest minVersion 24.0.0; `app.getColorProfiles`, `document.title`.
- Panel layout at 250-320 px width, QR scanning from the panel.
- Helper restart: panel reconnects, and sends document + frame again.
