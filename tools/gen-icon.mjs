// Legacy one-shot generator for the old TokenGauge extension icon.
//
// Do not run this to refresh the current shipped icon. A branding pass replaced
// resources/tokengauge-icon.png from an owner-approved media export, and that
// source is not tracked as part of the release asset flow yet.
//
// This script is kept only as a deterministic reference for the previous gauge
// motif. It emits a 256x256 RGBA PNG with zlib, no native deps, no network, and
// no external/trademarked assets.

import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const SIZE = 256;

// Palette. Background is a neutral dark slate so the gauge reads
// on both light and dark Marketplace tiles.
const BG = [30, 33, 39, 255];
const TRACK = [60, 64, 72, 255];
const CLAUDE = [193, 95, 60, 255]; // #c15f3c terracotta/amber
const CODEX = [91, 141, 184, 255]; // #5b8db8 calm blue
const NEEDLE = [232, 233, 236, 255]; // light hub/needle
const HUB = [232, 233, 236, 255];

const cx = SIZE / 2;
const cy = SIZE / 2;
const outerR = 96;
const ringW = 26;
const innerR = outerR - ringW;

// Gauge sweep: a 270° arc opening at the bottom (classic dial), split between
// the two agent hues. Angles measured clockwise from the 12 o'clock-ish start.
const START = Math.PI * 0.75; // 135° (lower-left)
const END = Math.PI * 2.25; // 405° => sweeps 270° to lower-right
const SPLIT = START + (END - START) * 0.5;

function lerp(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
    Math.round(a[3] + (b[3] - a[3]) * t),
  ];
}

function blend(dst, src) {
  const sa = src[3] / 255;
  const da = dst[3] / 255;
  const oa = sa + da * (1 - sa);
  if (oa === 0) {
    return [0, 0, 0, 0];
  }
  const ch = (i) => Math.round((src[i] * sa + dst[i] * da * (1 - sa)) / oa);
  return [ch(0), ch(1), ch(2), Math.round(oa * 255)];
}

const px = new Array(SIZE * SIZE);

// Antialiased coverage from a signed-distance edge over ~1px.
function coverage(d) {
  if (d <= -0.5) {
    return 1;
  }
  if (d >= 0.5) {
    return 0;
  }
  return 0.5 - d;
}

// Supersample each pixel 3x3 for smooth arcs, averaging the samples.
const SS = 3;

const needleAng = START + (END - START) * 0.62;
const ndx = Math.cos(needleAng);
const ndy = Math.sin(needleAng);

for (let y = 0; y < SIZE; y += 1) {
  for (let x = 0; x < SIZE; x += 1) {
    let r0 = 0;
    let g0 = 0;
    let b0 = 0;
    let a0 = 0;
    for (let sy = 0; sy < SS; sy += 1) {
      for (let sx = 0; sx < SS; sx += 1) {
        const fx = x + (sx + 0.5) / SS;
        const fy = y + (sy + 0.5) / SS;
        const dx = fx - cx;
        const dy = fy - cy;
        const r = Math.hypot(dx, dy);

        let sample = [BG[0], BG[1], BG[2], BG[3]];

        // Ring band.
        const rMid = (outerR + innerR) / 2;
        const halfW = ringW / 2;
        const bandCov = coverage(Math.abs(r - rMid) - halfW);
        if (bandCov > 0) {
          let ang = Math.atan2(dy, dx);
          if (ang < 0) {
            ang += Math.PI * 2;
          }
          let a = ang;
          if (a < START) {
            a += Math.PI * 2;
          }
          const inSweep = a >= START && a <= END;
          if (inSweep) {
            // Smooth hue transition near the split for a clean blend.
            const t = Math.max(0, Math.min(1, (a - (SPLIT - 0.18)) / 0.36));
            const hue = lerp(CLAUDE, CODEX, t);
            sample = blend(sample, [hue[0], hue[1], hue[2], Math.round(255 * bandCov)]);
          } else {
            sample = blend(sample, [TRACK[0], TRACK[1], TRACK[2], Math.round(255 * bandCov * 0.9)]);
          }
        }

        // Needle.
        const proj = dx * ndx + dy * ndy;
        const perp = Math.abs(-dx * ndy + dy * ndx);
        if (proj > 6 && proj < innerR - 4) {
          const halfWidth = 5 * (1 - proj / (innerR - 4)) + 1.3;
          const nCov = coverage(perp - halfWidth);
          if (nCov > 0) {
            sample = blend(sample, [NEEDLE[0], NEEDLE[1], NEEDLE[2], Math.round(255 * nCov)]);
          }
        }

        // Hub.
        const hubCov = coverage(r - 13);
        if (hubCov > 0) {
          sample = blend(sample, [HUB[0], HUB[1], HUB[2], Math.round(255 * hubCov)]);
        }

        r0 += sample[0];
        g0 += sample[1];
        b0 += sample[2];
        a0 += sample[3];
      }
    }
    const n = SS * SS;
    px[y * SIZE + x] = [
      Math.round(r0 / n),
      Math.round(g0 / n),
      Math.round(b0 / n),
      Math.round(a0 / n),
    ];
  }
}

// Encode RGBA -> PNG.
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    }
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr.writeUInt8(8, 8); // bit depth
ihdr.writeUInt8(6, 9); // color type RGBA
ihdr.writeUInt8(0, 10);
ihdr.writeUInt8(0, 11);
ihdr.writeUInt8(0, 12);

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
let o = 0;
for (let y = 0; y < SIZE; y += 1) {
  raw[o] = 0; // filter: none
  o += 1;
  for (let x = 0; x < SIZE; x += 1) {
    const p = px[y * SIZE + x];
    raw[o] = p[0];
    raw[o + 1] = p[1];
    raw[o + 2] = p[2];
    raw[o + 3] = p[3];
    o += 4;
  }
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

writeFileSync('resources/tokengauge-icon.png', png);
console.log(`wrote resources/tokengauge-icon.png (${png.length} bytes, ${SIZE}x${SIZE})`);
