'use strict';

// Small dependency-free QR encoder: byte mode, error correction M, versions 1-10
// (up to 213 bytes at v10). Enough for http://192.168.x.x:47825/c/CODE.

// Per version (index = version): data codewords per block groups and EC codewords per block.
// [ecPerBlock, [count1, dataPerBlock1], [count2, dataPerBlock2]]
const BLOCKS_M = [
  null,
  [10, [1, 16]],
  [16, [1, 28]],
  [26, [1, 44]],
  [18, [2, 32]],
  [24, [2, 43]],
  [16, [4, 27]],
  [18, [4, 31]],
  [22, [2, 38], [2, 39]],
  [22, [3, 36], [2, 37]],
  [26, [4, 43], [1, 44]],
];
const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
const MAX_VERSION = 10;

// --- Reed-Solomon over GF(256), polynomial 0x11D ---
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i += 1) {
  EXP[i] = x;
  LOG[x] = i;
  x <<= 1;
  if (x & 0x100) x ^= 0x11d;
}
for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];

function gfMul(a, b) {
  return a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]];
}

function rsRemainder(data, degree) {
  let gen = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = new Array(gen.length + 1).fill(0);
    for (let j = 0; j < gen.length; j += 1) {
      next[j] ^= gen[j];
      next[j + 1] ^= gfMul(gen[j], EXP[i]);
    }
    gen = next;
  }
  // gen[0] is the leading (x^degree) coefficient = 1.
  const rem = new Array(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ rem.shift();
    rem.push(0);
    for (let i = 0; i < degree; i += 1) rem[i] ^= gfMul(gen[i + 1], factor);
  }
  return rem;
}

function dataCapacity(version) {
  const info = BLOCKS_M[version];
  return info.slice(1).reduce((sum, [count, per]) => sum + count * per, 0);
}

function chooseVersion(byteLength) {
  for (let v = 1; v <= MAX_VERSION; v += 1) {
    const countBits = v < 10 ? 8 : 16;
    if (4 + countBits + 8 * byteLength <= dataCapacity(v) * 8) return v;
  }
  throw new Error(`QR: text too long (${byteLength} bytes, max version ${MAX_VERSION})`);
}

function buildCodewords(bytes, version) {
  const bits = [];
  const put = (value, len) => {
    for (let i = len - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
  };
  put(0b0100, 4);
  put(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  const capBits = dataCapacity(version) * 8;
  put(0, Math.min(4, capBits - bits.length));
  while (bits.length % 8) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let pad = 0xec; data.length < dataCapacity(version); pad ^= 0xec ^ 0x11) data.push(pad);

  const [ecLen, ...groups] = BLOCKS_M[version];
  const blocks = [];
  let pos = 0;
  for (const [count, per] of groups) {
    for (let i = 0; i < count; i += 1) {
      const chunk = data.slice(pos, pos + per);
      pos += per;
      blocks.push({ data: chunk, ec: rsRemainder(chunk, ecLen) });
    }
  }
  const out = [];
  const maxData = Math.max(...blocks.map((b) => b.data.length));
  for (let i = 0; i < maxData; i += 1) for (const b of blocks) if (i < b.data.length) out.push(b.data[i]);
  for (let i = 0; i < ecLen; i += 1) for (const b of blocks) out.push(b.ec[i]);
  return out;
}

class Matrix {
  constructor(version) {
    this.version = version;
    this.size = 17 + 4 * version;
    this.mod = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
    this.fn = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
    this.drawFunctionPatterns();
  }

  set(x, y, dark) {
    this.mod[y][x] = dark;
    this.fn[y][x] = true;
  }

  drawFunctionPatterns() {
    const { size, version } = this;
    for (let i = 0; i < size; i += 1) {
      this.set(6, i, i % 2 === 0);
      this.set(i, 6, i % 2 === 0);
    }
    for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
      for (let dy = -4; dy <= 4; dy += 1) {
        for (let dx = -4; dx <= 4; dx += 1) {
          const x = cx + dx;
          const y = cy + dy;
          if (x < 0 || y < 0 || x >= size || y >= size) continue;
          const dist = Math.max(Math.abs(dx), Math.abs(dy));
          this.set(x, y, dist !== 2 && dist !== 4);
        }
      }
    }
    const pos = ALIGN[version];
    for (let i = 0; i < pos.length; i += 1) {
      for (let j = 0; j < pos.length; j += 1) {
        const last = pos.length - 1;
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
        for (let dy = -2; dy <= 2; dy += 1) {
          for (let dx = -2; dx <= 2; dx += 1) this.set(pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
    this.drawFormat(0);
    if (version >= 7) {
      let rem = version;
      for (let i = 0; i < 12; i += 1) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      const bits = (version << 12) | rem;
      for (let i = 0; i < 18; i += 1) {
        const dark = ((bits >>> i) & 1) === 1;
        const a = size - 11 + (i % 3);
        const b = Math.floor(i / 3);
        this.set(a, b, dark);
        this.set(b, a, dark);
      }
    }
  }

  drawFormat(mask) {
    const { size } = this;
    const data = (0b00 << 3) | mask; // ECC level M = 00
    let rem = data;
    for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const bit = (i) => ((bits >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i += 1) this.set(8, i, bit(i));
    this.set(8, 7, bit(6));
    this.set(8, 8, bit(7));
    this.set(7, 8, bit(8));
    for (let i = 9; i < 15; i += 1) this.set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i += 1) this.set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i += 1) this.set(8, size - 15 + i, bit(i));
    this.set(8, size - 8, true);
  }

  drawCodewords(codewords) {
    const { size } = this;
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert += 1) {
        for (let j = 0; j < 2; j += 1) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vert : vert;
          if (!this.fn[y][x] && i < codewords.length * 8) {
            this.mod[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
            i += 1;
          }
        }
      }
    }
  }

  applyMask(mask) {
    const { size } = this;
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        let invert;
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break;
          case 1: invert = y % 2 === 0; break;
          case 2: invert = x % 3 === 0; break;
          case 3: invert = (x + y) % 3 === 0; break;
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
          case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          default: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
        }
        if (invert && !this.fn[y][x]) this.mod[y][x] = !this.mod[y][x];
      }
    }
  }

  penalty() {
    const { size, mod } = this;
    let score = 0;
    const lines = [];
    for (let i = 0; i < size; i += 1) {
      lines.push(mod[i].slice());
      lines.push(mod.map((row) => row[i]));
    }
    for (const line of lines) {
      let run = 1;
      for (let i = 1; i <= size; i += 1) {
        if (i < size && line[i] === line[i - 1]) run += 1;
        else {
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
        }
      }
      const s = line.map((d) => (d ? '1' : '0')).join('');
      for (const pat of ['10111010000', '00001011101']) {
        let at = s.indexOf(pat);
        while (at !== -1) {
          score += 40;
          at = s.indexOf(pat, at + 1);
        }
      }
    }
    for (let y = 0; y < size - 1; y += 1) {
      for (let x = 0; x < size - 1; x += 1) {
        const c = mod[y][x];
        if (c === mod[y][x + 1] && c === mod[y + 1][x] && c === mod[y + 1][x + 1]) score += 3;
      }
    }
    let dark = 0;
    for (const row of mod) for (const d of row) if (d) dark += 1;
    score += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;
    return score;
  }
}

// -> { version, size, modules: boolean[][] }  (modules[y][x], true = dark)
function encode(text) {
  const bytes = Buffer.from(String(text), 'utf8');
  const version = chooseVersion(bytes.length);
  const codewords = buildCodewords(bytes, version);
  const m = new Matrix(version);
  m.drawCodewords(codewords);
  let best = 0;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask += 1) {
    m.applyMask(mask);
    m.drawFormat(mask);
    const score = m.penalty();
    if (score < bestScore) {
      best = mask;
      bestScore = score;
    }
    m.applyMask(mask); // undo
  }
  m.applyMask(best);
  m.drawFormat(best);
  return { version, size: m.size, modules: m.mod };
}

function toSvg(text, { quiet = 4, dark = '#000', light = '#fff' } = {}) {
  const { size, modules } = encode(text);
  const total = size + quiet * 2;
  let path = '';
  for (let y = 0; y < size; y += 1) {
    let x = 0;
    while (x < size) {
      if (!modules[y][x]) {
        x += 1;
        continue;
      }
      let end = x;
      while (end < size && modules[y][end]) end += 1;
      path += `M${x + quiet} ${y + quiet}h${end - x}v1h-${end - x}z`;
      x = end;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges">` +
    `<rect width="${total}" height="${total}" fill="${light}"/><path d="${path}" fill="${dark}"/></svg>`;
}

module.exports = { encode, toSvg, MAX_VERSION };
