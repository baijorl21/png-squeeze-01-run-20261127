// PNG Squeeze: re-encode each screenshot as the smallest lossless PNG we can find.
//
// For every instance the program decodes the stored RGBA PNG, then screens several
// lossless colour forms (palette, grey, grey+alpha, RGB, RGBA) against several
// per-row filter strategies, deflates each screened stream at level 9 and writes
// the smallest valid PNG. Every candidate decodes to the exact input pixels, and
// all choices are fixed functions of the input bytes, so two runs write the same
// bytes. Only Node built-ins are used.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync, inflateSync, constants } from 'node:zlib';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes, start, end) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

// Decode a PNG (bit depth 8, colour types 0/2/3/4/6, no interlace) to RGBA.
function decodePng(bytes) {
  for (let i = 0; i < 8; i++) if (bytes[i] !== SIGNATURE[i]) throw new Error('bad signature');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let width = 0;
  let height = 0;
  let colourType = 6;
  let palette = null;
  let trns = null;
  const idat = [];
  while (at + 12 <= bytes.length) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    const data = bytes.subarray(at + 8, at + 8 + len);
    at += 12 + len;
    if (type === 'IHDR') {
      width = view.getUint32(at - len - 12 + 8);
      height = view.getUint32(at - len - 12 + 12);
      colourType = data[9];
      if (data[8] !== 8 || data[12] !== 0) throw new Error('unsupported IHDR');
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
  }
  const channels = CHANNELS[colourType];
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  const samples = new Uint8Array(width * height * channels);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    const row = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? row[i - channels] : 0;
      const b = prev === null ? 0 : prev[i];
      const c = prev !== null && i >= channels ? prev[i - channels] : 0;
      let v = raw[p++];
      if (filter === 1) v = (v + a) & 0xff;
      else if (filter === 2) v = (v + b) & 0xff;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) v = (v + paeth(a, b, c)) & 0xff;
      row[i] = v;
    }
  }
  const rgba = new Uint8Array(width * height * 4);
  const n = width * height;
  if (colourType === 6) {
    rgba.set(samples);
  } else if (colourType === 2) {
    let tr = -1, tg = -1, tb = -1;
    if (trns !== null && trns.length >= 6) {
      tr = trns[1]; tg = trns[3]; tb = trns[5];
    }
    for (let i = 0; i < n; i++) {
      rgba[i * 4] = samples[i * 3];
      rgba[i * 4 + 1] = samples[i * 3 + 1];
      rgba[i * 4 + 2] = samples[i * 3 + 2];
      rgba[i * 4 + 3] = samples[i * 3] === tr && samples[i * 3 + 1] === tg && samples[i * 3 + 2] === tb ? 0 : 255;
    }
  } else if (colourType === 0) {
    const tg = trns !== null && trns.length >= 2 ? trns[1] : -1;
    for (let i = 0; i < n; i++) {
      const g = samples[i];
      rgba[i * 4] = g; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = g;
      rgba[i * 4 + 3] = g === tg ? 0 : 255;
    }
  } else if (colourType === 4) {
    for (let i = 0; i < n; i++) {
      const g = samples[i * 2];
      rgba[i * 4] = g; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = g;
      rgba[i * 4 + 3] = samples[i * 2 + 1];
    }
  } else if (colourType === 3) {
    for (let i = 0; i < n; i++) {
      const idx = samples[i];
      rgba[i * 4] = palette[idx * 3];
      rgba[i * 4 + 1] = palette[idx * 3 + 1];
      rgba[i * 4 + 2] = palette[idx * 3 + 2];
      rgba[i * 4 + 3] = trns !== null && idx < trns.length ? trns[idx] : 255;
    }
  }
  return { width, height, rgba };
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

function ihdr(width, height, colourType) {
  const d = new Uint8Array(13);
  const v = new DataView(d.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  d[8] = 8;
  d[9] = colourType;
  return d;
}

function buildPng(width, height, colourType, extraChunks, zlibStream) {
  const parts = [Uint8Array.from(SIGNATURE), chunk('IHDR', ihdr(width, height, colourType))];
  for (const [type, data] of extraChunks) parts.push(chunk(type, data));
  parts.push(chunk('IDAT', zlibStream));
  parts.push(chunk('IEND', new Uint8Array(0)));
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

function filterRow(type, cur, prev, bpp, out) {
  const n = cur.length;
  if (type === 0) { out.set(cur); return; }
  for (let i = 0; i < n; i++) {
    const a = i >= bpp ? cur[i - bpp] : 0;
    const b = prev === null ? 0 : prev[i];
    let pred = 0;
    if (type === 1) pred = a;
    else if (type === 2) pred = b;
    else if (type === 3) pred = (a + b) >> 1;
    else pred = paeth(a, b, prev !== null && i >= bpp ? prev[i - bpp] : 0);
    out[i] = (cur[i] - pred) & 0xff;
  }
}

function msadCost(row) {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

const CLOG = (() => {
  const t = new Float64Array(8192);
  for (let c = 2; c < t.length; c++) t[c] = c * Math.log2(c);
  return t;
})();

// Order-0 entropy cost of a row: lower means the byte histogram is sharper.
function entropyCost(row, hist) {
  hist.fill(0);
  for (let i = 0; i < row.length; i++) hist[row[i]]++;
  let s = 0;
  for (let i = 0; i < 256; i++) s += CLOG[hist[i]];
  return -s;
}

// Filter every row with one strategy: 'msad'/'entropy' pick per row, a number fixes the type.
function filteredStream(samples, width, height, bpp, strategy) {
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  const trial = new Uint8Array(stride);
  const hist = new Int32Array(256);
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const dest = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    if (strategy === 'msad' || strategy === 'entropy') {
      let bestType = 0;
      let bestCost = Infinity;
      for (let t = 0; t < 5; t++) {
        filterRow(t, cur, prev, bpp, trial);
        const c = strategy === 'msad' ? msadCost(trial) : entropyCost(trial, hist);
        if (c < bestCost) { bestCost = c; bestType = t; dest.set(trial); }
      }
      raw[y * (stride + 1)] = bestType;
    } else {
      filterRow(strategy, cur, prev, bpp, dest);
      raw[y * (stride + 1)] = strategy;
    }
  }
  return raw;
}

function deflateBest(raw, full = true) {
  let best = null;
  const variants = full
    ? [
        { level: 9, memLevel: 9, strategy: constants.Z_DEFAULT_STRATEGY },
        { level: 9, memLevel: 9, strategy: constants.Z_FILTERED },
      ]
    : [{ level: 9, memLevel: 9, strategy: constants.Z_DEFAULT_STRATEGY }];
  for (const opts of variants) {
    const z = deflateSync(raw, opts);
    if (best === null || z.length < best.length) best = z;
  }
  return best;
}

// Candidate colour forms for one image. Each: {colourType, bpp, samples, extra}.
function candidates(width, height, rgba) {
  const n = width * height;
  const forms = [];
  let allOpaque = true;
  let allGrey = true;
  const colours = new Map();
  for (let i = 0; i < n; i++) {
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2], a = rgba[i * 4 + 3];
    if (a !== 255) allOpaque = false;
    if (r !== g || g !== b) allGrey = false;
    const key = (r << 24) | (g << 16) | (b << 8) | a;
    const rec = colours.get(key);
    if (rec === undefined) colours.set(key, { r, g, b, a, count: 1, first: i });
    else rec.count++;
  }
  if (colours.size <= 256) {
    const list = [...colours.values()];
    const lum = (c) => 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
    const adjacency = (() => {
      const rest = new Set(list);
      const start = [...list].sort((x, y) => y.count - x.count || x.first - y.first)[0];
      const order = [start];
      rest.delete(start);
      let last = start;
      while (rest.size > 0) {
        let bestC = null;
        let bestD = Infinity;
        for (const c of rest) {
          const d = (c.r - last.r) ** 2 + (c.g - last.g) ** 2 + (c.b - last.b) ** 2 + 2 * (c.a - last.a) ** 2;
          if (d < bestD) { bestD = d; bestC = c; }
        }
        order.push(bestC);
        rest.delete(bestC);
        last = bestC;
      }
      return order;
    })();
    const orderings = [
      [...list].sort((x, y) => y.count - x.count || x.first - y.first),
      [...list].sort((x, y) => x.first - y.first),
      [...list].sort((x, y) => lum(x) - lum(y) || x.a - y.a || x.r - y.r || x.g - y.g || x.b - y.b),
      [...list].sort((x, y) => x.a - y.a || lum(x) - lum(y) || x.r - y.r || x.g - y.g || x.b - y.b),
      adjacency,
    ];
    for (const order of orderings) {
      const indexOf = new Map();
      order.forEach((c, i) => indexOf.set((c.r << 24) | (c.g << 16) | (c.b << 8) | c.a, i));
      const samples = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        samples[i] = indexOf.get((rgba[i * 4] << 24) | (rgba[i * 4 + 1] << 16) | (rgba[i * 4 + 2] << 8) | rgba[i * 4 + 3]);
      }
      const plte = new Uint8Array(order.length * 3);
      order.forEach((c, i) => { plte[i * 3] = c.r; plte[i * 3 + 1] = c.g; plte[i * 3 + 2] = c.b; });
      const extra = [['PLTE', plte]];
      let lastAlpha = order.length - 1;
      while (lastAlpha >= 0 && order[lastAlpha].a === 255) lastAlpha--;
      if (lastAlpha >= 0) {
        const trns = new Uint8Array(lastAlpha + 1);
        for (let i = 0; i <= lastAlpha; i++) trns[i] = order[i].a;
        extra.push(['tRNS', trns]);
      }
      forms.push({ colourType: 3, bpp: 1, samples, extra });
    }
  }
  if (allGrey) {
    const grey = new Uint8Array(n);
    for (let i = 0; i < n; i++) grey[i] = rgba[i * 4];
    if (allOpaque) forms.push({ colourType: 0, bpp: 1, samples: grey, extra: [] });
    const ga = new Uint8Array(n * 2);
    for (let i = 0; i < n; i++) { ga[i * 2] = rgba[i * 4]; ga[i * 2 + 1] = rgba[i * 4 + 3]; }
    forms.push({ colourType: 4, bpp: 2, samples: ga, extra: [] });
  }
  // Single-colour transparency: RGB/grey samples plus a tRNS chunk, valid only
  // when every alpha is 0 or 255, all transparent pixels share one colour, and
  // no opaque pixel uses that colour.
  {
    let partial = false;
    let transKey = -1;
    let transOk = true;
    let anyTrans = false;
    for (let i = 0; i < n; i++) {
      const a = rgba[i * 4 + 3];
      if (a === 0) {
        anyTrans = true;
        const key = (rgba[i * 4] << 16) | (rgba[i * 4 + 1] << 8) | rgba[i * 4 + 2];
        if (transKey === -1) transKey = key;
        else if (key !== transKey) transOk = false;
      } else if (a !== 255) partial = true;
    }
    if (anyTrans && transOk && !partial) {
      let clash = false;
      for (let i = 0; i < n && !clash; i++) {
        if (rgba[i * 4 + 3] === 255 && ((rgba[i * 4] << 16) | (rgba[i * 4 + 1] << 8) | rgba[i * 4 + 2]) === transKey) clash = true;
      }
      if (!clash) {
        const tr = (transKey >> 16) & 0xff, tg = (transKey >> 8) & 0xff, tb = transKey & 0xff;
        if (allGrey && tr === tg && tg === tb) {
          const grey = new Uint8Array(n);
          for (let i = 0; i < n; i++) grey[i] = rgba[i * 4];
          forms.push({ colourType: 0, bpp: 1, samples: grey, extra: [['tRNS', Uint8Array.of(0, tr)]] });
        }
        const rgb = new Uint8Array(n * 3);
        for (let i = 0; i < n; i++) {
          rgb[i * 3] = rgba[i * 4]; rgb[i * 3 + 1] = rgba[i * 4 + 1]; rgb[i * 3 + 2] = rgba[i * 4 + 2];
        }
        forms.push({ colourType: 2, bpp: 3, samples: rgb, extra: [['tRNS', Uint8Array.of(0, tr, 0, tg, 0, tb)]] });
      }
    }
  }
  if (allOpaque) {
    const rgb = new Uint8Array(n * 3);
    for (let i = 0; i < n; i++) {
      rgb[i * 3] = rgba[i * 4]; rgb[i * 3 + 1] = rgba[i * 4 + 1]; rgb[i * 3 + 2] = rgba[i * 4 + 2];
    }
    forms.push({ colourType: 2, bpp: 3, samples: rgb, extra: [] });
  }
  forms.push({ colourType: 6, bpp: 4, samples: rgba, extra: [] });
  return forms;
}

// --- Optimal-parse deflate -------------------------------------------------
// A small zopfli-style deflater: hash-chain match search, a shortest-path parse
// under Huffman bit costs, two cost-refinement rounds, then dynamic-Huffman
// blocks (fixed-Huffman when that is smaller). Work is bounded by input size
// only. Callers verify the stream by inflating it before use.
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

function lenSymbol(len) {
  let s = 28;
  while (LEN_BASE[s] > len) s--;
  return 257 + s;
}

function distSymbol(dist) {
  let s = 29;
  while (DIST_BASE[s] > dist) s--;
  return s;
}

const LEN_SYM = Array.from({ length: 259 }, (_, l) => (l >= 3 ? lenSymbol(l) : 0));
const DIST_SYM = (() => {
  const t = new Int32Array(32769);
  for (let s = 0; s < 30; s++) {
    const from = DIST_BASE[s];
    const to = s + 1 < 30 ? DIST_BASE[s + 1] : 32769;
    for (let d = from; d < to; d++) t[d] = s;
  }
  return t;
})();
const CAND_LENGTHS = (() => {
  const table = [null, null, null];
  for (let L = 3; L <= 258; L++) {
    const out = [];
    const lim = Math.min(L, 18);
    for (let l = 3; l <= lim; l++) out.push(l);
    for (const b of [19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258]) {
      if (b <= L && b > lim) out.push(b);
    }
    if (L > lim && out[out.length - 1] !== L) out.push(L);
    table.push(out);
  }
  return table;
})();

function adler32(bytes) {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length;) {
    const end = Math.min(bytes.length, i + 5552);
    for (; i < end; i++) { a += bytes[i]; b += a; }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

// Length-limited Huffman code lengths by package-merge.
function huffmanLengths(freq, maxBits) {
  const lengths = new Array(freq.length).fill(0);
  const syms = [];
  for (let s = 0; s < freq.length; s++) if (freq[s] > 0) syms.push(s);
  if (syms.length === 0) return lengths;
  if (syms.length === 1) {
    lengths[syms[0]] = 1;
    lengths[syms[0] === 0 ? 1 : 0] = 1;
    return lengths;
  }
  const sorted = [...syms].sort((x, y) => freq[x] - freq[y] || x - y);
  const singles = sorted.map((s) => ({ w: freq[s], members: [s] }));
  let list = singles;
  for (let i = 1; i < maxBits; i++) {
    const packaged = [];
    for (let j = 0; j + 1 < list.length; j += 2) {
      packaged.push({ w: list[j].w + list[j + 1].w, members: [...list[j].members, ...list[j + 1].members] });
    }
    const merged = [];
    let p = 0;
    let q = 0;
    while (p < packaged.length || q < singles.length) {
      if (q >= singles.length || (p < packaged.length && packaged[p].w <= singles[q].w)) merged.push(packaged[p++]);
      else merged.push(singles[q++]);
    }
    list = merged;
  }
  for (const item of list.slice(0, 2 * sorted.length - 2)) {
    for (const s of item.members) lengths[s]++;
  }
  return lengths;
}

function canonicalCodes(lengths) {
  const maxBits = Math.max(...lengths, 0);
  const blCount = new Array(maxBits + 1).fill(0);
  for (const l of lengths) if (l > 0) blCount[l]++;
  const nextCode = new Array(maxBits + 1).fill(0);
  let code = 0;
  for (let b = 1; b <= maxBits; b++) {
    code = (code + blCount[b - 1]) << 1;
    nextCode[b] = code;
  }
  return lengths.map((l) => {
    if (l === 0) return 0;
    let c = nextCode[l]++;
    let r = 0;
    for (let i = 0; i < l; i++) { r = (r << 1) | (c & 1); c >>= 1; }
    return r;
  });
}

class BitWriter {
  constructor() { this.bytes = []; this.buf = 0; this.cnt = 0; }
  write(value, count) {
    this.buf |= value << this.cnt;
    this.cnt += count;
    while (this.cnt >= 8) {
      this.bytes.push(this.buf & 0xff);
      this.buf >>= 8;
      this.cnt -= 8;
    }
  }
  finish() {
    if (this.cnt > 0) this.bytes.push(this.buf & 0xff);
    return Uint8Array.from(this.bytes);
  }
}

function parseSegment(raw, segStart, segEnd, mLen, mDist, litLengths, distLengths) {
  const n = segEnd - segStart;
  const litCost = new Float64Array(288);
  for (let s = 0; s < 288; s++) litCost[s] = litLengths[s] > 0 ? litLengths[s] : 15;
  const lenCost = new Float64Array(259);
  for (let l = 3; l <= 258; l++) lenCost[l] = litCost[LEN_SYM[l]] + LEN_EXTRA[LEN_SYM[l] - 257];
  const distCost = new Float64Array(32769);
  for (let d = 1; d <= 32768; d++) {
    const s = DIST_SYM[d];
    distCost[d] = (distLengths[s] > 0 ? distLengths[s] : 15) + DIST_EXTRA[s];
  }
  const dp = new Float64Array(n + 1).fill(Infinity);
  dp[0] = 0;
  const from = new Int32Array(n + 1);
  const tokLen = new Int32Array(n + 1);
  const tokDist = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) {
    const base = dp[i];
    const litCand = base + litCost[raw[segStart + i]];
    if (litCand < dp[i + 1]) { dp[i + 1] = litCand; from[i + 1] = i; tokLen[i + 1] = 0; }
    const L = mLen[i];
    if (L >= 3) {
      const dc = distCost[mDist[i]];
      const cands = CAND_LENGTHS[L];
      for (let k = 0; k < cands.length; k++) {
        const l = cands[k];
        const c = base + lenCost[l] + dc;
        if (c < dp[i + l]) { dp[i + l] = c; from[i + l] = i; tokLen[i + l] = l; tokDist[i + l] = mDist[i]; }
      }
    }
  }
  const lits = [];
  const lens = [];
  const dists = [];
  for (let p = n; p > 0;) {
    const f = from[p];
    if (tokLen[p] === 0) { lits.push(raw[segStart + f]); lens.push(0); dists.push(0); }
    else { lits.push(-1); lens.push(tokLen[p]); dists.push(tokDist[p]); }
    p = f;
  }
  lits.reverse();
  lens.reverse();
  dists.reverse();
  return { lits, lens, dists, count: lits.length };
}

function tokenFreq(tokens) {
  const litFreq = new Array(288).fill(0);
  const distFreq = new Array(30).fill(0);
  litFreq[256] = 1;
  for (let i = 0; i < tokens.count; i++) {
    if (tokens.lens[i] === 0) litFreq[tokens.lits[i]]++;
    else { litFreq[LEN_SYM[tokens.lens[i]]]++; distFreq[DIST_SYM[tokens.dists[i]]]++; }
  }
  return { litFreq, distFreq };
}

function tokenBits(tokens, litLengths, distLengths) {
  let bits = litLengths[256];
  for (let i = 0; i < tokens.count; i++) {
    if (tokens.lens[i] === 0) bits += litLengths[tokens.lits[i]];
    else {
      const ls = LEN_SYM[tokens.lens[i]];
      const ds = DIST_SYM[tokens.dists[i]];
      bits += litLengths[ls] + LEN_EXTRA[ls - 257] + distLengths[ds] + DIST_EXTRA[ds];
    }
  }
  return bits;
}

function emitTokens(bw, tokens, litLengths, distLengths) {
  const litCodes = canonicalCodes(litLengths);
  const distCodes = canonicalCodes(distLengths);
  for (let i = 0; i < tokens.count; i++) {
    if (tokens.lens[i] === 0) {
      bw.write(litCodes[tokens.lits[i]], litLengths[tokens.lits[i]]);
    } else {
      const ls = LEN_SYM[tokens.lens[i]];
      bw.write(litCodes[ls], litLengths[ls]);
      if (LEN_EXTRA[ls - 257] > 0) bw.write(tokens.lens[i] - LEN_BASE[ls - 257], LEN_EXTRA[ls - 257]);
      const ds = DIST_SYM[tokens.dists[i]];
      bw.write(distCodes[ds], distLengths[ds]);
      if (DIST_EXTRA[ds] > 0) bw.write(tokens.dists[i] - DIST_BASE[ds], DIST_EXTRA[ds]);
    }
  }
  bw.write(litCodes[256], litLengths[256]);
}

function emitBlock(bw, tokens, isFinal) {
  const { litFreq, distFreq } = tokenFreq(tokens);
  if (distFreq.every((f) => f === 0)) { distFreq[0] = 1; distFreq[1] = 1; }
  const litLengths = huffmanLengths(litFreq, 15);
  const distLengths = huffmanLengths(distFreq, 15);
  let hlitCount = 288;
  while (hlitCount > 257 && litLengths[hlitCount - 1] === 0) hlitCount--;
  let hdistCount = 30;
  while (hdistCount > 1 && distLengths[hdistCount - 1] === 0) hdistCount--;
  const seq = [...litLengths.slice(0, hlitCount), ...distLengths.slice(0, hdistCount)];
  const clTokens = [];
  for (let i = 0; i < seq.length;) {
    const v = seq[i];
    let run = 1;
    while (i + run < seq.length && seq[i + run] === v) run++;
    if (v === 0) {
      let left = run;
      while (left >= 11) { const take = Math.min(left, 138); clTokens.push([18, take - 11, 7]); left -= take; }
      if (left >= 3) { clTokens.push([17, left - 3, 3]); left = 0; }
      while (left-- > 0) clTokens.push([0, 0, 0]);
    } else {
      clTokens.push([v, 0, 0]);
      let left = run - 1;
      while (left >= 3) { const take = Math.min(left, 6); clTokens.push([16, take - 3, 2]); left -= take; }
      while (left-- > 0) clTokens.push([v, 0, 0]);
    }
    i += run;
  }
  const clFreq = new Array(19).fill(0);
  for (const [s] of clTokens) clFreq[s]++;
  const clLengths = huffmanLengths(clFreq, 7);
  let hclenCount = 19;
  while (hclenCount > 4 && clLengths[CL_ORDER[hclenCount - 1]] === 0) hclenCount--;
  let headerBits = 3 + 5 + 5 + 4 + hclenCount * 3;
  for (const [s, , extra] of clTokens) headerBits += clLengths[s] + extra;
  const fixedLit = Array.from({ length: 288 }, (_, s) => (s < 144 ? 8 : s < 256 ? 9 : s < 280 ? 7 : 8));
  const fixedDist = new Array(30).fill(5);
  const dynBits = headerBits + tokenBits(tokens, litLengths, distLengths);
  const fixBits = 3 + tokenBits(tokens, fixedLit, fixedDist);
  bw.write(isFinal ? 1 : 0, 1);
  if (dynBits <= fixBits) {
    bw.write(2, 2);
    bw.write(hlitCount - 257, 5);
    bw.write(hdistCount - 1, 5);
    bw.write(hclenCount - 4, 4);
    for (let i = 0; i < hclenCount; i++) bw.write(clLengths[CL_ORDER[i]], 3);
    const clCodes = canonicalCodes(clLengths);
    for (const [s, extraVal, extraBits] of clTokens) {
      bw.write(clCodes[s], clLengths[s]);
      if (extraBits > 0) bw.write(extraVal, extraBits);
    }
    emitTokens(bw, tokens, litLengths, distLengths);
  } else {
    bw.write(1, 2);
    emitTokens(bw, tokens, fixedLit, fixedDist);
  }
}

function deflateOptimal(raw) {
  const n = raw.length;
  if (n === 0) return null;
  const head = new Int32Array(32768).fill(-1);
  const prev = new Int32Array(n).fill(-1);
  const hash3 = (i) => ((raw[i] << 10) ^ (raw[i + 1] << 5) ^ raw[i + 2]) & 32767;
  for (let i = 0; i + 2 < n; i++) {
    const h = hash3(i);
    prev[i] = head[h];
    head[h] = i;
  }
  const maxChain = n > 2000000 ? 16 : 32;
  const fixedLit = Array.from({ length: 288 }, (_, s) => (s < 144 ? 8 : s < 256 ? 9 : s < 280 ? 7 : 8));
  const fixedDist = new Array(30).fill(5);
  const bw = new BitWriter();
  const SEG = 262144;
  for (let segStart = 0; segStart < n; segStart += SEG) {
    const segEnd = Math.min(n, segStart + SEG);
    const mLen = new Int32Array(segEnd - segStart);
    const mDist = new Int32Array(segEnd - segStart);
    for (let i = segStart; i + 2 < segEnd; i++) {
      const maxL = Math.min(258, segEnd - i);
      let cand = prev[i];
      let best = 0;
      let bestDist = 0;
      let chain = 0;
      let chainLimit = maxChain;
      while (cand >= 0 && i - cand <= 32768 && chain < chainLimit) {
        if (best === 0 || raw[cand + best] === raw[i + best]) {
          let l = 0;
          while (l < maxL && raw[cand + l] === raw[i + l]) l++;
          if (l > best) {
            best = l;
            bestDist = i - cand;
            if (best >= maxL) break;
            if (best >= 32) chainLimit = Math.min(chainLimit, chain + 4);
          }
        }
        cand = prev[cand];
        chain++;
      }
      if (best >= 3) { mLen[i - segStart] = best; mDist[i - segStart] = bestDist; }
    }
    let tokens = parseSegment(raw, segStart, segEnd, mLen, mDist, fixedLit, fixedDist);
    const { litFreq, distFreq } = tokenFreq(tokens);
    if (distFreq.every((f) => f === 0)) { distFreq[0] = 1; distFreq[1] = 1; }
    tokens = parseSegment(raw, segStart, segEnd, mLen, mDist, huffmanLengths(litFreq, 15), huffmanLengths(distFreq, 15));
    emitBlock(bw, tokens, segEnd === n);
  }
  const body = bw.finish();
  const adler = adler32(raw);
  const out = new Uint8Array(2 + body.length + 4);
  out[0] = 0x78;
  out[1] = 0xda;
  out.set(body, 2);
  new DataView(out.buffer).setUint32(2 + body.length, adler);
  return out;
}

function pngOverhead(form) {
  let s = 8 + 25 + 12 + 12;
  for (const [, data] of form.extra) s += 12 + data.length;
  return s;
}

function screenSize(raw, form) {
  return deflateSync(raw, { level: 6, memLevel: 8 }).length + pngOverhead(form);
}

// Staged screening: level-6 deflates rank every colour form on the adaptive
// strategies, the two best forms also get the fixed strategies screened, then
// only the four best streams get full level-9 treatment.
function squeeze(width, height, rgba) {
  const contenders = [];
  const formBest = [];
  for (const form of candidates(width, height, rgba)) {
    let bestForForm = Infinity;
    for (const strategy of ['msad', 'entropy']) {
      const raw = filteredStream(form.samples, width, height, form.bpp, strategy);
      const size = screenSize(raw, form);
      contenders.push({ form, raw, size });
      if (size < bestForForm) bestForForm = size;
    }
    formBest.push({ form, size: bestForForm });
  }
  formBest.sort((a, b) => a.size - b.size);
  for (const { form } of formBest.slice(0, 2)) {
    for (const strategy of [4, 1, 2, 3, 0]) {
      const raw = filteredStream(form.samples, width, height, form.bpp, strategy);
      contenders.push({ form, raw, size: screenSize(raw, form) });
    }
  }
  contenders.sort((a, b) => a.size - b.size);
  let best = null;
  contenders.slice(0, 4).forEach(({ form, raw }, rank) => {
    const png = buildPng(width, height, form.colourType, form.extra, deflateBest(raw, rank < 2));
    if (best === null || png.length < best.length) best = png;
    if (rank === 0) {
      try {
        const z = deflateOptimal(raw);
        if (z !== null && inflateSync(z).equals(Buffer.from(raw))) {
          const opt = buildPng(width, height, form.colourType, form.extra, z);
          if (opt.length < best.length) best = opt;
        }
      } catch { /* keep the zlib result */ }
    }
  });
  return best;
}

for (const id of readdirSync(INPUT_DIR).sort()) {
  const { width, height, rgba } = decodePng(readFileSync(join(INPUT_DIR, id, 'image.png')));
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'image.png'), squeeze(width, height, rgba));
}
