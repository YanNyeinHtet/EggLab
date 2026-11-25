# Local editing and seam control

## Decide the scope
First decide whether the request is a localized edit or a new image inspired by the source. If the user asks to preserve the original photograph, do not regenerate the whole image unless the tool cannot make the requested edit and you explain the trade-off.

## Protect unchanged regions
Name what may change and what must remain unchanged. Use a preservation clause referencing position, object identity, geometry, light, texture and crop. Change one variable per revision where practical.

## Local region preparation
- Use a crop around the target when the edit needs detailed local context; retain enough surrounding context for lighting and geometry.
- Use inpainting/selection when the live tool supports it and the target can be isolated reliably.
- Ensure the region boundary is clear on all four sides and includes transition context.
- Original v1 describes feathering values 48, 96 and 160 and strength around 0.25–0.5 as working suggestions. These values depend on tool units and must be checked against the actual current schema. Do not blindly copy them into a different API.

## Seam prevention
- Match camera perspective, scale, light direction, color temperature, sharpness, grain and depth of field.
- Include contact shadow, cast shadow, reflected light and occlusion only when physically appropriate.
- Avoid halos, doubled edges, repeated patterns, mismatched blur and abrupt texture changes.
- Inspect every transition at native size and at a reduced view.
- If seam persists, make the edit region/context better before simply increasing strength.

## Iteration and provenance
Keep original input untouched. Record source image, crop/selection, prompt, strength/settings, seed, model version and output. Review after each pass; do not chain many edits without checking drift. Prefer the strongest source and the fewest passes that solve the task.

## Masked edits (painted mask layer)
Qwen-Image-2.1 is an instruction-edit model. The engine's init-image + mask path does not inpaint with it (measured: the masked area was refilled with the surrounding fabric), so EggLab never sends a mask to the engine as a mask. The panel does this instead:
1. converts the painted layer to "EggLab mask (B/W)" (white = editable, black = keep);
2. marks the editable area on a copy of the source with a light red tint and outline. This is the method the model was trained on: paint the region, then name it in the prompt;
3. sends [source, marked copy] to Qwen and composites the render back through the B/W selector, so pixels outside the mark stay byte-identical.

Protocol:
- Call `egl_photocraft_layers` first. Use exact names for `source_layer` (the original layer, e.g. "Layer 0") and `mask_layer` (e.g. "Mask").
- Check bounds before anything else. A layer marked `offCanvas` (and each entry in the layers response `warnings`) extends past the canvas edge. A painted mask like that is refused and no edit runs, because the part outside the canvas cannot be selected or edited. Do not work around it with another layer or a smaller stroke. Report the exact sides to the user, ask them to move the stroke onto the canvas or enlarge the canvas, then stop.
- Call `egl_photocraft_edit_active` with `source_layer`, `mask_layer` and `prompt`. Never put the painted layer, the B/W selector or any mask attachment in `reference_images`, `images` or any donor list.
- Write the change only. Say "the marked area" when you need a location. Never mention the mask or selection, never write "all text" for a masked request, and never write "background surface".
- Use only the object and details the user named. Do not add colours, lid positions, logos, brands or extra objects the user did not ask for. If a detail is needed for a plausible result, say in the report that you assumed it.
- Removal: "Remove the text in the marked area and reconstruct the surface behind it, continuing its texture, colour and light. Keep everything else unchanged."
- Replacement: "Replace the object in the marked area with <new object>, matching perspective, light and shadows. Keep everything else unchanged."
- If you cannot view images, do not invent a material, colour or gradient. "The surface behind it" lets the model read the source itself.
- Read the returned `references`, `verify`, `selector` and `layers`. `verify.outsideChangedPx` must be 0. A `verify.insideChangedPct` near 0 means the edit did not take effect: change the prompt and do not report success.
- Report only what the tool returned: layer bounds and `offCanvas`, which layers are visible, and what was measured inside and outside the mark. Say "not visually checked" unless you actually viewed the pixels. Do not call the replacement "perfect", "verified" or "matching the scene" from numbers alone.
- Layer state after an edit: the original stays hidden as the backup; the result is the visible active layer; the B/W selector stays visible under the result when the result is fully opaque; the painted layer stays hidden.
