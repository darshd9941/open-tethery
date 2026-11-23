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
| `js/bus.js` | event bus (CONTRACT.md); core emits `frame`, `state`, `layout`, `conn`, `audio-levels` |
| `js/overlays/index.js`, `js/overlays/info.js`, `js/ui-kit.js` | M4 entry: tile sheet, info overlay, composite for save-with-overlays |
| `js/social.js`, `social/*.json` | social frames (11 platforms as data) + profiles |
| `js/guides.js` | safe zones, thirds, centre, grid, letterbox mattes |
| `js/scopes.js`, `js/scope-math.js`, `js/scope-worker.js` | histogram, waveform, vectorscope, false colour, zebras, audio meters |
| `js/transport-webrtc.js` | stub that reports unsupported (WebRTC comes later) |

### Overlays (M4)

Everything is drawn on the phone from the decoded picture; nothing is sent to the PC. Tap **Overlays**: a tile sheet
(Social frames, Guides, Scopes and exposure, Info) plus **Save frame with overlays**. Details in `CONTRACT.md`.

- **Social frames:** Instagram Reels / Feed (4:5) / Story, YouTube (16:9 player), YouTube Shorts, TikTok, X, Facebook,
  Snapchat, Pinterest, Reddit. Our own outline drawings. Each is one file `social/<id>.json` (zones in coordinates
  0..1 of a reference frame, e.g. 9:16; list in `social/index.json`), so a new platform is a data change; the schema
  is checked by `validatePlatform()` in the tests. "Highlight unsafe areas" paints zones covered by the app red and
  the clear area green. A picture with a different shape from the platform's gets the frame fitted inside it.
  Profiles: several (picture picked from the phone's photos, downscaled to 96 px and kept as a data URL in
  localStorage, @handle, caption text or grey placeholder lines), switch in the Profile section.
- **Guides:** title/action safe (90% / 93%, adjustable), thirds, centre mark, custom N x M grid, letterbox/crop mattes
  (2.39, 2.35, 1.85, 4:3, 1:1, 4:5, 9:16).
- **Scopes:** histogram (luma / RGB / parade), waveform (luma), vectorscope (75% bar targets, skin-tone line), audio
  meters (stereo, from the audio chunks, needs Sound on). Computed from a <= 320 px copy, at most 10 times a second,
  in a module Web Worker (main-thread fallback). Draggable, three sizes (S/M/L button), positions saved.
- **Exposure:** false colour with legend, zebras (level slider, 95% / 100% presets), as a full-picture canvas.
- **Info:** timecode, sequence name, play state, fps, host app.
- **Save frame with overlays:** picture plus all visible overlay layers in one PNG at the picture's resolution
  (scope widgets are not included). The normal Save frame stays clean.
- Settings live in localStorage under `ot.social.*`, `ot.guides.*`, `ot.scopes.*`, `ot.info.*`.

## Tests

```
cd viewer && npm install      # only installs `ws` for the fake helper
npm test                      # node --test test/*.test.mjs
```

- `test/pure.test.mjs`: OTV1, code input, timecode, jitter maths, seek throttle, transport, layout.
- `test/overlays-pure.test.mjs`: scope maths (colour bars land on the vectorscope targets, histogram bins, false colour,
  zebras, audio levels), every social JSON file validates and stays inside 0..1, guides geometry.
- `test/overlays.test.mjs`: Playwright, every social frame, guides, each scope, false colour, zebras, drag, save with
  overlays; screenshots in `test/screenshots/overlays/`.
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

9. **Overlays on a real phone:** the profile picture picker (iOS Photos / Android gallery via the file input), scope
   speed on an older phone with a 1080x1920 stream (should stay smooth; scopes run <= 10/s), dragging scopes with a
   finger while pinch-zoom is active, the S/M/L sizes and tap targets at real size, Save frame with overlays going
   through the share sheet (Save to Photos), audio meters moving with Sound on in Premiere.
10. **Social frames vs the real apps:** compare each drawing with the current app UI (apps change their layouts);
    adjust the JSON zones. Helper must serve `.json` files from `viewer/social/` (the fake server does).

## Protocol notes

- "Connected, waiting for picture - <PC name>" uses `welcome.server.pcName` (or `server.host`) when the helper sends
  it, else `location.hostname`. Proposal: add `server.pcName` to the `welcome` message (section 3).
