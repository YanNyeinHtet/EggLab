---
name: photocraft-production
description: Use PhotoCraft as EggLab's native creative workspace for editable document construction, typography, vector graphics, layers, masks, adjustments, compositing, inspection, audits, saving and verified exports.
---

# PhotoCraft Production

## Purpose

PhotoCraft is a **first-class native creative workspace** in EggLab. It is not merely a place to assemble Qwen outputs at the end. Use it whenever the task benefits from editable documents, typography, vectors, layers, masks, deterministic image operations, adjustments, compositing or controlled export.

This skill covers PhotoCraft document and production operations. It does not replace:

- `reference-editing` for deciding how Qwen should transform source imagery, use donor references, interpret annotations or perform image edits.
- `design-pipeline` for the overall creative brief, art direction, asset plan and sequence of a complete design job.
- `transparency` for Qwen RGBA generation, extraction and alpha-specific workflows.
- `qa-delivery` for the full deliverable acceptance and reporting protocol.

Use PhotoCraft directly when the task is fundamentally native design or deterministic editing. Use it together with Qwen when generated imagery and editable construction both contribute to the result. Do not call Qwen just because the user says “design”.

## 1. Before touching a document

1. Call `egl_status`. Do not call `photocraft_status`.
2. If PhotoCraft is unavailable, call `egl_photocraft_launch` and wait for a connected status before continuing.
3. Establish which document this chat owns. A chat already attached to a PhotoCraft document uses that document as its default canvas. Confirm the live document identity before stateful operations.
4. A genuinely separate piece may have its own canvas. When the request is clearly a separate piece, create a new document at the appropriate working size and build that piece there. The beta application is expected to associate the conversation with that piece after the turn; verify the active document and chat/document association rather than assuming the switch succeeded. Do not create a second document merely to work around a size limit, run QA, test a command or hold temporary layers.
5. If a tool response reports `activated:false`, activate the returned document using the documented PhotoCraft command before issuing further document commands. Discover the exact command and schema; do not guess.
6. For an existing project, inspect the document snapshot and layer tree before editing. Record the document identity, dimensions, layer structure, active layer, saved path and dirty state when those fields are available.
7. If the active document or document identity changes during the task, refresh the snapshot before proceeding. Never assume a previously inspected layer or document is still active.
8. Never rename or Save-As an already open document unless the user explicitly requests it and the application’s chat/document association behavior is verified. A rename or identity change may detach the chat from its canvas.

## 2. Tool and command discovery

Use the curated EggLab tools for reliable common operations:

- `egl_status`
- `egl_photocraft_launch`
- `egl_photocraft_new_document`
- `egl_photocraft_layers`
- `egl_photocraft_place`
- `egl_photocraft_canvas`
- `egl_photocraft_edit_active`
- `egl_photocraft_audit`
- `egl_photocraft_save`
- `egl_photocraft_export_flat`
- `egl_photocraft_export_layers`
- `egl_photocraft_command`
- `egl_photocraft_commands`
- `egl_photocraft_batch`

For capabilities that are not covered by a curated wrapper, discover the native PhotoCraft command progressively:

1. Use `egl_photocraft_commands` with `detail:"names"` and a relevant group or search term to find candidate command IDs and risk classes.
2. Request `detail:"brief"` only when a command label or purpose is unclear.
3. Request `detail:"full"` for the exact schema of the specific command or small set of commands you intend to execute.
4. Execute through `egl_photocraft_command` or `egl_photocraft_batch` using only the returned, documented parameters.

Search by the capability needed, such as `document`, `layer`, `type`, `shape`, `selection`, `mask`, `adjustment`, `filter`, `transform`, `image`, `export` or `ui`.

**Do not load or dump the entire command catalogue into active reasoning.** The agent should know that a capability exists and discover its exact command only when the current task needs it. Do not invent command IDs, field names, enum values or parameter combinations.

### Command risk classes

- `read_only`: inspect, list or retrieve state. These are normally safe.
- `reversible`: create, move, rename a layer, edit text or adjust values where a reliable undo/reversal exists. Still inspect the target and preserve source content.
- `destructive`: delete, flatten, merge, overwrite, close or permanently apply changes. Ask for explicit approval before destructive operations on user work. Do not flatten or merge when an editable project is requested.

Treat live command results and schemas as authoritative over remembered examples in this skill.

## 3. Understand the document before building

Before a substantial operation, inspect the minimum state needed to act safely:

- Document identity and whether it belongs to the current chat.
- Canvas width, height, resolution and background/alpha state, where available.
- Active layer and layer-tree order.
- Layer IDs/names, visibility, lock state, bounds and semantic purpose, where available.
- Existing text layers and exact copy that must be preserved.
- Existing masks, adjustment layers, groups and source/reference layers.
- Saved path and dirty/unsaved state, where available.

Do not assume layer names are unique or that a remembered layer ID remains valid. Use the current snapshot and exact IDs/names returned by PhotoCraft.

For a new document, establish the requested output dimensions, orientation, background/alpha requirement and intended export format before creating it. Do not silently change the dimensions of an existing user document.

## 4. Native design and composition workflow

For a design job, follow the high-level creative direction and asset plan from `design-pipeline`. This skill governs the native PhotoCraft construction stage.

### 4.1 Plan the document and layer structure

Choose a logical, editable layer structure appropriate to the design. A common stack is:

1. Background
2. Environment or base plate
3. Hero subject/product
4. Supporting objects
5. Decorative elements
6. Graphic shapes and vector elements
7. Headline and display typography
8. Body copy and information
9. CTA, logo and brand elements
10. Finishing adjustments

This is a planning pattern, not a mandatory fixed order. Adapt it to the visual hierarchy and the actual artwork. Name layers by purpose, not generic labels such as `Layer 23`.

Keep generated assets, donor/source images, type, vector elements, masks and adjustments separate whenever practical. Preserve alpha when placing transparent assets. Do not flatten generated assets into the document unless the user requests a flattened result or a specific operation requires it.

### 4.2 Place generated and external assets

- Use `egl_photocraft_place` for placing approved assets into the working document.
- Verify the destination document, target position, scale and layer result from the tool response and layer snapshot.
- Keep each important asset on an independent, clearly named layer.
- Preserve transparency. Do not add a background behind an RGBA asset unless the design requires it.
- Do not replace an approved source asset merely because a new generation is available. Keep alternatives distinguishable until one is selected.
- Size assets for their actual role in the composition. Avoid generating oversized files when the asset occupies a small part of the final layout, unless later cropping or high-resolution delivery requires it.

### 4.3 Editable typography

Use native PhotoCraft text operations such as `type.create` and `type.edit` when available through the command catalogue.

- Keep client-readable copy editable by default.
- Preserve exact user-provided spelling, case, punctuation, spacing, numbers and script.
- Do not invent claims, dates, prices, URLs, product details or legal wording.
- Establish hierarchy through scale, weight, alignment, spacing and placement; do not use decorative effects to compensate for weak hierarchy.
- Inspect text at the intended display size and at a reduced/thumbnail view.
- Verify important copy against the brief after edits. Do not assume text is correct because the command succeeded.
- Bake text into pixels only when lettering itself is the artwork or the user explicitly requests it. Inspect baked lettering carefully.

Do not generate exact logos, legal copy, QR codes, fine print or precision text as image pixels when they should remain editable or machine-readable in PhotoCraft.

### 4.4 Shapes and vector graphics

Use native vector/shape tools, such as `shape.create`, when appropriate.

- Prefer editable vector elements for flat graphics, icons, dividers, geometric accents, simple diagrams and layout structure.
- Verify fill, stroke, dimensions, alignment, position and layer order.
- Keep shapes separate when they have distinct semantic roles or may need later revision.
- Do not approximate a complex brand mark with improvised shapes when an approved logo asset is available.

### 4.5 Layers, groups and masks

- Inspect the layer tree before moving, hiding, locking, grouping or changing an existing layer.
- Use descriptive names and meaningful groups for complex documents.
- Keep original/source layers untouched; duplicate or create a new working layer when an operation might alter source pixels.
- Prefer non-destructive masks and adjustments when available.
- Applying a mask, deleting a source layer, flattening or merging is destructive unless the tool provides a verified reversible operation. Follow the risk/approval rule.
- Do not assume a layer mask attached to a layer is equivalent to a separate mask layer accepted by the Qwen editing integration. For Qwen mask semantics, follow `reference-editing` and the live tool schema.
- Avoid accumulating abandoned proof layers, duplicate assets or superseded alternatives in the final document. Clean them up only when safe and authorized.

### 4.6 Adjustments, filters and transforms

- Prefer clipped/non-destructive adjustment layers for colour, tonal and finishing changes when available.
- Use deterministic PhotoCraft adjustments for colour or tonal refinement of approved pixels instead of needlessly re-rendering them through Qwen.
- Transform, crop, scale or reposition approved assets before deciding to regenerate them.
- Inspect interpolation, edge quality, clipping, blend modes and interaction with masks after transformations or filters.
- Do not apply a global adjustment when only one layer or group should change.
- Record material adjustments in job state when they are important to reproduce or revise the result.

## 5. PhotoCraft in Image Editing jobs

PhotoCraft may be used during an Image Editing job for source inspection, layer management, annotation/mask access, placement, compositing and finishing. It does not automatically mean the Qwen edit should be executed through PhotoCraft.

Choose the method from `ROUTER.md` and `reference-editing/SKILL.md`:

- Direct or multi-reference full-image edit: use the documented `egl_edit` path when appropriate.
- Marks drawn directly on the photo: use the annotation-guided workflow specified by `reference-editing`.
- Separate native mask layer: inspect and identify the exact mask layer, then use the documented `egl_photocraft_edit_active` mask path.
- Native deterministic changes (crop, type, shapes, layer arrangement, adjustments): use PhotoCraft commands.

When a Qwen result is returned, place it on a new layer or replace only the intended working layer after checking the source and target. Preserve the original source. Verify the document still corresponds to the intended chat/job before saving.

Do not make PhotoCraft the mandatory route for every image edit. Do not use PhotoCraft region/mask tools when the router and reference-editing skill specify a better whole-image annotation or direct Qwen path.

## 6. Batches and execution safety

PhotoCraft batches may stop at the first error. Plan batches so partial success is understandable and recoverable.

- Preflight all command IDs, schemas, target document/layer IDs and required values before batching.
- Keep related operations together only when later operations safely depend on earlier success.
- Split long workflows into recovery boundaries: create document/layers; place assets; create/edit type; apply finishing; save/export.
- After a failed batch, inspect the document and identify which operations completed before retrying.
- Never rerun a batch blindly. Do not repeat an identical call when its outcome is already known.
- For transient busy/timeout/connection failures, follow the retry rule in `AGENT.md`; for content or schema failures, change the relevant input or method.
- Do not run concurrent image-generation jobs unless live runtime explicitly confirms that concurrency is safe. PhotoCraft operations should also be serialized when order or document state matters.

## 7. Visual inspection and audit

A successful PhotoCraft command or audit response is not proof that the design is correct.

For every meaningful production/review task:

1. Obtain a canvas preview using `egl_photocraft_canvas` or export a preview from the working document.
2. Call `egl_inspect` with the exact absolute path returned by the tool to inspect the actual pixels.
3. Use `egl_photocraft_audit` when available as a supplementary numeric/document audit. Do not treat a numeric audit as a replacement for visual inspection.
4. Inspect the result at the full canvas and at intended display size. Check the thumbnail hierarchy where relevant.
5. If a defect is found, name it specifically, make the smallest relevant correction, and inspect again.
6. Re-audit once after meaningful fixes; do not loop endlessly or make arbitrary changes to satisfy a checklist.

### Visual QA checklist

- Overall hierarchy and focal point are clear.
- Alignment, spacing, margins, safe areas and visual rhythm are intentional.
- No accidental collisions, clipping, unwanted overlaps or off-canvas elements.
- Layer order and blend behavior are correct.
- Generated assets integrate with the composition: scale, perspective, lighting, colour and edge quality.
- Text content is exact, readable and editable where expected.
- Logos, product markings, brand assets and legal copy are correct and not invented.
- Transparency and edge quality are appropriate for the intended background/composite.
- Source layers and approved assets remain preserved.
- Document dimensions and export format match the brief.

Do not add grain, texture, print artifacts, shadows or decorative details merely to satisfy a checklist. Use them only when they serve the selected visual direction.

## 8. Save and export

1. Inspect the current document identity, path and dirty/unsaved state using `egl_status` and the available document snapshot.
2. Save the editable project using `egl_photocraft_save`. Confirm the returned status/path; do not claim a save succeeded without the tool result.
3. Choose the requested delivery format:
   - `egl_photocraft_export_flat` for a flattened final image.
   - `egl_photocraft_export_layers` for an explicitly requested layered handoff.
4. Do not export both “just in case”. Export both only when the user asks for both or the deliverables explicitly require both.
5. Verify every returned output path and status. If the tool returns a relative path, do not invent an absolute path; report it as returned or resolve it only through an approved tool.
6. Inspect the final flat export with `egl_inspect` when it is the visual deliverable. For layered handoffs, inspect the document/layer state and verify the export result.
7. Keep one approved final deliverable set per piece in a clean folder. Do not ship superseded alternatives, QA proofs or temporary layers.

Do not create scratch documents for QA. Inspect exports from the working document. Do not close user-created or potentially active documents as routine cleanup. Closing a document is destructive and requires explicit approval.

## 9. Job-state continuity

For multi-step work, use `egl_job_state` to record the PhotoCraft production state. Keep it concise and update after meaningful milestones.

Track, when relevant:

- Current document identity and chat ownership.
- Canvas dimensions and intended output format.
- Important layer IDs/names and their semantic roles.
- Generated assets placed and their paths.
- Text content and whether it remains editable.
- Significant masks, adjustments, transforms or blend modes.
- Commands/batches completed and any partial failures.
- Inspection/audit results and remaining defects.
- Save/export paths and confirmation status.

On resume, read the job state and refresh live document status before acting. Job state is continuity information, not authority to override current tool results or user instructions.

## 10. Completion and reporting

A PhotoCraft task is complete only when:

- The intended document was edited or created.
- Important content and visual checks were performed on actual pixels.
- Exact text, measurements and source-critical details were verified where relevant.
- Source and editable layer structure are preserved as required.
- The editable project save is confirmed when required.
- Requested exports are confirmed and their paths are known.

Report briefly and factually:

- What was created or changed.
- Which document/project was used.
- Whether the project remains editable.
- Verified save/export paths.
- What was visually inspected and audited.
- Any placeholders, unsupported operations or unresolved limitations.

Never claim that a command was executed, a document was saved, or an export was created without tool evidence. Never claim visual correctness without inspecting the result.
