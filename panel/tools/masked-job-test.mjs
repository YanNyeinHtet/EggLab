// Unit test for the painted-mask edit pipeline (service/maskedjob.mjs). No GPU,
// no PhotoCraft: synthetic PNGs stand in for the layer, the mask and the render.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decodePng, encodePng } from '../service/pngfeather.mjs';
import {
  normalizeMask,
  prepareMaskedEdit,
  composeMaskedPrompt,
  referenceMapClause,
  finishMaskedEdit,
  verifyMaskedEdit,
  isOpaque,
} from '../service/maskedjob.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egglab-masked-'));
let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};
const W = 64;
const H = 48;
const px = (img, x, y) => [...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)];
const expectThrow = (fn, needle) => {
  try {
    fn();
    return { threw: false, message: '' };
  } catch (err) {
    return { threw: true, message: err.message, ok: String(err.message).includes(needle) };
  }
};

// Source: smooth gradient, fully opaque.
const source = path.join(dir, 'source.png');
const srcData = Buffer.alloc(W * H * 4);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    srcData[i] = 40 + x;
    srcData[i + 1] = 90 + y;
    srcData[i + 2] = 120;
    srcData[i + 3] = 255;
  }
}
encodePng(source, W, H, srcData);

// Opaque B/W mask: white rectangle at (10..29, 8..25).
const mask = path.join(dir, 'mask.png');
const maskData = Buffer.alloc(W * H * 4);
for (let i = 0; i < W * H; i++) {
  const v = 0;
  maskData[i * 4] = maskData[i * 4 + 1] = maskData[i * 4 + 2] = v;
  maskData[i * 4 + 3] = 255;
}
for (let y = 8; y < 26; y++) {
  for (let x = 10; x < 30; x++) {
    const i = (y * W + x) * 4;
    maskData[i] = maskData[i + 1] = maskData[i + 2] = 255;
  }
}
encodePng(mask, W, H, maskData);

// 1) Preparation: guide marks the area and leaves the rest of the source intact.
const prep = prepareMaskedEdit({ initImg: source, mask, donors: [], tmpDir: dir, tag: 'a' });
const guide = decodePng(prep.guideFile);
const src = decodePng(source);
const inside = px(guide, 20, 16);
const srcInside = px(src, 20, 16);
check('guide tints the marked area toward red', inside[0] > srcInside[0] + 40 && inside[1] < srcInside[1], `${JSON.stringify(inside)} vs ${JSON.stringify(srcInside)}`);
check('guide draws a visible boundary', px(guide, 10, 16)[0] > 240 && px(guide, 10, 16)[1] < 20);
check('guide leaves unmarked pixels byte-identical', JSON.stringify(px(guide, 2, 2)) === JSON.stringify(px(src, 2, 2)));
check('prepared selector is opaque', isOpaque(prep.maskFile));
check('prepared ratio matches the rectangle', Math.abs(prep.ratio - (20 * 18) / (W * H)) < 0.001, prep.ratio.toFixed(4));

// 2) Guards that stop a bad render before any GPU work.
const sizeBad = path.join(dir, 'mask-small.png');
encodePng(sizeBad, 32, 24, Buffer.alloc(32 * 24 * 4, 255));
const mismatch = expectThrow(() => prepareMaskedEdit({ initImg: source, mask: sizeBad, donors: [], tmpDir: dir, tag: 'b' }), 'Mask is 32x24');
check('size mismatch is refused', mismatch.threw && mismatch.ok, mismatch.message);

const allWhite = path.join(dir, 'mask-white.png');
encodePng(allWhite, W, H, Buffer.alloc(W * H * 4, 255));
const white = expectThrow(() => prepareMaskedEdit({ initImg: source, mask: allWhite, donors: [], tmpDir: dir, tag: 'c' }), 'covers essentially the whole canvas');
check('all-white mask is refused', white.threw && white.ok, white.message);

const empty = path.join(dir, 'mask-empty.png');
const emptyData = Buffer.alloc(W * H * 4, 0);
for (let i = 3; i < emptyData.length; i += 4) emptyData[i] = 255;
encodePng(empty, W, H, emptyData);
const none = expectThrow(() => prepareMaskedEdit({ initImg: source, mask: empty, donors: [], tmpDir: dir, tag: 'd' }), 'selects no pixels');
check('empty mask is refused', none.threw && none.ok, none.message);

const selfDonor = expectThrow(() => prepareMaskedEdit({ initImg: source, mask, donors: [mask], tmpDir: dir, tag: 'e' }), 'listed as a reference');
check('the mask file cannot be a donor', selfDonor.threw && selfDonor.ok, selfDonor.message);

// The same shape in a different colour is still the mask in disguise (the brush
// export of the same stroke), so it must be refused as a donor.
const disguised = path.join(dir, 'brush-copy.png');
const disguisedData = Buffer.alloc(W * H * 4);
for (let i = 0; i < W * H; i++) {
  disguisedData[i * 4] = 200;
  disguisedData[i * 4 + 1] = 30;
  disguisedData[i * 4 + 2] = 30;
  disguisedData[i * 4 + 3] = 255;
}
for (let y = 8; y < 26; y++) {
  for (let x = 10; x < 30; x++) {
    const i = (y * W + x) * 4;
    disguisedData[i] = 255;
    disguisedData[i + 1] = 255;
    disguisedData[i + 2] = 255;
  }
}
encodePng(disguised, W, H, disguisedData);
const copy = expectThrow(() => prepareMaskedEdit({ initImg: source, mask, donors: [disguised], tmpDir: dir, tag: 'f' }), 'same shape');
check('a same-shape copy of the mask is refused as a donor', copy.threw && copy.ok, copy.message);

// A real donor (a different picture) is kept and gets its own tag.
const donor = path.join(dir, 'donor.png');
const donorData = Buffer.alloc(W * H * 4, 90);
for (let i = 3; i < donorData.length; i += 4) donorData[i] = 255;
encodePng(donor, W, H, donorData);
const withDonor = prepareMaskedEdit({ initImg: source, mask, donors: [donor], tmpDir: dir, tag: 'g' });
check('an ordinary donor is kept', withDonor.donors.length === 1 && withDonor.donors[0] === donor);

// 3) Prompt tags: the guide is the last reference, after any donors.
const p0 = composeMaskedPrompt('Remove the text in the marked area.', 0);
check('no donors: guide is <image2>', p0.includes('<image2> is the same canvas') && !p0.includes('<image3>'));
const p1 = composeMaskedPrompt('Add a hat in the marked area.', 1);
check('one donor: guide is <image3>', p1.includes('<image3> is the same canvas') && p1.includes('keep <image1>'));
check('one donor: the donor is named too', p1.includes('<image2> is the donor reference'));
const p1r = composeMaskedPrompt('Add a hat in the marked area.', 1, ['clothing_donor']);
check('a donor role names the reference', p1r.includes('<image2> supplies the clothing reference only'));
const p1t = composeMaskedPrompt('Add the hat from <image2> in the marked area.', 1);
check('an already tagged donor is not repeated', !p1t.includes('<image2> is the donor reference'));
check('the prompt never says mask or selection', !/mask|selection/i.test(p0 + p1 + p1r));

// The reference-edit map names only donors the prompt left untagged.
const rm = referenceMapClause([null, 'canvas', 'clothing_donor'], 2, 'Put the dress from the reference on the man.');
check('reference map names an untagged donor', rm.includes('<image2> supplies the clothing reference only'));
const rm2 = referenceMapClause([null, 'canvas', 'clothing_donor'], 2, 'Put the dress from <image2> on the man.');
check('reference map skips a tagged donor', rm2 === '');

// 4) Alpha-only selector (a cut-out brush layer) is read from its alpha.
const alphaSel = path.join(dir, 'alpha-sel.png');
const alphaData = Buffer.alloc(W * H * 4, 0);
for (let y = 8; y < 26; y++) {
  for (let x = 10; x < 30; x++) alphaData[(y * W + x) * 4 + 3] = 255;
}
encodePng(alphaSel, W, H, alphaData);
const alphaOut = path.join(dir, 'alpha-norm.png');
const alphaNorm = normalizeMask(alphaSel, alphaOut);
check('alpha selector normalizes to its painted area', Math.abs(alphaNorm.ratio - (20 * 18) / (W * H)) < 0.001, alphaNorm.ratio.toFixed(4));

// 5) Finish: the render is delivered only inside the selector.
const raw = path.join(dir, 'raw.png');
const rawData = Buffer.alloc(W * H * 4);
for (let i = 0; i < W * H; i++) {
  rawData[i * 4] = 10;
  rawData[i * 4 + 1] = 200;
  rawData[i * 4 + 2] = 10;
  rawData[i * 4 + 3] = 255;
}
encodePng(raw, W, H, rawData);
const out = path.join(dir, 'final.png');
const fin = finishMaskedEdit({ initImg: source, maskFile: prep.maskFile, rawOut: raw, dstFile: out });
const finImg = decodePng(out);
check('composite takes the render inside the selector', JSON.stringify(px(finImg, 20, 16).slice(0, 3)) === JSON.stringify([10, 200, 10]), JSON.stringify(px(finImg, 20, 16)));
check('composite keeps the source byte-identical outside', JSON.stringify(px(finImg, 2, 2)) === JSON.stringify(px(src, 2, 2)));
check('verify: no pixel outside the mark changed', fin.verify.outsideChangedPx === 0, `${fin.verify.outsideChangedPx}`);
check('verify: the marked area changed measurably', fin.verify.insideChangedPct > 50, `${fin.verify.insideChangedPct}%`);
check('verify passes with no warnings', fin.verify.ok && fin.verify.warnings.length === 0, JSON.stringify(fin.verify.warnings));
check('finished result is opaque', fin.opaque === true);

// 6) A render that did not change the area must be reported, not delivered as done.
const same = path.join(dir, 'same.png');
const sameVerify = verifyMaskedEdit(source, source, prep.maskFile);
check('an unchanged render is flagged', !sameVerify.ok && sameVerify.warnings.some((w) => w.includes('may not have taken effect')), sameVerify.warnings[0] || '');
void same;

// 7) Outside changes are caught by the verifier (defence in depth).
const leaked = path.join(dir, 'leaked.png');
const leakedData = Buffer.from(srcData);
const far = (2 * W + 2) * 4;
leakedData[far] = 255;
encodePng(leaked, W, H, leakedData);
const leakVerify = verifyMaskedEdit(source, leaked, prep.maskFile);
check('a change far outside the mark is reported', leakVerify.outsideChangedPx === 1 && !leakVerify.ok, `${leakVerify.outsideChangedPx}px`);

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${failures ? 'FAILED' : 'OK'} — ${failures} failure(s)`);
process.exit(failures ? 1 : 0);
