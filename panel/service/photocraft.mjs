import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { getSettings, patchSettings } from './settings.mjs';
import { TMP_DIR, DATA_DIR, stamp, readJson, writeJson } from './paths.mjs';

/* ------------------------------------------------------------------ */
/* tiny MCP stdio client for `photocraft-cli mcp --bridge`             */
/* ------------------------------------------------------------------ */

class Bridge {
  constructor() {
    this.child = null;
    this.buf = '';
    this.seq = 0;
    this.pending = new Map();
    this.ready = null;
    this.version = null;
  }

  async start() {
    const s = getSettings().photocraft;
    if (!fs.existsSync(s.cli)) throw new Error(`photocraft-cli not found at ${s.cli}`);
    if (!(await portOpen(s.controlPort))) {
      throw new Error(`PhotoCraft control port ${s.controlPort} is closed. Start PhotoCraft from EggLab first.`);
    }
    if (!fs.existsSync(s.tokenFile)) {
      fs.mkdirSync(path.dirname(s.tokenFile), { recursive: true });
      fs.writeFileSync(s.tokenFile, crypto.randomBytes(32).toString('hex'), 'utf8');
    }
    const child = spawn(
      s.cli,
      ['mcp', '--bridge', `127.0.0.1:${s.controlPort}`, '--control-token-file', s.tokenFile],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );
    this.child = child;
    this.buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.onData(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', () => {});
    child.on('exit', () => {
      this.child = null;
      this.ready = null;
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error('PhotoCraft bridge closed'));
      }
      this.pending.clear();
    });

    const init = await this.request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'egglab-panel', version: '0.1.0' },
    });
    this.version = init?.serverInfo?.version || null;
    this.write({ jsonrpc: '2.0', method: 'notifications/initialized' });
    this.tools = (await this.request('tools/list', {}))?.tools || [];
    return this;
  }

  write(msg) {
    if (!this.child) throw new Error('PhotoCraft bridge is not running');
    this.child.stdin.write(JSON.stringify(msg) + '\n');
  }

  request(method, params = {}, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`PhotoCraft ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  onData(chunk) {
    this.buf += chunk;
    let idx;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const pending = this.pending.get(msg.id);
      if (!pending) continue;
      this.pending.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.error) pending.reject(new Error(msg.error.message || 'PhotoCraft error'));
      else pending.resolve(msg.result);
    }
  }

  async call(name, args = {}, timeoutMs = 120000) {
    const res = await this.request('tools/call', { name, arguments: args }, timeoutMs);
    if (res?.isError) {
      const text = (res.content || []).map((c) => c.text).filter(Boolean).join('\n');
      throw new Error(text || `PhotoCraft tool ${name} failed`);
    }
    const images = [];
    const texts = [];
    for (const part of res?.content || []) {
      if (part.type === 'text') texts.push(part.text);
      if (part.type === 'image' && part.data) images.push(part);
    }
    const joined = texts.join('\n');
    let json = null;
    try {
      json = joined ? JSON.parse(joined) : null;
    } catch {}
    return { json, text: joined, images };
  }

  stop() {
    try {
      this.child?.kill();
    } catch {}
    this.child = null;
  }
}

let bridge = null;
let bridgePromise = null;

async function getBridge() {
  if (bridge?.child) return bridge;
  if (!bridgePromise) {
    bridgePromise = (async () => {
      const b = new Bridge();
      await b.start();
      bridge = b;
      return b;
    })().finally(() => {
      bridgePromise = null;
    });
  }
  return bridgePromise;
}

export function resetBridge() {
  bridge?.stop();
  bridge = null;
}

/* ------------------------------------------------------------------ */

export function portOpen(port, timeoutMs = 700) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port: Number(port) });
    const done = (ok) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    sock.once('timeout', () => done(false));
  });
}

function pngSize(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(24);
    fs.readSync(fd, head, 0, 24, 0);
    fs.closeSync(fd);
    if (head.toString('ascii', 1, 4) !== 'PNG') return null;
    return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
  } catch {
    return null;
  }
}

export async function status() {
  const s = getSettings().photocraft;
  const running = await portOpen(s.controlPort);
  const out = {
    running,
    port: s.controlPort,
    exe: s.exe,
    exeExists: fs.existsSync(s.exe),
    cliExists: fs.existsSync(s.cli),
    bridge: Boolean(bridge?.child),
    version: bridge?.version || null,
    document: null,
    error: null,
  };
  if (!running) return out;
  try {
    const b = await getBridge();
    out.bridge = true;
    out.version = b.version;
    const res = await b.call('doc_inspect', {});
    const doc = res.json;
    if (doc && doc.document !== null) {
      const d = doc.document || doc;
      const key = docKey({ path: d.path, name: d.name, width: d.width, height: d.height });
      const saved = savedRevisions[key];
      out.document = {
        key,
        name: d.name || d.title || 'Untitled',
        path: d.path || null,
        width: d.width || d.size?.[0],
        height: d.height || d.size?.[1],
        layers: countLayers(d),
        revision: d.revision,
        dirty: saved === undefined ? true : saved !== d.revision,
      };
    }
  } catch (err) {
    out.error = err.message;
    // "no document open" is a normal state, not a dead bridge.
    if (/bridge|connect|closed|timed out|ECONN/i.test(err.message)) resetBridge();
  }
  return out;
}

function countLayers(node) {
  if (!node) return 0;
  let n = 0;
  const walk = (layers) => {
    for (const l of layers || []) {
      n++;
      if (l.children) walk(l.children);
    }
  };
  walk(node.layers || node.children || (Array.isArray(node) ? node : []));
  return n;
}

export async function launch() {
  const s = getSettings().photocraft;
  if (await portOpen(s.controlPort)) return { launched: false, running: true };
  if (!fs.existsSync(s.exe)) throw new Error(`PhotoCraft not found at ${s.exe}`);
  if (!fs.existsSync(s.tokenFile)) {
    fs.mkdirSync(path.dirname(s.tokenFile), { recursive: true });
    fs.writeFileSync(s.tokenFile, crypto.randomBytes(32).toString('hex'), 'utf8');
  }
  const args = [
    '--control',
    String(s.controlPort),
    '--control-token-file',
    s.tokenFile,
    '--automation-read-root',
    s.readRoot,
    '--automation-write-root',
    s.writeRoot,
  ];
  const child = spawn(s.exe, args, { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    if (await portOpen(s.controlPort, 400)) return { launched: true, running: true };
    await new Promise((r) => setTimeout(r, 700));
  }
  throw new Error('PhotoCraft started but the control port never opened.');
}

export async function inspect() {
  const b = await getBridge();
  const res = await b.call('doc_inspect', {});
  return res.json;
}

export async function activeLayer() {
  const doc = await inspect();
  if (!doc) return null;
  const layers = [];
  const walk = (list, depth = 0) => {
    for (const l of list || []) {
      layers.push({ ...l, depth });
      if (l.children) walk(l.children, depth + 1);
    }
  };
  walk(doc.layers);
  const id = doc.activeLayer;
  return (
    layers.find((l) => l.id === id) ||
    layers.find((l) => l.selected) ||
    layers.find((l) => l.active) ||
    null
  );
}

export async function layers() {
  const doc = await inspect();
  if (!doc) return { document: null, layers: [] };
  const d = doc.document || doc;
  const canvas = { width: d.width, height: d.height };
  // Mark every layer that extends past the canvas: its part outside cannot be
  // selected or edited, so the agent must see this before it builds a mask.
  const annotate = (list) =>
    (list || []).map((l) => {
      const off = offCanvasSides(l.bounds, canvas);
      return {
        ...l,
        ...(off ? { offCanvas: off } : {}),
        ...(l.children ? { children: annotate(l.children) } : {}),
      };
    });
  const tree = annotate(doc.layers || []);
  const warnings = flatLayers(tree)
    .filter((l) => l.offCanvas)
    .map(
      (l) =>
        `"${l.name}" extends past the canvas (${Object.entries(l.offCanvas)
          .map(([side, px]) => `${px} px ${side}`)
          .join(', ')}). A painted mask on it is refused until it lies fully on the canvas.`,
    );
  return {
    document: { name: d.name, width: d.width, height: d.height },
    activeLayer: doc.activeLayer || null,
    layers: tree,
    ...(warnings.length ? { warnings } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* clipboard transport                                                 */
/*                                                                     */
/* The desktop control surface refuses `doc_place` because the command */
/* it maps to reads an ambient path. Copy/paste is the supported road: */
/* the panel writes the image to the OS clipboard, PhotoCraft pastes   */
/* it (edit.paste), and layer pixels come back through edit.copy.      */
/* ------------------------------------------------------------------ */

async function clipboardApi() {
  const mod = await import('electron');
  if (!mod.clipboard || !mod.nativeImage) {
    throw new Error('The clipboard bridge needs the EggLab desktop app.');
  }
  return mod;
}

async function clipboardToPng(file) {
  const { clipboard } = await clipboardApi();
  const img = clipboard.readImage();
  if (img.isEmpty()) throw new Error('PhotoCraft put no image on the clipboard.');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, img.toPNG());
  return img.getSize();
}

/** Write a resized copy of an image and return its path (null when unchanged). */
async function scaledCopy(file, width, height) {
  const { nativeImage } = await clipboardApi();
  const img = nativeImage.createFromPath(file);
  if (img.isEmpty()) throw new Error(`Could not read the image: ${file}`);
  const size = img.getSize();
  if (Math.round(width) === size.width && Math.round(height) === size.height) return null;
  const resized = img.resize({ width: Math.round(width), height: Math.round(height), quality: 'best' });
  const out = path.join(TMP_DIR, `pc-scaled-${stamp()}-${Math.random().toString(36).slice(2, 7)}.png`);
  fs.writeFileSync(out, resized.toPNG());
  return out;
}

/** Write a cropped copy of an image and return its path. */
export async function cropCopy(file, rect) {
  const { nativeImage } = await clipboardApi();
  const img = nativeImage.createFromPath(file);
  if (img.isEmpty()) throw new Error(`Could not read the image: ${file}`);
  const size = img.getSize();
  const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v) || 0)));
  const x = clampInt(rect[0], 0, size.width - 1);
  const y = clampInt(rect[1], 0, size.height - 1);
  const width = clampInt(rect[2], 1, size.width - x);
  const height = clampInt(rect[3], 1, size.height - y);
  const out = path.join(TMP_DIR, `pc-crop-${stamp()}-${Math.random().toString(36).slice(2, 7)}.png`);
  fs.writeFileSync(out, img.crop({ x, y, width, height }).toPNG());
  return { path: out, rect: [x, y, width, height] };
}

/** Any control method through the MCP bridge's pass-through tool. */
async function control(method, params = {}) {
  const b = await getBridge();
  const res = await b.call('control_call', { method, params });
  return res.json ?? res.text;
}

/**
 * Bring a PNG into the active document with its alpha intact. The desktop
 * refuses `doc_place` (ambient path), so the panel opens the file through the
 * read root, copies its layer into the user's document and closes it again.
 */
async function openAndCopy(file, { at, center, name } = {}) {
  // The destination is whatever document was active *before* the file is
  // opened. Picking "the first document that is not the source" breaks as soon
  // as a third document is open, which is exactly the normal case: an existing
  // document, the new document the agent just made, and the PNG being placed.
  const before = await documentEntries();
  const destBefore = before.find((d) => d.checked) || before[0] || null;
  if (!destBefore) throw new Error('Open or create a PhotoCraft document before placing art into it.');

  const opened = await (async () => {
    const b = await getBridge();
    const res = await b.call('doc_open', { path: file });
    return res.json ?? res.text;
  })();

  const after = await documentEntries();
  const known = new Set(before.map((d) => d.id));
  // Opening a file activates it, and it is always a *new* window entry. Find it
  // by identity; falling back to "some other document" would copy the wrong
  // layers into the user's file, which is far worse than failing loudly.
  const source = after.find((d) => !known.has(d.id)) || null;
  const dest = after.find((d) => d.id === destBefore.id) || null;
  if (!source || !dest) {
    throw new Error(
      `Could not open ${path.basename(file)} as a document while placing: ` +
        (source ? 'the destination document disappeared' : 'the file did not open'),
    );
  }
  const sourceIndex = source.index;
  const destIndex = dest.index;

  const b = await getBridge();
  const inspected = await b.call('doc_inspect', {});
  const doc = inspected.json || {};
  const layers = doc.layers || [];
  const ids = layers.map((l) => l.id).filter((id) => id !== undefined);

  const params = {
    document: destIndex,
    source: sourceIndex,
    ...(ids.length ? { layers: ids } : {}),
    ...(at ? { at } : {}),
    ...(center ? { center: true } : {}),
    ...(name ? { name } : {}),
  };
  const copied = await command('layer.copyToDocument', params);
  let closed = null;
  try {
    closed = await command('file.close', { document: sourceIndex });
  } catch (err) {
    closed = { error: err.message };
  }
  return { opened, copied, closed, source: sourceIndex, destination: destIndex, layers: ids, name: dest.label };
}

function documentSize(doc) {
  const d = doc?.document || doc || {};
  return { width: Number(d.width) || 1080, height: Number(d.height) || 1080 };
}

export async function place(file, opts = {}) {
  const doc = await inspect();
  const { width: docW, height: docH } = documentSize(doc);
  const { nativeImage } = await clipboardApi();
  const img = nativeImage.createFromPath(file);
  if (img.isEmpty()) throw new Error(`Could not read the image: ${file}`);
  let size = img.getSize();
  let source = file;

  if (opts.scale) {
    const scale = Number(opts.scale) / 100;
    const width = Math.max(1, Math.round(size.width * scale));
    const height = Math.max(1, Math.round(size.height * scale));
    source = (await scaledCopy(file, width, height)) || file;
    size = { width, height };
  } else if (opts.fit) {
    const k = Math.min(docW / size.width, docH / size.height, 1);
    if (k < 0.999) {
      const width = Math.max(1, Math.round(size.width * k));
      const height = Math.max(1, Math.round(size.height * k));
      source = (await scaledCopy(file, width, height)) || file;
      size = { width, height };
    }
  }

  const center = Array.isArray(opts.center)
    ? opts.center
    : [docW / 2, docH / 2];
  const fallbackName = path.basename(file).replace(/\.[^.]+$/, '').slice(0, 48);
  const result = await openAndCopy(source, { at: center, name: opts.name || fallbackName });
  return { placed: result.copied, ...result, size, center, file };
}

export async function placeAtBounds(file, bounds, opts = {}) {
  if (!bounds) return place(file, { fit: true, name: opts.name });
  const size = pngSize(file);
  if (!size) return { file, bounds, size: null, placed: await place(file, { fit: true, name: opts.name }) };
  let source = file;
  if (Math.round(size.width) !== Math.round(bounds[2]) || Math.round(size.height) !== Math.round(bounds[3])) {
    source = (await scaledCopy(file, bounds[2], bounds[3])) || file;
  }
  const center = [bounds[0] + bounds[2] / 2, bounds[1] + bounds[3] / 2];
  const result = await openAndCopy(source, { at: center, name: opts.name });
  return { file, bounds, size, placed: result.copied, ...result };
}

/** Every open document as the window menu reports it. */
async function documentEntries() {
  const menu = (await control('ui.menu.list')) || [];
  return (Array.isArray(menu) ? menu : [])
    .filter((m) => /^window\.document\./.test(String(m?.id)))
    .map((m) => ({
      id: String(m.id),
      index: Number(String(m.id).split('.').pop()),
      label: m.label,
      checked: Boolean(m.checked),
    }));
}

export async function newDocument({ width = 1080, height = 1080, background = 'white', name } = {}) {
  const before = await documentEntries();
  const b = await getBridge();
  const res = await b.call('doc_new', { width, height, background, name });
  const created = res.json ?? res.text;

  // The desktop creates the document but leaves the previous one active, so a
  // following place/save would silently land in whatever was open before.
  // Activate the new document and confirm it before returning.
  let index = Number(created?.document ?? created?.index);
  if (!Number.isFinite(index)) {
    const after = await documentEntries();
    const known = new Set(before.map((d) => d.id));
    const fresh = after.filter((d) => !known.has(d.id));
    const chosen = fresh.length ? fresh[fresh.length - 1] : after[after.length - 1];
    if (chosen) index = chosen.index;
  }

  let activated = null;
  if (Number.isFinite(index)) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await command('document.activate', { document: index });
      } catch {}
      const after = await documentEntries();
      const active = after.find((d) => d.checked);
      if (active && active.index === index) {
        activated = index;
        break;
      }
    }
  }

  return {
    ...(created && typeof created === 'object' ? created : { result: created }),
    document: Number.isFinite(index) ? index : undefined,
    activated: activated !== null,
  };
}

/**
 * Save the visible composite as one flat PNG. This is the deliverable export for
 * anything the client sees as a single image; layer exports are for handoff of an
 * editable stack. The project path is untouched.
 */
export async function exportFlattened({ dir, name, overwrite = true } = {}) {
  const doc = await inspect();
  if (!doc) throw new Error('No document is open.');
  const targetDir = path.isAbsolute(dir)
    ? dir
    : path.join(getSettings().photocraft.writeRoot, dir || 'EggLab/out');
  fs.mkdirSync(targetDir, { recursive: true });
  const base = sanitize(String(name || doc.name || `untitled-${stamp()}`)).replace(/\.(pcraft|psd|psb|png)$/i, '');
  const file = path.join(targetDir, `${base}.png`);
  if (!overwrite && fs.existsSync(file)) throw new Error(`${file} already exists.`);
  // Copy Merged copies only the selection when one is active, which would ship a
  // cropped deliverable; a flat export is always the whole canvas.
  try {
    await command('select.deselect', {});
  } catch {}
  await command('edit.copyMerged', {});
  const size = await clipboardToPng(file);
  return {
    file,
    width: size?.width ?? doc.width,
    height: size?.height ?? doc.height,
    bytes: fs.statSync(file).size,
  };
}

/**
 * Measure the composite the way a print checker would: real ink bounds, edge
 * contact, palette shares, luminance spread and type collisions. The canvas is
 * a downscaled look; this is the numbers behind it.
 */
export async function audit({ maxSide = 1024 } = {}) {
  const doc = await inspect();
  if (!doc) throw new Error('No document is open.');
  const shot = await preview(maxSide);
  if (!shot.path) throw new Error('Could not render the composite.');
  const { nativeImage } = await clipboardApi();
  const img = nativeImage.createFromPath(shot.path);
  if (img.isEmpty()) throw new Error('Could not read the composite.');
  const { width: iw, height: ih } = img.getSize();
  const bmp = img.toBitmap(); // BGRA, premultiplied on some platforms
  const sx = doc.width / iw;
  const sy = doc.height / ih;
  const px = (x, y) => {
    const o = (y * iw + x) * 4;
    return [bmp[o + 2], bmp[o + 1], bmp[o], bmp[o + 3]];
  };

  // Dominant colour: the background by definition on these pieces. Keep one real
  // pixel per bucket — comparing against the quantised centre shifts dark palettes.
  const hist = new Map();
  for (let y = 0; y < ih; y++) {
    for (let x = 0; x < iw; x++) {
      const [r, g, b, a] = px(x, y);
      if (a < 8) continue;
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      const entry = hist.get(key);
      if (entry) {
        entry.n++;
        entry.sr += r;
        entry.sg += g;
        entry.sb += b;
      } else hist.set(key, { n: 1, sr: r, sg: g, sb: b });
    }
  }
  const ranked = [...hist.entries()].sort((a, b) => b[1].n - a[1].n);
  const total = ranked.reduce((n, [, v]) => n + v.n, 0) || 1;
  const hex = ([r, g, b]) =>
    '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
  const bgRgb = (() => {
    const e = ranked[0]?.[1];
    return e ? [e.sr / e.n, e.sg / e.n, e.sb / e.n] : [0, 0, 0];
  })();
  const bg = hex(bgRgb);

  let minX = iw, minY = ih, maxX = -1, maxY = -1;
  const lumHist = new Array(64).fill(0);
  const edge = { top: 0, right: 0, bottom: 0, left: 0 };
  for (let y = 0; y < ih; y++) {
    for (let x = 0; x < iw; x++) {
      const [r, g, b, a] = px(x, y);
      if (a < 8) continue;
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      lumHist[Math.min(63, Math.max(0, Math.round((lum / 255) * 63)))]++;
      const diff = Math.abs(r - bgRgb[0]) + Math.abs(g - bgRgb[1]) + Math.abs(b - bgRgb[2]);
      if (diff <= 24) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (y === 0) edge.top++;
      if (y === ih - 1) edge.bottom++;
      if (x === 0) edge.left++;
      if (x === iw - 1) edge.right++;
    }
  }
  const ink = maxX < 0
    ? null
    : {
        left: Math.round(minX * sx),
        top: Math.round(minY * sy),
        right: Math.round((iw - 1 - maxX) * sx),
        bottom: Math.round((ih - 1 - maxY) * sy),
      };

  const cum = [];
  let run = 0;
  for (const v of lumHist) {
    run += v;
    cum.push(run);
  }
  const pct = (p) => {
    const target = (total * p) / 100;
    const i = cum.findIndex((v) => v >= target);
    return Math.round(((i < 0 ? 63 : i) / 63) * 100);
  };

  const palette = ranked
    .slice(0, 6)
    .filter(([, v]) => v.n / total >= 0.01)
    .map(([, v]) => ({ hex: hex([v.sr / v.n, v.sg / v.n, v.sb / v.n]), pct: Math.round((v.n / total) * 100) }));

  // Type: sizes and text-on-text collisions from real layer bounds.
  const flat = [];
  const walk = (list) => {
    for (const l of list || []) {
      flat.push(l);
      if (l.children) walk(l.children);
    }
  };
  walk(doc.layers);
  const texts = flat.filter((l) => String(l.kind || '').toLowerCase() === 'type' || l.text);
  const sizes = texts
    .map((l) => Number(l.text?.sizePt ?? l.text?.size ?? l.sizePt))
    .filter((n) => Number.isFinite(n) && n > 0);
  const collisions = [];
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      const a = texts[i], b = texts[j];
      if (a.visible === false || b.visible === false) continue;
      const ra = a.bounds, rb = b.bounds;
      if (!ra || !rb) continue;
      const w = Math.min(ra.x + ra.width, rb.x + rb.width) - Math.max(ra.x, rb.x);
      const h = Math.min(ra.y + ra.height, rb.y + rb.height) - Math.max(ra.y, rb.y);
      if (w > 4 && h > 4) collisions.push({ a: a.name, b: b.name, overlap: [Math.round(w), Math.round(h)] });
    }
  }
  const smallest = texts
    .filter((l) => Number(l.text?.sizePt ?? l.text?.size ?? l.sizePt) > 0)
    .sort((a, b) => Number(a.text?.sizePt ?? a.text?.size ?? a.sizePt) - Number(b.text?.sizePt ?? b.text?.size ?? b.sizePt))
    .slice(0, 2)
    .map((l) => ({ name: l.name, pt: Number(l.text?.sizePt ?? l.text?.size ?? l.sizePt) }));

  return {
    doc: { name: doc.name, width: doc.width, height: doc.height },
    canvas: shot.path,
    background: bg,
    backgroundPct: Math.round(((ranked[0]?.[1].n || 0) / total) * 100),
    ink,
    edgeTouch: Object.entries(edge)
      .filter(([, n]) => n > 0)
      .map(([side]) => side),
    palette,
    luminance: { p2: pct(2), p50: pct(50), p98: pct(98) },
    type: { layers: texts.length, minPt: sizes.length ? Math.min(...sizes) : null, maxPt: sizes.length ? Math.max(...sizes) : null, smallest },
    collisions,
    note: 'ink = content margin in document px (null = empty canvas). contrast = p2 vs p98 luminance (%).',
  };
}

export async function exportLayers({ dir, visibleOnly = false, prefix = 'layer' } = {}) {  const doc = await inspect();
  if (!doc) throw new Error('No document is open.');
  const targetDir = path.isAbsolute(dir)
    ? dir
    : path.join(
        getSettings().photocraft.writeRoot,
        dir || `EggLab/panel/tmp/pc-${stamp()}`,
      );
  fs.mkdirSync(targetDir, { recursive: true });
  const files = [];
  const skipped = [];
  const activeId = doc.activeLayer;
  const roots = doc.layers || [];
  let index = 0;
  for (const layer of roots) {
    if (visibleOnly && !layer.visible) {
      skipped.push({ layer: layer.id, name: layer.name, reason: 'hidden' });
      continue;
    }
    await command('layer.select', { layer: layer.id });
    await command('edit.copy', {});
    const name = `${prefix}-${String(index++).padStart(2, '0')}-${sanitize(layer.name || 'layer')}.png`;
    const file = path.join(targetDir, name);
    await clipboardToPng(file);
    files.push(file);
  }
  if (activeId !== undefined) {
    try {
      await command('layer.select', { layer: activeId });
    } catch {}
  }
  return { files, skipped, dir: targetDir };
}


/** Downscale a PNG in place-ish (writes a sibling) so vision stays cheap. */
async function shrinkPng(file, maxSide) {
  if (!maxSide) return file;
  try {
    const { nativeImage } = await import('electron');
    const img = nativeImage.createFromPath(file);
    if (img.isEmpty()) return file;
    const { width, height } = img.getSize();
    const long = Math.max(width, height);
    if (long <= maxSide) return file;
    const scale = maxSide / long;
    const small = img.resize({
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
      quality: 'good',
    });
    const out = file.replace(/\.png$/i, `-${maxSide}.png`);
    fs.writeFileSync(out, small.toPNG());
    try { fs.unlinkSync(file); } catch {}
    return out;
  } catch {
    return file;
  }
}

export async function preview(maxSide = 1024) {
  const b = await getBridge();
  // Prefer the real composite: `doc_save` with a .png path exports a flat
  // copy of the canvas (no layer mutation, document stays dirty as before).
  // The bridge's `render_preview` is only a window screenshot, which shows
  // panels and chrome and is useless as a design reference.
  const shot = path.join(TMP_DIR, `pc-canvas-${Date.now()}.png`);
  try {
    await b.call('doc_save', { path: shot });
    if (fs.existsSync(shot) && fs.statSync(shot).size > 0) {
      return { path: await shrinkPng(shot, maxSide), kind: 'composite' };
    }
  } catch {}
  const res = await b.call('render_preview', { max_side: maxSide });
  const img = res.images?.[0];
  if (!img) return { path: null, text: res.text, kind: 'none' };
  const file = path.join(TMP_DIR, `pc-preview-${Date.now()}.png`);
  fs.writeFileSync(file, Buffer.from(img.data, 'base64'));
  return { path: file, kind: 'window' };
}

export async function command(id, params = {}) {
  const b = await getBridge();
  const res = await b.call('command_run', { id, params });
  return res.json ?? res.text;
}

/** The live command registry (ids, labels, enablement, param docs). */
export async function commands(filter = '') {
  const b = await getBridge();
  const res = await b.call('command_list', { filter: filter || undefined });
  return res.json ?? res.text;
}

/**
 * A compact view of the 900+ command registry for the agent.
 *
 * The raw registry is far too large to put in a prompt, so the agent looks
 * commands up on demand: `filter` searches id/label/menu (e.g. "mask",
 * "adjustment", "layer."), and `ids` fetches the exact param spec for the
 * handful it is about to run. Params are truncated in list mode only.
 */
const COMMAND_GROUPS = [
  ['document', /^(?:doc|document)(?:\.|$)|(?:^|\.)project(?:\.|$)/i],
  ['layer', /^layer(?:\.|$)/i],
  ['type', /^(?:type|text)(?:\.|$)/i],
  ['shape', /^(?:shape|vector|path)(?:\.|$)/i],
  ['selection', /^(?:select|selection)(?:\.|$)/i],
  ['mask', /(?:^|\.)mask(?:\.|$)|quick.?mask/i],
  ['adjustment', /^(?:adjustment|adjust)(?:\.|$)/i],
  ['filter', /^(?:filter|effect)(?:\.|$)/i],
  ['transform', /^(?:transform|crop|resize|rotate|flip)(?:\.|$)/i],
  ['image', /^(?:image|raster|canvas)(?:\.|$)/i],
  ['export', /^(?:export|save|file)(?:\.|$)/i],
  ['ui', /^(?:ui|view|panel)(?:\.|$)/i],
];

function commandGroup(id) {
  const value = String(id || '');
  for (const [name, re] of COMMAND_GROUPS) if (re.test(value)) return name;
  return 'other';
}

/**
 * Risk class for a raw command. Destructive commands can destroy user work;
 * the agent must ask before running them on a document it did not just create.
 */
function commandRisk(id) {
  const value = String(id || '');
  if (/(?:^|\.)(?:delete|remove|flatten|merge|close|clear|overwrite|rasterize|apply|replace|reset|discard)(?:\.|$)/i.test(value)) {
    return 'destructive';
  }
  if (/(?:inspect|list|get|preview|snapshot|state|status|select|activate|open|recent|query)(?:\.|$)/i.test(value)) {
    return 'read_only';
  }
  return 'reversible';
}

/**
 * Capability search over the live PhotoCraft catalog.
 *
 * Progressive disclosure (Anthropic search_tools pattern): `detail: "names"`
 * returns id + group + risk only; `"brief"` adds the menu/label; `"full"` adds
 * the exact parameter schema. Search is by id/label/menu/group; `ids` fetches
 * exact commands with full params. Nothing here is cached into the prompt —
 * the agent reads only what it asks for.
 */
export async function commandCatalog({ filter = '', query = '', ids = [], group = '', limit = 40, detail = '', fullParams = false } = {}) {
  const raw = await commands('');
  const list = Array.isArray(raw) ? raw : raw?.commands || [];
  const mode = String(detail || '').toLowerCase() || (fullParams ? 'full' : 'brief');
  const level = ['names', 'brief', 'full'].includes(mode) ? mode : 'brief';
  const shape = (c, withParams) => ({
    id: c.id,
    group: commandGroup(c.id),
    risk: commandRisk(c.id),
    ...(level === 'names'
      ? {}
      : {
          label: c.label,
          menu: c.menu,
          enabled: c.enabled,
          needsDocument: c.needsDocument,
        }),
    ...(level === 'full' && c.params ? { params: withParams ? c.params : c.params.slice(0, 220) } : {}),
  });

  const wanted = (Array.isArray(ids) ? ids : String(ids || '').split(/[,\s]+/))
    .map((s) => String(s).trim())
    .filter(Boolean);
  if (wanted.length) {
    const commandsOut = wanted.map((id) => {
      const hit = list.find((c) => c.id === id);
      return hit ? shape(hit, true) : { id, missing: true };
    });
    return { mode: 'exact', detail: 'full', commands: commandsOut };
  }

  const needle = String(filter || query || '').trim().toLowerCase();
  const wantedGroup = String(group || '').trim().toLowerCase();
  const matched = list.filter((c) => {
    if (wantedGroup && commandGroup(c.id) !== wantedGroup) return false;
    if (!needle) return true;
    return [c.id, c.label, commandGroup(c.id), ...(Array.isArray(c.menu) ? c.menu : [])]
      .join(' ')
      .toLowerCase()
      .includes(needle);
  });
  const cap = Math.min(Math.max(Number(limit) || 40, 1), 200);
  const groups = {};
  for (const c of matched) {
    const g = commandGroup(c.id);
    groups[g] = (groups[g] || 0) + 1;
  }
  return {
    mode: needle || wantedGroup ? 'search' : 'all',
    detail: level,
    total: matched.length,
    returned: Math.min(cap, matched.length),
    groups,
    commands: matched.slice(0, cap).map((c) => shape(c, Boolean(fullParams) || level === 'full')),
  };
}

export async function exportActiveLayer() {
  const doc = await inspect();
  if (!doc) throw new Error('Open a document in PhotoCraft first.');
  const layer = await activeLayer();
  if (!layer) throw new Error('Select a layer in PhotoCraft first.');
  let madeVisible = false;
  if (layer.visible === false) {
    try {
      await command('layer.setProps', { layer: layer.id, visible: true });
      madeVisible = true;
    } catch {}
  }
  try {
    await command('layer.select', { layer: layer.id });
    await command('edit.copy', {});
  } finally {
    if (madeVisible) {
      try {
        await command('layer.setProps', { layer: layer.id, visible: false });
      } catch {}
    }
  }
  const file = path.join(TMP_DIR, `pc-layer-${stamp()}-${layer.id}.png`);
  const size = await clipboardToPng(file);
  return {
    path: file,
    size,
    layer: {
      id: layer.id,
      name: layer.name,
      bounds: layer.bounds,
      visible: layer.visible,
    },
  };
}

/**
 * Export a single layer by name to a PNG file via the clipboard (alpha preserved).
 * Finds the layer in the active document, selects it, copies it, and writes it out.
 * Restores the previous selection/visibility afterward.
 */
import { decodePng, encodePng } from './pngfeather.mjs';
import { offCanvasSides, flatLayers } from './maskedjob.mjs';

/**
 * Pad a cropped layer export back to full canvas at its document bounds.
 *
 * PhotoCraft's clipboard copy returns the layer's visible content only (a
 * 170x189 paint patch, not the 1784x1080 canvas). A mask with different
 * dimensions than the image it edits is silently resized by the engine and
 * lands in the wrong place. Layer FILE exports keep transparent margins
 * (PhotoCraft PR #3519), and this reproduces that: full canvas, layer content
 * at its true position, transparent elsewhere (transparent = keep for masks).
 */
function padToCanvas(file, docWidth, docHeight, bounds) {
  const width = Number(docWidth);
  const height = Number(docHeight);
  if (!(width > 0) || !(height > 0)) return null;
  const src = decodePng(file);
  const [ox, oy] = (bounds || [0, 0]).map((v) => Math.round(Number(v) || 0));
  if (src.width === width && src.height === height) return file;
  const out = Buffer.alloc(width * height * 4);
  for (let y = 0; y < src.height; y++) {
    const dy = oy + y;
    if (dy < 0 || dy >= height) continue;
    for (let x = 0; x < src.width; x++) {
      const dx = ox + x;
      if (dx < 0 || dx >= width) continue;
      const s = (y * src.width + x) * 4;
      const d = (dy * width + dx) * 4;
      out[d] = src.data[s];
      out[d + 1] = src.data[s + 1];
      out[d + 2] = src.data[s + 2];
      out[d + 3] = src.data[s + 3];
    }
  }
  const aligned = file.replace(/\.png$/i, '-fullcanvas.png');
  encodePng(aligned, width, height, out);
  return aligned;
}

export async function exportLayerByName(name, { makeVisible = true, fullCanvas = true } = {}) {
  const doc = await inspect();
  if (!doc) throw new Error('Open a document in PhotoCraft first.');
  const layers = doc.layers || [];
  const flat = [];
  const walk = (list, depth = 0) => {
    for (const l of list || []) {
      flat.push({ ...l, depth });
      if (l.children) walk(l.children, depth + 1);
    }
  };
  walk(layers);
  const match0 = flat.find((l) => l.name === name);
  let match = match0;
  if (!match) {
    // Try case-insensitive match
    const ci = flat.find((l) => String(l.name || '').toLowerCase() === String(name).toLowerCase());
    if (!ci) throw new Error(`Layer "${name}" not found in the current document.`);
    match = ci;
  }
  const prevActive = doc.activeLayer;
  let madeVisible = false;
  if (match.visible === false && makeVisible) {
    try {
      await command('layer.setProps', { layer: match.id, visible: true });
      madeVisible = true;
    } catch {}
  }
  try {
    await command('layer.select', { layer: match.id });
    await command('edit.copy', {});
  } finally {
    if (madeVisible) {
      try {
        await command('layer.setProps', { layer: match.id, visible: false });
      } catch {}
    }
    if (prevActive !== undefined) {
      try { await command('layer.select', { layer: prevActive }); } catch {}
    }
  }
  const file = path.join(TMP_DIR, `pc-ref-${stamp()}-${sanitize(match.name || 'layer')}.png`);
  const size = await clipboardToPng(file);
  // Clipboard copy returns the layer's content only; align it back to the
  // document canvas so masks and references share the source's dimensions.
  const aligned = fullCanvas ? padToCanvas(file, doc.width, doc.height, match.bounds) : null;
  return {
    path: aligned || file,
    croppedPath: aligned ? file : undefined,
    size: aligned ? { width: doc.width, height: doc.height } : size,
    croppedSize: aligned ? size : undefined,
    layer: {
      id: match.id,
      name: match.name,
      bounds: match.bounds,
      visible: match.visible,
    },
  };
}

/**
 * Resolve multiple @layerName mentions to exported PNG reference files.
 * Returns { files: string[], resolved: [{mention, layer, path}], unresolved: string[] }.
 */
export async function exportLayersByMentions(mentions) {
  const files = [];
  const resolved = [];
  const unresolved = [];
  for (const mention of mentions) {
    try {
      const exp = await exportLayerByName(mention);
      files.push(exp.path);
      resolved.push({ mention, layer: exp.layer, path: exp.path });
    } catch (err) {
      unresolved.push(mention);
    }
  }
  return { files, resolved, unresolved };
}



function sanitize(name) {
  return String(name).replace(/[\\/:*?"<>|]/g, '_');
}

export async function hideLayer(id) {
  return command('layer.setProps', { layer: id, visible: false });
}

export async function ensureRunning() {
  const s = getSettings().photocraft;
  if (!(await portOpen(s.controlPort))) {
    if (!s.autoLaunch) throw new Error('PhotoCraft is not running with the control port.');
    await launch();
  }
  return true;
}

export async function useActiveLayer() {
  const res = await exportActiveLayer();
  return res;
}

export function bridgeInfo() {
  return { connected: Boolean(bridge?.child), version: bridge?.version || null };
}

export { pngSize };

/* ------------------------------------------------------------------ */
/* project management                                                  */
/*                                                                     */
/* The control channel refuses every `file.*` command that touches a   */
/* path, so open/save go through the automation roots with `app.open`  */
/* / `app.save` instead. The desktop exposes no dirty flag (only the   */
/* workspace server's session.list does), so dirty is derived from the */
/* document revision vs. the revision recorded at the last save.       */
/* ------------------------------------------------------------------ */

const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');
let savedRevisions = readJson(PROJECTS_FILE, {});
if (!savedRevisions || typeof savedRevisions !== 'object' || Array.isArray(savedRevisions)) savedRevisions = {};

// Older builds stored the root-relative key PhotoCraft reports after an
// automated save; normalise everything to the absolute form docKey() uses.
{
  const migrated = {};
  let changed = false;
  for (const [key, rev] of Object.entries(savedRevisions)) {
    const next = key.startsWith('untitled:') ? key : docKey({ path: key });
    if (next !== key) changed = true;
    migrated[next] = rev;
  }
  if (changed) {
    savedRevisions = migrated;
    writeJson(PROJECTS_FILE, savedRevisions);
  }
}

function saveProjects() {
  writeJson(PROJECTS_FILE, savedRevisions);
}

function projectRoot() {
  const s = getSettings().photocraft;
  return s.projectRoot || path.join(s.writeRoot, 'projects');
}

/** Key a document by its path, or by name+size while it has never been saved. */
export function docKey(doc) {
  if (!doc) return null;
  if (doc.path) {
    // PhotoCraft reports the path root-relative after an automated save and
    // absolute when the user saved it by hand; normalise so both agree.
    const abs = path.isAbsolute(doc.path)
      ? doc.path
      : path.join(getSettings().photocraft.writeRoot, doc.path);
    return path.normalize(abs).toLowerCase();
  }
  return `untitled:${doc.name || 'Untitled'}:${doc.width}x${doc.height}`;
}

/**
 * The open documents, the active one, and whether it has unsaved changes.
 * Uses `app.open`-level state only, so it never mutates anything.
 */
export async function projectState() {
  const running = await portOpen(getSettings().photocraft.controlPort);
  const out = {
    running,
    projectRoot: projectRoot(),
    autosave: Boolean(getSettings().photocraft.autosave),
    document: null,
    documents: [],
    error: null,
  };
  if (!running) return out;

  // The menu is the only place that lists *every* open document.
  let menu = [];
  try {
    menu = (await control('ui.menu.list')) || [];
  } catch (err) {
    out.error = err.message;
    return out;
  }
  const entries = (Array.isArray(menu) ? menu : []).filter((m) => /^window\.document\./.test(String(m?.id)));
  out.documents = entries.map((m, i) => ({
    index: Number(String(m.id).split('.').pop()),
    label: m.label,
    active: Boolean(m.checked),
    order: i,
  }));

  try {
    const doc = await inspect();
    const d = doc?.document || doc || null;
    if (d && d.name) {
      const key = docKey({ path: d.path, name: d.name, width: d.width, height: d.height });
      const saved = savedRevisions[key];
      out.document = {
        key,
        name: d.name,
        path: d.path || null,
        width: d.width,
        height: d.height,
        revision: d.revision,
        layers: countLayers(d),
        // Never saved = always dirty; saved = dirty only when the revision moved on.
        dirty: saved === undefined ? true : saved !== d.revision,
        savedRevision: saved ?? null,
      };
    }
  } catch (err) {
    out.error = err.message;
    if (/bridge|connect|closed|timed out|ECONN/i.test(err.message)) resetBridge();
  }
  return out;
}

/**
 * Save the active document. With no `path` this writes back to the document's
 * own file (like File › Save) and refuses if it has never been saved — an
 * untitled document would open a save dialog we cannot answer, so callers
 * must pass a path for those.
 */
export async function save({ path: target, format, source } = {}) {
  const doc = await inspect();
  const d = doc?.document || doc;
  if (!d || !d.name) throw new Error('No document is open.');
  if (!target && !d.path) {
    throw new Error('This document has never been saved. Give a path, e.g. projects/<name>/<name>.pcraft.');
  }
  // The agent must not save-as (rename) an existing document: the identity
  // change strands the chat bound to the old document. Naming is allowed
  // only for a document that has no file yet.
  if (source === 'agent' && target && d.path) {
    const root = getSettings().photocraft.writeRoot;
    const targetAbs = path.resolve(root, target);
    const currentAbs = path.resolve(root, d.path);
    if (targetAbs.toLowerCase() !== currentAbs.toLowerCase()) {
      throw new Error(
        'The agent must not save-as or rename the open document: that changes its identity and strands this chat. ' +
          'Save in place (omit path), or finish in the current project.',
      );
    }
  }
  const params = {};
  if (target) params.path = toRootRelative(target);
  if (format) params.format = format;
  const res = await control('app.save', params);
  const savedRel = res?.path || target || d.path;
  const savedAbs = savedRel ? path.resolve(getSettings().photocraft.writeRoot, savedRel) : null;
  const after = await inspect();
  const a = after?.document || after || {};
  const key = docKey({ path: savedAbs || a.path || savedRel, name: a.name, width: a.width, height: a.height });
  // The document was "untitled:<name>:<size>" a moment ago; drop that key so the
  // map does not accumulate an entry per unsaved session.
  const staleKey = docKey({ path: d.path, name: d.name, width: d.width, height: d.height });
  if (staleKey && staleKey !== key) delete savedRevisions[staleKey];
  savedRevisions[key] = a.revision;
  saveProjects();
  return {
    path: savedAbs,
    rootRelative: savedRel,
    name: a.name || d.name,
    revision: a.revision,
    warnings: res?.warnings || [],
    dirty: false,
  };
}

/** Open a PhotoCraft project or image through the read root. */
export async function openProject({ path: target, activate = true } = {}) {
  if (!target) throw new Error('Give the path of the file to open.');
  const file = path.isAbsolute(target) ? target : path.join(getSettings().photocraft.readRoot, target);
  // Reopening a file that is already open creates a second document with the same
  // path, and every save then writes to whichever copy happens to be active.
  const state = await projectState();
  const open = (state.documents || []).find((d) => d.label === path.basename(file));
  if (open) {
    if (activate && !open.active) {
      try {
        await command('document.activate', { document: open.index });
      } catch {}
    }
    return { path: file, name: path.basename(file), warnings: [], activated: true, alreadyOpen: true };
  }
  const res = await (async () => {
    const b = await getBridge();
    const r = await b.call('doc_open', { path: file });
    return r.json ?? r.text;
  })();
  return { path: res?.path || file, name: res?.name, warnings: res?.warnings || [], activated: activate };
}

/**
 * Close the active document, saving first when asked. PhotoCraft raises an
 * unsaved-changes prompt (`discard`) that must be answered explicitly, and
 * saving an untitled document opens a save dialog — so those two cases are
 * reported back instead of being guessed at.
 */
export async function closeDocument({ save: shouldSave = false } = {}) {
  const doc = await inspect();
  const d = doc?.document || doc || {};
  try {
    await command('file.close', {});
  } catch (err) {
    // The prompt blocks the close; answer it below instead of failing.
    if (!/discard|unsaved|prompt/i.test(err.message)) throw err;
  }
  const dialogs = await discardDialogs();
  if (!dialogs.length) return { closed: true, saved: false, name: d.name };
  if (shouldSave && d.path) {
    await control('ui.dialog.confirm', { dialog: 'discard', choice: 'save' });
    return { closed: true, saved: true, name: d.name, path: d.path };
  }
  if (shouldSave && !d.path) {
    return { closed: false, saved: false, needsPath: true, name: d.name };
  }
  await control('ui.dialog.confirm', { dialog: 'discard', choice: 'dontSave' });
  return { closed: true, saved: false, name: d.name };
}

async function discardDialogs() {
  try {
    const ui = await control('ui.inspect');
    const dialogs = ui?.dialogs || [];
    return (Array.isArray(dialogs) ? dialogs : Object.values(dialogs || {})).filter((d) => d?.id === 'discard' || d?.dialog === 'discard');
  } catch {
    return [];
  }
}

/** Turn a caller path into one the automation write root will accept. */
function toRootRelative(target) {
  const s = getSettings().photocraft;
  const abs = path.isAbsolute(target) ? target : path.join(s.writeRoot, target);
  const norm = path.normalize(abs).replace(/[\\/]/g, '/');
  const rootNorm = path.normalize(s.writeRoot).replace(/[\\/]/g, '/').replace(/\/$/, '');
  if (!norm.startsWith(rootNorm + '/') && norm !== rootNorm) {
    throw new Error(`"${target}" is outside the automation write root (${s.writeRoot}).`);
  }
  return norm.slice(rootNorm.length + 1) || path.basename(norm);
}

/**
 * Persist the active document after an agent-driven change, but only when it
 * already has a file to write back to. An untitled document is never saved
 * silently — a path we must not invent would be needed — so callers get a
 * `needsSave` flag to act on.
 */
export async function autosave(note = null) {
  if (!getSettings().photocraft.autosave) return { autosaved: false, reason: 'autosave is off' };
  try {
    const state = await projectState();
    if (!state.document) return { autosaved: false, reason: 'no document is open' };
    if (!state.document.path) {
      return {
        autosaved: false,
        needsSave: true,
        reason: 'This document has never been saved. Save it to a project folder first.',
      };
    }
    const saved = await save({});
    return { autosaved: true, path: saved.path, name: saved.name, note };
  } catch (err) {
    return { autosaved: false, reason: err.message };
  }
}

/** Recent project files under the project root, newest first. */export function recentProjects(limit = 20) {
  const root = projectRoot();
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 2 || out.length >= limit) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= limit) break;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (/\.(pcraft|psd|psb)$/i.test(entry.name)) {
        let mtime = 0;
        try {
          mtime = fs.statSync(full).mtimeMs;
        } catch {}
        out.push({ path: full, name: entry.name, mtime });
      }
    }
  };
  fs.mkdirSync(root, { recursive: true });
  walk(root, 0);
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

/**
 * Save a project path for the active document, creating the project folder on
 * the way. Returns the path to pass to `save()`.
 */
export function projectPathFor(name, { ext = '.pcraft' } = {}) {
  const root = projectRoot();
  const slug = sanitize(String(name || 'untitled').replace(/\s+/g, '-')).slice(0, 48) || 'untitled';
  const dir = path.join(root, slug);
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  return path.join(dir, `${slug}${ext}`);
}

