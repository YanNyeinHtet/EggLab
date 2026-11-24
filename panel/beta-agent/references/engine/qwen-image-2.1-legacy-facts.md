# Qwen-Image-2.1 engine profile — verified against the live EggLab runtime

This replaces the old legacy guesswork with facts measured on the actual EggLab
engine (stable-diffusion.cpp build, Qwen-Image-2.1 GGUF + Qwen3-VL text encoder
+ 2.1 VAE + community Turbo LoRA). Cross-checked against the official
`QwenLM/Qwen-Image-2.1` model card (Sep 2026) and `stable-diffusion.cpp` docs.
Still verify live state with `egl_status` before model-sensitive work.

## What this model is
- **Unified model**: one checkpoint does text-to-image AND reference editing.
  Editing is native, not a bolt-on. Text encoder: Qwen3-VL-8B (sees reference
  images directly — visual instructions in the image are first-class inputs).
- **Native local editing (official capability)**: the model was trained to
  follow **circles, painted annotations and separate masks drawn ON the image**
  as region selectors. Showcased officially: circle-guided multi-region editing
  (remove watch, change hair, replace clothing in one pass).
- Up to 10 reference images; `<image1>`'s framing/aspect survives by default.
- Native RGBA transparency, decided by the prompt (see Transparency below).

## Verified local-edit paths (measured on this engine, 768×512 Turbo)

### Path 1 — drawn circle/marks on the photo (BEST for most local edits)
Send the marked photo as a normal reference edit. No mask, no init, no
strength tuning. Measured result: replaced the object inside a drawn red ring
exactly, removed the ring completely, left everything outside untouched.

Prompt shape that works (measured):
`Inside the red circle, replace the <object> with <detailed result description>
matching the lighting. Keep <the rest> exactly the same. Remove the red circle
from the image and keep everything outside the circle unchanged.`
- Name each mark's color/shape and its target; multi-mark maps are supported.
- Official ComfyUI guidance: naming the mark's colour in the prompt points the edit at that region ("change the jacket in the red area"). Keep the mark inside the area you want changed. EggLab's panel marks masked areas this way; the prompt says "the marked area" and the panel supplies the colour.
- This is the FIRST choice for "circle / drawn area" requests.

### Path 2 — painted mask (NOT init image + mask + strength)
Do not use `--init-img` + `--mask` + `--strength` for Qwen-Image-2.1. Measured on
this engine: the engine's denoise mask re-noised the masked area with no target
instruction and refilled it with the surrounding fabric. The strength table that
used to live here came from that broken path and is retired.
Painted masks go through `egl_photocraft_edit_active` (`mask_layer`) or `egl_edit`
(`init_image` + `mask_image`). The panel marks the area on a copy of the source
(Path 1 method), Qwen edits that copy, and the render is composited back through
the B/W selector, so pixels outside the mark stay unchanged. See
`references/reference-editing/local-edit-and-seam-control.md`, "Masked edits".

### Path 3 — region crop edit (rectangle)
Edits a tight crop and feathers it back. Use only for subjects that carry
their own context (an isolated product on a plain surface). A tight crop of a
flat or contextual area makes the model guess the surroundings — prefer Path 1
or Path 2. If you do crop, EXPAND the rectangle well beyond the object so the
model keeps context, and let the feather band do the blending.

## Prompt style for edits (official guidance)
- The official prompt-rewriter for edits produces **long, detailed, imperative
  prompts** that name the change, describe the resulting state concretely, and
  reference `<image1>`/`<image2>` roles. Short one-liners underperform.
- Be generous about the TARGET of the change (what it should look like
  afterwards, materials, lighting integration); keep preserved content named by
  role, not described in detail.
- Edit output inherits `<image1>`'s aspect by default; say otherwise explicitly.

## Sketch input (verified official pattern)
Sketch → photo is a trained behavior. The official example turns a yacht line
sketch into a photorealistic render by **translating the sketch structure into
words exhaustively** ("Build the vessel with the structure shown in the input
sketch: a long low hull; one tall mast stepped forward; … one small square
window at the bow, an upper line of five round portholes…"). Do that:
enumerate every structural element the sketch shows (hull/body shape, counts,
openings, placements, camera angle), then describe materials, lighting and
photorealism. Inspect against the sketch and fix named mismatches.

## Attached mask images (chat attachments)
A mask attachment is a selector, never an image: do not pass it in `images` or
`reference_images`. Call `egl_edit` with `init_image` (the photo) and `mask_image`
(the mask). The panel handles it exactly like a PhotoCraft `mask_layer`: marked
copy, Qwen edit, composite through the mask. `strength` does not apply.

## Drawn descriptions (annotated photos)
Circles, sketched areas and handwritten notes on an attached photo are the
instructions (the model is trained on annotation-guided local editing). Send
the marked photo whole, name each mark's target and result, say the marks are
removed, and protect the unmarked areas. Donors (a hat, a garment) go in as
`<image2>`+ with an explicit role and the mark names WHERE they apply.

## Engine facts and limits
- Steps/CFG: panel presets are quality 40 steps @ CFG 1.0, turbo 8 steps @ 1.0
  (Turbo = fixed 8-sigma schedule, `--sigmas qwen-image-2.1-turbo`). The
  official ComfyUI edit template also uses CFG 1 — do not hand-tune CFG.
- **Seed rule (verified upstream bug)**: reusing the exact seed that generated
  a reference image reproduces its starting noise → oversaturated/over-sharpened
  edits ("noise replay"). EggLab forces a fresh seed on every edit; never pass a
  fixed seed equal to the source's seed into an edit.
- Resolutions are multiples of 32. Periodic 8px/4px grid artifacts have been
  reported at native 2K sizes on this engine — for critical work prefer ≤1536
  long side or inspect for grid patterns before shipping.
- RGBA prompt format (official, applies to edits too): "This is an RGBA image
  with transparency. <description>. The image has alpha channel and the
  background is transparent." Alpha survives only in PNG/WebP output.
- Edits need vision weights (`--llm_vision` mmproj) and the q8_0 prefix cache
  on 8 GB VRAM; the panel wires both automatically.
