const fs = require('fs');
const zlib = require('zlib');

// ── PNG PARSER ──────────────────────────────
function parsePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('Not a PNG');
  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.slice(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }
  return { width, height, bitDepth, colorType, idat };
}

function unfilter(bytes, width, height, bpp) {
  const stride = width * bpp;
  const out = Buffer.alloc(height * stride);
  let inPos = 0;
  for (let y = 0; y < height; y++) {
    const filter = bytes[inPos++];
    const row = y * stride;
    const prevRow = row - stride;
    for (let x = 0; x < stride; x++) {
      const raw = bytes[inPos++];
      const a = x >= bpp ? out[row + x - bpp] : 0;
      const b = y > 0 ? out[prevRow + x] : 0;
      const c = (y > 0 && x >= bpp) ? out[prevRow + x - bpp] : 0;
      let val;
      switch (filter) {
        case 0: val = raw; break;
        case 1: val = raw + a; break;
        case 2: val = raw + b; break;
        case 3: val = raw + Math.floor((a + b) / 2); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          val = raw + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error('bad filter ' + filter);
      }
      out[row + x] = val & 0xff;
    }
  }
  return out;
}

// ── CRC32 ──────────────────────────────────
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePNG(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// ── MAIN ───────────────────────────────────
const buf = fs.readFileSync('icon_launcher.png');
const png = parsePNG(buf);
if (png.bitDepth !== 8) throw new Error('Unsupported bit depth ' + png.bitDepth);
let bpp;
if (png.colorType === 6) bpp = 4;
else if (png.colorType === 2) bpp = 3;
else if (png.colorType === 0) bpp = 1;
else throw new Error('Unsupported color type ' + png.colorType);

const raw = unfilter(zlib.inflateSync(Buffer.concat(png.idat)), png.width, png.height, bpp);
const W = png.width, H = png.height;

// Build RGBA
const rgba = Buffer.alloc(W * H * 4);
for (let i = 0; i < W * H; i++) {
  if (bpp === 4) {
    rgba[i*4] = raw[i*4]; rgba[i*4+1] = raw[i*4+1]; rgba[i*4+2] = raw[i*4+2]; rgba[i*4+3] = raw[i*4+3];
  } else if (bpp === 3) {
    rgba[i*4] = raw[i*3]; rgba[i*4+1] = raw[i*3+1]; rgba[i*4+2] = raw[i*3+2]; rgba[i*4+3] = 255;
  } else {
    rgba[i*4] = raw[i]; rgba[i*4+1] = raw[i]; rgba[i*4+2] = raw[i]; rgba[i*4+3] = 255;
  }
}

// Find bounding box of visible (alpha > 10) pixels
let minX = W, minY = H, maxX = -1, maxY = -1;
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    if (rgba[(y*W + x)*4 + 3] > 10) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
}

console.log('Full size:', W, 'x', H);
console.log('Visible content box: (' + minX + ',' + minY + ') → (' + maxX + ',' + maxY + ')');
console.log('Visible content size:', (maxX - minX + 1), 'x', (maxY - minY + 1));
console.log('Content covers', (((maxX - minX + 1) / W) * 100).toFixed(1) + '% of width');
console.log('Content covers', (((maxY - minY + 1) / H) * 100).toFixed(1) + '% of height');

// Crop with a small margin (5% breathing room based on cropped size)
const margin = Math.round((maxX - minX + 1) * 0.05);
const x0 = Math.max(0, minX - margin);
const y0 = Math.max(0, minY - margin);
const x1 = Math.min(W, maxX + margin + 1);
const y1 = Math.min(H, maxY + margin + 1);
const cw = x1 - x0;
const ch = y1 - y0;

const cropped = Buffer.alloc(cw * ch * 4);
for (let y = 0; y < ch; y++) {
  for (let x = 0; x < cw; x++) {
    const si = ((y0 + y) * W + (x0 + x)) * 4;
    const di = (y * cw + x) * 4;
    cropped[di] = rgba[si];
    cropped[di+1] = rgba[si+1];
    cropped[di+2] = rgba[si+2];
    cropped[di+3] = rgba[si+3];
  }
}

const output = encodePNG(cw, ch, cropped);
fs.writeFileSync('icon_launcher_cropped.png', output);
console.log('Cropped →', cw, 'x', ch, 'saved as icon_launcher_cropped.png');
console.log('Cropped image now covers ~' + (ch / H * 100).toFixed(0) + '% of original height');