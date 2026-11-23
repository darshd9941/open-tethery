// Module worker: scope accumulators off the main thread. See scope-math.js.
import { analyse } from './scope-math.js';

self.onmessage = (e) => {
  const { id, buffer, w, h, want } = e.data;
  const r = analyse(new Uint8ClampedArray(buffer), w, h, want);
  const transfer = [];
  if (r.hist) for (const k of ['luma', 'r', 'g', 'b']) transfer.push(r.hist[k].buffer);
  if (r.wave) transfer.push(r.wave.buffer);
  if (r.vec) transfer.push(r.vec.buffer);
  self.postMessage({ id, result: r }, transfer);
};
