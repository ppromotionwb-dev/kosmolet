'use strict';
// Сборка иконки Космолёта из SVG (владелец: tools-pack).
// Запуск электроном из папки проекта:
//   node_modules\electron\dist\electron.exe tools\make-icon.js [--preview]
// Рендерит assets/logo.svg (и упрощённый assets/logo-small.svg для 16–24 px) в offscreen-окне,
// собирает assets/icon.ico (16, 24, 32, 48, 64, 128 — BMP-записи, 256 — PNG) и assets/icon.png (512).
// --preview дополнительно пишет увеличенные копии в tools/dev-out/f-tools/icon-<размер>.png.

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { app, BrowserWindow, nativeImage } = require('electron');

const ROOT = path.resolve(__dirname, '..');
const ASSETS = path.join(ROOT, 'assets');
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const SMALL_MAX = 24; // до этого размера включительно — упрощённый знак
const PREVIEW = process.argv.includes('--preview');
const CANVAS = 512;

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.commandLine.appendSwitch('high-dpi-support', '1');
app.setPath('userData', path.join(os.tmpdir(), 'kosmolet-make-icon'));

function htmlFor(svg, size) {
  const src = 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64');
  return '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}' +
    'img{display:block;width:' + size + 'px;height:' + size + 'px}</style></head><body><img src="' + src + '"></body></html>';
}

// ---------- PNG → RGBA (нужно для BMP-записей ICO: прямая, не домноженная альфа) ----------
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('не PNG');
  let off = 8, w = 0, hgt = 0, depth = 0, ctype = 0, interlace = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); hgt = data.readUInt32BE(4); depth = data[8]; ctype = data[9]; interlace = data[12]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (depth !== 8 || interlace || (ctype !== 6 && ctype !== 2)) throw new Error(`неподдерживаемый PNG: глубина ${depth}, тип ${ctype}, interlace ${interlace}`);
  const bpp = ctype === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const out = Buffer.alloc(w * hgt * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < hgt; y++) {
    const ft = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      line[i] = v & 255;
    }
    for (let x = 0; x < w; x++) {
      const s = x * bpp, d = (y * w + x) * 4;
      out[d] = line[s]; out[d + 1] = line[s + 1]; out[d + 2] = line[s + 2]; out[d + 3] = bpp === 4 ? line[s + 3] : 255;
    }
    prev = line;
  }
  return { width: w, height: hgt, rgba: out };
}

// ---------- ICO ----------
function bmpEntry(rgba, size) {
  const maskRow = Math.ceil(size / 32) * 4;
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // XOR + AND
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16);
  header.writeUInt32LE(size * size * 4 + maskRow * size, 20);
  const pixels = Buffer.alloc(size * size * 4);
  const mask = Buffer.alloc(maskRow * size);
  for (let y = 0; y < size; y++) {
    const ry = size - 1 - y; // снизу вверх
    for (let x = 0; x < size; x++) {
      const s = (y * size + x) * 4, d = (ry * size + x) * 4;
      pixels[d] = rgba[s + 2]; pixels[d + 1] = rgba[s + 1]; pixels[d + 2] = rgba[s]; pixels[d + 3] = rgba[s + 3];
      if (rgba[s + 3] === 0) mask[ry * maskRow + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return Buffer.concat([header, pixels, mask]);
}

function buildIco(entries) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + dir.length;
  entries.forEach((e, i) => {
    const o = i * 16;
    dir[o] = e.size >= 256 ? 0 : e.size;
    dir[o + 1] = e.size >= 256 ? 0 : e.size;
    dir[o + 2] = 0; dir[o + 3] = 0;
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(e.data.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += e.data.length;
  });
  return Buffer.concat([head, dir, ...entries.map((e) => e.data)]);
}

// Увеличенная копия «по пикселям» — чтобы рассмотреть маленькие размеры.
function zoomPng(rgba, size, k) {
  const W = size * k;
  const bgra = Buffer.alloc(W * W * 4);
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const s = ((Math.floor(y / k)) * size + Math.floor(x / k)) * 4, d = (y * W + x) * 4;
      // на шахматке, чтобы была видна прозрачность
      const chk = ((x >> 3) + (y >> 3)) & 1 ? 200 : 235;
      const a = rgba[s + 3] / 255;
      bgra[d] = Math.round(rgba[s + 2] * a + chk * (1 - a));
      bgra[d + 1] = Math.round(rgba[s + 1] * a + chk * (1 - a));
      bgra[d + 2] = Math.round(rgba[s] * a + chk * (1 - a));
      bgra[d + 3] = 255;
    }
  }
  return nativeImage.createFromBitmap(bgra, { width: W, height: W }).toPNG();
}

// ---------- рендер ----------
function createRenderer() {
  const win = new BrowserWindow({
    width: CANVAS, height: CANVAS, useContentSize: true, show: false, frame: false, transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: true },
  });
  const wc = win.webContents;
  let lastFrame = null;
  let waiters = [];
  wc.on('paint', (_e, _dirty, image) => {
    lastFrame = image;
    const w = waiters; waiters = [];
    for (const fn of w) fn(image);
  });
  wc.setFrameRate(30);
  const nextFrame = (ms) => new Promise((resolve) => {
    const t = setTimeout(() => resolve(lastFrame), ms || 1500);
    waiters.push((img) => { clearTimeout(t); resolve(img); });
  });

  async function render(svg, size) {
    await wc.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(htmlFor(svg, size)));
    await wc.executeJavaScript('new Promise((r) => { const i = document.querySelector("img"); (i.complete ? Promise.resolve() : new Promise((d) => { i.onload = d; i.onerror = d; })).then(() => requestAnimationFrame(() => requestAnimationFrame(r))); })');
    wc.invalidate();
    let frame = await nextFrame(1500);
    if (!frame || frame.isEmpty()) frame = await wc.capturePage();
    if (!frame || frame.isEmpty()) throw new Error('пустой кадр для ' + size);
    let img = frame.crop({ x: 0, y: 0, width: size, height: size });
    const s = img.getSize();
    if (s.width !== size || s.height !== size) img = img.resize({ width: size, height: size, quality: 'best' });
    return img;
  }

  return { render, close: () => win.destroy() };
}

async function main() {
  const big = fs.readFileSync(path.join(ASSETS, 'logo.svg'), 'utf8');
  const small = fs.readFileSync(path.join(ASSETS, 'logo-small.svg'), 'utf8');
  const r = createRenderer();
  const entries = [];
  const previewDir = path.join(ROOT, 'tools', 'dev-out', 'f-tools');
  if (PREVIEW) fs.mkdirSync(previewDir, { recursive: true });
  try {
    for (const size of ICO_SIZES) {
      const img = await r.render(size <= SMALL_MAX ? small : big, size);
      const png = img.toPNG();
      const dec = decodePng(png);
      if (dec.width !== size || dec.height !== size) throw new Error(`размер ${dec.width}×${dec.height} вместо ${size}`);
      const opaque = dec.rgba.some((v, i) => (i & 3) === 3 && v > 0);
      if (!opaque) throw new Error('кадр ' + size + ' полностью прозрачный — рендер не удался');
      entries.push({ size, data: size >= 256 ? png : bmpEntry(dec.rgba, size) });
      if (PREVIEW) {
        fs.writeFileSync(path.join(previewDir, `icon-${size}.png`), png);
        if (size <= 64) fs.writeFileSync(path.join(previewDir, `icon-${size}-zoom.png`), zoomPng(dec.rgba, size, Math.max(4, Math.round(256 / size))));
      }
      console.log(`  ${size}×${size}: ${size >= 256 ? 'PNG' : 'BMP'} ${entries[entries.length - 1].data.length} байт`);
    }
    const ico = buildIco(entries);
    fs.writeFileSync(path.join(ASSETS, 'icon.ico'), ico);
    const p512 = (await r.render(big, 512)).toPNG();
    fs.writeFileSync(path.join(ASSETS, 'icon.png'), p512);
    console.log(`assets/icon.ico — ${ico.length} байт, ${entries.length} размеров; assets/icon.png — 512×512, ${p512.length} байт`);
  } finally {
    r.close();
  }
}

app.whenReady().then(main).then(() => app.exit(0), (e) => { console.error('make-icon:', e && e.stack || e); app.exit(1); });
