---
name: reference-editing
description: Edit existing images with Qwen-Image-2.1 using direct instructions, multiple references, native masks, circle/paint annotations, or sketch guidance. Preserve source identity and composition, control scope, and verify results.
---

# Reference Editing

Qwen-Image-2.1 is a unified image-generation and image-editing model. This skill handles jobs where an existing image, layer, marked source, mask, sketch, or reference set is being transformed. Think **“change this source”**, not “write a new text-to-image description.”

Use `egl_edit` for edits to supplied image inputs and `egl_photocraft_edit_active` for the documented active-layer/native-mask operation. Do not route an existing-source edit through `egl_generate` unless the task has been reclassified by the router as a new-image/design job and the selected generation workflow supports the required references.

The Qwen model supports instruction editing, multiple references, local edits guided by circles or painted annotations, separate masks, and transparent-image workflows. Those model capabilities do not automatically mean every combination is exposed by the current EggLab wrapper. **The live EggLab tool schema and runtime are authoritative. Never silently omit, reorder, or reinterpret an input to make an unsupported combination appear to work.**

## 1. Classify the edit method

Choose the narrowest method that matches the user's input. The router defines the high-level path; this skill defines the procedure.

| Method | User input | Meaning | Primary tool path |
|---|---|---|---|
| `direct` | One source image + instruction | Transform the source without donor images or a separate selector | `egl_edit` |
| `multi_reference` | Source + one or more donor images | Transfer specific content or attributes from named references into the source | `egl_edit` with ordered `images` |
| `native_mask` | Painted mask layer in PhotoCraft, or a separate mask file | The mask is a special region selector, not a visual donor | PhotoCraft: `egl_photocraft_edit_active` with `mask_layer`; attachment: `egl_edit` with `init_image` + `mask_image` + `strength` |
| `circle_annotation` | Source with coloured circles or other marks | Marks visually identify existing objects/regions and map to instructions | Build/inspect the marked preview, then `egl_edit` |
| `paint_annotation` | Source with painted strokes or filled marks | Painted marks identify where a change should occur | Build/inspect the marked preview, then `egl_edit` |
| `sketch_guided` | Existing source plus sketch, or a sketch used to guide a new render | Sketch supplies structure, silhouette, camera or composition guidance | `egl_edit` with explicit image roles |
| `transparent_edit` | Existing image requiring subject extraction or alpha-aware change | Preserve/create transparency as part of the edit | Load `transparency/SKILL.md` and use the supported `egl_edit` path |

Do not collapse these methods into one generic “inpainting” workflow. In particular, a **native engine mask** and a **visual annotation painted onto the image** are different input types with different preprocessing and prompt rules.

## 2. Inspect and assign input roles

Before composing the prompt:

1. Inventory every image supplied by the user and every relevant PhotoCraft layer.
2. When the task concerns a PhotoCraft document, call `egl_photocraft_layers` and identify the correct source/canvas layer, any annotation layer, and any separate mask layer. Do not infer the active layer from its name alone.
3. Assign every image one primary role. Record the order and exact path in `egl_job_state`.
4. For ordinary multi-reference editing, `image_1` is the source canvas. Donors follow in order as `image_2`, `image_3`, etc.
5. For a mask workflow, the mask is a special `mask_image`/`mask_layer` input. Do not insert it into the ordinary donor list or count it as an ordinary donor unless a future, explicitly documented EggLab workflow says otherwise.
6. For an annotation workflow, the marked preview is the source canvas (`image_1`). Additional donor images follow it.
7. If two inputs have genuinely ambiguous roles and choosing incorrectly would materially change the result, ask one focused question. Otherwise state the interpretation and proceed.

### Standard reference roles

Use the most specific role that fits. A role describes what the image contributes; it does not grant permission to copy unrelated attributes.

- `canvas` — source whose framing, composition and scene are being edited.
- `identity` — person/character likeness to preserve or transfer.
- `product` — product design, silhouette, components, labels and branding.
- `object_donor` — a specific object to add or replace with.
- `clothing_donor` — garment, footwear or accessory to transfer.
- `pose` — body position or gesture guidance.
- `material` — a surface finish, texture or material property only.
- `lighting` — lighting direction, softness, colour or atmosphere only.
- `style` — visual treatment, not necessarily geometry or content.
- `environment` — setting or background elements.
- `layout` — arrangement/composition guidance.
- `sketch` — structural guidance.
- `annotation` — a marked visual instruction image; not a donor.
- `mask` — a special region selector; not a donor.

Do not send every reference as a generic “style reference.” State precisely what each donor contributes and what it must not contribute.

## 3. Prompt construction for Qwen edits

Write an imperative instruction. Be specific about the requested change, not verbose about everything already visible.

Use this structure when it helps:

1. **Action** — replace, remove, add, recolour, restyle, relight, restore, or modify.
2. **Target** — identify the object/person/feature precisely, using the correct image tag or annotation reference.
3. **Result state** — describe what the changed content should look like: shape, material, colour, texture, details and desired final condition.
4. **Integration** — explain scale, perspective, contact, occlusion, lighting and shadows where relevant.
5. **Preservation** — one concise clause naming the important untargeted content by type/position/role.
6. **Exact content** — quote required text exactly and preserve names, numbers, marks and branding.

A useful prompt contains enough detail to resolve the requested transformation. Do not make it long just for length. Avoid detailed descriptions of untouched content: those details can cause the model to redraw it. Keep the preservation clause focused on what matters to this edit.

### Multi-image prompt tags

When more than one ordinary image is sent, explicitly identify each image using its tag. Do not assume the model will infer the roles from upload order alone.

Example:

```text
Replace the jacket on the person in <image1> with the jacket shown in <image2>.
Use the cut, collar, fabric, colour and visible design details from <image2>.
Fit the garment naturally to the person's original body position and lighting.
Preserve the person's identity, face, hair, pose, body proportions and the original scene.
Do not copy the background or the model from <image2>.
```

For multiple donors, give each one a distinct role:

```text
<image1> is the source photograph and its composition is the one to preserve.
<image2> supplies the handbag design only.
<image3> supplies the shoe design only.
Add the handbag from <image2> and the shoes from <image3> to the person in <image1>.
Match their scale, perspective, contact and lighting. Do not copy the people or background from the donor images.
Preserve the person's identity, pose and the source scene.
```

If two references conflict, resolve the conflict before rendering. If the user's intent makes the priority clear, state the interpretation and proceed; otherwise ask one focused question.

### Prompt rules shared by all methods

- Lead with the requested operation, not a generic description such as “A beautiful photograph of…”.
- For an edit, treat `image_1` as the source composition unless the live workflow explicitly defines a different role.
- Mention each ordinary donor with its correct `<imageN>` tag.
- Point to an identity/product image instead of trying to recreate its likeness or design from a long text description.
- Preserve only the features that matter; do not repeat a complete description of the source image.
- State exact text in quotation marks. Do not paraphrase legal copy, labels, product names, numbers or user-provided wording.
- Do not put output dimensions or aspect ratio in the prompt unless the user explicitly asks for a composition/size change and the tool supports it. Ordinary edits should follow the source canvas unless the runtime says otherwise.
- Do not claim pixel-perfect preservation from a generative edit. Verify the result and use the native mask/compositing path when strict region control is required.

## 4. Direct instruction edit

Use `direct` when the user gives one source image and a text instruction, with no separate mask, drawn annotation or donor image.

1. Confirm which image is the source.
2. Inspect it if the target is ambiguous or if important details must be identified accurately.
3. Write an imperative prompt naming the precise target and desired result.
4. Include one preservation clause for the important identity, pose, framing, product geometry or scene elements.
5. Call `egl_edit` with the source image in the first image position using the live schema.
6. Inspect the returned image with `egl_inspect` and evaluate the requested change and collateral drift.

Do not use `egl_generate` for this operation. If the requested change is too broad to count as an edit (for example, a new scene with no composition to preserve), return to the router and reclassify the job.

## 5. Multi-reference editing

Use `multi_reference` when the source image must receive content or attributes from other images.

### Image order and model capacity

- `image_1` is the source canvas whose composition is being edited.
- `image_2` onward are donor/reference images in the exact order recorded in the job state.
- The Qwen-Image-2.1 model documentation specifies support for up to 10 reference images. Some workflow encoders expose more slots, but that does not prove the model or EggLab runtime supports that many. Treat **10 as the upstream documented ceiling**, not a promise that every EggLab configuration can process 10.
- The effective EggLab limit is the lowest of the model-supported limit, the live tool schema, the active engine/backend and the available memory. Check the current runtime and tool schema before a large reference set. Prefer a small set of highly relevant images over a large set of weakly related images.
- Do not count a special `mask_image` or `mask_layer` as an ordinary donor slot unless the live API explicitly defines it that way.

### Donor discipline

For every donor, state:

- what feature it contributes;
- which source object/person receives that feature;
- which donor features must not transfer (for example, background, pose, face, camera or unrelated accessories).

Examples:

- Virtual try-on: person canvas + garment donor(s). Transfer garment construction and appearance, not the donor model or background.
- Product placement: scene canvas + product donor. Preserve the product's silhouette, components, labels and markings unless redesign is requested.
- Material transfer: object canvas + material donor. Transfer surface finish, not shape.
- Lighting transfer: subject canvas + lighting reference. Transfer light direction, softness and colour, not geometry or identity.
- Group portrait: scene canvas + identity donor(s). State the intended left-to-right person mapping; do not leave identity assignment implicit.
- Interior edit: room canvas + furniture/material donors. State the intended placement and the attributes each donor supplies.

If the user requests source + mask + donors, check that the live `egl_edit` schema and handler can send the special mask input and ordinary reference images in the same call. If they cannot, do not drop the donors or convert the mask into a donor. Explain the actual limitation and offer a supported alternative, such as a two-stage operation or a PhotoCraft workflow, only when the alternative is genuinely supported.

## 6. Native mask editing

Use `native_mask` when a separate painted mask defines the editable region. A native mask is a **special selector input**, not a visual donor and not a prompt reference.

There are two supported entry paths in the current EggLab workflow:

### A. PhotoCraft mask layer

1. Call `egl_photocraft_layers` and identify the exact source layer and mask-layer name.
2. Keep the original source layer as the active edit canvas. Do not make the mask layer the source image.
3. Call `egl_photocraft_edit_active` with the exact `mask_layer` name. Use `mask_invert` only when the actual mask convention is inverted.
4. The panel's native-mask path exports and aligns the mask to the canvas and uses the engine mask input. Do not also send that mask as a donor image.
5. The tool result reports `maskLayer: "EggLab mask (B/W)"` — the canonical black/white mask it actually used (converted from the painted layer). For any follow-up edit on the same region, pass that name as `mask_layer` so the existing B/W mask is reused instead of rebuilt.
5. Preserve the original layer as a backup and inspect the rendered result and boundary.

### B. Separate mask attachment

1. Identify which attachment is the original source and which is the mask.
2. Confirm the mask corresponds to the source dimensions/aspect and is a valid mask image. If the dimensions do not match, use a supported PhotoCraft full-canvas mask export/alignment workflow; do not silently stretch or guess.
3. Use the `egl_edit` special mask inputs (`init_image`, `mask_image`, and `strength`) only if those fields are present in the live schema. The original goes to `init_image`; the mask goes to `mask_image`.
4. Do not put the mask into the ordinary `images` donor array.
5. If the user also supplied donor references, confirm the live tool supports the combination of `init_image` + `mask_image` + references. If it does not, stop and state the limitation instead of silently dropping any input.

### Mask convention and source integrity

- Default EggLab convention: **white/opaque = editable; black/transparent = protected**.
- Use `mask_invert` only when inspection shows the provided mask uses the opposite convention.
- A separate layer mask attached to a layer is not automatically the same thing as a standalone full-canvas mask layer. Use only the input form supported by the current PhotoCraft wrapper.
- Masked editing must start from a clean source. If the active layer contains a previous failed render, select the untouched source/original layer rather than stacking edits on contaminated pixels.
- Do not create a mask UI or ask the user to repaint a valid existing mask. If the mask is absent, all-white, all-black, misaligned or otherwise invalid, explain the specific problem and use the existing supported way to correct it.

### Strength guidance

Use these **EggLab runtime-tested operating ranges** only when the active tool exposes a `strength` parameter and the current backend uses the same scale. They are practical starting points, not universal Qwen model guarantees.

| Task | Starting range |
|---|---:|
| Replace/add/remove an object or substantially rewrite a feature | `0.75–0.95` |
| Remove text, logo, watermark or stamp | `0.90–0.95` |
| Recolour, change material/texture or lighting | `0.40–0.60` |
| Subtle retouch (skin, blemish, tonal adjustment) | `0.25–0.35` |

The previous EggLab tests found that a value around `0.4` could leave some replacement requests almost unchanged. If the requested replacement is weak, inspect the result and consider increasing strength before rewriting an otherwise adequate prompt. Do not apply this table to unrelated tools or assume the same values work in a different backend/profile.

### Native-mask prompt rules

The mask is consumed by the tool. **Do not describe the mask, its colour, its pixels or its shape in the Qwen prompt.** Do not write “the masked region,” “the red area,” “the white selection,” or “change inside the mask.” The source image supplies the scene; describe the requested result at the target surface without narrating the mask.

Before prompting, inspect the source so the desired replacement surface is clear. Then write:

1. the requested operation;
2. the exact visible result that should occupy the target surface;
3. any necessary material, texture or lighting integration;
4. one concise clause to keep the rest of the image unchanged.

Example — remove text from a sky:

```text
Remove the white lettering completely and reconstruct a plain light-blue sky
surface in its place, with no clouds, lettering or additional objects. Match
the surrounding sky colour and light. Keep all other content unchanged.
```

Example — replace a cushion:

```text
Replace the existing cushion with a blue velvet cushion. Match the original
cushion's position, size and perspective, with realistic velvet texture and
soft contact shadows. Keep the rest of the scene unchanged.
```

Do not describe the whole picture, invent a scene description, or begin with “A photograph of…” or “A poster of…”. Avoid promising that pixels outside the target are unchanged unless the selected native workflow deterministically composites through the mask and the actual output has been checked.

## 7. Circle-guided and paint-guided annotation editing

Use annotation editing when the user draws instructions **on the image itself**. The marked image is a visual guide to the requested edit; it is not a binary mask.

### A. Circle-guided editing

Different coloured circles can identify different existing objects or regions. Treat each mark as a pointer to a target, not as a request to reproduce the mark.

1. Inspect the marked source at sufficient size to identify every circle, colour, shape and intended target.
2. Map each annotation to one user-requested operation, preserving the user's order. Do not invent what a colour means if the user did not define it and the target is unclear.
3. Use the marked composite as `image_1` and put any donor images after it as `image_2`, `image_3`, etc.
4. In the prompt, state each colour/shape-to-instruction mapping explicitly. Tie donor references to the relevant mark.
5. Tell the model to remove all annotation marks from the final result and preserve the important unmarked content.
6. Inspect that the edits were applied to the intended targets and that the marks are gone.

### B. Paint-guided editing

Painted strokes or fills indicate where something should be added, replaced or changed. The user may be marking an existing object or an empty area where new content should appear.

1. Inspect the painted source and identify the painted region(s), nearby objects and the intended target.
2. Ask only if the paint has no clear meaning and a wrong interpretation would materially affect the result. Otherwise state the interpretation and proceed.
3. Use the marked composite as `image_1`; add donor references after it when needed.
4. Explain what the painted mark means in ordinary visual terms: for example, “the green painted area indicates where the new red bicycle should be placed.” Use the colour/shape as a pointer only when that is how the user identified it.
5. Specify the content to add/change and how it should integrate with perspective, scale, lighting, occlusion and shadows.
6. Tell the model to remove the annotations from the final image and preserve unrelated content.
7. Inspect the generated result, including the boundary around the edited area.

### Preparing marked images from PhotoCraft

- If the marks are already part of the source image, use that image directly.
- If the marks are on a separate PhotoCraft layer, export a **flat marked composite** with `egl_photocraft_export_flat`; do not send the annotation layer alone as `image_1`.
- Use the flat marked composite as `image_1` with `egl_edit`, then place the resulting image back as a new layer with `egl_photocraft_place`. Keep the original and annotation layers as recoverable source material until the result is approved.
- Do not use the annotation layer as a texture/style donor.
- Do not use `mask_layer` for coloured annotation guidance. The annotation is a visual instruction image, not an engine mask.

Example — multiple annotations and donors:

```text
<image1> is the source photo with the user's visual instructions.
<image2> supplies the red hat design only.
<image3> supplies the short hairstyle reference only.

Use the marks on <image1> as edit guidance:
- Blue circle: put the red hat from <image2> on the person inside the circle.
- Red circle: change that person's hair to the short dark hairstyle from <image3>.
- Green painted area: replace the marked object with a small ceramic flower pot.

Fit each change to the source perspective, scale and lighting. Remove all drawn
marks from the final image. Preserve the other people, objects and background.
```

### When to use a crop/region edit

Do not default to a tight crop just because annotations are present. The whole marked image often supplies important context. Use a `region`/crop edit only when a nearby distractor causes repeated unwanted changes and the live tool supports a region operation. Expand the crop enough to retain context. A tight surgical crop is the last resort because it removes the scene information needed for integration.

## 8. Sketch-guided editing

A sketch supplies structure: silhouette, component count, openings, placement, proportions and camera direction. It is not a guarantee of exact stroke tracing or ControlNet-level geometric control.

- For an existing source plus a sketch, `image_1` is the source canvas and the sketch is a later reference image with an explicit `sketch` role.
- Translate important sketch structure into words: overall silhouette, major parts, counts, openings, relative positions and camera angle. Then describe desired materials, surface detail and lighting.
- Make clear which parts of the source should remain and which structural features should follow the sketch.
- Do not let a sketch reference unintentionally replace the identity, lighting or composition of the source.
- Inspect against the sketch for omitted components, wrong counts, changed openings, warped proportions and invented details. Correct a concrete failure in the next pass.

If there is no source canvas and the user wants a new image based on a sketch, follow the router's new-image/design path and load the relevant generation skill as well. Do not force a new-image job into an existing-photo edit workflow.

## 9. Sequential edits and iteration

- Prefer one meaningful transformation per pass when several changes could interfere with each other. Combine edits only when they are closely related and the model can distinguish their targets.
- Keep the original source and each generated result distinguishable. Never overwrite the approved source layer.
- Record prompt, image roles, render path, seed, model/profile and relevant parameters in `egl_job_state` when available.
- Use a fresh seed for a genuinely new creative iteration unless the user explicitly wants reproducibility. Reusing a seed across chained edits has produced artifacts in some EggLab tests; treat this as an observed runtime issue, not a universal model rule.
- After every pass, inspect identity, object count, geometry, text, pose, framing, unrequested changes and edge quality.
- If unrelated areas drift, first determine whether the method is too broad. Consider a native mask or more specific target instruction rather than adding a long description of the entire scene.
- Do not run concurrent image jobs unless live runtime status confirms that the active backend supports it.

## 10. Capability and runtime boundaries

- The official Qwen-Image-2.1 documentation describes support for up to 10 reference images and local editing with circles, painted annotations and separate masks. The active EggLab tool schema and backend can expose fewer combinations or inputs; always verify the effective capability.
- Some ComfyUI encoder nodes expose 16 image slots. This is an encoder/workflow detail, not proof that EggLab's model path should accept 16. Use the Qwen model's documented ceiling and the lower live EggLab limit.
- Do not assume all wrappers can combine a special mask input with additional donor references. Check the schema and implementation; never silently drop references.
- No generative edit guarantees perfect preservation of every unrequested pixel. Use the native mask/composite workflow when regional invariance matters and inspect the result.
- Do not claim strict ControlNet/pose/depth/edge control unless the current EggLab integration actually exposes and verifies it.
- Do not promise exact typography or logo reproduction. Use editable PhotoCraft text/vector elements for exact production copy and branding.
- Do not assume Turbo is active. Check `egl_status` and current settings before selecting a runtime-specific workflow or describing its speed/quality.
- Do not assume transparent output is valid because it looks like a checkerboard. Load `transparency/SKILL.md` and verify actual alpha with `egl_check_alpha` when alpha is required.
- Treat official model capabilities, community examples and prior EggLab tests as evidence with different confidence levels. Live tool schemas and actual inspected outputs determine what happened in this run.

## 11. QA before reporting

Inspect the generated image with `egl_inspect` using the actual absolute path returned by the tool. Do not rely only on a text status or generation-success flag.

Check the relevant items:

- The requested operation is visible and applied to the correct target.
- All ordinary references were used in their intended roles; no donor background/person/pose leaked into the result unintentionally.
- Identity, pose, body proportions, product geometry, branding, markings and object count remain correct where requested.
- The source composition and framing are preserved when the task requires them.
- Annotation circles, strokes and notes are removed from the final image.
- Native-mask edits have a convincing transition and no unwanted residue; verify the source/unchanged areas against the original.
- Sketch structure is respected without contradictory invented components.
- Exact text, spelling, numbers and script are correct; use PhotoCraft for exact editable text when needed.
- Transparency is real and verified when required.
- The original source and editable project remain recoverable.

For a seam-sensitive edit, inspect the boundary at native size. If the transition is poor, identify whether the problem is mask shape, edge feathering, lighting mismatch, perspective, or insufficient context. Change the relevant condition rather than repeating the same call.

## 12. Failure handling

- If a required input is missing or invalid, describe the exact issue and request only the missing item that is essential.
- If a mask is all-white/all-black, misaligned, or the wrong layer is active, do not render. Correct the supported source/mask selection first.
- If the live schema cannot accept the requested combination (for example, mask + donor references), state which inputs are unsupported together and offer only a verified alternative.
- If a call fails transiently, follow `AGENT.md` retry policy. Check partial success before retrying.
- If a result is visually wrong, identify one concrete failure and change one relevant condition. Do not repeat an identical call or make an uncontrolled series of prompt changes.
- If the task exceeds the runtime's practical memory or reference limit, reduce unnecessary references or use a supported staged workflow. Never silently downscale, drop or reorder user inputs without stating it.

## 13. Required references and related skills

Load these only when the decision requires them:

- `references/reference-editing/reference-mapping.md` — image-role mapping and reference handling.
- `references/reference-editing/local-edit-and-seam-control.md` — local-edit methods and seam troubleshooting.
- `references/research/local/qwen-image-2.1-features.md` — EggLab's verified Qwen capability notes.
- The current Qwen seamless/local-edit research when a region boundary or preservation issue needs deeper investigation.
- `skills/transparency/SKILL.md` — any cut-out, RGBA, alpha-preservation or transparent-output task.
- `skills/photocraft-production/SKILL.md` — layer inspection, export of marked composites, placing results, masks, save/export.
- `skills/qa-delivery/SKILL.md` — final review and delivery.

If a required reference cannot be loaded, state that limitation. Do not invent its contents.

## Research links

- Qwen-Image-2.1 official repository and model capabilities: https://github.com/QwenLM/Qwen-Image-2.1
- ComfyUI Qwen-Image-2.1 workflow guide: https://github.com/Comfy-Org/docs/blob/main/tutorials/image/qwen/qwen-image-2-1.mdx
- ComfyUI Qwen-Image-2.1 edit workflow template: https://github.com/Comfy-Org/workflow_templates/blob/main/templates/image_qwen_image_2_1_image_edit.json
- Official Qwen edit prompt rewriter: https://github.com/QwenLM/Qwen-Image-2.1/blob/main/prompt_rewrite/prompts/system_prompt_edit.txt
