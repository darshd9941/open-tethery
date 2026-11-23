// OTV1 binary media parser (docs/PROTOCOL.md section 5). Pure, no DOM.
export const KIND_VIDEO = 1;
export const KIND_AUDIO = 2;
export const HEADER_BYTES = 24;

const MAGIC = [0x4f, 0x54, 0x56, 0x31]; // "OTV1"

// Returns null for anything malformed (the caller just ignores it).
export function parseOTV1(buffer) {
  if (!(buffer instanceof ArrayBuffer) && !ArrayBuffer.isView(buffer)) return null;
  const u8 = buffer instanceof ArrayBuffer
    ? new Uint8Array(buffer)
    : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (u8.length < HEADER_BYTES + 8) return null;
  for (let i = 0; i < 4; i++) if (u8[i] !== MAGIC[i]) return null;

  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const kind = u8[4];
  const flags = u8[5];
  const seq = dv.getUint32(8, true);
  const t = dv.getFloat64(16, true);
  const time = Number.isFinite(t) ? t : NaN;

  if (kind === KIND_VIDEO) {
    if (u8.length <= 32) return null;
    return {
      kind: 'video',
      keyframe: (flags & 1) === 1,
      seq,
      time,
      width: dv.getUint16(24, true),
      height: dv.getUint16(26, true),
      srcW: dv.getUint16(28, true),
      srcH: dv.getUint16(30, true),
      jpeg: u8.subarray(32),
    };
  }

  if (kind === KIND_AUDIO) {
    const sampleRate = dv.getUint32(24, true);
    const channels = u8[28];
    const format = u8[29];
    const frames = dv.getUint16(30, true);
    if (format !== 1 || channels < 1 || channels > 8 || sampleRate < 8000 || sampleRate > 192000) return null;
    const bytes = frames * channels * 2;
    if (frames === 0 || u8.length < 32 + bytes) return null;
    // Copy so the Int16Array is aligned whatever the source offset.
    const samples = new Int16Array(frames * channels);
    for (let i = 0; i < samples.length; i++) samples[i] = dv.getInt16(32 + i * 2, true);
    return { kind: 'audio', seq, time, sampleRate, channels, frames, samples };
  }
  return null;
}
