'use strict';

// H.264 Annex B helpers: split an access unit into NAL units and build RTP
// payloads (RFC 6184, packetization-mode=1: single NAL units and FU-A).

const MAX_PAYLOAD = 1200; // bytes of RTP payload; stays under a typical 1280 path MTU with headers

// Returns the NAL units (without start codes) of an Annex B buffer.
function splitAnnexB(buf) {
  const nals = [];
  let start = -1;
  let i = 0;
  while (i + 2 < buf.length) {
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) {
      if (start >= 0) nals.push(trimZeros(buf, start, i));
      start = i + 3;
      i += 3;
    } else i += 1;
  }
  if (start >= 0 && start < buf.length) nals.push(trimZeros(buf, start, buf.length));
  return nals.filter((n) => n.length > 0);
}

// A 4-byte start code leaves one extra 0x00 at the end of the previous NAL.
function trimZeros(buf, from, to) {
  let end = to;
  while (end > from && buf[end - 1] === 0) end -= 1;
  return buf.subarray(from, end);
}

const nalType = (nal) => nal[0] & 0x1f;

// True when the access unit contains an IDR slice (type 5).
function hasIdr(nals) {
  return nals.some((n) => nalType(n) === 5);
}

// NAL units -> array of RTP payload Buffers. The last one carries the marker bit.
function packetize(nals, maxPayload = MAX_PAYLOAD) {
  const out = [];
  for (const nal of nals) {
    const t = nalType(nal);
    if (t === 9 || t === 12) continue; // access unit delimiter, filler: not needed
    if (nal.length <= maxPayload) {
      out.push(nal);
      continue;
    }
    const indicator = (nal[0] & 0xe0) | 28; // FU-A, keeps NRI
    let pos = 1; // the NAL header byte is carried in the FU header
    const chunk = maxPayload - 2;
    while (pos < nal.length) {
      const len = Math.min(chunk, nal.length - pos);
      const first = pos === 1;
      const last = pos + len >= nal.length;
      const head = Buffer.from([indicator, (first ? 0x80 : 0) | (last ? 0x40 : 0) | t]);
      out.push(Buffer.concat([head, nal.subarray(pos, pos + len)]));
      pos += len;
    }
  }
  return out;
}

module.exports = { splitAnnexB, packetize, hasIdr, nalType, MAX_PAYLOAD };
