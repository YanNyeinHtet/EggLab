#!/usr/bin/env node
/**
 * EggLab MCP server.
 *
 * OpenCode spawns this process; it is a thin JSON-RPC bridge to the EggLab
 * panel HTTP service, which owns the engine, the model downloads and the live
 * PhotoCraft session. Keeping the logic in the panel means the chat agent and
 * the UI always drive exactly the same state.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The knowledge package root. Defaults to the folder this file lives in
// (resources\knowledge packaged, the panel dir in dev). The beta agent's
// workspace runs the same server file with EGGLAB_KNOWLEDGE_ROOT set to its
// own package, so `egl_read_knowledge` serves beta skills without a second
// server copy.
const PANEL_DIR = path.resolve(
  process.env.EGGLAB_KNOWLEDGE_ROOT || path.dirname(fileURLToPath(import.meta.url)),
);

// The v2 knowledge package is read-only and allowlisted. Keeping the resolver
// here (not in the prompt) is what makes lazy loading real: the model can only
// see skill metadata until it asks for one specific file.
const KNOWLEDGE_FILES = new Set(['AGENT.md', 'ROUTER.md', 'manifest.yaml']);
const KNOWLEDGE_DIRS = ['skills', 'references', 'templates', 'config', 'evals'];
const KNOWLEDGE_MAX_BYTES = 512 * 1024;

function readKnowledge(requested) {
  const rel = String(requested || '')
    .replace(/\\/g, '/')
    .trim()
    .replace(/^\.\//, '');
  if (!rel) return { ok: false, error: 'not_found', message: 'path is required' };

  const abs = path.resolve(PANEL_DIR, rel);
  const norm = path.relative(PANEL_DIR, abs).replace(/\\/g, '/');
  if (!norm || norm.startsWith('..') || path.isAbsolute(norm)) {
    return { ok: false, error: 'not_allowlisted', path: rel };
  }
  const allowed = KNOWLEDGE_FILES.has(norm) || KNOWLEDGE_DIRS.some((dir) => norm.startsWith(`${dir}/`));
  if (!allowed) return { ok: false, error: 'not_allowlisted', path: norm };
  if (!/\.(md|ya?ml|txt)$/i.test(norm)) return { ok: false, error: 'unsupported_type', path: norm };

  // Resolve symlinks so an allowlisted-looking file cannot point outside the package.
  let real;
  try {
    real = fs.realpathSync(abs);
  } catch {
    return { ok: false, error: 'not_found', path: norm };
  }
  const realRel = path.relative(fs.realpathSync(PANEL_DIR), real);
  if (!realRel || realRel.startsWith('..') || path.isAbsolute(realRel)) {
    return { ok: false, error: 'not_allowlisted', path: norm };
  }

  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    return { ok: false, error: 'not_found', path: norm };
  }
  if (!stat.isFile()) return { ok: false, error: 'not_found', path: norm };
  if (stat.size > KNOWLEDGE_MAX_BYTES) {
    return { ok: false, error: 'too_large', path: norm, bytes: stat.size, limit: KNOWLEDGE_MAX_BYTES };
  }
  return { ok: true, path: norm, bytes: stat.size, text: fs.readFileSync(abs, 'utf8') };
}

// Image inspection is an MCP tool, not OpenCode's generic `read`. That keeps
// filesystem permission rules out of the creative agent while still letting it
// see the pixels of its own renders. Paths are restricted to the live render,
// scratch and project roots supplied by the panel.
const IMAGE_MIMES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};
function canonical(file) {
  try {
    return fs.realpathSync.native
      ? fs.realpathSync.native(file)
      : fs.realpathSync(file);
  } catch {
    return null;
  }
}

function inside(canonicalRoot, canonicalFile) {
  const fold = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);
  const rel = path.relative(fold(canonicalRoot), fold(canonicalFile));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function readImage(requested) {
  // Fail closed. A missing/invalid/empty allowlist must never mean "allow all";
  // the panel always supplies EGGLAB_READ_ROOTS, so this only happens in a
  // misconfigured or compromised child process.
  let configured = [];
  try {
    const parsed = JSON.parse(process.env.EGGLAB_READ_ROOTS || '[]');
    if (Array.isArray(parsed)) configured = parsed;
  } catch {}
  if (!configured.length) return null;

  const requestedAbs = path.resolve(String(requested || ''));
  // Resolve the file and every root to their canonical targets before the
  // boundary check. A symlink inside an allowed directory must not be able to
  // point at a private file elsewhere.
  const file = canonical(requestedAbs);
  if (!file) return null;
  const roots = configured
    .map((root) => canonical(path.resolve(String(root))))
    .filter(Boolean);
  if (!roots.length || !roots.some((root) => inside(root, file))) return null;

  const mimeType = IMAGE_MIMES[path.extname(file).toLowerCase()];
  if (!mimeType) return null;
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size > 32 * 1024 * 1024) return null;
  return {
    __mcpContent: [
      { type: 'text', text: JSON.stringify({ ok: true, path: file, bytes: stat.size, mimeType }) },
      { type: 'image', data: fs.readFileSync(file).toString('base64'), mimeType },
    ],
  };
}

const BASE = process.env.EGGLAB_URL;
const TOKEN = process.env.EGGLAB_TOKEN;

// If the panel closes or restarts, OpenCode can leave this stdio child behind
// (observed as an orphan `EggLab.exe mcp-server.mjs` holding a model/tool
// process open). A cheap heartbeat makes the server exit on its own: three
// consecutive misses, or a token rejection after a restart.
if (BASE && TOKEN) {
  let misses = 0;
  const heartbeat = setInterval(async () => {
    try {
      const res = await fetch(`${BASE}/api/jobs`, {
        headers: { 'x-egglab-token': TOKEN },
        signal: AbortSignal.timeout(5000),
      });
      if (res.status === 401) process.exit(0);
      if (!res.ok) throw new Error(`status ${res.status}`);
      misses = 0;
    } catch {
      misses++;
      if (misses >= 3) process.exit(0);
    }
  }, 20000);
  heartbeat.unref();
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    handle(msg).catch(() => {});
  }
});

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function ok(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function fail(id, message, code = -32000) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

// node:http, not fetch: undici enforces a 300 s headers timeout, which killed a
// ~6-min quality edit at the tool layer (325 s observed) while the engine kept
// rendering. The socket timeout here matches the panel's own 30-minute ceiling.
const BASE_URL = BASE ? new URL(BASE) : null;

async function api(method, route, body) {
  if (!BASE) throw new Error('EGGLAB_URL is not set for the MCP server');
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: BASE_URL.hostname,
        port: BASE_URL.port,
        path: route,
        method,
        headers: {
          'x-egglab-token': TOKEN || '',
          ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = text ? JSON.parse(text) : null; } catch {}
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(json?.error || text || `EggLab HTTP ${res.statusCode}`));
            return;
          }
          resolve(json);
        });
      },
    );
    req.setTimeout(1_800_000, () => req.destroy(new Error('EggLab request timed out after 30 min.')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitJob(id, timeoutMs = 1_800_000) {
  const start = Date.now();
  for (;;) {
    const { job } = await api('GET', `/api/jobs/${encodeURIComponent(id)}`);
    if (!job) throw new Error(`Unknown job ${id}`);
    // 'queued' is a normal state when several renders are submitted together —
    // the engine runs them strictly serially. Only done/error/canceled settle.
    if (job.status !== 'running' && job.status !== 'queued') return job;
    if (Date.now() - start > timeoutMs) throw new Error('Render timed out');
    await sleep(1500);
  }
}

function summary(job) {
  return {
    status: job.status,
    path: job.outPath,
    seed: job.seed,
    workflow: job.workflow,
    size: `${job.width}x${job.height}`,
    sizeCapped: job.sizeCapped || undefined,
    steps: job.steps,
    cfg: job.cfg,
    seconds: Math.round(job.elapsedMs / 1000),
    transparent: job.transparent,
    alpha: job.alpha
      ? {
          verdict: job.alpha.verdict,
          transparentPct: job.alpha.transparentPct,
          opaquePct: job.alpha.opaquePct,
          partialPct: job.alpha.partialPct,
          minAlpha: job.alpha.minAlpha,
          maxAlpha: job.alpha.maxAlpha,
          subjectBounds: job.alpha.subjectBounds,
          subjectTouchesEdge: job.alpha.subjectTouchesEdge,
        }
      : undefined,
    error: job.status === 'done' ? undefined : job.error || undefined,
  };
}

const tools = [
  {
    name: 'status',
    description:
      'Live EggLab state in one compact call: engine ready, model files present, current workflow/steps/cfg/size, PhotoCraft connection and open document. Call once at the start of a turn; do not re-check what you already know. Pass full:true for the complete model/settings dump.',
    inputSchema: {
      type: 'object',
      properties: {
        full: { type: 'boolean', description: 'Return the entire status payload (large). Defaults to a compact summary.' },
      },
    },
  },
  {
    name: 'read_knowledge',
    description:
      'Read one allowlisted EggLab v2 knowledge file (read-only). Pass a package-relative path exactly as named in ROUTER.md or manifest.yaml, e.g. "skills/design-direction/SKILL.md" or "references/engine/qwen-image-2.1-legacy-facts.md". Readable roots: skills/, references/, templates/, config/, evals/ plus AGENT.md, ROUTER.md, manifest.yaml. Load a skill body only after routing selects it, and a reference only when the next concrete decision needs it; never dump the whole library. Errors are compact: not_found, not_allowlisted, unsupported_type, too_large.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Package-relative path with forward slashes.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'inspect',
    description:
      'Open a PNG/JPEG/WebP render, canvas preview or exported layer and return the actual pixels to the model. Pass the absolute path from an EggLab tool result. Use this whenever visual correctness matters: check composition, text, faces, seams, alpha edges and whether the requested change actually happened. Allowed paths are the EggLab output, tmp/canvas and project folders. This is not a text-file reader; use read_knowledge for documentation.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to a PNG/JPEG/WebP returned by an EggLab tool.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'job_state',
    description:
      'Read or update this chat thread\'s panel-managed job state. Omit patch to read. Patch may contain brief, constraints, approvals, assets, renders, qa, delivery and notes. The panel persists it per thread, so it survives turns and restarts; use it for multi-step work instead of writing files. Keep the record compact and factual: exact copy/constraints, approved direction, asset paths, render seeds/paths, QA result and delivery status.',
    inputSchema: {
      type: 'object',
      properties: {
        patch: {
          type: 'object',
          additionalProperties: true,
          description: 'Shallow state merge, e.g. {"delivery":{"status":"exported","path":"..."}}',
        },
      },
    },
  },
  {
    name: 'generate',
    description:
      'Generate a NEW image with Qwen-Image-2.1 and wait for the PNG. Use this only when no source image is the canvas. Three uses: a full scene/backdrop (text-to-image, describe the whole frame, leave empty space where type will go), a transparent asset (transparent=true, native RGBA for a product/person/prop/icon), or a background plate for compositing. If the user supplies a photo to change, use edit; if they drew circles/marks on a photo, use photocraft_edit_active; if they painted a separate mask layer, use photocraft_edit_active with mask_layer. Returns path, seed, duration and - for transparent jobs - measured alpha stats. Never assume a transparent render worked; read alpha. Steps/CFG come from panel settings.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Full description of the finished image. For transparent assets the panel wraps it in the official RGBA template, so describe only the subject.' },
        workflow: { type: 'string', enum: ['quality', 'turbo'], description: 'quality = the panel quality preset for final art and alpha edges; turbo = the panel turbo preset for contact sheets, composition and light tests. Use the live step/CFG values from egl_status, not a hardcoded number.' },
        width: { type: 'integer', description: 'Pixels, multiple of 32; 256–2048 (the service caps at 2048). Size the asset will occupy in the layout (or 1.5x), NOT the canvas size; floor 512 for anything bearing text. Render time scales with area.' },
        height: { type: 'integer', description: 'Pixels, multiple of 32; 256–2048 (the service caps at 2048). Match the element\'s aspect, not the canvas\'.' },
        steps: { type: 'integer' },
        seed: { type: 'integer', description: 'Reuse a seed to iterate one variable; change it to explore.' },
        transparent: { type: 'boolean' },
        count: { type: 'integer', description: '1-4 images, sequentially. Use 2-4 turbo variants to pick a direction before rendering the winner at quality.' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'edit',
    description:
      'Edit one or more source images with Qwen-Image-2.1 (full-image instruction edit). (A) Change THIS picture: remove/replace/recolour/retouch/relight with a short imperative plus one blanket preserve clause. (B) A NEW picture of this subject: place the person/product into a designed scene, build a poster or campaign frame, and lock identity to the reference. Multi-reference: <image1> is the canvas whose framing survives, <image2>+ are donors; tag every input and state its role. One image: no tags. Use use_active_layer=true to edit the selected PhotoCraft layer. For a marked photo or a separately painted mask layer, prefer photocraft_edit_active (region or mask_layer) instead of this tool; never pass a mask layer as a donor reference. Set transparent=true for a cut-out.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The change first, then what must stay unchanged. Never describe preserved things in detail — that makes them drift.' },
        images: { type: 'array', items: { type: 'string' }, description: 'Absolute paths to reference images (1-10). Order is the order the model sees: <image1>, <image2>, …' },
        use_active_layer: { type: 'boolean', description: 'Export the selected PhotoCraft layer and use it as the first reference.' },
        edit_mode: {
          type: 'string',
          enum: ['direct', 'multi_reference', 'native_mask', 'circle_annotation', 'paint_annotation'],
          description:
            'Explicit edit contract. direct = one source + instruction; multi_reference = source + donors with roles; native_mask = init_image + mask_image drive the engine inpaint, extra images are donors (supported and kept); circle_annotation / paint_annotation = first image is the annotated copy, rest donors. Omit to derive from the inputs. A mask is never a visual reference and is never described in the prompt.',
        },
        image_roles: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              index: { type: 'integer', description: '1-based position in images.' },
              role: {
                type: 'string',
                description: 'canvas | identity | product | object_donor | clothing_donor | pose | style | environment | lighting | layout | mask | annotation',
              },
            },
            required: ['index', 'role'],
          },
          description: 'Ordered role map for images; store it in egl_job_state. Input order is a contract — never reorder to match a prompt.',
        },
        init_image: { type: 'string', description: 'Absolute path to the image being changed. Only used with mask_image; defaults to images[0].' },
        mask_image: {
          type: 'string',
          description:
            'Absolute path to a SEPARATE mask attachment (a blank layer painted with the PhotoCraft brush, exported as an image): white/alpha = edit, black/transparent = keep. Runs a true masked inpaint of init_image at strength. Never pass the mask as a visual donor; do not also add it to images.',
        },
        strength: {
          type: 'number',
          description:
            'Masked inpaint strength 0.05..1 (default 0.85). Replace/add/remove 0.75–0.95; recolour or retouch 0.4–0.6. Ignored without mask_image.',
        },
        workflow: { type: 'string', enum: ['quality', 'turbo'], description: 'Use the panel preset; quality for final/identity work, turbo for tests. Live steps/CFG come from egl_status.' },
        width: { type: 'integer', description: 'Pixels, multiple of 32; 256–2048 (service caps at 2048). Default: follow the source aspect, capped at 1024 long side.' },
        height: { type: 'integer', description: 'Pixels, multiple of 32; 256–2048 (service caps at 2048).' },
        steps: { type: 'integer' },
        seed: { type: 'integer' },
        transparent: { type: 'boolean', description: 'Return a transparent RGBA cut-out instead of an opaque background.' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'settings',
    description: 'Read or update panel defaults (workflow, steps, cfg, aspect, size, transparent, seed lock, offload). Omit patch to read.',
    inputSchema: {
      type: 'object',
      properties: {
        patch: {
          type: 'object',
          description: 'Shallow patch, e.g. {"workflow":"turbo","aspect":"16:9","transparent":true}',
          additionalProperties: true,
        },
      },
    },
  },
  {
    name: 'models',
    description: 'Model inventory: which of DiT, VAE, text encoder, vision projector and Turbo LoRA are present, with sizes and download state.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'download_models',
    description: 'Download missing model files from Hugging Face and wait until they finish. ids: diffusion, vae, llm, mmproj, turbo.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string', enum: ['diffusion', 'vae', 'llm', 'mmproj', 'turbo'] } },
        variant: { type: 'string', description: 'Optional diffusion variant id: q4km-beta, uc-q5km or uc-fp8.' },
      },
      required: ['ids'],
    },
  },
  {
    name: 'cancel',
    description: 'Cancel a running render job.',
    inputSchema: { type: 'object', properties: { job_id: { type: 'string' } }, required: ['job_id'] },
  },
  {
    name: 'photocraft_launch',
    description: 'Launch PhotoCraft with the EggLab control port if it is not running.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'photocraft_layers',
    description: 'Layer tree of the active document: ids, names, bounds, visibility, active layer. Use this to find a user-painted mask layer by name before photocraft_edit_active; the mask must be a separate layer from the canvas.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'photocraft_place',
    description:
      'Place an image file into the active document as a new pixel layer with its alpha preserved. Give it a short, meaningful layer name.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        name: { type: 'string', description: 'Layer name shown in the PhotoCraft layers panel.' },
        fit: { type: 'boolean', description: 'Scale down to fit the canvas.' },
        scale: { type: 'number', description: 'Percent scale.' },
        center: { type: 'array', items: { type: 'number' }, description: '[x, y] document pixels for the centre of the new layer.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'photocraft_canvas',
    description: "Show the agent what the current PhotoCraft canvas looks like. Returns a PNG path of the full composite canvas (all visible layers flattened). Use this before editing or placing so you know the exact current state — text position, colors, layout, what's already on canvas. The returned path is a local file the panel can attach as a reference image.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'photocraft_audit',
    description:
      'Measure the composite instead of guessing: real ink margins in document pixels, which sides touch the frame, palette shares, luminance range (p2..p98) and text-on-text collisions. Use it with the canvas — the canvas shows the look, the audit gives the numbers. Cheap, read-only, no renders.',
    inputSchema: {
      type: 'object',
      properties: {
        max_side: { type: 'integer', description: 'Composite sample size, default 1024.' },
      },
    },
  },
  {
    name: 'photocraft_new_document',
    description:
      'Create a PhotoCraft document ONLY when this chat has no document yet (a fresh chat with no canvas). A chat already attached to a working document must keep building in that document — never create a second canvas to escape its size, for a QA proof, or for the final placement. The panel refuses this call for an attached chat. Returns {document:index, activated:true}; if activated is false, call photocraft_command {id:"document.activate",params:{document}} before placing anything.',
    inputSchema: {
      type: 'object',
      properties: {
        width: { type: 'integer' },
        height: { type: 'integer' },
        background: { type: 'string', description: 'white | black | transparent | #rrggbb' },
        name: { type: 'string' },
      },
      required: ['width', 'height'],
    },
  },
  {
    name: 'photocraft_export_flat',
    description:
      'Flatten the visible composite and save it as ONE PNG the user keeps (the normal deliverable for a poster, ad or story). Pass an absolute dir and a name; the project file path is untouched. Use this instead of exporting layers unless the handoff really is an editable stack.',
    inputSchema: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: 'Absolute output directory.' },
        name: { type: 'string', description: 'File name without extension; defaults to the document name.' },
        overwrite: { type: 'boolean', description: 'Replace an existing file (default true).' },
      },
      required: ['dir'],
    },
  },
  {
    name: 'photocraft_export_layers',
    description:
      'Export every top-level layer of the active document to its own PNG, alpha preserved. This is the deliverable exporter: pass an absolute dir the user keeps (e.g. the renders folder). Returns {files:[absolute paths]}.',
    inputSchema: {
      type: 'object',
      properties: {
        dir: {
          type: 'string',
          description: 'Absolute output directory, or a path under the write root. Defaults to a scratch folder — always set it for real deliverables.',
        },
        visible_only: { type: 'boolean' },
      },
    },
  },
  {
    name: 'check_alpha',
    description:
      'Measure a PNG\'s alpha channel: verdict (cutout / opaque / empty), transparent/opaque/partial percentages, alpha range, subject bounds and whether the subject touches the frame edge. Use it after every transparent render and on any exported layer before you rely on it: a transparent render can silently come back fully opaque.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Absolute path to a PNG.' } },
      required: ['path'],
    },
  },
  {
    name: 'photocraft_edit_active',
    description:
      'Edit the layer selected in PhotoCraft: exports it, runs the edit, places the result back at the same bounds and hides the original. The active layer is the canvas. Three local sources: (1) region:[x,y,w,h] for a rectangle (mode crop/inpaint); (2) marks the user drew on the active photo - describe each mark and tell the model to remove the annotation; (3) mask_layer for a separate painted layer, where white/alpha = editable and black/transparent = keep, with mask_invert if the convention is reversed. For mask_layer the panel automatically converts the painted shape into a canonical black/white mask layer named "EggLab mask (B/W)" and uses it as the edit selector - you do not build the mask yourself. The result reports maskLayer as that canonical name; pass it back as mask_layer on a follow-up edit to reuse the same mask. The panel supplies the region guidance internally: the prompt must describe ONLY the requested change and its result state (never the whole scene, never the mask, its colour or pixels). For removals name the exact exposed surface seen in the source (e.g. "plain light-blue sky") and say no new objects appear - never write only "the background". A region/mask edit must never come back with a visible rectangle; read all borders before reporting done. Never pass a mask layer as a donor reference.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        region: {
          type: 'array',
          items: { type: 'number' },
          description: '[x, y, width, height] in document pixels. Omit to edit the whole layer.',
        },
        mask_layer: {
          type: 'string',
          description:
            'Name of a separate layer containing the user-painted mask. White/alpha = editable, black/transparent = keep. The active layer is the canvas. Use photocraft_layers to find the exact name. Do not pass the mask as a donor image.',
        },
        mask_invert: {
          type: 'boolean',
          description: 'Invert the mask convention (use when black marks the editable area).',
        },
        reference_images: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Ordered donor images that follow the active layer (e.g. the hat photo when the user circles a girl). They are kept and passed to the engine after the source; the source itself is never listed twice. The mask layer is never a donor.',
        },
        mode: {
          type: 'string',
          enum: ['crop', 'inpaint'],
          description:
            'How a region edit is applied. "crop" (default) edits a tight crop and feathers the result back in over ~48 px — fast, and everything outside the feather band stays byte-identical. "inpaint" hands the whole layer plus a soft-edged mask to the engine (--init-img --mask --strength), so the model repaints one continuous canvas and no seam can exist — use it when a flat area (sky, wall, skin) would expose a blend line, accepting a slight drift over the whole layer. Both replace the old hard rectangle.',
        },
        feather: {
          type: 'integer',
          description:
            'Blend band in pixels beyond the region edge (default 48, max 256, 0 = hard edge). Raise it — do not lower it — if any edge is still visible; the model needs room to blend, not a surgical strip.',
        },
        strength: {
          type: 'number',
          description: 'mode:"inpaint" only - denoising strength 0.05..1 (default 0.4). Replace/add/remove 0.75-0.95; text/logo/watermark removal 0.9-0.95; recolour/retouch 0.25-0.6. Painted mask_layer edits are reference-guided and do not use strength.',
        },
        workflow: { type: 'string', enum: ['quality', 'turbo'] },
        steps: { type: 'integer' },
        seed: { type: 'integer' },
        replace: { type: 'boolean', description: 'Hide the original layer (default true). Region edits build a full-layer composite first, so the untouched pixels survive outside the region.' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'photocraft_command',
    description: 'Run a raw PhotoCraft engine command by id with params (948 commands). Use only when no dedicated tool fits.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, params: { type: 'object', additionalProperties: true } },
      required: ['id'],
    },
  },
  {
    name: 'photocraft_batch',
    description:
      'Run several PhotoCraft commands in one call, in order, stopping at the first error. Use this to build a whole layout in a single round trip instead of ten: pass type.create, shape.create, layer.* steps as {id,params}, or {id:"place",params:{path,name,fit}} to drop an image into the same stack. Returns {ok_count, failed, first_failed?, not_run?, results:[{i,id,ok,error?}]}: failed is a COUNT of failed steps (0 when all pass), first_failed the index of the first failure, not_run how many steps were skipped after an early stop.',
    inputSchema: {
      type: 'object',
      properties: {
        commands: {
          type: 'array',
          description: 'Commands to run in order.',
          items: {
            type: 'object',
            properties: { id: { type: 'string' }, params: { type: 'object', additionalProperties: true } },
            required: ['id'],
          },
        },
        continue_on_error: { type: 'boolean', description: 'Keep going after a failure (default false).' },
      },
      required: ['commands'],
    },
  },
  {
    name: 'photocraft_commands',
    description:
      'Capability search over the live PhotoCraft catalog, with progressive detail. Start at detail="names" (id + group + risk only), use "brief" for labels/menus, and "full" for the exact parameter schema of the commands you will actually run. Search by capability word, group, or exact ids. Risk classes: read_only, reversible, destructive — ask before destructive commands on user work. Do not load the whole catalog into reasoning; search, read the one schema, execute.',
    inputSchema: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: 'Case-insensitive substring matched against command id, label, menu and group. e.g. "layer.mask", "adjustment", "type".' },
        detail: {
          type: 'string',
          enum: ['names', 'brief', 'full'],
          description: 'Progressive detail (default brief). names = id + group + risk only; brief = adds label/menu/state; full = adds the exact params schema.',
        },
        group: { type: 'string', description: 'Optional group filter: document, layer, type, shape, selection, mask, adjustment, filter, transform, image, export, ui.' },
        ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Exact command ids to describe, e.g. ["layer.setProps","type.create"]. Overrides filter.',
        },
        limit: { type: 'number', description: 'Max results in search mode (default 40, max 200).' },
      },
    },
  },
  {
    name: 'photocraft_export_layer',
    description:
      'Export ONE layer to a temporary reference PNG for @mention or vision use (alpha preserved). It is written to the panel scratch folder and cleaned up — never hand this path to the user as a deliverable. For a file the user keeps, use photocraft_export_layers with an absolute dir.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Exact layer name as shown in PhotoCraft.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'photocraft_export_layers_by_mentions',
    description: 'Resolve multiple @layerName mentions to exported PNG files. Returns which mentions resolved and which failed.',
    inputSchema: {
      type: 'object',
      properties: {
        names: { type: 'array', items: { type: 'string' }, description: 'Layer names mentioned with @.' },
      },
      required: ['names'],
    },
  },
  {
    name: 'photocraft_project',
    description:
      'Project state: active document (name, path, size, revision, dirty), every open document, and recent project files. Call before saving or when you need to know whether work is unsaved.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'photocraft_save',
    description:
      'Save the active PhotoCraft document. With no path it saves to the document\'s own file (refuses if never saved). ALWAYS save after placing or editing layers - otherwise the work is lost when PhotoCraft closes. Agents: save IN PLACE (omit path and name). If a save was refused with a save-as message, call again without path/name.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Optional target under the write root, e.g. "projects/my-art/my-art.pcraft". Omit to save the document in place.',
        },
        name: {
          type: 'string',
          description:
            'Project name when no path is given: the panel picks projects/<slug>/<slug>.pcraft for you and saves there.',
        },
      },
    },
  },
  {
    name: 'photocraft_open',
    description: 'Open a PhotoCraft project or image file (path under the read root). Returns the opened document name and path.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'e.g. "projects/my-art/my-art.pcraft"' } },
      required: ['path'],
    },
  },
  {
    name: 'photocraft_recent_projects',
    description: 'List recent .pcraft / .psd / .psb files under the project root, newest first.',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer' } } },
  },
];

// The panel's production profile. OpenCode exposes these directly
// (`codemode: false`), so every schema in this list is paid for on every model
// request. Keep it to tools a normal creative turn actually needs; the panel
// owns installation, model downloads, settings and project navigation.
// The same list is mirrored in service/chat.mjs for the OpenCode tool
// allowlist, and tools/agent-regression.mjs checks that they stay in sync.
const AGENT_TOOL_NAMES = Object.freeze([
  'status',
  'read_knowledge',
  'inspect',
  'job_state',
  'generate',
  'edit',
  'cancel',
  'check_alpha',
  'photocraft_launch',
  'photocraft_new_document',
  'photocraft_layers',
  'photocraft_place',
  'photocraft_canvas',
  'photocraft_edit_active',
  'photocraft_audit',
  'photocraft_save',
  'photocraft_export_flat',
  'photocraft_export_layers',
  'photocraft_command',
  'photocraft_commands',
  'photocraft_batch',
]);
// Fail safe: the production agent profile is the default. The full registry is
// opt-in (`EGGLAB_TOOLSET=full`) for developer tools and contract tests.
// `agent-beta` is the beta agent's profile: it starts identical to `agent`, so
// beta tool/behavior changes land here first without touching the official
// agent's surface.
const TOOL_PROFILE = String(process.env.EGGLAB_TOOLSET || 'agent').toLowerCase();
const agentProfile = TOOL_PROFILE === 'agent' || TOOL_PROFILE === 'agent-beta';
// Beta harness gate: production must not start before the routed skill body has
// been loaded in this session. Deterministic — a prompt rule alone was skipped.
let knowledgeLoaded = false;
// Beta harness gate #2: the whole-image description in a native_mask prompt
// must come from actually SEEING the source. A render without any prior
// egl_inspect call means the agent guessed the scene (measured failure:
// "flower field scene" invented for a product poster).
let inspectedAny = false;
const activeTools = agentProfile
  ? tools.filter((tool) => AGENT_TOOL_NAMES.includes(tool.name))
  : tools;
const activeToolNames = new Set(activeTools.map((tool) => tool.name));

async function callTool(name, args = {}) {
  if (!activeToolNames.has(name)) {
    throw new Error(`Tool ${name} is not available in this tool profile (${TOOL_PROFILE}).`);
  }
  if (name === 'read_knowledge') knowledgeLoaded = true;
  if (name === 'inspect') inspectedAny = true;
  if (
    TOOL_PROFILE === 'agent-beta' &&
    !knowledgeLoaded &&
    ['generate', 'edit', 'photocraft_edit_active', 'photocraft_place'].includes(name)
  ) {
    throw new Error(
      'Load the routed skill first: call egl_read_knowledge (ROUTER.md step 0) — ' +
        'skills/reference-editing/SKILL.md for edits, skills/design-pipeline/SKILL.md for designs, ' +
        'skills/photocraft-production/SKILL.md for canvas work. Production stays locked until the skill body is read.',
    );
  }
  if (
    TOOL_PROFILE === 'agent-beta' &&
    !inspectedAny &&
    ['edit', 'photocraft_edit_active'].includes(name)
  ) {
    throw new Error(
      'Inspect the source before editing: call egl_inspect (or egl_photocraft_canvas) on the source image first. ' +
        'The whole-image description in a native_mask edit must come from the actual pixels — ' +
        'guessing the scene makes the render drift toward an invented image.',
    );
  }
  // Alias normalization: models often send camelCase, and unknown keys are
  // silently ignored — which is how a mask can vanish from a valid-looking
  // call. Normalize every documented alias before dispatch.
  const ALIASES = {
    maskLayer: 'mask_layer',
    maskInvert: 'mask_invert',
    referenceImages: 'reference_images',
    initImage: 'init_image',
    maskImage: 'mask_image',
    editMode: 'edit_mode',
    imageRoles: 'image_roles',
    useActiveLayer: 'use_active_layer',
    maskLayerName: 'mask_layer',
    refImages: 'reference_images',
  };
  for (const [from, to] of Object.entries(ALIASES)) {
    if (args[from] !== undefined && args[to] === undefined) args[to] = args[from];
  }
  // Every user-attached reference must be used in the job; reordering is fine,
  // dropping one is not. (Declared in the prompt; the tool echoes what it got.)
  switch (name) {
    case 'status': {
      const full = await api('GET', '/api/status');
      if (args.full) return full;
      // The raw status is ~5 KB of model variants the agent almost never needs.
      // Return the decision-relevant facts; `full: true` gets the rest.
      const e = full.engine || {};
      const s = full.settings || {};
      const pc = full.photocraft || {};
      const models = e.models || {};
      const missing = Object.entries(models)
        .filter(([, present]) => !present)
        .map(([key]) => key);
      const wf = e.workflows?.[s.workflow] || {};
      return {
        engine: { ready: !!e.ready, editReady: !!e.editReady },
        models: missing.length ? { missing } : 'all present',
        workflow: s.workflow,
        steps: wf.steps ?? null,
        cfg: wf.cfg ?? null,
        size: `${s.width}x${s.height}`,
        transparentDefault: !!s.transparent,
        photocraft: {
          running: !!pc.running,
          version: pc.version || null,
          document: pc.document || null,
        },
        busy: !!full.chat?.busy,
        note: 'Compact status. Pass full:true only if you need the full model/settings dump.',
      };
    }

    case 'read_knowledge':
      return readKnowledge(args.path);

    case 'inspect': {
      const image = readImage(args.path);
      if (!image) {
        throw new Error('inspect: file is missing, outside the allowed render/project roots, or not a supported image');
      }
      return image;
    }

    case 'job_state':
      return args.patch && typeof args.patch === 'object'
        ? await api('PATCH', '/api/job-state', { patch: args.patch })
        : await api('GET', '/api/job-state');

    case 'generate': {
      const count = Math.min(4, Math.max(1, Number(args.count) || 1));
      const outputs = [];
      for (let i = 0; i < count; i++) {
        const seed =
          args.seed === undefined || args.seed === null
            ? undefined
            : Number(args.seed) + i;
        const { job } = await api('POST', '/api/jobs', {
    // Tags the job as agent-started: the panel refuses these when no chat
    // turn is active, so a tool call still in flight after Stop cannot render.
    source: 'agent',
          prompt: args.prompt,
          workflow: args.workflow,
          width: args.width,
          height: args.height,
          steps: args.steps,
          seed,
          transparent: Boolean(args.transparent),
        });
        const done = await waitJob(job.id);
        if (done.status !== 'done') {
          return { ok: false, generated: outputs, failed: summary(done), error: done.error || 'Generation failed.' };
        }
        outputs.push(summary(done));
      }
      return { ok: true, generated: outputs, prompt: args.prompt };
    }

    case 'edit': {
      let images = Array.isArray(args.images) ? args.images.slice() : [];
      let layer = null;
      if (args.use_active_layer) {
        const exported = await api('POST', '/api/photocraft/export-active');
        images = [exported.path, ...images];
        layer = exported.layer || null;
      }
      const maskPath = args.mask_image ? String(args.mask_image) : '';
      const initPath = args.init_image ? String(args.init_image) : maskPath ? images[0] : '';
      if (!images.length && !maskPath) throw new Error('egl_edit needs images, use_active_layer=true, or init_image + mask_image.');
      if (maskPath && !initPath) throw new Error('mask_image needs a target: pass init_image (or images[0]).');
      // Explicit edit contract. Derived when omitted so old callers keep working.
      const editMode =
        args.edit_mode ||
        (maskPath ? 'native_mask' : images.length > 1 ? 'multi_reference' : 'direct');
      if (editMode === 'visual_mask') {
        throw new Error(
          'visual_mask is retired: a mask is never a visual reference. Use egl_photocraft_edit_active with mask_layer ' +
            '(the painted layer is converted to a canonical black/white mask) or egl_edit with init_image + mask_image. ' +
            'The prompt describes only the masked change, never the mask itself.',
        );
      }
      // Donors are never dropped. For native_mask the init canvas is already
      // the conditioning image; any OTHER images remain as donor references
      // (verified on this engine: -i + --mask + -r works and honours donors).
      const donorImages = maskPath ? images.filter((p) => String(p) !== initPath) : images;
      const { job } = await api('POST', '/api/jobs', {
    // Tags the job as agent-started: the panel refuses these when no chat
    // turn is active, so a tool call still in flight after Stop cannot render.
    source: 'agent',
        prompt: args.prompt,
        images: donorImages,
        ...(maskPath
          ? {
              initImg: initPath,
              mask: maskPath,
              strength: Math.min(1, Math.max(0.05, Number.isFinite(Number(args.strength)) ? Number(args.strength) : 0.85)),
              transparent: false,
            }
          : {}),
        workflow: args.workflow,
        width: args.width,
        height: args.height,
        steps: args.steps,
        seed: args.seed,
        transparent: maskPath ? false : Boolean(args.transparent),
      });
      const done = await waitJob(job.id);
      return {
        ok: done.status === 'done',
        edited: summary(done),
        edit_mode: editMode,
        references: images,
        init_image: initPath || undefined,
        mask_image: maskPath || undefined,
        strength: maskPath ? Math.min(1, Math.max(0.05, Number.isFinite(Number(args.strength)) ? Number(args.strength) : 0.85)) : undefined,
        layer,
        error: done.status === 'done' ? undefined : done.error || undefined,
      };
    }

    case 'check_alpha':
      if (!args.path) throw new Error('path is required');
      return await api('POST', '/api/check/alpha', { path: args.path });

    case 'settings':
      if (!args.patch) return await api('GET', '/api/settings');
      return await api('PATCH', '/api/settings', { patch: args.patch });

    case 'models':
      return await api('GET', '/api/models');

    case 'download_models': {
      const ids = [...new Set(Array.isArray(args.ids) ? args.ids : [])];
      if (!ids.length) throw new Error('ids is required');
      const variantId = args.variant || null;
      await api('POST', '/api/models/download', { ids, variant: variantId, source: 'agent' });
      const deadline = Date.now() + 3_600_000;
      for (;;) {
        const status = await api('GET', '/api/models');
        const requested = ids
          .map((id) => status.entries.find((e) => e.id === id))
          .filter(Boolean);
        const unknown = ids.filter((id) => !requested.some((e) => e.id === id));
        const target = (e) =>
          variantId ? e.variants?.find((v) => v.id === variantId) : e.variants?.[0];
        const badVariant = requested.filter((e) => variantId && !target(e));
        const active = requested.filter(
          (e) => e.download && (e.download.status === 'running' || e.download.status === 'queued'),
        );
        const failed = requested.filter((e) => e.download && e.download.status === 'error');
        const missing = requested.filter((e) => !target(e)?.installed);
        const snapshot = requested.map((e) => {
          const v = target(e);
          return {
            id: e.id,
            file: v?.file || e.file,
            variant: v?.id || null,
            exists: Boolean(v?.installed),
            size: e.sizeText,
            download: e.download?.status || null,
            error: e.download?.error || undefined,
          };
        });
        if (!active.length) {
          if (unknown.length) {
            return { ok: false, error: `Unknown model id(s): ${unknown.join(', ')}`, models: snapshot };
          }
          if (badVariant.length) {
            return { ok: false, error: `Unknown variant: ${variantId}`, models: snapshot };
          }
          if (!missing.length) return { ok: true, models: snapshot };
          const reason =
            failed[0]?.download?.error ||
            `Download did not complete: ${missing.map((e) => target(e)?.file || e.file).join(', ')}`;
          return { ok: false, error: reason, models: snapshot };
        }
        if (Date.now() > deadline) {
          return {
            ok: false,
            pending: true,
            error: 'Download still running after 60 minutes. Check the Models panel and retry if needed.',
            models: snapshot,
          };
        }
        await sleep(2000);
      }
    }

    case 'cancel':
      return await api('POST', `/api/jobs/${encodeURIComponent(args.job_id)}/cancel`);

    case 'photocraft_launch':
      return await api('POST', '/api/photocraft/launch');

    case 'photocraft_layers':
      return await api('POST', '/api/photocraft/layers');

    case 'photocraft_place':
      return await api('POST', '/api/photocraft/place', {
        path: args.path,
        name: args.name,
        fit: args.fit,
        scale: args.scale,
        center: args.center,
      });

    case 'photocraft_canvas':
      return await api('POST', '/api/photocraft/preview', {});

    case 'photocraft_audit':
      return await api('POST', '/api/photocraft/audit', { maxSide: args.max_side });

    case 'photocraft_new_document':
      return await api('POST', '/api/photocraft/new-document', {
        width: args.width,
        height: args.height,
        background: args.background,
        name: args.name,
        source: 'agent',
        // The beta agent may start a new canvas for a separate piece (the
        // panel relinks the conversation at run end); the official agent
        // keeps the working-document block.
        ...(TOOL_PROFILE === 'agent-beta' ? { profile: 'beta' } : {}),
      });

    case 'photocraft_export_layers':
      return await api('POST', '/api/photocraft/export-layers', {
        dir: args.dir,
        visibleOnly: args.visible_only,
      });

    case 'photocraft_export_flat':
      return await api('POST', '/api/photocraft/export-flat', {
        dir: args.dir,
        name: args.name,
        overwrite: args.overwrite,
      });

    case 'photocraft_edit_active': {
      // Mask intent is absolute: a painted mask layer is required, and a region
      // must not stand in for it. Then verify the layer exists before binding.
      if (/mask|masked/i.test(String(args.prompt || '')) && !args.mask_layer) {
        throw new Error(
          'This edit refers to a mask, so mask_layer is required (find the exact name with egl_photocraft_layers). ' +
            'A region does not replace a painted mask layer.',
        );
      }
      if (args.mask_layer) {
        const info = await api('POST', '/api/photocraft/layers', {});
        const names = (info?.layers || info?.result?.layers || []).map((l) => String(l.name));
        const hit = names.some((n) => n.toLowerCase() === String(args.mask_layer).toLowerCase());
        if (!hit) {
          throw new Error(
            `Mask layer "${args.mask_layer}" is not in this document. Layers: ${names.join(', ')}. ` +
              'Use egl_photocraft_layers for exact names.',
          );
        }
        // Deterministic prompt-shape gate for native-mask edits. The source
        // pixels carry the scene; the prompt states the operation, the exact
        // exposed surface and one keep clause. Scene descriptions and generic
        // "the background continuing" fills are rejected because they made the
        // model invent content (measured: a cloud painted over removed text).
        const mp = String(args.prompt || '').trim();
        if (!mp) throw new Error('A mask edit needs a prompt: state the requested change, the exact exposed surface, and one keep clause.');
        // A vague "background surface" made the model invent content. The
        // surface must be named, or described as the surface immediately
        // behind the removed content; the panel still composites through the
        // B/W mask, so nothing outside the painted region survives.
        if (/\b(original\s+)?background\s+(surface|area)\b/i.test(mp)) {
          throw new Error(
            'Name the surface behind the removed content — skin, wall, sky, fabric — ' +
              'not "the background surface".',
          );
        }
        if (/^(a|an|the)\s+(photo|photograph|poster|image|picture|painting|scene)\b/i.test(mp)) {
          throw new Error('Native-mask prompt must not start with a scene description. Start with the requested change — the source image is the scene.');
        }
        if (/\bbackground\s+(continuing|continues)\b/i.test(mp)) {
          throw new Error('Name the exact exposed surface from inspection instead of the generic word "background" — e.g. "plain light-blue sky", "flat white wall", "wooden desk". State that no new objects appear.');
        }
        if (!/(stay|stays|remain|remains|unchanged|exactly as it is|preserve)/i.test(mp)) {
          throw new Error('Native-mask prompt needs one keep-the-rest clause, e.g. "The rest of the image stays exactly as it is."');
        }
      }
      return await api('POST', '/api/photocraft/edit-active', {
        prompt: args.prompt,
        region: args.region,
        maskLayer: args.mask_layer,
        maskInvert: args.mask_invert,
        references: Array.isArray(args.reference_images) ? args.reference_images : undefined,
        mode: args.mode,
        feather: args.feather,
        strength: args.strength,
        workflow: args.workflow,
        steps: args.steps,
        seed: args.seed,
        replace: args.replace,
      });
    }

    case 'photocraft_command':
      return await api('POST', '/api/photocraft/command', { id: args.id, params: args.params || {}, source: 'agent' });

    case 'photocraft_batch': {
      const list = Array.isArray(args.commands) ? args.commands : [];
      const results = [];
      // A batch step is a command id, except `place`, which is a tool but has to
      // run in the same ordered stack as the type and shapes.
      const runStep = async (step) =>
        step.id === 'place' || step.id === 'photocraft_place'
          ? api('POST', '/api/photocraft/place', step.params || {})
          : api('POST', '/api/photocraft/command', { id: step.id, params: step.params || {}, source: 'agent' });
      for (let i = 0; i < list.length; i++) {
        const step = list[i] || {};
        try {
          const out = await runStep(step);
          const value = out && (out.result !== undefined ? out.result : out);
          results.push({
            i,
            id: step.id,
            ok: true,
            // Keep the payload tiny: ids and counts matter, whole documents do not.
            ...(value && typeof value === 'object'
              ? { id_out: value.id ?? value.layer ?? undefined, count: Array.isArray(value) ? value.length : undefined }
              : {}),
          });
        } catch (err) {
          results.push({ i, id: step.id, ok: false, error: String(err.message || err).slice(0, 300) });
          if (!args.continue_on_error) break;
        }
      }
      // Counts, not indexes: `failed: 3` must mean three failures, not "the
      // step at index 3 failed" — an agent reading it as a count makes the
      // wrong repair. The first failure's index and the number of steps that
      // never ran (early stop) are reported separately and explicitly.
      const failures = results.filter((r) => !r.ok);
      const notRun = Math.max(0, list.length - results.length);
      return {
        ok_count: results.filter((r) => r.ok).length,
        total: list.length,
        failed: failures.length,
        ...(failures.length ? { first_failed: failures[0].i } : {}),
        ...(notRun ? { not_run: notRun } : {}),
        results,
      };
    }

    case 'photocraft_commands':
      return await api('POST', '/api/photocraft/commands', {
        filter: args.filter || '',
        detail: args.detail || 'brief',
        group: args.group || '',
        ids: args.ids || [],
        limit: args.limit,
      });

    case 'photocraft_export_layer':
      return await api('POST', '/api/photocraft/export-layer', { name: args.name });

    case 'photocraft_export_layers_by_mentions':
      return await api('POST', '/api/photocraft/export-layers-by-mentions', { names: args.names || [] });

    case 'photocraft_project':
      return await api('GET', '/api/photocraft/project');

    case 'photocraft_save': {
      if (!args.path && args.name) {
        const made = await api('POST', '/api/photocraft/project/path', { name: args.name });
        args.path = made.path;
      }
      // source lets the panel refuse a save-as that would rename the open
      // document (identity change strands the chat).
      return await api('POST', '/api/photocraft/project/save', { path: args.path, source: 'agent' });
    }

    case 'photocraft_open':
      return await api('POST', '/api/photocraft/project/open', { path: args.path });

    case 'photocraft_recent_projects':
      return await api(
        'GET',
        `/api/photocraft/project/recent${
          Number.isFinite(Number(args.limit)) && Number(args.limit) > 0
            ? `?limit=${encodeURIComponent(args.limit)}`
            : ''
        }`,
      );

    default:
      throw new Error(`Unknown tool ${name}`);
  }
}

// Session clock: every tool result carries _clock {elapsed_s, call_s} so the
// agent can see time passing. Stating a budget in the prompt alone does not work
// — agents cannot anticipate action durations; harness-side timing feedback cut
// budget overrun from 161% to 99.7% in arXiv:2610.10833.
const T0 = Date.now();

let runtimeMetadataAt = 0;

/**
 * Keep tool descriptions consistent with the live panel workflow. Tool schemas
 * are part of the prompt, so a stale "40 steps" here can override the actual
 * 25-step runtime profile. Refresh before initialize/tools-list.
 */
async function applyRuntimeMetadata(force = false) {
  if (!BASE || !TOKEN) return;
  if (!force && Date.now() - runtimeMetadataAt < 30000) return;
  try {
    const status = await api('GET', '/api/status');
    const quality = status?.engine?.workflows?.quality || {};
    const turbo = status?.engine?.workflows?.turbo || {};
    const generateTool = tools.find((tool) => tool.name === 'generate');
    const editTool = tools.find((tool) => tool.name === 'edit');
    const description =
      `quality = ${quality.steps ?? 'panel preset'} steps, CFG ${quality.cfg ?? 'panel'}, final art and alpha edges; ` +
      `turbo = ${turbo.steps ?? 'panel preset'} steps, CFG ${turbo.cfg ?? 'panel'}, contact sheets, composition and light tests.`;
    if (generateTool?.inputSchema?.properties?.workflow) {
      generateTool.inputSchema.properties.workflow.description = description;
    }
    if (editTool?.inputSchema?.properties?.workflow) {
      editTool.inputSchema.properties.workflow.description = description;
    }
    runtimeMetadataAt = Date.now();
  } catch {
    // The panel may still be starting. Keep the generic description; the agent
    // also has live values from egl_status.
  }
}

async function handle(msg) {
  if (msg.id === undefined || msg.id === null) return;
  const { id, method, params } = msg;

  if (method === 'initialize') {
    await applyRuntimeMetadata(true);
    return ok(id, {
      protocolVersion: params?.protocolVersion || '2025-11-25',
      capabilities: { tools: {} },
      serverInfo: { name: 'egglab', version: '0.1.0' },
      instructions:
        'EggLab tools drive a local Qwen-Image-2.1 engine and a live PhotoCraft session. Tools are exposed directly under their exact egl_* names; do not use generic shell, file, web, OpenCode skill or experimental image tools. Start with egl_status (compact). Use egl_job_state to read/patch the panel-managed brief, constraints, assets, QA and delivery record. After a render, canvas preview or layer export that must be judged visually, call egl_inspect with its absolute path; it returns the actual image. Use egl_read_knowledge only for the knowledge package. Decompose the piece into assets: generate transparent cut-outs for subjects (egl_generate transparent=true, then read the returned alpha), full scenes or plates for fields, reference edits for anything derived from existing imagery (egl_edit), and local fixes with egl_photocraft_edit_active. For local work: a rectangle uses region:[x,y,w,h]; user-drawn circles/marks on the active photo are annotation guidance (name each mark and tell the model to remove it); a separately painted mask layer uses mask_layer:"name" (white/alpha = edit, black/transparent = keep), never as a donor image. A region/mask edit must never come back as a visible rectangle: pass mode:"inpaint" on flat areas or raise feather if you can see an edge, and read all four borders before calling it done. Assemble bottom-up inside the document this chat already owns (place, type, shape, adjustment layers); if the chat has no document yet, create one at the working size first. ' +
(TOOL_PROFILE === 'agent-beta'
  ? 'The chat stays with its piece: when a NEW piece genuinely needs its own canvas, create a second document at the working size and build the new piece there - the conversation follows that piece when the turn ends. Never leave the linked canvas mid-piece, and never switch documents mid-turn just to escape a size limit or for a QA proof. '
  : 'Never create a second document, leave the working document, or switch to another project mid-turn to escape its size or for a QA proof - the panel blocks new documents for attached chats. ') +
'Check with egl_photocraft_audit, save, export. egl_check_alpha measures any PNG. Look up unknown engine commands with egl_photocraft_commands. Knowledge loads on demand: use egl_read_knowledge for a skill body or reference only after ROUTER.md selects it.',
    });
  }
  if (method === 'ping') return ok(id, {});
  if (method === 'tools/list') {
    await applyRuntimeMetadata();
    return ok(id, { tools: activeTools });
  }
  if (method === 'resources/list') return ok(id, { resources: [] });
  if (method === 'prompts/list') return ok(id, { prompts: [] });
  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments || {};
    try {
      const tCall = Date.now();
      const result = await callTool(name, args);
      if (result?.__mcpContent) {
        return ok(id, { content: result.__mcpContent, isError: false });
      }
      const now = Date.now();
      const clock = {
        elapsed_s: Math.round((now - T0) / 1000),
        call_s: Math.round((now - tCall) / 1000),
      };
      const payload = result && typeof result === 'object' ? { ...result, _clock: clock } : result;
      return ok(id, {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
        isError: false,
      });
    } catch (err) {
      return ok(id, {
        content: [{ type: 'text', text: `Error: ${err.message}` }],
        isError: true,
      });
    }
  }
  return fail(id, `Method not found: ${method}`, -32601);
}
