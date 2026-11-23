# Viewer module contract

Plain ES modules, no build step. Served by the helper from `viewer/` at `/`
and also at `/c/<CODE>`, so **all URLs in HTML/JS/CSS are absolute** (`/js/app.js`).
Wire protocol: `docs/PROTOCOL.md` (owned by the host stream; do not edit it here).

## Files and owners

| Area | Files |
|---|---|
| Core | `index.html`, `manifest.webmanifest`, `css/base.css`, `js/app.js`, `js/net.js`, `js/otv1.js`, `js/player.js`, `js/audio.js`, `js/transport.js`, `dev/*`, `test/*` |
| Social previews | `js/social.js`, `social/*.json`, `css/social.css` |
| Scopes / exposure | `js/scopes.js`, `css/scopes.css` |
| Shared | `js/bus.js` (do not change the API) |

## Bus events (`js/bus.js`)

- `frame` → `{ image, width, height, srcW, srcH, time, seq }`. `image` is an
  `ImageBitmap` (or `HTMLImageElement` fallback) of the decoded JPEG. Treat it
  as read-only; core closes it on the next frame, so draw/copy synchronously.
- `state` → the latest protocol `state` object (§4).
- `layout` → `{ x, y, w, h }` CSS px: where the picture sits inside `#stage`
  (letter-boxed to `srcW:srcH`). `#layer` is kept positioned on this rect by core.
- `conn` → `{ status: 'connecting'|'live'|'idle'|'closed'|'error', detail? }`.

## Mount points (core calls these once from `app.js`)

```js
initSocial({ bus, layer, panel });   // js/social.js
initScopes({ bus, layer, panel, dock }); // js/scopes.js
```

- `layer`: a `div` covering exactly the picture rect (`position:absolute`),
  `pointer-events:none` by default. Draw overlays inside it.
- `panel`: a `div` inside the settings sheet; put this feature's controls here.
- `dock`: a `div` floating over the stage (top-right) for small scope widgets.

Each feature stores its own settings in `localStorage` under `ot.<feature>.*`
(wrap in try/catch). Feature modules must not open sockets or touch `#video`.

## Style tokens (`css/base.css`)

`--bg --surface --surface-2 --text --text-dim --accent --danger --ok --radius
--gap --font`. Dark UI by default. Phone-first, touch targets ≥ 44px.
