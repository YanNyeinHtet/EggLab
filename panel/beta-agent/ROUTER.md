# EggLab Beta Router — Job First, Then Method

## Purpose

One creative director, one agent, progressive knowledge loading.

Two production jobs:

- **IMAGE EDITING:** Transform an existing image or layer.
- **DESIGNING:** Create a new visual product from a brief, generate assets, compose and deliver.

Answering, explaining, reviewing and diagnosing are not automatically production jobs.

## Step 0 — Route and Load Knowledge

Before the first production tool call:

1. Identify the route and editing method or design stages.
2. Read the selected primary skill using `egl_read_knowledge`.
3. Read every required reference declared by that skill.
4. Read conditional references matching the selected method or stage.
5. Verify that each file returned actual content.
6. Record loaded paths in `egl_job_state`.

**Important:** Reading a skill does not automatically load its references. Call `egl_read_knowledge` separately for every required file. Never assume recursive loading or silently skip a dependency.

If a required file is missing or unreadable, report it and do not proceed with a workflow that depends on it. Never load the entire references directory.

## Step 1 — Top-Level Route

| Request | Route | Primary skill |
|---|---|---|
| Transform an existing image | IMAGE EDITING | `skills/reference-editing/SKILL.md` |
| Create a new visual product | DESIGNING | `skills/design-pipeline/SKILL.md` |
| Operate an existing PhotoCraft document | PHOTCRAFT | `skills/photocraft-production/SKILL.md` |
| Review or verify an artifact | QA / REVIEW | `skills/qa-delivery/SKILL.md` |
| Explain, answer or diagnose | ANSWER | No production skill required |

Load `skills/qa-delivery/SKILL.md` for every produced, modified, exported or reviewed artifact.

Additional skills are loaded only when their workflow stage requires them.

---

## A. IMAGE EDITING

An existing image is the canvas being transformed.

### Select the method

| Method | Input | Tool path |
|---|---|---|
| `direct` | One image + instruction | `egl_edit` |
| `multi_reference` | Source + donor images | `egl_edit` with ordered images and explicit roles |
| `native_mask` | Painted mask layer or separate mask | `egl_photocraft_edit_active` with `mask_layer`, or `egl_edit` with `init_image`, `mask_image`, `strength` |
| `circle_annotation` | Photo with coloured circles | Annotation preview → `egl_edit` |
| `paint_annotation` | Photo with painted regions | Annotation preview → `egl_edit` |
| `sketch_guided` | Sketch or structural reference | Inspect, describe structure, then use supported editing path |

### Image roles and prompt rules

- `<image1>` is always the canvas. `<image2>` and later images are references or donors.
- State every image's role. Never silently reorder or drop inputs.
- Masks and annotations are special selectors, never ordinary donors.
- Lead prompts with the requested operation.
- Identify donor content using its `<imageN>` reference.
- Preserve untargeted content with one concise blanket instruction.
- Quote exact required text.
- Follow the source composition and aspect ratio unless instructed otherwise.
- Never promise pixel-perfect preservation unless the runtime guarantees it.

### Method-specific rules

- **Native mask:** The source pixels carry the scene. Describe the operation and exact desired result in the editable area, not the entire image. Never describe mask colours or mask mechanics in the prompt.
- **Annotations:** Map each circle colour or painted region to its intended instruction. Remove annotations in the result.
- **Sketch:** Translate shapes, proportions, openings, placement, camera and materials into explicit language.
- **Strength:** Replace/add/remove 0.75–0.95; text/logo removal 0.90–0.95; recolour 0.40–0.60; subtle retouch 0.25–0.35. Respect live tool limits.

### Required knowledge

Always load:
- `skills/reference-editing/SKILL.md`
- `references/research/local/qwen-image-2.1-features.md`
- `skills/qa-delivery/SKILL.md`

Load matching references:
- Multi-reference → `references/reference-editing/reference-mapping.md`
- Mask/local edit → `references/reference-editing/local-edit-and-seam-control.md`
- Advanced seamless editing → `references/research/local/qwen-seamless-local-edit.md`
- Transparency → `skills/transparency/SKILL.md` and its declared references.

Follow the skill's additional dependencies.

### Verify

Inspect every result using `egl_inspect` with its absolute path. Check the requested change, identity/product fidelity, unrelated areas, annotations, mask edges, exact text and alpha where applicable.

---

## B. DESIGNING — Generate → Compose

1. **Brief:** Purpose, audience, format, dimensions, exact copy, brand rules and deliverable.
2. **Direction:** Concept, hierarchy, composition, palette, typography and visual style.
3. **Asset plan:** Identify each asset, production method, references, dimensions and QA requirements.
4. **Generate:** Use Qwen for photographic and illustrative assets. Inspect each result.
5. **Compose:** Use PhotoCraft for editable typography, vectors, layers, masks and layout.
6. **Refine:** Fix hierarchy, spacing, contrast and integration in the canvas.
7. **Deliver:** Audit, save the editable project and export the requested outputs.

### Rules

- Do not use Qwen for type/vector/layout-only work.
- Keep exact logos, legal copy, QR codes and precision text editable.
- Generate only the assets the design needs.
- Do not flatten an editable deliverable.

### Load skills and references as needed

- `design-pipeline` — always.
- `design-direction` — new concepts and subjective critique.
- `asset-planning` — multi-asset jobs.
- `image-generation` — new image assets.
- `photocraft-production` — composition and document operations.
- `qa-delivery` — always for production.

Each skill's declared references must also be retrieved before executing its stage.

---

## C. PHOTCRAFT OPERATIONS

Before touching the canvas:

- Read `skills/photocraft-production/SKILL.md` and its applicable references.
- Call `egl_status`; inspect the active document and ownership.
- Use curated tools for common operations.
- Otherwise discover commands with `egl_photocraft_commands`, retrieve the exact schema, then use `egl_photocraft_command` or `egl_photocraft_batch`.
- Never guess command IDs or parameters.
- Ask before destructive operations on user work.
- Preserve editable layers when the deliverable requires them.
- Audit, save/export and inspect the actual output.

---

## D. QA / REVIEW

Read `skills/qa-delivery/SKILL.md` and its applicable references. Inspect actual files or project state. Separate observed facts from assumptions. Verify every modification and export.

---

## Universal Rules

1. The Router selects knowledge; skills define workflows; references contain detailed expertise.
2. A skill read never substitutes for reading its references.
3. Retrieve each required file individually and verify its returned content.
4. Use live runtime status and schemas, not assumptions about model capabilities.
5. Do not silently drop unsupported inputs or invent tool parameters.
6. Inspect rendered and exported files; tool success is not visual QA.
7. Record selected methods, image roles, loaded knowledge paths, prompts, seeds, output paths and QA status in `egl_job_state`.

## Conflict Precedence

1. Safety, rights and source preservation (`AGENT.md`).
2. Explicit user constraints and exact copy.
3. Live runtime capabilities and schemas.
4. Task-specific skills and references.
5. Visual profile and general heuristics.

**Production starts only after the required knowledge for the selected workflow has been retrieved and verified.**