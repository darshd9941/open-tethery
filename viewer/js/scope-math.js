// Pure scope maths (no DOM). BT.709 luma, Cb/Cr, histogram, waveform, vectorscope,
// false-colour bands, zebra threshold, audio chunk levels. Pixel data is RGBA bytes (ImageData.data).

export const LUMA = { r: 0.2126, g: 0.7152, b: 0.0722 };
export const VEC_SIZE = 128; // vectorscope grid is VEC_SIZE x VEC_SIZE

// r,g,b in 0..1 (gamma-encoded) -> luma 0..1
export const luma709 = (r, g, b) => LUMA.r * r + LUMA.g * g + LUMA.b * b;

// BT.709 colour difference, each in -0.5..0.5. cr is "up" on the vectorscope.
export function cbcr(r, g, b) {
  const y = luma709(r, g, b);
  return { y, cb: (b - y) / 1.8556, cr: (r - y) / 1.5748 };
}

// Vectorscope grid cell for a cb/cr pair (x right = +Cb, y down = -Cr).
export function vecCell(cb, cr, size = VEC_SIZE) {
  const gx = Math.round((cb + 0.5) * (size - 1));
  const gy = Math.round((0.5 - cr) * (size - 1));
  return { gx: Math.min(size - 1, Math.max(0, gx)), gy: Math.min(size - 1, Math.max(0, gy)) };
}

// 75% colour bars: amplitude 0.75 on the active channels.
export const BAR_TARGETS = [
  { name: 'R', rgb: [1, 0, 0] }, { name: 'Mg', rgb: [1, 0, 1] }, { name: 'B', rgb: [0, 0, 1] },
  { name: 'Cy', rgb: [0, 1, 1] }, { name: 'G', rgb: [0, 1, 0] }, { name: 'Yl', rgb: [1, 1, 0] },
].map((t) => {
  const [r, g, b] = t.rgb.map((v) => v * 0.75);
  const { cb, cr } = cbcr(r, g, b);
  return { name: t.name, cb, cr };
});

// Skin-tone line: 123 degrees from +Cb, counter-clockwise, through the centre.
export const SKIN_ANGLE_DEG = 123;
export function skinLineEnd(radius = 0.5) {
  const a = (SKIN_ANGLE_DEG * Math.PI) / 180;
  return { cb: Math.cos(a) * radius, cr: Math.sin(a) * radius };
}

// Downscaled picture size for analysis (<= maxW wide, keeps aspect).
export function analysisSize(w, h, maxW = 320) {
  if (!(w > 0 && h > 0)) return { w: 1, h: 1 };
  const s = Math.min(1, maxW / w);
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}

// want: { hist, wave, vec }. Returns only the requested accumulators.
export function analyse(data, w, h, want = { hist: true, wave: true, vec: true }) {
  const out = { w, h };
  const hist = want.hist ? { luma: new Uint32Array(256), r: new Uint32Array(256), g: new Uint32Array(256), b: new Uint32Array(256) } : null;
  const wave = want.wave ? new Uint32Array(w * 256) : null;
  const vec = want.vec ? new Uint32Array(VEC_SIZE * VEC_SIZE) : null;
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const l = Math.round(LUMA.r * r + LUMA.g * g + LUMA.b * b);
      if (hist) { hist.luma[l]++; hist.r[r]++; hist.g[g]++; hist.b[b]++; }
      if (wave) wave[x * 256 + l]++;
      if (vec) {
        const c = cbcr(r / 255, g / 255, b / 255);
        const cell = vecCell(c.cb, c.cr);
        vec[cell.gy * VEC_SIZE + cell.gx]++;
      }
    }
  }
  if (hist) out.hist = hist;
  if (wave) out.wave = wave;
  if (vec) out.vec = vec;
  return out;
}

export const arrayMax = (a) => { let m = 0; for (let i = 0; i < a.length; i++) if (a[i] > m) m = a[i]; return m; };

// ---- exposure helpers ----

// Bands in percent of luma (0..100). `rgb` null means "show the picture in grey".
export const FALSE_COLOUR_BANDS = [
  { to: 2, rgb: [123, 47, 191], label: '0–2  crushed' },
  { to: 10, rgb: [47, 95, 223], label: '2–10  deep shadow' },
  { to: 25, rgb: [31, 181, 181], label: '10–25  shadow' },
  { to: 42, rgb: null, label: '25–42  dark mid' },
  { to: 52, rgb: [63, 191, 74], label: '42–52  mid grey' },
  { to: 70, rgb: null, label: '52–70  light mid' },
  { to: 85, rgb: [232, 210, 58], label: '70–85  bright' },
  { to: 95, rgb: [240, 138, 36], label: '85–95  near clip' },
  { to: 100.001, rgb: [224, 32, 32], label: '95–100  clipped' },
];

export function falseColourBand(lumaPct) {
  const p = Math.min(100, Math.max(0, lumaPct));
  for (let i = 0; i < FALSE_COLOUR_BANDS.length; i++) if (p <= FALSE_COLOUR_BANDS[i].to) return i;
  return FALSE_COLOUR_BANDS.length - 1;
}

// Fill `out` (RGBA, same size as data) with false colour.
export function falseColourImage(data, out) {
  for (let i = 0; i < data.length; i += 4) {
    const l = LUMA.r * data[i] + LUMA.g * data[i + 1] + LUMA.b * data[i + 2];
    const band = FALSE_COLOUR_BANDS[falseColourBand((l / 255) * 100)];
    if (band.rgb) { out[i] = band.rgb[0]; out[i + 1] = band.rgb[1]; out[i + 2] = band.rgb[2]; }
    else { out[i] = out[i + 1] = out[i + 2] = l; }
    out[i + 3] = 255;
  }
  return out;
}

// Zebra: true where luma percent >= threshold (95 = near clip, 100 = clipped).
export const isZebra = (lumaByte, thresholdPct) => (lumaByte / 255) * 100 >= thresholdPct - 1e-9;

// Alpha mask (255 where zebra) written into out RGBA.
export function zebraMask(data, out, thresholdPct) {
  for (let i = 0; i < data.length; i += 4) {
    const l = LUMA.r * data[i] + LUMA.g * data[i + 1] + LUMA.b * data[i + 2];
    out[i] = out[i + 1] = out[i + 2] = 255;
    out[i + 3] = isZebra(l, thresholdPct) ? 255 : 0;
  }
  return out;
}

// ---- audio ----

// Interleaved Int16 samples -> { l, r, peakL, peakR } (rms and sample peak, 0..1).
export function chunkLevels(samples, channels) {
  const ch = Math.max(1, channels | 0);
  const sum = [0, 0], peak = [0, 0], n = [0, 0];
  for (let i = 0; i < samples.length; i++) {
    const c = ch === 1 ? 0 : Math.min(i % ch, 1);
    const v = Math.abs(samples[i]) / 32768;
    sum[c] += v * v; n[c]++;
    if (v > peak[c]) peak[c] = v;
  }
  const rms = (c) => (n[c] ? Math.sqrt(sum[c] / n[c]) : 0);
  if (ch === 1) return { l: rms(0), r: rms(0), peakL: peak[0], peakR: peak[0] };
  return { l: rms(0), r: rms(1), peakL: peak[0], peakR: peak[1] };
}

// linear 0..1 -> meter fraction 0..1 over -60..0 dBFS
export function levelToMeter(v, floorDb = -60) {
  if (!(v > 0)) return 0;
  const db = 20 * Math.log10(v);
  return Math.min(1, Math.max(0, (db - floorDb) / -floorDb));
}

// Where to put floating scope widgets. `stage` {w,h} is the dock, `pic` {x,y,w,h} the picture inside it,
// `sizes` [{w,h}] the widgets in order. Widgets go into the empty bands around the picture (above, below,
// left, right: the largest band first, filled left to right in rows); only a widget that fits no band
// floats over the picture, packed down the right-hand side. Returns [{x, y, docked}] in the same order.
export function dockLayout(stage, pic, sizes, { gap = 6, margin = 6 } = {}) {
  const S = { w: stage.w, h: stage.h };
  const bands = [
    { x: 0, y: 0, w: S.w, h: pic.y },
    { x: 0, y: pic.y + pic.h, w: S.w, h: S.h - (pic.y + pic.h) },
    { x: 0, y: 0, w: pic.x, h: S.h },
    { x: pic.x + pic.w, y: 0, w: S.w - (pic.x + pic.w), h: S.h },
  ].filter((b) => b.w > 0 && b.h > 0).sort((a, b) => b.w * b.h - a.w * a.h)
    .map((b) => ({ ...b, cx: b.x + margin, cy: b.y + margin, rowH: 0 }));
  const out = [];
  let fx = S.w - margin, fy = margin, fcol = 0; // floating column over the picture
  for (const sz of sizes) {
    let spot = null;
    for (const b of bands) {
      let cx = b.cx, cy = b.cy, rowH = b.rowH;
      if (cx + sz.w > b.x + b.w - margin + 0.5) { cx = b.x + margin; cy += rowH + gap; rowH = 0; } // next row
      if (cx + sz.w <= b.x + b.w - margin + 0.5 && cy + sz.h <= b.y + b.h - margin + 0.5) {
        spot = { x: cx, y: cy, docked: true };
        b.cx = cx + sz.w + gap; b.cy = cy; b.rowH = Math.max(rowH, sz.h);
        break;
      }
    }
    if (!spot) {
      if (fy + sz.h > S.h - margin && fy > margin) { fx -= fcol + gap; fy = margin; fcol = 0; }
      spot = { x: Math.max(0, fx - sz.w), y: fy, docked: false };
      fy += sz.h + gap; fcol = Math.max(fcol, sz.w);
    }
    out.push(spot);
  }
  return out;
}
