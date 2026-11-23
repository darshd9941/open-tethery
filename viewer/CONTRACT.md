# Viewer module contract

Plain ES modules, no build step. Served by the helper from `viewer/` at `/`
and also at `/c/<CODE>`, so **all URLs in HTML/JS/CSS are absolute** (`/js/app.js`).
Wire protocol: `docs/PROTOCOL.md` (owned by the host stream; do not edit it here).

## Files and owners

| Area | Files |
|---|---|
| Core | `index.html`, `manifest.webmanifest`, `css/base.css`, `js/app.js`, `js/net.js`, `js/otv1.js`, `js/player.js`, `js/audio.js`, `js/transport.js`, `dev/*`, `test/*` |
| Overlays entry | `js/overlays/index.js` (tile sheet, mounts the four groups, `composite()`), `js/overlays/info.js`, `js/ui-kit.js`, `css/overlays.css` |
| Social previews | `js/social.js`, `social/*.json` (+ `social/index.json`) |
| Guides | `js/guides.js` |
| Scopes / exposure | `js/scopes.js`, `js/scope-math.js` (pure), `js/scope-worker.js`, `css/scopes.css` |
| Shared | `js/bus.js` (do not change the API) |

## Bus events (`js/bus.js`)

- `frame` → `{ image, width, height, srcW, srcH, time, seq }`. `image` is an
  `ImageBitmap` (or `HTMLImageElement` fallback) of the decoded JPEG. Treat it
  as read-only; core closes it on the next frame, so draw/copy synchronously.
- `state` → the latest protocol `state` object (§4).
- `layout` → `{ x, y, w, h }` CSS px: where the picture sits inside `#stage`
  (letter-boxed to `srcW:srcH`). `#layer` is kept positioned on this rect by core.
- `audio-levels` → `{ l, r, peakL, peakR }` (0..1 RMS / sample peak of the latest audio chunk; published by
  `app.js` from `audio.js`'s `onLevels` hook, only while Sound is on).
- `conn` → `{ status: 'connecting'|'live'|'idle'|'closed'|'error', detail? }`.

## Mount points: one path

`app.js` imports `/js/overlays/index.js` once at start (so saved overlays come back without opening the sheet)
and calls `init({ bus, getStage, layer, panel, dock, toast, saveFrame })`; the Overlays button only calls
`open()`. `index.js` is the only caller of the feature mounts (app.js no longer calls them directly):

```js
initScopes({ bus, layer, panel, dock });  // js/scopes.js   (scopes + exposure; false colour/zebra canvas in layer)
initSocial({ bus, layer, panel });        // js/social.js
initGuides({ bus, layer, panel });        // js/guides.js
initInfo({ bus, layer, panel });          // js/overlays/info.js
```

Each returns `{ isActive(), summary() }` for the tile badges. `index.js` also exports `composite(canvas)`,
which draws the picture plus every visible `layer` child (`<svg>` or `<canvas>`) into one canvas for
"Save frame with overlays". Rule for modules: draw into `layer` as an `<svg>` (with its own embedded `<style>`,
no external CSS, so it serialises) or a `<canvas>`; the viewBox is the picture size in CSS px.

- `layer`: the picture rect (`#overlayStage`, zooms with the picture), `pointer-events:none`.
- `panel`: a `div` this feature fills with its controls (shown inside the Overlays sheet).
- `dock`: a `div` covering the stage (not zoomed) for draggable scope widgets. Widgets must stop pointer
  events from reaching `#stage` (core's pan/zoom gestures capture the pointer).

Each feature stores its own settings in `localStorage` under `ot.<feature>.*`
(wrap in try/catch). Feature modules must not open sockets or touch `#video`.

## Style tokens (`css/base.css`)

`--bg --surface --surface-2 --text --text-dim --accent --danger --ok --radius
--gap --font`. Dark UI by default. Phone-first, touch targets ≥ 44px.
