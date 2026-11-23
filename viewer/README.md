# Open Tethery viewer (phone web app)

Static PWA served by the helper at `/` and `/c/CODE`. Plain ES modules, no build step, no CDN, no frameworks.
It talks to the helper on the same origin: `ws(s)://<host>/ws`, protocol v1 (`docs/PROTOCOL.md`).
Module contract for feature streams (scopes, social frames): `CONTRACT.md`.

## Files

| File | What |
|---|---|
| `index.html`, `css/base.css`, `manifest.webmanifest`, icons | page, dark theme, PWA |
| `js/app.js` | UI wiring, code entry, now-playing, transport bar, sound, stats, save/share/fullscreen |
| `js/net.js` | WebSocket: hello/welcome, ping every 2 s, reconnect with backoff, bad-code / locked |
| `js/otv1.js` | OTV1 binary parser (video kind 1, PCM kind 2) |
| `js/audio.js`, `js/jitter.js` | Web Audio playback, ~100 ms jitter buffer, sync offset |
| `js/transport.js`, `js/throttle.js` | control messages, availability rules, seek throttle (<= 15/s) |
| `js/gestures.js` | pinch-zoom, pan, double-tap fit, tap toggles UI |
| `js/frame-bus.js` | **API for overlays/scopes**: `onFrame(cb)`, `getStage()`, `onLayout(cb)`, `getLatestFrame()` |
| `js/bus.js`, `js/social.js`, `js/scopes.js` | event bus + stubs from the other viewer stream (CONTRACT.md); core emits `frame`, `state`, `layout`, `conn` |
| `js/transport-webrtc.js` | stub that reports unsupported (WebRTC comes later) |

### Mount point for overlays

`getStage()` returns `#overlayStage`: an absolutely positioned div that always covers exactly the picture
(letter-boxed to the source aspect) and zooms with it. The Overlays button does
`import('/js/overlays/index.js')`; if the file is missing it shows "Overlays are coming soon". If it exists,
core calls its `init({ bus, getStage, layer, panel, toast })` once (panel = element inside the Overlays sheet),
then `open()` each time the sheet is shown. `initSocial` / `initScopes` (CONTRACT.md) are also called at start.

## Tests

```
cd viewer && npm install      # only installs `ws` for the fake helper
npm test                      # node --test test/*.test.mjs
```

- `test/pure.test.mjs`: OTV1, code input, timecode, jitter maths, seek throttle, transport, layout.
- `test/smoke.test.mjs`: Playwright (Chromium, iPhone 13 emulation) against `test/fake-server.mjs`; skipped if
  `playwright` is not installed. Screenshots go to `test/screenshots/`.
- `npm run dev` starts the fake helper (code `ABCD`) with the viewer on port 47825, for manual poking.

## Not done

- Invite view with a QR code (the helper already serves `/api/qr.svg` for the PC side).
- Service worker (nothing useful to cache; the helper sends `no-store` for `index.html`).
- WebRTC (stub only).

## Needs PC / real phone testing

1. Real helper + Premiere/AE: picture, timecode, LIVE/IDLE, sequence name, aspect and fps look right.
2. **iPhone Safari audio unlock:** tap Sound with a real stream, audio must start without a second tap; check
   the silent (ringer) switch behaviour; lock/unlock the phone and confirm sound resumes.
3. **Audio sync:** play with sound on; adjust Sync until lips match, check -300 and +300 behave.
4. **Fullscreen on iOS:** iPhone Safari has no Fullscreen API, so the button only hides the controls
   (tap picture to bring back). Check Android Chrome real fullscreen and the "Add to Home Screen" standalone launch.
5. **Share sheet:** Save frame opens the share sheet with the PNG on iOS/Android (Save to Photos); desktop falls
   back to a download. Share link opens the share sheet; fallback copies the URL.
6. Transport: play/pause, step, jump, scrub against Premiere and After Effects; control off shows the note;
   Photoshop shows "no playback to control".
7. Wrong code x5 shows the locked countdown; Wi-Fi drop shows the reconnect banner and recovers.
8. Pinch-zoom/pan/double-tap on a phone with a 9x16 and a 16x9 sequence.

## Protocol notes

- "Connected, waiting for picture - <PC name>" uses `welcome.server.pcName` (or `server.host`) when the helper sends
  it, else `location.hostname`. Proposal: add `server.pcName` to the `welcome` message (section 3).
