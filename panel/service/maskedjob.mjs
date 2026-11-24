// Painted-mask edits for Qwen-Image-2.1.
//
// Qwen-Image-2.1 is an instruction-edit model. The engine's --init-img/--mask
// path does not inpaint with it (measured: the masked area was refilled with the
// surrounding fabric), so a mask never reaches the engine as a mask. It is used
// the way the model was trained for: the editable area is marked on a copy of
// the source (official ComfyUI method: paint the region, name the colour in the
// prompt), the model edits that copy, and the render is composited back through
// the B/W selector so pixels outside the mark stay exactly as they were.
import fs from 'node:fs';
import path from 'node:path';
import {
  decodePng,
  encodePng,
  markMaskRegion,
  compositeMasked,
  sameMaskShape,
} from './pngfeather.mjs';

export const MARK_COLOR = [255, 0, 0];
export const MARK_TINT = 0.28;
export const MARK_OUTLINE = 3;
const CHANGE_THRESHOLD = 8;
const MIN_INSIDE_CHANGE_PCT = 0.5;
const BLEND_RADIUS = 2;

export function pngHeaderSize(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(24);
    const n = fs.readSync(fd, buf, 0, 24, 0);
    if (n < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  } finally {
    fs.closeSync(fd);
  }
}

// One opaque grey selector: white = edit, black = keep. An alpha-only selector
// (a cut-out painted layer) contributes its alpha. Soft edges are kept.
export function normalizeMask(maskFile, dstFile) {
  const m = decodePng(maskFile);
  const n = m.width * m.height;
  let alphaOnly = false;
  for (let p = 3; p < m.data.length; p += 4) {
    if (m.data[p] < 250) {
      alphaOnly = true;
      break;
    }
  }
  const out = Buffer.alloc(n * 4);
  let selected = 0;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const v = alphaOnly ? m.data[p + 3] : m.data[p];
    out[p] = out[p + 1] = out[p + 2] = v;
    out[p + 3] = 255;
    if (v > 127) selected++;
  }
  if (!selected) {
    throw new Error(
      'The painted mask selects no pixels. Paint the area to change on the mask layer, then retry.',
    );
  }
  encodePng(dstFile, m.width, m.height, out);
  return { file: dstFile, width: m.width, height: m.height, selected, ratio: selected / n };
}

// Everything the engine needs for a masked edit, validated before any GPU work.
// The mask is never returned as a donor: the caller's donors are checked against
// the selector shape and rejected if they are the mask in disguise.
export function prepareMaskedEdit({ initImg, mask, donors = [], tmpDir, tag }) {
  const src = pngHeaderSize(initImg);
  const msz = pngHeaderSize(mask);
  if (!src || !msz) throw new Error('The source and the mask must both be PNG files.');
  if (src.width !== msz.width || src.height !== msz.height) {
    throw new Error(
      `Mask is ${msz.width}x${msz.height} but the source is ${src.width}x${src.height}. ` +
        'A mask must share the source canvas: export it full-canvas on the same layer.',
    );
  }
  const maskFile = path.join(tmpDir, `${tag}-selector.png`);
  const norm = normalizeMask(mask, maskFile);
  if (norm.ratio > 0.98) {
    throw new Error(
      'The mask covers essentially the whole canvas (all-white). That is a failed mask build, not an edit region. ' +
        'Repaint the area to change, or use region mode for a full-frame edit.',
    );
  }
  const abs = (p) => path.resolve(String(p)).toLowerCase();
  for (const d of donors) {
    if (abs(d) === abs(initImg) || abs(d) === abs(mask)) {
      throw new Error('A mask or the source is listed as a reference. The source is the canvas and a mask is a selector; remove it from the references.');
    }
    if (sameMaskShape(d, maskFile)) {
      throw new Error(
        'A reference image has the same shape as the painted mask. A mask is never a donor: remove it from the references and pass it only as the mask.',
      );
    }
  }
  const guideFile = path.join(tmpDir, `${tag}-guide.png`);
  markMaskRegion(initImg, maskFile, guideFile, MARK_COLOR, MARK_TINT, MARK_OUTLINE);
  return { maskFile, guideFile, donors: donors.slice(), ratio: norm.ratio };
}

// <image1> is the canvas; the marked copy is the last reference, after any donors.
export function maskedPromptClause(donorCount) {
  const k = donorCount + 2;
  return (
    `<image1> is the source canvas. <image${k}> is the same canvas with the edit area marked by a light red tint and outline. ` +
    `Apply the requested change only inside that marked area of <image${k}>, and keep <image1> exactly unchanged everywhere outside it. ` +
    'The red tint and outline are location guides only and must not appear in the result.'
  );
}

export function composeMaskedPrompt(prompt, donorCount) {
  return `${String(prompt || '').trim()}\n\n${maskedPromptClause(donorCount)}`;
}

export function isOpaque(file) {
  const img = decodePng(file);
  for (let p = 3; p < img.data.length; p += 4) {
    if (img.data[p] < 250) return false;
  }
  return true;
}

// Measured, not claimed: pixels outside the mark (beyond the blend band) must be
// byte-identical to the source, and the marked area must visibly change.
export function verifyMaskedEdit(baseFile, outFile, maskFile) {
  const base = decodePng(baseFile);
  const out = decodePng(outFile);
  const mask = decodePng(maskFile);
  const W = base.width;
  const H = base.height;
  if (out.width !== W || out.height !== H) throw new Error('Verify: the render and the source differ in size.');
  const sel = new Uint8Array(W * H);
  for (let i = 0, p = 0; i < W * H; i++, p += 4) sel[i] = mask.data[p] > 127 ? 1 : 0;

  let inside = 0;
  let insideChanged = 0;
  let insideDiffSum = 0;
  let outside = 0;
  let outsideChanged = 0;
  let outsideMax = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const p = i * 4;
      let d = 0;
      for (let c = 0; c < 3; c++) {
        const v = Math.abs(out.data[p + c] - base.data[p + c]);
        if (v > d) d = v;
      }
      if (sel[i]) {
        inside++;
        insideDiffSum += d;
        if (d > CHANGE_THRESHOLD) insideChanged++;
        continue;
      }
      let near = false;
      for (let dy = -BLEND_RADIUS; dy <= BLEND_RADIUS && !near; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= H) continue;
        for (let dx = -BLEND_RADIUS; dx <= BLEND_RADIUS; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= W) continue;
          if (sel[yy * W + xx]) {
            near = true;
            break;
          }
        }
      }
      if (near) continue;
      outside++;
      if (d > 0) {
        outsideChanged++;
        if (d > outsideMax) outsideMax = d;
      }
    }
  }
  const insideChangedPct = inside ? Math.round((insideChanged / inside) * 10000) / 100 : 0;
  const warnings = [];
  if (!inside) warnings.push('The mask selects no pixels.');
  if (outsideChanged > 0) {
    warnings.push(`${outsideChanged} pixels outside the mark changed; the composite should not allow this. Inspect the output.`);
  }
  if (inside && insideChangedPct < MIN_INSIDE_CHANGE_PCT) {
    warnings.push(
      `Only ${insideChangedPct}% of the marked area changed. The edit may not have taken effect; change the prompt before reporting success.`,
    );
  }
  return {
    insideChangedPct,
    insideMeanDiff: inside ? Math.round((insideDiffSum / inside) * 100) / 100 : 0,
    outsideChangedPx: outsideChanged,
    outsideMaxDiff: outsideMax,
    outsidePx: outside,
    ok: outsideChanged === 0 && (!inside || insideChangedPct >= MIN_INSIDE_CHANGE_PCT),
    warnings,
  };
}

// The render is only delivered through the selector. Returns the composite path,
// the measured verification and whether the result covers the whole layer.
export function finishMaskedEdit({ initImg, maskFile, rawOut, dstFile }) {
  compositeMasked(initImg, rawOut, maskFile, dstFile);
  return {
    outPath: dstFile,
    verify: verifyMaskedEdit(initImg, dstFile, maskFile),
    opaque: isOpaque(dstFile),
  };
}
