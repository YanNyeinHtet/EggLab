// Feather a PNG's edges into transparency so a patched region can be composited
// without a visible rectangle.
//
// Why this exists: the local-edit path crops a region, has the model edit the
// crop, and pastes it back at the same bounds. Model output is opaque, so the
// paste lands as a hard-edged rectangle over an unchanged image — measured on a
// real retouch as an outside delta of exactly 0.00 jumping straight to ~2 at the
// boundary. In smooth areas (sky, skin, wall) a straight step like that is
// immediately visible.
//
// Setting a ramped alpha instead means the top layer fades into the layer below
// over N pixels, so there is no line to see.
import fs from 'node:fs';
import zlib from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/* ------------------------------------------------------------------ */
/* decode                                                              */
/* ------------------------------------------------------------------ */

export function decodePng(file) {
  const buf = fs.readFileSync(file);
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error(`Not a PNG: ${file}`);
  let pos = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = 0;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (!width || !height) throw new Error(`PNG has no header: ${file}`);
  if (depth !== 8) throw new Error(`Unsupported bit depth ${depth}: ${file}`);
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`Unsupported colour type ${colorType}: ${file}`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(stride * height);
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  let off = 0;
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[off++];
    const line = raw.subarray(off, off + stride);
    off += stride;
    const cur = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) v += paeth(a, b, c);
      cur[x] = v & 0xff;
    }
    cur.copy(out, y * stride);
    prev = cur;
  }
  // Normalise everything to RGBA so the encoder only ever writes one layout.
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0, j = 0; i < width * height; i++, j += 4) {
    const s = i * channels;
    if (channels === 4) {
      rgba[j] = out[s];
      rgba[j + 1] = out[s + 1];
      rgba[j + 2] = out[s + 2];
      rgba[j + 3] = out[s + 3];
    } else if (channels === 3) {
      rgba[j] = out[s];
      rgba[j + 1] = out[s + 1];
      rgba[j + 2] = out[s + 2];
      rgba[j + 3] = 255;
    } else if (channels === 2) {
      rgba[j] = rgba[j + 1] = rgba[j + 2] = out[s];
      rgba[j + 3] = out[s + 1];
    } else {
      rgba[j] = rgba[j + 1] = rgba[j + 2] = out[s];
      rgba[j + 3] = 255;
    }
  }
  return { width, height, data: rgba };
}

/* ------------------------------------------------------------------ */
/* encode                                                              */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** Write an RGBA buffer as a PNG (colour type 6, no interlace). */
export function encodePng(file, width, height, rgba) {
  if (rgba.length !== width * height * 4) {
    throw new Error(`RGBA buffer is ${rgba.length} bytes, expected ${width * height * 4}`);
  }
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none, keeps the encoder honest and simple
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const png = Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  fs.writeFileSync(file, png);
  return file;
}

/* ------------------------------------------------------------------ */
/* feather                                                             */
/* ------------------------------------------------------------------ */

// Smoothstep, so the ramp has no visible shoulder where it starts or ends.
const smooth = (t) => {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
};

/**
 * Ramp alpha to 0 over `px` pixels at every edge of the image.
 * Returns the feather actually used (clamped so a small patch never loses its
 * whole interior).
 */
/**
 * Write an inpaint mask: white over `rect`, fading to black over `feather` px
 * past each edge (smoothstep, so it starts and ends with a zero slope).
 *
 * Why the ramp lives *outside* the rect rather than inside it: the edit box is
 * where the change must land, so the core has to be fully selected; the blend
 * band sits in pixels the edit does not need, which is exactly where a cut line
 * would otherwise show. Growing past the box also gives the model surrounding
 * context to match against — a surgical strip is the thing that reads as a seam.
 */
export function regionMask(file, width, height, rect, featherPx) {
  const [rx, ry, rw, rh] = rect.map((v) => Math.round(Number(v) || 0));
  const wanted = Math.max(1, Math.round(Number(featherPx) || 0));
  // Keep at least a quarter of the box as solid core, whatever the request.
  const limit = Math.max(1, Math.floor(Math.min(rw, rh) / 4));
  const f = Math.min(wanted, limit);
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Distance outside the rect (0 or negative inside).
      const dx = Math.max(rx - x, x - (rx + rw - 1), 0);
      const dy = Math.max(ry - y, y - (ry + rh - 1), 0);
      const d = Math.max(dx, dy);
      const a = d >= f ? 0 : smooth(1 - d / f);
      const v = Math.round(a * 255);
      const i = (y * width + x) * 4;
      rgba[i] = v;
      rgba[i + 1] = v;
      rgba[i + 2] = v;
      rgba[i + 3] = 255;
    }
  }
  encodePng(file, width, height, rgba);
  return f;
}

/**
 * Convert a user-painted PhotoCraft mask layer into a full-canvas inpaint mask.
 *
 * The exported layer may be opaque black/white (luminance selects the region)
 * or a transparent layer with white brush strokes (alpha selects the region).
 * Multiply luminance by alpha so both conventions work. The result is written
 * as an opaque black/white PNG at the active layer's pixel size, with the mask
 * layer positioned by its document bounds. `invert` flips the convention.
 *
 * `sourceCanvas` distinguishes the two possible exports:
 *   false — src is the mask layer's own pixels (cropped), placed at `bounds`
 *           (document offset of the mask layer relative to the target layer).
 *   true  — src is already the full canvas (PhotoCraft's file export keeps
 *           transparent margins), so `bounds` is the TARGET layer's document
 *           origin and the source is sampled at that offset. Without this the
 *           canvas-sized export gets shifted a second time and the engine
 *           repaints the wrong part of the picture.
 */
export function layerMask(
  srcFile,
  dstFile,
  width,
  height,
  bounds,
  invert = false,
  sourceCanvas = false,
) {
  const src = decodePng(srcFile);
  const [ox, oy] = (bounds || []).map((v) => Math.round(Number(v) || 0));
  // Selector convention: a painted overlay has transparent pixels, so its
  // ALPHA is the selection (any opaque stroke, red or white, fully selected).
  // An opaque grayscale mask has no transparency, so luminance is the selector.
  // Using luminance on red paint turned a full stroke into ~30% gray.
  let paintedOverlay = false;
  for (let i = 3; i < src.data.length; i += 4) {
    if (src.data[i] < 250) {
      paintedOverlay = true;
      break;
    }
  }
  // PhotoCraft's clipboard copy can FLATTEN a transparent painted layer onto
  // white (alpha lost). Then the white background must be keep-area and the
  // colored strokes selected — the opposite of luminance. Detect that case:
  // opaque image + a meaningful number of saturated (painted) pixels.
  let saturated = 0;
  let sampled = 0;
  for (let i = 0; i < src.data.length; i += 16) {
    const r = src.data[i];
    const g = src.data[i + 1];
    const b = src.data[i + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max - min > 40) saturated++;
    sampled++;
  }
  const flattenedPainted = !paintedOverlay && sampled > 0 && saturated / sampled > 0.001;
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255; // opaque black keep-area
  for (let dy = 0; dy < height; dy++) {
    const sy = sourceCanvas ? dy + oy : dy - oy;
    if (sy < 0 || sy >= src.height) continue;
    for (let dx = 0; dx < width; dx++) {
      const sx = sourceCanvas ? dx + ox : dx - ox;
      if (sx < 0 || sx >= src.width) continue;
      const s = (sy * src.width + sx) * 4;
      const alpha = src.data[s + 3] / 255;
      // Unpainted/transparent pixels are always keep-area, even when inverting:
      // inversion applies to the painted black/white mask, not to transparency.
      if (alpha <= 0.004) continue;
      let v;
      if (paintedOverlay) {
        v = Math.round(255 * alpha);
      } else if (flattenedPainted) {
        // Selected = anything painted over the flattened background (white).
        const dist = 255 - Math.min(src.data[s], src.data[s + 1], src.data[s + 2]);
        v = dist > 60 ? 255 : 0;
      } else {
        const lum =
          (src.data[s] * 0.299 + src.data[s + 1] * 0.587 + src.data[s + 2] * 0.114) / 255;
        v = Math.round(255 * lum * alpha);
      }
      if (invert) v = 255 - v;
      const d = (dy * width + dx) * 4;
      rgba[d] = rgba[d + 1] = rgba[d + 2] = v;
    }
  }
  encodePng(dstFile, width, height, rgba);
  return { width, height, source: { width: src.width, height: src.height }, bounds: [ox, oy] };
}

export function featherEdges(src, dst, px) {
  const { width, height, data } = decodePng(src);
  const wanted = Math.max(1, Math.round(Number(px) || 0));
  // Never eat more than a third of the patch: the middle has to stay opaque or
  // the edit stops being visible at all.
  const limit = Math.max(1, Math.floor(Math.min(width, height) / 3));
  const f = Math.min(wanted, limit);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const fromEdge = Math.min(x, y, width - 1 - x, height - 1 - y);
      if (fromEdge >= f) continue;
      const a = smooth((fromEdge + 1) / (f + 1));
      data[(y * width + x) * 4 + 3] = Math.round(data[(y * width + x) * 4 + 3] * a);
    }
  }
  encodePng(dst, width, height, data);
  return f;
}

/**
 * Resize an RGBA buffer with bilinear sampling in premultiplied alpha, so a
 * feathered edge does not pick up dark or white fringes. Used when the engine
 * renders a region at a capped size and the result has to be composited back
 * at the layer's true pixel dimensions.
 */
function resizeRgba(src, sw, sh, dw, dh) {
  if (sw === dw && sh === dh) return src;
  const out = Buffer.alloc(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const sy = Math.max(0, Math.min(sh - 1, (y + 0.5) * sh / dh - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(sh - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < dw; x++) {
      const sx = Math.max(0, Math.min(sw - 1, (x + 0.5) * sw / dw - 0.5));
      const x0 = Math.floor(sx);
      const x1 = Math.min(sw - 1, x0 + 1);
      const fx = sx - x0;
      const idx = [y0 * sw + x0, y0 * sw + x1, y1 * sw + x0, y1 * sw + x1];
      const weights = [(1 - fx) * (1 - fy), fx * (1 - fy), (1 - fx) * fy, fx * fy];
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let i = 0; i < 4; i++) {
        const s = idx[i] * 4;
        const wa = (src[s + 3] / 255) * weights[i];
        r += src[s] * wa;
        g += src[s + 1] * wa;
        b += src[s + 2] * wa;
        a += wa;
      }
      const d = (y * dw + x) * 4;
      if (a > 0) {
        out[d] = Math.round(r / a);
        out[d + 1] = Math.round(g / a);
        out[d + 2] = Math.round(b / a);
        out[d + 3] = Math.round(a * 255);
      }
    }
  }
  return out;
}

/**
 * Composite a masked inpaint back onto the original through its mask.
 *
 * The engine's --init-img/--mask/--strength path re-noises the whole canvas, so
 * at useful strengths it repaints outside the mask too. This makes the mask a
 * guarantee: inside = the new render, outside = the original pixels, with a
 * soft transition from a small mask blur.
 */
/**
 * Mark the edit region on a copy of the source as a light tint plus a thin
 * outline.
 *
 * Qwen-Image-2.1 is an instruction-edit model, not an inpaint checkpoint. Its
 * trained local-edit path is a reference image with the target area marked.
 * A solid red fill hides the very content the model has to change: measured on
 * a mask around the "3.0" title, an 80% fill made the render replace the text
 * with a tiled face collage. A light tint keeps the glyphs/objects readable
 * while still showing the region; the outline makes the boundary explicit.
 * The service composites the result back through the real B/W mask, so the
 * mask remains the selector and nothing outside it can change.
 */
export function markMaskRegion(
  baseFile,
  maskFile,
  dstFile,
  color = [255, 0, 0],
  tint = 0.28,
  thickness = null,
) {
  const base = decodePng(baseFile);
  const mask = decodePng(maskFile);
  const maskData =
    mask.width === base.width && mask.height === base.height
      ? mask.data
      : resizeRgba(mask.data, mask.width, mask.height, base.width, base.height);
  const [r, g, b] = color.map((v) => Math.max(0, Math.min(255, Math.round(Number(v) || 0))));
  const strength = Math.max(0, Math.min(1, Number(tint)));
  const t = Number.isFinite(Number(thickness))
    ? Math.max(0, Math.min(16, Math.round(Number(thickness))))
    : Math.max(2, Math.round(Math.max(base.width, base.height) / 360));
  const inside = new Uint8Array(base.width * base.height);
  for (let i = 0, p = 0; i < inside.length; i++, p += 4) {
    inside[i] = maskData[p] > 128 ? 1 : 0;
  }
  const out = Buffer.from(base.data);
  for (let y = 0; y < base.height; y++) {
    for (let x = 0; x < base.width; x++) {
      const i = y * base.width + x;
      if (!inside[i]) continue;
      const p = i * 4;
      if (strength > 0) {
        const a = (maskData[p] / 255) * strength;
        out[p] = Math.round(out[p] * (1 - a) + r * a);
        out[p + 1] = Math.round(out[p + 1] * (1 - a) + g * a);
        out[p + 2] = Math.round(out[p + 2] * (1 - a) + b * a);
        out[p + 3] = Math.round(out[p + 3] * (1 - a) + 255 * a);
      }
      if (t <= 0) continue;
      let edge = false;
      for (let dy = -t; dy <= t && !edge; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= base.height) {
          edge = true;
          break;
        }
        for (let dx = -t; dx <= t; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= base.width || !inside[yy * base.width + xx]) {
            edge = true;
            break;
          }
        }
      }
      if (edge) {
        out[p] = r;
        out[p + 1] = g;
        out[p + 2] = b;
        out[p + 3] = 255;
      }
    }
  }
  encodePng(dstFile, base.width, base.height, out);
  return { width: base.width, height: base.height };
}

/**
 * Compare two images by their selector shape (alpha or white-on-black mask),
 * not by colour. Used to stop a painted mask from being passed as a donor
 * reference: the chat attachment and the engine mask are different files but
 * describe the same selector.
 */
export function sameMaskShape(aFile, bFile, tolerance = 0.02, samples = 256) {
  const a = decodePng(aFile);
  const b = decodePng(bFile);
  const n = Math.max(32, Math.min(512, Math.round(Number(samples) || 256)));
  const hasAlpha = (img) => {
    for (let p = 3; p < img.data.length; p += 4) if (img.data[p] < 250) return true;
    return false;
  };
  const alphaA = hasAlpha(a);
  const alphaB = hasAlpha(b);
  const selected = (img, alphaMode, x, y) => {
    const p = (y * img.width + x) * 4;
    if (alphaMode) return img.data[p + 3] > 128;
    return img.data[p] > 240 && img.data[p + 1] > 240 && img.data[p + 2] > 240;
  };
  let inter = 0;
  let union = 0;
  for (let i = 0; i < n; i++) {
    const ya = Math.min(a.height - 1, Math.floor(((i + 0.5) * a.height) / n));
    const yb = Math.min(b.height - 1, Math.floor(((i + 0.5) * b.height) / n));
    for (let j = 0; j < n; j++) {
      const xa = Math.min(a.width - 1, Math.floor(((j + 0.5) * a.width) / n));
      const xb = Math.min(b.width - 1, Math.floor(((j + 0.5) * b.width) / n));
      const inA = selected(a, alphaA, xa, ya);
      const inB = selected(b, alphaB, xb, yb);
      if (inA && inB) inter++;
      if (inA || inB) union++;
    }
  }
  if (!union) return false;
  return inter / union >= 1 - Math.max(0, Math.min(0.2, Number(tolerance) || 0));
}

export function compositeMasked(baseFile, patchFile, maskFile, dstFile) {
  const base = decodePng(baseFile);
  const patch = decodePng(patchFile);
  const mask = decodePng(maskFile);
  const patchData = resizeRgba(patch.data, patch.width, patch.height, base.width, base.height);
  const maskData =
    mask.width === base.width && mask.height === base.height
      ? mask.data
      : resizeRgba(mask.data, mask.width, mask.height, base.width, base.height);

  // Soften the mask edge (3x3 box blur) so the blend has no visible step.
  const m = new Float32Array(base.width * base.height);
  for (let i = 0, p = 0; i < m.length; i++, p += 4) m[i] = maskData[p] / 255;
  const soft = new Float32Array(m.length);
  for (let y = 0; y < base.height; y++) {
    for (let x = 0; x < base.width; x++) {
      let sum = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= base.height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= base.width) continue;
          sum += m[yy * base.width + xx];
          n++;
        }
      }
      soft[y * base.width + x] = sum / n;
    }
  }

  const out = Buffer.from(base.data);
  for (let i = 0, p = 0; i < soft.length; i++, p += 4) {
    const a = Math.max(0, Math.min(1, soft[i]));
    if (a <= 0.002) continue;
    out[p] = Math.round(patchData[p] * a + out[p] * (1 - a));
    out[p + 1] = Math.round(patchData[p + 1] * a + out[p + 1] * (1 - a));
    out[p + 2] = Math.round(patchData[p + 2] * a + out[p + 2] * (1 - a));
  }
  encodePng(dstFile, base.width, base.height, out);
  return { width: base.width, height: base.height };
}
export function compositePng(baseFile, patchFile, dstFile, rect) {
  const base = decodePng(baseFile);
  const patch = decodePng(patchFile);
  const [rx, ry, rw, rh] = (rect || []).map((v) => Math.round(Number(v) || 0));
  if (!(rw > 0) || !(rh > 0)) throw new Error('compositePng needs a positive region');
  const patchData = resizeRgba(patch.data, patch.width, patch.height, rw, rh);
  const data = Buffer.from(base.data);
  for (let y = 0; y < rh; y++) {
    const by = ry + y;
    if (by < 0 || by >= base.height) continue;
    for (let x = 0; x < rw; x++) {
      const bx = rx + x;
      if (bx < 0 || bx >= base.width) continue;
      const s = (y * rw + x) * 4;
      const sa = patchData[s + 3] / 255;
      if (sa <= 0) continue;
      const d = (by * base.width + bx) * 4;
      const da = data[d + 3] / 255;
      const oa = sa + da * (1 - sa);
      if (oa <= 0) continue;
      data[d] = Math.round((patchData[s] * sa + data[d] * da * (1 - sa)) / oa);
      data[d + 1] = Math.round((patchData[s + 1] * sa + data[d + 1] * da * (1 - sa)) / oa);
      data[d + 2] = Math.round((patchData[s + 2] * sa + data[d + 2] * da * (1 - sa)) / oa);
      data[d + 3] = Math.round(oa * 255);
    }
  }
  encodePng(dstFile, base.width, base.height, data);
  return { width: base.width, height: base.height, rect: [rx, ry, rw, rh] };
}
