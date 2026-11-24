// Unit test for converting a user-painted PhotoCraft mask layer to the
// full-canvas black/white mask used by sd-cli --mask. No PhotoCraft/GPU needed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  decodePng,
  encodePng,
  layerMask,
  markMaskRegion,
  compositeMasked,
  sameMaskShape,
} from '../service/pngfeather.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egglab-mask-'));
const mask = path.join(dir, 'mask.png');
const out = path.join(dir, 'out.png');
const invert = path.join(dir, 'invert.png');
const alphaMask = path.join(dir, 'alpha.png');
const alphaOut = path.join(dir, 'alpha-out.png');

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

// Opaque black mask with a white 10x8 region at (5,7).
const mw = 40;
const mh = 30;
const md = Buffer.alloc(mw * mh * 4);
for (let i = 3; i < md.length; i += 4) md[i] = 255;
for (let y = 7; y < 15; y++) {
  for (let x = 5; x < 15; x++) {
    const i = (y * mw + x) * 4;
    md[i] = md[i + 1] = md[i + 2] = 255;
  }
}
encodePng(mask, mw, mh, md);

// Place the mask at document (20,10) on a 100x80 canvas layer.
layerMask(mask, out, 100, 80, [20, 10], false);
const o = decodePng(out);
const at = (x, y) => o.data[(y * 100 + x) * 4];
check('mask canvas size', o.width === 100 && o.height === 80);
check('white region lands at bounds', at(27, 19) === 255, String(at(27, 19)));
check('outside stays black', at(0, 0) === 0 && at(60, 50) === 0);
check('output is opaque', o.data[3] === 255);

layerMask(mask, invert, 100, 80, [20, 10], true);
const inv = decodePng(invert);
const iat = (x, y) => inv.data[(y * 100 + x) * 4];
check('invert flips editable area', iat(27, 19) === 0 && iat(20, 10) === 255);

// Transparent layer with a white brush stroke: alpha must select the region.
const aw = 20;
const ah = 20;
const ad = Buffer.alloc(aw * ah * 4);
for (let i = 0; i < ad.length; i += 4) {
  ad[i] = ad[i + 1] = ad[i + 2] = 255;
  ad[i + 3] = 0;
}
for (let y = 2; y < 6; y++) {
  for (let x = 3; x < 9; x++) ad[(y * aw + x) * 4 + 3] = 255;
}
encodePng(alphaMask, aw, ah, ad);
layerMask(alphaMask, alphaOut, 40, 40, [5, 5], false);
const ao = decodePng(alphaOut);
const aat = (x, y) => ao.data[(y * 40 + x) * 4];
check('transparent stroke selected by alpha', aat(9, 8) === 255, String(aat(9, 8)));
check('transparent background kept', aat(0, 0) === 0);

// Full-canvas export (PhotoCraft pads the clipboard copy back to the document).
// It must be cropped at the target layer origin, never shifted a second time.
// Canvas 100x80, target layer at (20,10) sized 60x50; the stroke is already at
// document (25..34, 17..24), i.e. local (5..14, 7..14) of the target.
const canvasMaskPath = path.join(dir, 'canvas-mask.png');
const canvasMaskOut = path.join(dir, 'canvas-mask-out.png');
const cm = Buffer.alloc(100 * 80 * 4);
for (let i = 3; i < cm.length; i += 4) cm[i] = 255;
for (let y = 17; y < 25; y++) {
  for (let x = 25; x < 35; x++) {
    const i = (y * 100 + x) * 4;
    cm[i] = cm[i + 1] = cm[i + 2] = 255;
  }
}
encodePng(canvasMaskPath, 100, 80, cm);
layerMask(canvasMaskPath, canvasMaskOut, 60, 50, [20, 10], false, true);
const cmo = decodePng(canvasMaskOut);
const cmAt = (x, y) => cmo.data[(y * 60 + x) * 4];
check('full-canvas mask keeps document position', cmAt(5, 7) === 255, String(cmAt(5, 7)));
check('full-canvas mask does not double-offset', cmAt(25, 17) === 0, String(cmAt(25, 17)));
check('full-canvas mask outside stroke stays black', cmAt(0, 0) === 0);

// The edit guide Qwen sees: the source with the editable region marked red.
// The guide is a reference only; the B/W mask still composites the result.
const bw = 40;
const bh = 30;
const baseData = Buffer.alloc(bw * bh * 4);
for (let i = 0; i < baseData.length; i += 4) {
  baseData[i] = 10;
  baseData[i + 1] = 120;
  baseData[i + 2] = 30;
  baseData[i + 3] = 255;
}
const baseFile = path.join(dir, 'base.png');
encodePng(baseFile, bw, bh, baseData);
const bwMaskFile = path.join(dir, 'bw-mask.png');
encodePng(bwMaskFile, bw, bh, md);
const guideFile = path.join(dir, 'guide.png');
markMaskRegion(baseFile, bwMaskFile, guideFile, [255, 0, 0], 0.28, 3);
const guide = decodePng(guideFile);
const gAt = (x, y) => [...guide.data.subarray((y * bw + x) * 4, (y * bw + x) * 4 + 4)];
const inside = gAt(10, 10);
const edge = gAt(5, 10);
const outside = gAt(0, 0);
check('guide tints the editable region without hiding it', inside[0] > 60 && inside[0] < 110 && inside[1] > 60 && inside[1] < 110, JSON.stringify(inside));
check('guide draws a red boundary', edge[0] > 240 && edge[1] < 10 && edge[2] < 10, JSON.stringify(edge));
check('guide leaves protected pixels byte-identical', JSON.stringify(outside) === JSON.stringify([10, 120, 30, 255]), JSON.stringify(outside));
check('guide stays opaque', inside[3] === 255);

// Final composite guarantee: the render may only land inside the B/W mask.
const patchData = Buffer.alloc(bw * bh * 4);
for (let i = 0; i < patchData.length; i += 4) {
  patchData[i] = 20;
  patchData[i + 1] = 20;
  patchData[i + 2] = 200;
  patchData[i + 3] = 255;
}
const patchFile = path.join(dir, 'patch.png');
encodePng(patchFile, bw, bh, patchData);
const compositeFile = path.join(dir, 'mask-composite.png');
compositeMasked(baseFile, patchFile, bwMaskFile, compositeFile);
const composite = decodePng(compositeFile);
const cAt = (x, y) => [...composite.data.subarray((y * bw + x) * 4, (y * bw + x) * 4 + 4)];
check('composite takes the render inside the mask', JSON.stringify(cAt(10, 10)) === JSON.stringify([20, 20, 200, 255]), JSON.stringify(cAt(10, 10)));
check('composite preserves pixels outside the mask', JSON.stringify(cAt(0, 0)) === JSON.stringify([10, 120, 30, 255]), JSON.stringify(cAt(0, 0)));

// A mask attachment is often an alpha cut-out while the engine selector is
// black/white. The guard must compare the selector shape, not the colour.
const alphaSameFile = path.join(dir, 'alpha-same.png');
const alphaOtherFile = path.join(dir, 'alpha-other.png');
const sameData = Buffer.alloc(bw * bh * 4);
const otherData = Buffer.alloc(bw * bh * 4);
for (let y = 0; y < bh; y++) {
  for (let x = 0; x < bw; x++) {
    const i = (y * bw + x) * 4;
    sameData[i] = sameData[i + 1] = sameData[i + 2] = 255;
    otherData[i] = otherData[i + 1] = otherData[i + 2] = 255;
    sameData[i + 3] = otherData[i + 3] = 0;
    if (x >= 5 && x < 15 && y >= 7 && y < 15) sameData[i + 3] = 255;
    if (x >= 20 && x < 25 && y >= 10 && y < 15) otherData[i + 3] = 255;
  }
}
encodePng(alphaSameFile, bw, bh, sameData);
encodePng(alphaOtherFile, bw, bh, otherData);
check('selector-shape guard matches B/W and alpha copies', sameMaskShape(bwMaskFile, alphaSameFile));
check('selector-shape guard rejects a different mask', !sameMaskShape(bwMaskFile, alphaOtherFile));

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${failures ? 'FAILED' : 'OK'} — ${failures} failure(s)`);
process.exit(failures ? 1 : 0);
