// 生成自有图标：256x256 圆角方块 + 白色「日记行」motif。
// 纯 Node 手写 PNG（zlib + CRC）与 ICO 容器，不依赖任何图像库。
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 256;

function makePixels() {
  const px = Buffer.alloc(SIZE * SIZE * 4, 0);
  const R = 56;                 // 圆角半径
  const ACCENT = [74, 124, 247];
  const ACCENT2 = [93, 148, 255];

  const inRounded = (x, y) => {
    const min = R, max = SIZE - 1 - R;
    let cx = x, cy = y;
    if (x < min) cx = min; else if (x > max) cx = max;
    if (y < min) cy = min; else if (y > max) cy = max;
    if (cx === x && cy === y) return true;
    const dx = x - cx, dy = y - cy;
    return dx * dx + dy * dy <= R * R;
  };

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (!inRounded(x, y)) continue;
      const i = (y * SIZE + x) * 4;
      // 竖向渐变
      const t = y / (SIZE - 1);
      px[i] = Math.round(ACCENT[0] + (ACCENT2[0] - ACCENT[0]) * t);
      px[i + 1] = Math.round(ACCENT[1] + (ACCENT2[1] - ACCENT[1]) * t);
      px[i + 2] = Math.round(ACCENT[2] + (ACCENT2[2] - ACCENT2[2]) * t);
      px[i + 3] = 255;
    }
  }

  // 白色书脊
  for (let y = 58; y <= 198; y++) {
    for (let x = 74; x <= 82; x++) {
      const i = (y * SIZE + x) * 4;
      px[i] = 255; px[i + 1] = 255; px[i + 2] = 255; px[i + 3] = 255;
    }
  }

  // 三条「文字行」
  const lines = [[78, 182], [108, 182], [138, 150]];
  for (const [ly, lxEnd] of lines) {
    for (let y = ly; y <= ly + 9; y++) {
      for (let x = 102; x <= lxEnd; x++) {
        const i = (y * SIZE + x) * 4;
        px[i] = 255; px[i + 1] = 255; px[i + 2] = 255; px[i + 3] = 235;
      }
    }
  }
  return px;
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

function encodePng(px) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
  for (let y = 0; y < SIZE; y++) {
    raw[y * (SIZE * 4 + 1)] = 0; // filter: none
    px.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

function encodeIco(pngBuf) {
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2); // ICO
  dir.writeUInt16LE(1, 4); // 1 image
  const entry = Buffer.alloc(16);
  entry[0] = 0; // 256
  entry[1] = 0;
  entry[2] = 0;
  entry[3] = 0;
  entry.writeUInt16LE(1, 4);   // planes
  entry.writeUInt16LE(32, 6);  // bpp
  entry.writeUInt32LE(pngBuf.length, 8);
  entry.writeUInt32LE(22, 12);
  return Buffer.concat([dir, entry, pngBuf]);
}

const buildDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(buildDir, { recursive: true });

const png = encodePng(makePixels());
fs.writeFileSync(path.join(buildDir, 'icon.png'), png);
fs.writeFileSync(path.join(buildDir, 'icon.ico'), encodeIco(png));

console.log('icon.png ' + png.length + ' bytes');
console.log('icon.ico ' + (png.length + 22) + ' bytes');
console.log('-> ' + buildDir);
