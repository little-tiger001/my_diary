// 生成自有图标：256x256 圆角方块（对角渐变）+ 白色页面 + 书签带 + 文字行。
// 纯 Node 手写 PNG（zlib + CRC）与 ICO 容器，不依赖任何图像库。
//
// 4 倍超采样后降采样：早期版本是逐像素硬边界，小尺寸下边缘全是锯齿。
// ICO 一次写入 16/32/48/64/128/256 六个尺寸（PNG 压缩条目），
// 任务栏（32）与资源管理器大图标（256）各自取合适的那张，不靠系统缩放。
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 256;
const SS = 4;                 // 超采样倍数
const W = SIZE * SS;

const ACCENT = [74, 124, 247];
const BOOKMARK = [245, 158, 35];
const BG_LIGHT = [112, 162, 255];
const BG_DARK = [40, 78, 190];
const LINE = [63, 74, 99];

function inRounded(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function mix(a, b, t) {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

function over(dst, src, alpha) {
  return [dst[0] + (src[0] - dst[0]) * alpha, dst[1] + (src[1] - dst[1]) * alpha, dst[2] + (src[2] - dst[2]) * alpha];
}

// 单个采样点的颜色，返回 [r,g,b,a]（a 为 0..1）
function shade(x, y) {
  if (!inRounded(x, y, 0, 0, SIZE - 1, SIZE - 1, 56)) return null;

  // 背景：左上亮、右下深的对角渐变
  let col = mix(BG_LIGHT, BG_DARK, Math.min(1, Math.max(0, (x + y) / (2 * (SIZE - 1)))));

  // 页面投影（三层轻微错位，近似软阴影）
  if (inRounded(x, y, 59, 52, 201, 220, 18)) col = over(col, [10, 25, 60], 0.06);
  if (inRounded(x, y, 58, 49, 202, 218, 17)) col = over(col, [10, 25, 60], 0.08);
  if (inRounded(x, y, 58, 47, 202, 216, 16)) col = over(col, [10, 25, 60], 0.10);

  const onPage = inRounded(x, y, 56, 44, 200, 212, 16);
  if (onPage) col = [255, 255, 255];

  // 书签带：挂在页面里、从上沿垂下来，底部切 V 形缺口。
  // 用暖色而不是主题蓝——同色时它和背景连成一片，看起来像折角而不是书签。
  if (x >= 154 && x <= 178 && y >= 44 && y <= 108) {
    const notchTop = 92 + Math.abs(x - 166);
    col = y >= notchTop ? [255, 255, 255] : BOOKMARK;
  }

  // 三条文字行（圆头），最后一条用主题蓝
  const bars = [[124, 180, LINE], [148, 180, LINE], [172, 142, ACCENT]];
  for (const [by, bxEnd, color] of bars) {
    if (inRounded(x, y, 76, by, bxEnd, by + 9, 4.5)) col = color;
  }
  return col;
}

// 4x 超采样 -> 256x256 RGBA
function renderBase() {
  const px = Buffer.alloc(SIZE * SIZE * 4);
  const acc = new Float64Array(SIZE * SIZE * 3);
  const cnt = new Float64Array(SIZE * SIZE);
  for (let sy = 0; sy < W; sy++) {
    for (let sx = 0; sx < W; sx++) {
      const c = shade((sx + 0.5) / SS, (sy + 0.5) / SS);
      if (!c) continue;
      const i = ((sy / SS) | 0) * SIZE + ((sx / SS) | 0);
      acc[i * 3] += c[0];
      acc[i * 3 + 1] += c[1];
      acc[i * 3 + 2] += c[2];
      cnt[i] += 1;
    }
  }
  const total = SS * SS;
  for (let i = 0; i < SIZE * SIZE; i++) {
    const a = cnt[i] / total;
    px[i * 4 + 3] = Math.round(a * 255);
    if (!cnt[i]) continue;
    px[i * 4] = Math.round(acc[i * 3] / cnt[i]);
    px[i * 4 + 1] = Math.round(acc[i * 3 + 1] / cnt[i]);
    px[i * 4 + 2] = Math.round(acc[i * 3 + 2] / cnt[i]);
  }
  return px;
}

// 面积平均降采样到 size×size（预乘 alpha 后再平均，避免边缘发灰）
function scaleTo(px, size) {
  const out = Buffer.alloc(size * size * 4);
  const ratio = SIZE / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const x0 = x * ratio;
      const y0 = y * ratio;
      const x1 = Math.min(SIZE, x0 + ratio);
      const y1 = Math.min(SIZE, y0 + ratio);
      let r = 0, g = 0, b = 0, a = 0, wsum = 0;
      for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy++) {
        for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx++) {
          const wx = Math.min(x1, sx + 1) - Math.max(x0, sx);
          const wy = Math.min(y1, sy + 1) - Math.max(y0, sy);
          const w = wx * wy;
          if (w <= 0) continue;
          const i = (sy * SIZE + sx) * 4;
          const al = px[i + 3] / 255;
          r += px[i] * al * w;
          g += px[i + 1] * al * w;
          b += px[i + 2] * al * w;
          a += al * w;
          wsum += w;
        }
      }
      const o = (y * size + x) * 4;
      if (wsum > 0 && a > 0) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
      }
      out[o + 3] = Math.round((a / wsum) * 255);
    }
  }
  return out;
}

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(px, size) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

const SIZES = [16, 32, 48, 64, 128, 256];

function encodeIco(entries) {
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2);              // type: ICO
  dir.writeUInt16LE(entries.length, 4);
  let offset = 6 + entries.length * 16;
  const heads = [];
  for (const { size, png } of entries) {
    const e = Buffer.alloc(16);
    e[0] = size === 256 ? 0 : size;     // 256 记作 0
    e[1] = size === 256 ? 0 : size;
    e[2] = 0;
    e[3] = 0;
    e.writeUInt16LE(1, 4);              // planes
    e.writeUInt16LE(32, 6);             // bpp
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += png.length;
    heads.push(e);
  }
  return Buffer.concat([dir, ...heads, ...entries.map((e) => e.png)]);
}

const buildDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(buildDir, { recursive: true });

const base = renderBase();
const png256 = encodePng(base, SIZE);
const entries = SIZES.map((size) => ({ size, png: size === SIZE ? png256 : encodePng(scaleTo(base, size), size) }));
const ico = encodeIco(entries);

fs.writeFileSync(path.join(buildDir, 'icon.png'), png256);
fs.writeFileSync(path.join(buildDir, 'icon.ico'), ico);

console.log(`icon.png ${png256.length} bytes (${SIZE}x${SIZE})`);
console.log(`icon.ico ${ico.length} bytes（${SIZES.join('/')} 六个尺寸）`);
console.log('-> ' + buildDir);
