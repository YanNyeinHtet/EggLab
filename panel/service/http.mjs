import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { URL } from 'node:url';
import * as engine from './engine.mjs';
import * as models from './models.mjs';
import * as chat from './chat.mjs';
import * as pc from './photocraft.mjs';
import * as sessions from './sessions.mjs';
import * as setup from './setup.mjs';
import * as updater from './updater.mjs';
import { alphaStats, describeAlpha } from './imagecheck.mjs';
import { featherEdges, regionMask, layerMask, compositePng } from './pngfeather.mjs';
import { offCanvasSides, offCanvasMessage, sizeMismatch, newLayerId } from './maskedjob.mjs';
import { getSettings, patchSettings } from './settings.mjs';
import { LOG_DIR, TMP_DIR, stamp, clamp } from './paths.mjs';
import { emit } from './bus.mjs';

export const TOKEN = crypto.randomBytes(24).toString('hex');
let selfUrl = null;

function json(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': data.length,
    'cache-control': 'no-store',
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 4_000_000) reject(new Error('Body too large'));
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function authorized(req, url) {
  const header = req.headers['x-egglab-token'];
  const query = url.searchParams.get('token');
  return header === TOKEN || query === TOKEN;
}

async function handle(req, res, url) {
  const route = `${req.method} ${url.pathname.replace(/\/+$/, '')}`;
  const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readBody(req);

  switch (route) {
    case 'GET /api/ping':
      return json(res, 200, { ok: true, name: 'egglab', version: '0.1.0' });

    case 'GET /api/status': {
      const s = getSettings();
      return json(res, 200, {
        engine: engine.engineStatus(),
        models: models.modelStatus(),
        settings: s,
        photocraft: await pc.status(),
        chat: { busy: chat.isBusy(), sessionID: chat.getHistory().sessionID },
      });
    }

    case 'GET /api/settings':
      return json(res, 200, getSettings());

    case 'PATCH /api/settings': {
      const before = getSettings().quality?.steps;
      const next = patchSettings(body?.patch || body);
      if (body?.quality?.steps !== undefined && body.quality.steps !== before) {
        try {
          fs.appendFileSync(
            path.join(LOG_DIR, 'main.log'),
            `${new Date().toISOString()} settings quality.steps ${before} -> ${body.quality.steps} (api)\n`
          );
        } catch {}
      }
      // The agent prompt bakes in the live values (quality/turbo steps and CFG,
      // engine/model paths, output dir, control port, roots, default size), and
      // the workspace config declares the selected model's capabilities. Rebuild
      // on every patch so the agent never reads a stale manual, and tell the
      // window so its settings drawer reflects the change immediately.
      try {
        chat.buildWorkspace({ url: selfUrl, token: TOKEN });
      } catch (err) {
        try {
          fs.appendFileSync(
            path.join(LOG_DIR, 'main.log'),
            `${new Date().toISOString()} workspace rebuild failed: ${err.message}\n`
          );
        } catch {}
      }
      emit('settings', { settings: next });
      return json(res, 200, next);
    }

    case 'GET /api/models':
      return json(res, 200, models.modelStatus());

    case 'GET /api/setup':
      return json(res, 200, await setup.setupStatus());

    case 'POST /api/setup/detect': {
      const status = await setup.refreshDetection();
      if (selfUrl) {
        try {
          chat.buildWorkspace({ url: selfUrl, token: TOKEN });
        } catch {}
      }
      return json(res, 200, status);
    }

    case 'POST /api/setup/photocraft': {
      const status = await setup.setPhotoCraft(body.path);
      if (selfUrl) {
        try {
          chat.buildWorkspace({ url: selfUrl, token: TOKEN });
        } catch {}
      }
      return json(res, 200, status);
    }

    case 'POST /api/setup/engine':
      return json(res, 200, await setup.installEngine(body.variant || 'auto', Boolean(body.force)));

    case 'POST /api/setup/opencode':
      return json(res, 200, await setup.installOpencode());

    case 'POST /api/setup/import-model':
      return json(res, 200, await setup.importModelFile(body.path));

    case 'POST /api/setup/complete':
      return json(res, 200, await setup.completeSetup());

    case 'GET /api/update':
      return json(res, 200, updater.updateStatus());

    case 'POST /api/update/check':
      return json(res, 200, await updater.checkForUpdates({ userInitiated: true }));

    case 'POST /api/update/install':
      updater.installUpdate();
      return json(res, 200, { installing: true });

    case 'POST /api/models/download': {
      const ids = Array.isArray(body.ids) ? body.ids : [body.id].filter(Boolean);
      return json(res, 200, models.startDownloads(ids, body.variant || null, body.source || 'manual'));
    }

    case 'POST /api/models/download/cancel':
      return json(res, 200, { canceled: models.cancelDownload(body.id) });

    case 'POST /api/check/alpha': {
      // Any PNG on the machine: a render, an exported layer, or a cut-out the
      // user handed over. Answers "is this really transparent" with numbers.
      const file = String(body.path || '');
      if (!file) return json(res, 400, { error: 'path is required' });
      const stats = alphaStats(file);
      return json(res, 200, { ...stats, description: describeAlpha(stats) });
    }

    case 'POST /api/models/use':
      return json(res, 200, models.useVariant(body.id, body.file));

    case 'POST /api/models/folder': {
      const status = await setup.setModelsFolder(body.folder);
      try {
        chat.buildWorkspace({ url: selfUrl, token: TOKEN });
      } catch {}
      return json(res, 200, status);
    }

    case 'POST /api/models/path': {
      const status = await setup.setModelFile(body.role, body.path);
      try {
        chat.buildWorkspace({ url: selfUrl, token: TOKEN });
      } catch {}
      return json(res, 200, status);
    }

    case 'GET /api/opencode':
      return json(res, 200, await setup.opencodeInfo(url.searchParams.get('force') === '1'));

    case 'POST /api/opencode/path': {
      const status = await setup.setOpenCode(body.path);
      try {
        chat.buildWorkspace({ url: selfUrl, token: TOKEN });
      } catch {}
      return json(res, 200, status);
    }

    case 'GET /api/jobs':
      return json(res, 200, { jobs: engine.listJobs() });

    case 'POST /api/jobs': {
      // Jobs the agent starts through MCP are only valid while its turn is
      // running. OpenCode is killed on Stop, but an MCP tool call already on
      // the wire still reaches us; without this check it would start a render
      // the user just canceled. (Manual renders from the UI have no source.)
      if (body?.source === 'agent' && !chat.isBusy()) {
        return json(res, 409, {
          error: 'The turn was stopped, so this render was not started.',
          code: 'STOPPED',
        });
      }
      const job = engine.startJob(body);
      return json(res, 200, { job });
    }

    case 'GET /api/chat':
      return json(res, 200, chat.getHistory());

    case 'GET /api/job-state':
      return json(res, 200, chat.getJobState());

    case 'PATCH /api/job-state':
      return json(res, 200, chat.patchJobState(body?.patch || body));

    case 'GET /api/sessions':
      return json(res, 200, await sessions.list(Number(body?.limit) || 40));

    case 'POST /api/sessions/rename':
      return json(res, 200, sessions.rename(body.key, body.title));

    case 'POST /api/sessions/new':
      return json(res, 200, chat.newThread());

    case 'POST /api/sessions/switch': {
      // HTTP has no window control, so it switches the chat only; the desktop
      // UI additionally brings the thread's document forward via IPC.
      const result = chat.useThread(body.key);
      return json(res, 200, { ...result, history: chat.getHistory() });
    }

    case 'POST /api/sessions/clear':
      return json(res, 200, { ok: chat.clearHistory() });

    case 'POST /api/sessions/delete':
      return json(res, 200, await chat.deleteThread(body.key));

    case 'POST /api/sessions/move':
      return json(res, 200, chat.moveThread(body.key, body.docKey, body.title || null));

    case 'POST /api/chat': {
      // Same stale-binding guard as the IPC path: bind to the document that is
      // actually active in PhotoCraft before appending the user message.
      if (!chat.isBusy()) {
        try {
          const state = await pc.projectState();
          const doc = state.document;
          if (doc?.key && doc.key !== chat.documentKey()) {
            chat.useDocument(doc.key, doc.name || null);
          }
        } catch {}
      }
      const item = await chat.send(body.text, body.files || [], body.refMap || {});
      return json(res, 200, { item });
    }

    case 'POST /api/chat/stop':
      return json(res, 200, {
        stopped: chat.stop(),
        canceled: engine.cancelAllJobs(),
        downloads: models.cancelAgentDownloads(),
      });

    case 'POST /api/chat/clear':
      return json(res, 200, { ok: chat.clearHistory() });

    case 'POST /api/photocraft/launch':
      return json(res, 200, await pc.launch());

    case 'POST /api/photocraft/layers':
      return json(res, 200, await pc.layers());

    case 'POST /api/photocraft/preview':
      return json(res, 200, await pc.preview(Number(body.maxSide) || 1024));

    case 'POST /api/photocraft/place':
      return json(res, 200, { result: await pc.place(body.path, body), save: await pc.autosave('placed a layer') });

    case 'POST /api/photocraft/new-document': {
      // A chat that already owns a document must stay in it. Letting an agent
      // create a new canvas mid-turn moves the PhotoCraft active document and
      // used to retarget the conversation onto it (two chats on one doc, the
      // working doc left without its chat). Only a chat with no document may
      // create one; a human can always start a new chat for a separate piece.
      // EXCEPTION (Phase C, beta profile): the beta agent may start a second
      // canvas for a genuinely new piece — the conversation then follows that
      // piece when the turn ends (chat.noteRunCanvasSwitch → watcher relink).
      if (body.source === 'agent' && body.profile !== 'beta') {
        const working = chat.workingDocument();
        if (working) {
          return json(res, 409, {
            error:
              `This chat is working in "${working}". Keep building in that document. ` +
              'Only a chat with no document may create a new one; use the current canvas, ' +
              'or ask the user to open a separate canvas first.',
          });
        }
      }
      if (body.source === 'agent' && body.profile === 'beta' && chat.workingDocument()) {
        chat.noteRunCanvasSwitch();
      }
      return json(res, 200, { result: await pc.newDocument(body) });
    }

    case 'POST /api/photocraft/export-layers':
      return json(res, 200, { result: await pc.exportLayers(body) });

    case 'POST /api/photocraft/export-flat':
      return json(res, 200, await pc.exportFlattened(body));

    case 'POST /api/photocraft/audit':
      return json(res, 200, await pc.audit(body));

    case 'POST /api/photocraft/export-active':
      return json(res, 200, await pc.exportActiveLayer());

    case 'POST /api/photocraft/export-layer': {
      return json(res, 200, await pc.exportLayerByName(body.name, body));
    }

    case 'POST /api/photocraft/export-layers-by-mentions': {
      return json(res, 200, await pc.exportLayersByMentions(body.names || []));
    }

    case 'POST /api/photocraft/command': {
      // The tool registry exposes one generic command bridge; keep the
      // no-new-document rule there too, so an agent cannot bypass the guarded
      // tool with `doc_new`/`document.new`.
      const id = String(body.id || '');
      if (body.source === 'agent' && /^(?:doc|document|file)\.(?:new|create)$/i.test(id)) {
        const working = chat.workingDocument();
        if (working) {
          return json(res, 409, {
            error:
              `This chat is working in "${working}". New documents are only allowed from a chat ` +
              'with no document; keep working in the current canvas.',
          });
        }
      }
      // Renaming / Save-As changes the document identity, which strands the
      // chat (a new document key means the conversation no longer matches its
      // canvas). Agents must keep the document's name; naming is only allowed
      // when a chat without a document creates its canvas.
      if (body.source === 'agent' && /(?:^|\.)(?:rename|save.?as|saveas)$/i.test(id)) {
        return json(res, 409, {
          error:
            `The agent must not rename or save-as the current document (command "${id}"). ` +
            'That changes the document identity and strands this chat. Keep the existing name; ' +
            'only a canvas created for a chat without a document may be named.',
        });
      }
      // Activating another open document is the other way out of the working
      // canvas. Allow only the chat's own document; the watcher would otherwise
      // have to drag the user back after the turn.
      if (body.source === 'agent' && /^document\.activate$/i.test(id)) {
        const working = chat.workingDocument();
        const target = Number(body.params?.document);
        if (working && Number.isFinite(target)) {
          const state = await pc.projectState().catch(() => null);
          const documents = state?.documents || [];
          const doc = documents.find((d) => d.index === target);
          if (doc) {
            const active = documents.find((d) => d.active);
            const targetIsActive = Boolean(active && active.index === target);
            const workingName = working.startsWith('untitled:') ? working.split(':')[1] : null;
            const sameUntitledName = Boolean(
              workingName && String(doc.label || doc.name || '') === workingName,
            );
            const samePath = Boolean(
              doc.path &&
                path.resolve(String(doc.path)).toLowerCase() ===
                  path.resolve(working).toLowerCase(),
            );
            const key = pc.docKey({
              path: doc.path || '',
              name: doc.label || doc.name,
              width: doc.width,
              height: doc.height,
            });
            if (!targetIsActive && !sameUntitledName && !samePath && key !== working) {
              const label = String(doc.label || doc.name || key);
              return json(res, 409, {
                error:
                  `This chat is working in "${working}". Do not activate "${label}" during the turn; ` +
                  'keep building in the working document.',
              });
            }
          }
        }
      }
      return json(res, 200, { result: await pc.command(id, body.params || {}) });
    }

    case 'POST /api/photocraft/commands':
      return json(res, 200, await pc.commandCatalog(body || {}));

    case 'GET /api/photocraft/project':
      return json(res, 200, await pc.projectState());

    case 'POST /api/photocraft/project/save':
      return json(res, 200, await pc.save(body || {}));

    case 'POST /api/photocraft/project/open':
      return json(res, 200, await pc.openProject(body || {}));

    case 'POST /api/photocraft/project/close':
      return json(res, 200, await pc.closeDocument(body || {}));

    case 'POST /api/photocraft/project/path':
      return json(res, 200, { path: pc.projectPathFor(body.name, body) });

    case 'GET /api/photocraft/project/recent':
      return json(res, 200, {
        projects: pc.recentProjects(
          Number(url.searchParams.get('limit')) || Number(body?.limit) || 20,
        ),
      });

    case 'POST /api/photocraft/edit-active':
      return json(res, 200, { ...(await editActive(body)), save: await pc.autosave('edited a layer') });

    case 'GET /api/events': {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      const { bus } = await import('./bus.mjs');
      const handler = (evt) => {
        res.write(`data: ${JSON.stringify(evt)}\n\n`);
      };
      bus.on('event', handler);
      req.on('close', () => bus.off('event', handler));
      return;
    }

    default:
      break;
  }

  // parameterised routes
  let m = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
  if (m && req.method === 'GET') {
    const job = engine.getJob(m[1]);
    return job ? json(res, 200, { job }) : json(res, 404, { error: 'Unknown job' });
  }
  m = url.pathname.match(/^\/api\/jobs\/([^/]+)\/cancel$/);
  if (m && req.method === 'POST') {
    return json(res, 200, { canceled: engine.cancelJob(m[1]) });
  }

  return json(res, 404, { error: `No route for ${req.method} ${url.pathname}` });
}

/**
 * Export the active PhotoCraft layer, edit it, put the new pixels back at the
 * same place and hide the original. The whole point of the panel.
 */
async function editActive(body) {
  try {
    fs.appendFileSync(
      path.join(LOG_DIR, 'main.log'),
      `${new Date().toISOString()} edit-active maskLayer=${body.maskLayer || ''} ` +
        `region=${JSON.stringify(body.region || null)} mode=${body.mode || 'crop'} ` +
        `refs=${(body.references || []).length}\n`,
    );
  } catch {}
  // The source is named explicitly when the caller gives it, so the edit never
  // depends on whichever layer happened to be active (the source is often a
  // hidden original, and the active layer is often the previous result).
  if (body.sourceLayer) {
    const wanted = String(body.sourceLayer).trim();
    if (!wanted) throw new Error('source_layer must be a layer name.');
    await pc.command('layer.select', { name: wanted });
  }
  const exported = await pc.exportActiveLayer();
  if (
    body.sourceLayer &&
    String(exported.layer?.name || '').toLowerCase() !== String(body.sourceLayer).trim().toLowerCase()
  ) {
    throw new Error(
      `source_layer "${body.sourceLayer}" did not become the active layer (active: "${exported.layer?.name}").`,
    );
  }
  if (!exported?.path) throw new Error('No active layer to edit.');
  const layer = exported.layer;
  const size = pc.pngSize(exported.path);

  // A local edit. Two shapes, both built to avoid the same defect: a
  // hard-edged rectangle pasted back over an unchanged image. Measured on a
  // real retouch, that path gave an outside delta of exactly 0.00 jumping
  // straight to ~2.19 at col 260 — a clean 520x839 rectangle with zero feather,
  // which is what "I can see the seam" looks like in numbers.
  //
  //   mode "crop"    (default) edit a tight crop — Qwen is far more reliable on
  //                  a tight subject than on a whole canvas — then ramp the
  //                  result's alpha down over the edge band so it crossfades
  //                  into the layer below instead of stopping at a line.
  //   mode "inpaint" hand the WHOLE layer to the engine together with a soft
  //                  mask (sd-cli --init-img --mask --strength). The model
  //                  repaints one continuous canvas, so nothing is ever pasted
  //                  and a seam cannot exist by construction. Costs a small
  //                  global VAE drift; buys a perfect blend.
  let region = null;
  let cropRect = null; // layer-relative [x,y,w,h] for a crop edit
  let source = exported.path;
  let pasteBounds = null; // where the result lands; null = use the layer bounds
  let swapOriginal = false; // result covers the whole layer, so hide the old one
  let usedMaskLayer = null;
  let autoMaskId = null;
  // The B/W selector drives the edit (the engine marks it on a copy of the source
  // and composites the render back through it). The user's painted layer is a
  // source for the selector: it is never a donor and stays hidden.
  let maskForComposite = null;
  let sourceMaskId = null;
  let sourceMaskName = null;
  const local = {};

  // A separately painted mask layer in PhotoCraft. The active layer is the
  // canvas; the named layer supplies the editable region. Qwen-Image-2.1 is an
  // instruction-edit model, so the engine marks the region for it (its trained
  // local-edit path) and composites the render back through the selector.
  if (body.maskLayer) {
    const name = String(body.maskLayer).trim();
    if (!name) throw new Error('mask_layer must be a layer name.');
    if (!layer?.bounds) throw new Error('A mask-layer edit needs an active layer with pixel bounds.');
    if (!size?.width || !size?.height) throw new Error('Could not read the active layer pixels.');
    if (String(layer.name || '').toLowerCase() === name.toLowerCase()) {
      throw new Error('The mask layer must be a separate layer, not the active canvas.');
    }
    // The canonical mask is already black/white and full-canvas: use it as-is.
    // Re-converting it would build a second, redundant mask and report the
    // wrong layer name to the agent.
    const isCanonicalMask =
      name.toLowerCase() === 'egglab mask (b/w)';
    const maskExport = await pc.exportLayerByName(name);
    if (!maskExport?.path || !maskExport.layer?.bounds) {
      throw new Error(`Mask layer "${name}" has no pixel bounds.`);
    }
    const [mx, my] = maskExport.layer.bounds;
    const [lx, ly] = layer.bounds;
    // exportLayerByName pads the clipboard export back to the full canvas at
    // the layer's document bounds. A canvas-sized mask must be CROPPED at the
    // target layer's origin, not shifted again by (mx-lx, my-ly) — that double
    // offset repainted a different part of the picture while the painted area
    // stayed untouched (measured: text stayed, the girl's arm gained a blob).
    const docNow = await pc.inspect();
    const canvasW = Number(docNow?.document?.width || docNow?.width) || 0;
    const canvasH = Number(docNow?.document?.height || docNow?.height) || 0;
    // Refuse before any work: a mask past the canvas edge loses that part in the
    // canvas-sized selector, so the edit would not match the painted shape.
    const offSides = offCanvasSides(maskExport.layer.bounds, { width: canvasW, height: canvasH });
    if (offSides) {
      throw new Error(offCanvasMessage(name, offSides, { width: canvasW, height: canvasH }));
    }
    if (sizeMismatch(maskExport.layer.bounds, maskExport.croppedSize)) {
      throw new Error(
        `The painted layer "${name}" has ${maskExport.croppedSize.width}x${maskExport.croppedSize.height} pixels ` +
          `but reports bounds ${maskExport.layer.bounds.join(', ')}, so some of its pixels lie outside the reported area. ` +
          'No edit was run. Move the stroke fully onto the canvas (or enlarge the canvas), then retry.',
      );
    }
    const sourceCanvas =
      Boolean(maskExport.croppedPath) ||
      (canvasW > 0 &&
        canvasH > 0 &&
        Number(maskExport.size?.width) === canvasW &&
        Number(maskExport.size?.height) === canvasH);
    const maskOffset = sourceCanvas ? [lx, ly] : [mx - lx, my - ly];
    const maskFile = path.join(
      TMP_DIR,
      `pc-user-mask-${stamp()}-${Math.random().toString(36).slice(2, 7)}.png`,
    );
    if (!isCanonicalMask) {
      layerMask(
        maskExport.path,
        maskFile,
        size.width,
        size.height,
        maskOffset,
        Boolean(body.maskInvert),
        sourceCanvas,
      );
      try {
        fs.appendFileSync(
          path.join(LOG_DIR, 'main.log'),
          `${new Date().toISOString()} mask-build layer=${name} ` +
            `src=${maskExport.size?.width}x${maskExport.size?.height} ` +
            `target=${size.width}x${size.height} canvas=${sourceCanvas} ` +
            `offset=${maskOffset.join(',')}\n`,
        );
      } catch {}
    }
    maskForComposite = isCanonicalMask ? maskExport.path : maskFile;
    // The engine receives the source and the B/W selector; it builds the marked
    // copy and composites the render back through the selector (maskedjob.mjs).
    local.initImg = exported.path;
    local.mask = maskForComposite;
    sourceMaskId = maskExport.layer?.id ?? null;
    sourceMaskName = name;
    pasteBounds = layer.bounds;
    swapOriginal = true;
    usedMaskLayer = 'EggLab mask (B/W)';
    // Auto-mask step (user paints a shape; the system makes the canonical
    // black/white mask and keeps it in the document so the conversion is
    // visible and reusable). The painted layer is hidden after the edit.
    // placeAtBounds returns copy metadata, not the new layer id, so identify
    // the added layer by diffing the tree before/after. Reuse an existing
    // canonical layer's slot by removing stale copies first, so repeated edits
    // do not pile up duplicate "EggLab mask (B/W)" layers.
    if (!isCanonicalMask) {
      try {
        const existing = await pc.layers();
        const flat = [];
        const walk = (list) => {
          for (const l of list || []) {
            flat.push(l);
            if (l.children) walk(l.children);
          }
        };
        walk(existing?.layers || []);
        for (const l of flat) {
          if (String(l.name || '').toLowerCase() === 'egglab mask (b/w)') {
            try { await pc.command('layer.delete', { layer: l.id }); } catch {}
          }
        }
      } catch {}
      try {
        const beforeLayers = await pc.layers();
        await pc.placeAtBounds(maskFile, [0, 0, size.width, size.height], {
          name: 'EggLab mask (B/W)',
        });
        const afterLayers = await pc.layers();
        const beforeIds = new Set((beforeLayers?.layers || []).map((l) => l.id));
        const added =
          (afterLayers?.layers || []).find(
            (l) => !beforeIds.has(l.id) && l.name === 'EggLab mask (B/W)',
          ) || (afterLayers?.layers || []).find((l) => !beforeIds.has(l.id));
        let hidden = false;
        if (added?.id !== undefined) {
          autoMaskId = added.id;
          await pc.command('layer.setProps', { layer: added.id, visible: false });
          hidden = true;
        }
        try {
          fs.appendFileSync(
            path.join(LOG_DIR, 'main.log'),
            `${new Date().toISOString()} auto-mask layer=${added?.id ?? 'none'} ` +
              `hidden=${hidden} name=${added?.name || 'none'}\n`,
          );
        } catch {}
        emit('log', `auto-mask: made EggLab mask (B/W) layer (hidden=${hidden})`);
      } catch (err) {
        try {
          fs.appendFileSync(
            path.join(LOG_DIR, 'main.log'),
            `${new Date().toISOString()} auto-mask failed: ${err.message}\n`,
          );
        } catch {}
        emit('log', `auto-mask placement failed (${err.message}); engine mask still applied`);
      }
    } else {
      // Canonical mask passed in: reuse it as the engine mask; no new layer.
      autoMaskId = maskExport.layer?.id ?? null;
      try {
        await pc.command('layer.setProps', { layer: autoMaskId, visible: false });
      } catch {}
      try {
        fs.appendFileSync(
          path.join(LOG_DIR, 'main.log'),
          `${new Date().toISOString()} auto-mask reused canonical layer=${autoMaskId}\n`,
        );
      } catch {}
    }
    // Keep the editable source selected. The B/W copy is a hidden selector,
    // not the canvas the user should see active while the render runs.
    try {
      await pc.command('layer.select', { layer: layer.id });
    } catch {}

  } else if (Array.isArray(body.region) && body.region.length === 4) {
    if (!layer?.bounds) throw new Error('A region edit needs a layer with pixel bounds.');
    const [lx, ly] = layer.bounds;
    if (!size?.width || !size?.height) throw new Error('Could not read the layer pixels.');
    const rx = clamp(Math.round(Number(body.region[0]) - lx), 0, size.width - 1);
    const ry = clamp(Math.round(Number(body.region[1]) - ly), 0, size.height - 1);
    const rw = clamp(Math.round(Number(body.region[2])), 1, size.width - rx);
    const rh = clamp(Math.round(Number(body.region[3])), 1, size.height - ry);
    if (!(rw > 0) || !(rh > 0)) throw new Error('region must be [x, y, width, height] with positive size.');
    region = [lx + rx, ly + ry, rw, rh];

    // The blend band. Grown OUTSIDE the edit box on purpose: the box is where
    // the change has to land, and the pixels just beyond it are the ones that
    // have to absorb the transition. A surgical strip is what reads as a seam.
    const band = clamp(
      body.feather === undefined || body.feather === null ? 48 : Number(body.feather),
      0,
      256,
    );

    if (String(body.mode || 'crop') === 'inpaint') {
      const strength = Number.isFinite(Number(body.strength)) ? Number(body.strength) : 0.4;
      const maskPath = path.join(TMP_DIR, `pc-mask-${stamp()}-${Math.random().toString(36).slice(2, 7)}.png`);
      regionMask(maskPath, size.width, size.height, [rx, ry, rw, rh], band || 32);
      local.initImg = exported.path;
      local.mask = maskPath;
      local.strength = clamp(strength, 0.05, 1);
      if (Number.isFinite(Number(body.imgCfg))) local.imgCfg = Number(body.imgCfg);
      pasteBounds = layer.bounds;
      swapOriginal = true;
    } else {
      const cropped = await pc.cropCopy(exported.path, [rx, ry, rw, rh]);
      source = cropped.path;
      region = [lx + cropped.rect[0], ly + cropped.rect[1], cropped.rect[2], cropped.rect[3]];
      cropRect = [
        cropped.rect[0],
        cropped.rect[1],
        cropped.rect[2],
        cropped.rect[3],
      ];
      pasteBounds = region;
      local.feather = band;
    }
  }

  const sourceSize = pc.pngSize(source);
  const inpaint = Boolean(local.mask);
  const maskedEdit = Boolean(maskForComposite);
  // A masked edit must follow the source layer's geometry. Falling back to the
  // panel's default square (960x960) stretches a portrait layer and ruins the
  // render — refuse instead of guessing.
  const geometryDriven = inpaint || maskedEdit;
  if (geometryDriven && !(Number(sourceSize?.width) > 0 && Number(sourceSize?.height) > 0)) {
    throw new Error(
      'Could not read the active layer pixels for the masked edit (no size/aspect). ' +
        'Select the source layer again and retry — refusing to render at a default square size.',
    );
  }

  // Follow the source's aspect ratio instead of capping each side on its own.
  // min(1024,w) x min(1024,h) turns a 1024x1280 layer into a 1024x1024 square,
  // and placeAtBounds then stretches that back over a 1024x1280 box — a 25 %
  // vertical distortion. Cap the LONG side and let the other side follow.
  // (engine.mjs rounds both to a multiple of 32 on the way out.)
  //
  // The cap differs by mode because the consequence differs. A crop patch is
  // small and gets pasted into its own rectangle; an inpaint result covers the
  // WHOLE layer, so a downscale here is a loss of sharpness across the entire
  // image. Capping a 1024x1280 layer at 1024 made the engine render 832x1024
  // (its preprocess log: `resize=832x1024`), which placeAtBounds then stretched
  // back up — 97.9 % of pixels changed and the background visibly softened.
  // Inpaint therefore runs at the layer's own size; the tiled VAE handles it.
  const fitted = (() => {
    const w = Number(sourceSize?.width) || 0;
    const h = Number(sourceSize?.height) || 0;
    if (!(w > 0) || !(h > 0)) return {};
    const cap = geometryDriven ? 1536 : 1024;
    const k = Math.min(1, cap / Math.max(w, h));
    return { width: Math.round(w * k), height: Math.round(h * k) };
  })();

  // Donor references (circles/paint plus e.g. a hat photo) follow the active
  // layer in order. The source is the canvas and is never listed twice. A
  // painted mask is a selector: the engine refuses it if it arrives as a donor.
  const donorRefs = (Array.isArray(body.references) ? body.references : [])
    .filter(Boolean)
    .map(String)
    .filter((p) => p !== exported.path);
  const job = engine.startJob({
    ...body,
    region: undefined,
    prompt: body.prompt,
    images: inpaint ? donorRefs : [source, ...donorRefs],
    ...(inpaint ? { transparent: false } : {}),
    ...local,
    width: body.width || fitted.width || undefined,
    height: body.height || fitted.height || undefined,
  });
  const done = await engine.waitForJob(job.id);
  if (done.status !== 'done') {
    return { ok: false, job: done, error: done.error || 'Edit failed.' };
  }

  // Crop mode: fade the patch's own edges into transparency before it goes
  // down, so the composite steps smoothly across the boundary instead of
  // showing where the rectangle was cut. The interior stays fully opaque —
  // a ramp that ate the middle would ghost two half-visible versions of the
  // subject instead of blending them.
  let output = done.outPath;
  let feathered = 0;
  if (local.feather > 0 && done.outPath) {
    try {
      const faded = path.join(
        TMP_DIR,
        `pc-feather-${stamp()}-${Math.random().toString(36).slice(2, 7)}.png`,
      );
      feathered = featherEdges(done.outPath, faded, local.feather);
      if (feathered > 0) output = faded;
    } catch (err) {
      emit('log', `feather failed (${err.message}); placing the un-feathered result`);
    }
  }

  // Crop edits used to place the feathered patch directly over the still-visible
  // original. At a uniform fill the original showed through the ramp as arcs
  // and seams, and the agent had to hide the whole layer manually. Composite
  // the patch over a copy of the original instead: the result is a full-layer
  // replacement with the untouched pixels preserved outside the region.
  if (cropRect && output && layer?.bounds) {
    try {
      const composed = path.join(
        TMP_DIR,
        `pc-composite-${stamp()}-${Math.random().toString(36).slice(2, 7)}.png`,
      );
      compositePng(exported.path, output, composed, cropRect);
      output = composed;
      pasteBounds = layer.bounds;
      swapOriginal = true;
    } catch (err) {
      emit('log', `region composite failed (${err.message}); using the feathered patch`);
    }
  }

  const doc = await pc.inspect();
  const d = doc?.document || doc || {};
  const bounds = pasteBounds || layer?.bounds;

  // The selector is the active layer while the result is placed, so the result
  // lands directly above it: the B/W selector sits under the result, not over it.
  if (autoMaskId !== null) {
    try {
      await pc.command('layer.select', { layer: autoMaskId });
    } catch {}
  }
  // The edited crop goes back exactly over the original: paste at its bounds
  // and let the panel scale the result to those pixels.
  const resultName = bounds
    ? layer?.name
      ? `${layer.name} (EggLab${region ? ' region' : ''})`
      : 'EggLab edit'
    : 'EggLab edit';
  const layersBeforeResult = await pc.layers();
  const placed = bounds
    ? await pc.placeAtBounds(output, bounds, { name: resultName })
    : await pc.place(output, {
        fit: true,
        name: 'EggLab edit',
        center: [(d.width || 0) / 2, (d.height || 0) / 2],
      });
  // The placement reply does not carry the new layer's id; take it from the tree.
  const resultLayerId = newLayerId(layersBeforeResult, await pc.layers(), resultName);

  let hidden = null;
  // Inpaint results cover the whole layer, so leaving the original visible
  // would stack two copies of it; a feathered crop sits only over its own
  // rectangle and the layer beneath is meant to keep showing through.
  if (body.replace !== false && layer?.id !== undefined && (!region || swapOriginal)) {
    try {
      hidden = await pc.command('layer.setProps', { layer: layer.id, visible: false });
    } catch (err) {
      hidden = { error: err.message };
    }
  }
  // Make the RESULT the active layer: exports, further edits and verification
  // must start from the composite, not from the hidden original.
  try {
    if (resultLayerId !== null) await pc.command('layer.select', { layer: resultLayerId });
  } catch {}
  // Final state, by policy. The result is the visible artwork and the original
  // stays hidden as the backup. The painted layer is a source and stays hidden.
  // The B/W selector stays visible only when the result is fully opaque and sits
  // under the result, so it can be inspected without covering the canvas.
  const placedId = resultLayerId ?? undefined;
  let selectorVisible = false;
  let selectorPlacement = null;
  try {
    if (body.replace !== false && layer?.id !== undefined && (!region || swapOriginal)) {
      await pc.command('layer.setProps', { layer: layer.id, visible: false });
    }
    if (sourceMaskId !== null && sourceMaskId !== autoMaskId) {
      await pc.command('layer.setProps', { layer: sourceMaskId, visible: false });
    }
    if (autoMaskId !== null) {
      selectorVisible = Boolean(maskedEdit && done.selectorOpaque);
      await pc.command('layer.setProps', { layer: autoMaskId, visible: selectorVisible });
    }
  } catch {}
  let stack = [];
  try {
    const flat = [];
    const walk = (list) => {
      for (const l of list || []) {
        flat.push(l);
        if (l.children) walk(l.children);
      }
    };
    walk((await pc.layers())?.layers || []);
    stack = flat;
    if (autoMaskId !== null && placedId !== undefined) {
      const selectorAt = flat.findIndex((l) => l.id === autoMaskId);
      const resultAt = flat.findIndex((l) => l.id === placedId);
      if (selectorAt >= 0 && resultAt >= 0 && selectorAt < resultAt) {
        if (selectorVisible) {
          await pc.command('layer.setProps', { layer: autoMaskId, visible: false });
        }
        selectorVisible = false;
        selectorPlacement = 'above-result';
      } else {
        selectorPlacement = 'under-result';
      }
    }
  } catch {}
  const stateOf = (id) => {
    const l = stack.find((x) => x.id === id);
    return l ? { id: l.id, name: l.name, visible: l.visible } : null;
  };
  try {
    fs.appendFileSync(
      path.join(LOG_DIR, 'main.log'),
      `${new Date().toISOString()} edit-final result=${placedId ?? 'none'} ` +
        `selector=${autoMaskId ?? 'none'}:${selectorVisible} placement=${selectorPlacement || 'none'} ` +
        `original=${layer?.id ?? 'none'} painted=${sourceMaskId ?? 'none'}\n`,
    );
  } catch {}

  return {
    ok: true,
    job: done,
    region,
    mode: maskedEdit ? 'mask' : local.mask ? 'inpaint' : region ? 'crop' : 'full',
    source: layer ? { id: layer.id, name: layer.name } : null,
    maskSource: sourceMaskName ? { layer: sourceMaskName, id: sourceMaskId, visible: stateOf(sourceMaskId)?.visible ?? false } : null,
    selector: maskedEdit
      ? { layer: 'EggLab mask (B/W)', id: autoMaskId, visible: selectorVisible, placement: selectorPlacement, state: stateOf(autoMaskId) }
      : null,
    references: [
      ...(layer ? [{ role: 'source', layer: layer.name }] : []),
      ...donorRefs.map((p) => ({ role: 'reference', path: p })),
      ...(maskedEdit
        ? [{ role: 'guide', derivedFrom: 'EggLab mask (B/W)', note: 'the source with the edit area marked in light red' }]
        : []),
    ],
    promptUsed: done.promptUsed || null,
    verify: done.maskVerify || null,
    maskLayer: maskedEdit ? 'EggLab mask (B/W)' : null,
    feather: feathered,
    alpha: done.alpha || null,
    layer: layer ? { id: layer.id, name: layer.name, bounds: layer.bounds } : null,
    placed,
    hiddenOriginal: hidden,
    output,
  };
}

export function startServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (!authorized(req, url)) {
        return json(res, 401, { error: 'Bad or missing EggLab token' });
      }
      handle(req, res, url).catch((err) => {
        json(res, 500, { error: err.message, code: err.code || null });
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      selfUrl = `http://127.0.0.1:${port}`;
      resolve({ server, port, url: selfUrl });
    });
  });
}
