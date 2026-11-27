import { app, BrowserWindow, ipcMain, dialog, screen, shell, protocol, net, globalShortcut } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { onEvent, emit } from './service/bus.mjs';
import { startServer, TOKEN } from './service/http.mjs';
import { getSettings, patchSettings, opencodeModels, ensureDirs } from './service/settings.mjs';
import { engineStatus, listJobs, startJob, cancelJob, cancelAllJobs, cleanupStaleEngines, killActiveEngine } from './service/engine.mjs';
import { modelStatus, startDownloads, cancelDownload, cancelAgentDownloads, retryDownload, useVariant } from './service/models.mjs';
import * as pc from './service/photocraft.mjs';
import * as chat from './service/chat.mjs';
import * as sessions from './service/sessions.mjs';
import * as setup from './service/setup.mjs';
import * as updater from './service/updater.mjs';
import { CONTROL_FILE, DATA_DIR, LOG_DIR, OUT_DIR, PANEL_DIR, TMP_DIR, pruneScratch } from './service/paths.mjs';

protocol.registerSchemesAsPrivileged([
  { scheme: 'egl', privileges: { standard: false, secure: true, supportFetchAPI: true, stream: true } },
]);

let win = null;
let serviceUrl = null;
let dockProc = null;
// The egg floats above PhotoCraft by default. The pin button can opt out.
let pinned = true;

/* ------------------------------------------------------------------ */
/* floating egg shell                                                  */
/* ------------------------------------------------------------------ */

// Collapsed: a single egg with enough transparent gutter for its shadow.
// Expanded: the chat surface. Both are fixed — the shell never resizes freely.
const EGG = { width: 108, height: 128 };
const PANEL = { width: 464, height: 676 };
const WINDOW_STATE_FILE = path.join(DATA_DIR, 'window-state.json');

let shellExpanded = false;
let eggAnchor = null;
let applyingBounds = false;
let suppressMoveUntil = 0;
let windowSaveTimer = 0;

/**
 * Append one line to the main log. Module scope so IPC handlers (session
 * switches, clears, deletes) leave the same evidence as the document watcher —
 * without a line here, a thread change is invisible when a switch goes wrong.
 */
const trace = (msg) => {
  try {
    fs.appendFileSync(path.join(LOG_DIR, 'main.log'), `${new Date().toISOString()} ${msg}\n`);
  } catch {}
};

/**
 * After the user picks a chat in the list, PhotoCraft needs a moment to bring
 * its document to the front. The document watcher stays quiet for this long so
 * it cannot snap the thread back before the canvas catches up.
 */
let holdSyncUntil = 0;

function shellLog(message) {
  try {
    fs.appendFileSync(
      path.join(LOG_DIR, 'main.log'),
      `${new Date().toISOString()} shell ${message}\n`,
    );
  } catch {}
}

function readWindowState() {
  try {
    const raw = JSON.parse(fs.readFileSync(WINDOW_STATE_FILE, 'utf8'));
    const x = Number(raw?.egg?.x);
    const y = Number(raw?.egg?.y);
    if (Number.isFinite(x) && Number.isFinite(y)) return { x: Math.round(x), y: Math.round(y) };
  } catch {}
  return null;
}

function writeWindowState() {
  try {
    fs.writeFileSync(
      WINDOW_STATE_FILE,
      JSON.stringify({ egg: eggAnchor, at: new Date().toISOString() }, null, 2),
      'utf8',
    );
  } catch {}
}

function scheduleWindowSave() {
  clearTimeout(windowSaveTimer);
  windowSaveTimer = setTimeout(() => {
    windowSaveTimer = 0;
    writeWindowState();
  }, 260);
  windowSaveTimer.unref?.();
}

function clampEggAnchor(point) {
  const x = Number(point?.x);
  const y = Number(point?.y);
  const fallback = defaultEggAnchor();
  if (!Number.isFinite(x) || !Number.isFinite(y)) return fallback;
  const display = screen.getDisplayMatching({
    x: Math.round(x),
    y: Math.round(y),
    width: EGG.width,
    height: EGG.height,
  });
  const work = display.workArea;
  return {
    x: Math.round(Math.max(work.x, Math.min(x, work.x + work.width - EGG.width))),
    y: Math.round(Math.max(work.y, Math.min(y, work.y + work.height - EGG.height))),
  };
}

function defaultEggAnchor() {
  const work = screen.getPrimaryDisplay().workArea;
  return {
    x: Math.round(work.x + work.width - EGG.width - 26),
    y: Math.round(work.y + work.height - EGG.height - 26),
  };
}

function applyBounds(bounds) {
  if (!win || win.isDestroyed()) return;
  applyingBounds = true;
  suppressMoveUntil = Date.now() + 400;
  try {
    win.setBounds(bounds, false);
  } finally {
    applyingBounds = false;
  }
}

function shellPayload() {
  return {
    expanded: shellExpanded,
    bounds: win && !win.isDestroyed() ? win.getBounds() : null,
    egg: eggAnchor,
  };
}

function sendShell(expanded) {
  sendToRenderer('egglab:shell', { expanded });
}

function expandShell() {
  if (!win || win.isDestroyed()) return { expanded: false, bounds: null };
  if (shellExpanded) return shellPayload();
  shellLog('expand');
  const current = win.getBounds();
  eggAnchor = clampEggAnchor({ x: current.x, y: current.y });
  const display = screen.getDisplayMatching({
    x: current.x,
    y: current.y,
    width: current.width,
    height: current.height,
  });
  const work = display.workArea;
  const width = Math.min(PANEL.width, work.width);
  const height = Math.min(PANEL.height, work.height);
  // Open upward from the egg, bottom-aligned, then clamp. If there is no room
  // above, fall back to centring on the egg; the work area always wins.
  let x = Math.round(eggAnchor.x + EGG.width / 2 - width / 2);
  let y = Math.round(eggAnchor.y + EGG.height - height);
  if (y < work.y) y = Math.round(eggAnchor.y + EGG.height / 2 - height / 2);
  x = Math.max(work.x, Math.min(x, work.x + work.width - width));
  y = Math.max(work.y, Math.min(y, work.y + work.height - height));
  applyBounds({ x, y, width, height });
  shellExpanded = true;
  try {
    win.setAlwaysOnTop(true, 'floating');
  } catch {}
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  sendShell(true);
  scheduleWindowSave();
  return shellPayload();
}

function collapseShell() {
  if (!win || win.isDestroyed()) return { expanded: false, bounds: null };
  if (!shellExpanded) return shellPayload();
  shellLog('collapse');
  const anchor = clampEggAnchor(eggAnchor || win.getBounds());
  applyBounds({ x: anchor.x, y: anchor.y, width: EGG.width, height: EGG.height });
  shellExpanded = false;
  sendShell(false);
  // Give focus back to PhotoCraft instead of keeping a hidden chat focused.
  try {
    win.blur();
  } catch {}
  scheduleWindowSave();
  return shellPayload();
}

function toggleShell() {
  return shellExpanded ? collapseShell() : expandShell();
}


const IMAGE_ROOTS = [OUT_DIR, TMP_DIR];

function isAllowedFile(file) {
  const resolved = path.resolve(file);
  return IMAGE_ROOTS.some((root) => resolved.toLowerCase().startsWith(path.resolve(root).toLowerCase()));
}

/* ------------------------------------------------------------------ */
/* window                                                              */
/* ------------------------------------------------------------------ */

function createWindow() {
  eggAnchor = clampEggAnchor(readWindowState() || defaultEggAnchor());
  win = new BrowserWindow({
    x: eggAnchor.x,
    y: eggAnchor.y,
    width: EGG.width,
    height: EGG.height,
    minWidth: EGG.width,
    minHeight: EGG.height,
    maxWidth: PANEL.width,
    maxHeight: PANEL.height,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    show: false,
    skipTaskbar: false,
    title: 'EggLab',
    webPreferences: {
      preload: path.join(PANEL_DIR, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  win.loadFile(path.join(PANEL_DIR, 'renderer', 'index.html'));

  // Renderer visibility: console errors and crashes go to main.log, so a
  // silent renderer failure (e.g. an exception that kills UI wiring) is
  // diagnosable from the logs instead of "the panel cannot open".
  win.webContents.on('console-message', (event, level, message) => {
    // Electron emits both (event, level, message) and a single details object
    // depending on version; support both so errors are never silently lost.
    const lvl = typeof level === 'string' ? level : event?.level;
    const msg = typeof message === 'string' ? message : event?.message;
    if (lvl === 'error' || lvl === 'warning') {
      trace(`renderer console ${lvl}: ${String(msg || '').slice(0, 500)}`);
    }
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    trace(`renderer gone: ${JSON.stringify(details).slice(0, 400)}`);
    // Self-heal: a crashed renderer must not leave a dead window. Reload it
    // after a beat; the app state is all service-side, so a reload is cheap.
    if (win && !win.isDestroyed()) {
      setTimeout(() => {
        try {
          if (win && !win.isDestroyed()) win.webContents.reload();
        } catch {}
      }, 800);
    }
  });
  win.webContents.on('did-fail-load', (_event, code, desc, url) => {
    trace(`renderer load failed: ${code} ${desc} ${url}`);
  });

  win.once('ready-to-show', () => {
    try {
      win.setAlwaysOnTop(true, 'floating');
    } catch {}
    // The egg must not pull focus away from the editor when it appears.
    win.showInactive();
  });

  win.on('closed', () => {
    shellLog('window closed');
    writeWindowState();
    win = null;
    stopDockWatcher();
  });

  win.on('move', () => {
    if (!win || win.isDestroyed() || applyingBounds) return;
    // setBounds emits move asynchronously on Windows. Ignore the echo so the
    // remembered egg anchor is not rewritten from a programmatic resize.
    if (Date.now() < suppressMoveUntil) return;
    const b = win.getBounds();
    if (shellExpanded) {
      // Dragging the chat header moves the panel. Collapsing should put the egg
      // back near the panel's bottom-left, not at its old pre-expansion spot.
      eggAnchor = clampEggAnchor({ x: b.x + 18, y: b.y + b.height - EGG.height - 18 });
    } else {
      eggAnchor = clampEggAnchor({ x: b.x, y: b.y });
    }
    scheduleWindowSave();
  });
}

function sendToRenderer(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/**
 * Show a chat's document in PhotoCraft — open the file if it is closed,
 * activate its tab if it is not — so the chat list and the canvas always
 * describe the same thing. Returns false for a key PhotoCraft cannot show
 * (`no-document`, a draft tab that is gone, the editor closed); the chat then
 * simply stays where the user put it until the canvas itself changes.
 */
async function showDocumentForKey(key) {
  const value = String(key || '');
  if (!value || value === 'no-document') return false;
  if (value.toLowerCase().endsWith('.pcraft')) {
    await pc.openProject({ path: value });
    return true;
  }
  if (value.startsWith('untitled:')) {
    const name = value.split(':')[1] || '';
    const state = await pc.projectState();
    const hit = (state.documents || []).find(
      (d) => String(d.label || '').replace(/\.(pcraft|psd|psb)$/i, '') === name,
    );
    if (!hit) return false;
    if (!hit.active) await pc.command('document.activate', { document: hit.index });
    return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* docking to the PhotoCraft window                                    */
/* ------------------------------------------------------------------ */

function stopDockWatcher() {
  if (dockProc) {
    try {
      dockProc.kill();
    } catch {}
    dockProc = null;
  }
}

function toggleDock() {
  // Docking belonged to the old full-size panel. The egg shell positions
  // itself, so this stays off and the checkbox is no longer shown.
  stopDockWatcher();
  return false;
}

/* ------------------------------------------------------------------ */
/* app                                                                 */
/* ------------------------------------------------------------------ */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    trace('ready');
    const server = await startServer();
    serviceUrl = server.url;
    trace(`server ${serviceUrl}`);
    fs.writeFileSync(
      CONTROL_FILE,
      JSON.stringify({ url: serviceUrl, token: TOKEN, at: new Date().toISOString() }, null, 2),
      'utf8',
    );
    trace('control written');
    chat.buildWorkspace({ url: serviceUrl, token: TOKEN });
    trace('workspace built');
    try {
      ensureDirs();
    } catch {}
    chat.sanitizeOnLoad();
    trace('history sanitized');
    // A tombstone outlives a crash between "deleted" and "unbind": drop any
    // binding it still matches before the backups/sweeps look at the registry.
    const purgedBindings = sessions.purgeDeletedThreads();
    if (purgedBindings) trace(`purged ${purgedBindings} deleted chat binding(s)`);
    const sessionBackup = chat.backupSessionData();
    if (sessionBackup) trace(`session backup -> ${sessionBackup}`);
    const pruned = chat.pruneOrphanThreads();
    if (pruned) trace(`pruned ${pruned} orphan chat transcript(s)`);
    const empties = chat.pruneEmptyThreads();
    if (empties) trace(`pruned ${empties} empty chat thread(s)`);
    const scratch = pruneScratch();
    if (scratch) trace(`pruned ${scratch} stale reference render(s)`);
    // Repair transcripts lost to the old lossy filename scheme. OpenCode still
    // has the messages, so this is a background restore, not a blank chat.
    chat
      .recoverMissingHistories(24)
      .then(async (recovered) => {
        if (recovered) trace(`recovered ${recovered} transcript(s) from OpenCode`);
        // After recovery, drop only bindings that a successful live session
        // list proves are gone. The panel transcript remains; the next message
        // starts a fresh OpenCode session instead of failing on a dead id.
        const cleared = await sessions.repairDeadSessions();
        if (cleared) trace(`cleared ${cleared} dead OpenCode session binding(s)`);
      })
      .catch((err) => trace(`transcript recovery failed: ${err.message}`));

    /**
     * Follow the active PhotoCraft document: when the user switches tabs in
     * the editor, the chat switches to that project's own thread and session.
     * Polling is the only signal available — PhotoCraft emits no event when the
     * active document changes.
     *
     * "Is the chat on the right thread?" is answered by comparing PhotoCraft's
     * document with `chat.documentKey()` — the thread actually loaded. It used
     * to be answered against a remembered copy of the key, so any change made
     * outside this watcher (a pick in the session list, a cleared or deleted
     * chat) left the two out of step: the guard then matched on every poll and
     * returned early, and the chat stayed on a thread the canvas no longer
     * owned — it stopped following the document until the next tab switch.
     */
    let lastDocKey = null;
    let lastDocTab = null;
    let lastPcUp = null;
    const NO_DOCUMENT = 'no-document';
    const isUntitledKey = (value) => typeof value === 'string' && value.startsWith('untitled:');
    const isPcraftKey = (value) => typeof value === 'string' && value.toLowerCase().endsWith('.pcraft');
    const syncDocument = async () => {
      try {
        // An agent run may create a document. Switching the chat thread while
        // the run is streaming would move the transcript out from under it, so
        // wait until the turn ends — the migration below then carries the whole
        // exchange onto the new document.
        if (chat.isBusy()) return;
        const state = await pc.projectState();
        if (chat.isBusy()) return;

        const doc = state.document || null;
        // PhotoCraft closed (or its menu could not be read) is not a document
        // change. Detaching to the no-document chat there used to hide the
        // conversation the user was reading as soon as the editor went away.
        const pcUp = Boolean(state.running) && (!state.error || Boolean(doc));
        if (!pcUp) {
          if (lastPcUp !== false) {
            lastPcUp = false;
            sendToRenderer('egglab:event', {
              type: 'chat',
              action: 'document',
              docKey: chat.documentKey(),
              doc: null,
            });
          }
          return;
        }
        // Coming back up after the editor closed: the status line was cleared
        // then, so a document event must go out even if nothing else moved.
        const cameUp = lastPcUp !== true;
        lastPcUp = true;

        const key = doc?.key || NO_DOCUMENT;
        const activeTab = Array.isArray(state.documents)
          ? state.documents.find((d) => d.active)?.index ?? null
          : null;

        const attachedKey = chat.documentKey();
        const docChanged = key !== lastDocKey;
        const tabChanged = activeTab !== lastDocTab;
        // Nothing moved and the chat already owns this thread.
        if (key === attachedKey && !docChanged && !tabChanged && !cameUp) return;
        // The user just picked a chat and PhotoCraft is still bringing its
        // document forward; do not drag the thread back while it does.
        if (Date.now() < holdSyncUntil) return;

        const runAt = chat.lastRunStartedAt();
        const runEndedAt = chat.lastRunEndedAt();
        const runDoc = chat.lastRunDocumentKey();
        const justFinishedRun = Boolean(runEndedAt) && Date.now() - runEndedAt < 15000;
        const recentRun = Boolean(runAt) && Date.now() - runAt < 30 * 60 * 1000;

        // The agent left the document it was working in. A chat that owns a
        // document must never follow another canvas: retargeting the thread is
        // what left two chats on one document and the working document with
        // none. Put the working document back and keep the thread where it is.
        // Only a chat that started with no document may adopt a new canvas.
        // EXCEPTION (Phase C, beta profile): when the agent deliberately
        // created a second canvas for a new piece mid-run, the conversation
        // follows that piece instead of yanking the old canvas back.
        const runCanvasSwitch = justFinishedRun && chat.consumeRunCanvasSwitch();
        if (
          justFinishedRun &&
          !runCanvasSwitch &&
          runDoc &&
          runDoc !== NO_DOCUMENT &&
          attachedKey === runDoc &&
          key !== runDoc
        ) {
          const restored = await showDocumentForKey(runDoc).catch(() => false);
          lastDocKey = runDoc;
          lastDocTab = null;
          trace(
            `agent left document ${runDoc} -> ${key}; ` +
              (restored ? 'restored the working document' : 'could not restore the working document'),
          );
          sendToRenderer('egglab:event', { type: 'chat', action: 'document', docKey: runDoc, doc: null });
          return;
        }

        // A render/scratch path opened as a document is a preview, not a chat
        // scope (Phase A): it gets no thread, no migration and never moves
        // the conversation.
        if (chat.isTransientKey(key)) {
          lastDocKey = key;
          lastDocTab = activeTab;
          sendToRenderer('egglab:event', { type: 'chat', action: 'document', docKey: chat.documentKey(), doc, transientDoc: true });
          return;
        }

        // Saving an untitled document for the first time changes its identity
        // (untitled:<name>:<w>x<h> -> the real path). Carry its conversation
        // across, but only when the SAME PhotoCraft tab changed identity: a
        // switch between two existing documents must never move a transcript.
        const draftBecameFile =
          lastDocTab !== null &&
          activeTab === lastDocTab &&
          isUntitledKey(lastDocKey) &&
          key !== NO_DOCUMENT &&
          !isUntitledKey(key) &&
          attachedKey === lastDocKey;

        // A chat with no document may adopt the canvas the agent creates for
        // it. An attached chat never migrates (handled above).
        let savedDuringRun = false;
        if (recentRun && attachedKey === NO_DOCUMENT && isPcraftKey(key) && key !== lastDocKey) {
          try {
            savedDuringRun = fs.statSync(key).mtimeMs >= runAt - 2000;
          } catch {}
        }
        const docAppearedDuringRun = key !== lastDocKey;
        const createdForDetachedChat =
          recentRun &&
          attachedKey === NO_DOCUMENT &&
          docAppearedDuringRun &&
          (savedDuringRun || isUntitledKey(key));

        let migrateFrom = draftBecameFile || createdForDetachedChat ? attachedKey : null;
        if (migrateFrom) {
          if (chat.migrateThread(migrateFrom, key, doc?.name || null)) trace(`thread migrated -> ${key}`);
        }

        // Document-driven chats (revised concept, research-backed): the canvas
        // you look at has its own conversation, like Notion binds its AI panel
        // to the current page. Phase B uid identity means a chat NEVER moves
        // between documents, so following the canvas is predictable: switching
        // tabs reveals that document's own chat (minting a uid chat when the
        // document has none). Transient renders are still not chat scopes.
        // EXCEPTION: a pinned chat (explicit pick whose canvas could not be
        // opened) holds the watcher while PhotoCraft keeps showing the same
        // document — otherwise it would drag the conversation straight back.
        const pin = chat.chatPinState();
        if (pin) {
          if (pin.threadKey === chat.currentThreadId() && key === pin.docKey) {
            sendToRenderer('egglab:event', { type: 'chat', action: 'document', docKey: chat.documentKey(), doc });
            return;
          }
          chat.clearChatPin();
        }
        const result = chat.useDocument(key, doc?.name || null);
        if (result.changed) trace(`thread -> ${key}`);
        // Advance the watcher state only after the chat actually adopted the
        // document. Updating these first meant a failed adoption (busy/race)
        // was treated as "already synced" on every later poll.
        lastDocKey = key;
        lastDocTab = activeTab;
      } catch (err) {
        // PhotoCraft being closed is normal; keep the last thread.
      }
    };
    syncDocument();
    const docTimer = setInterval(syncDocument, 2500);
    docTimer.unref?.();
    app.on('will-quit', () => clearInterval(docTimer));

    protocol.handle('egl', (request) => {
      try {
        const url = new URL(request.url);
        const file = decodeURIComponent(url.pathname.replace(/^\//, ''));
        if (!isAllowedFile(file) || !fs.existsSync(file)) {
          return new Response('Not found', { status: 404 });
        }
        return net.fetch(pathToFileURL(file).toString());
      } catch {
        return new Response('Bad request', { status: 400 });
      }
    });
    trace('protocol registered');

    createWindow();
    trace('window created');
    // Leftover engine processes from a crashed/killed job hold VRAM and make
    // the next render fail at a random stage. Sweep ours before anything runs.
    try {
      cleanupStaleEngines(true);
    } catch {}
    try {
      trace(`auto-update ${updater.initUpdater() ? 'armed' : 'unavailable (dev build)'}`);
    } catch (err) {
      trace(`auto-update init failed ${err?.message || err}`);
    }

    // One shortcut brings the assistant back from anywhere. It must never be
    // the only way to reach the egg, so failures are logged, not fatal.
    try {
      const ok = globalShortcut.register('CommandOrControl+Alt+E', () => {
        if (shellExpanded) collapseShell();
        else expandShell();
      });
      trace(`shortcut Ctrl+Alt+E ${ok ? 'registered' : 'unavailable'}`);
    } catch (err) {
      trace(`shortcut failed ${err?.message || err}`);
    }
    app.on('will-quit', () => {
      try {
        globalShortcut.unregisterAll();
      } catch {}
      // Do not leave a render process holding 6 GB of VRAM after EggLab exits.
      try {
        killActiveEngine();
      } catch {}
    });
  }).catch((err) => {
    try {
      fs.appendFileSync(path.join(LOG_DIR, 'main.log'), `STARTUP FAILED ${err?.stack || err}\n`);
    } catch {}
  });

  app.on('window-all-closed', () => {
    stopDockWatcher();
    pc.resetBridge();
    app.quit();
  });
}

/* ------------------------------------------------------------------ */
/* events + ipc                                                        */
/* ------------------------------------------------------------------ */

onEvent((event) => {
  sendToRenderer('egglab:event', event);
  if (event.type === 'job') {
    chat.upsertJobCard(event.job, event.job.status !== 'running');
  }
});

ipcMain.handle('app:state', async () => ({
  settings: getSettings(),
  engine: engineStatus(),
  models: modelStatus(),
  photocraft: await pc.status(),
  chat: chat.getHistory(),
  jobs: listJobs().slice(0, 8),
  serviceUrl,
  outDir: OUT_DIR,
  busy: chat.isBusy(),
  pinned,
  version: app.getVersion(),
}));

ipcMain.handle('settings:patch', (e, patch) => {
  const before = getSettings().quality?.steps;
  const next = patchSettings(patch);
  // A step count silently reverting to the legacy 20 is the exact failure that
  // shipped soft renders for weeks. Record who changed it.
  if (patch?.quality?.steps !== undefined && patch.quality.steps !== before) {
    try {
      fs.appendFileSync(
        path.join(LOG_DIR, 'main.log'),
        `${new Date().toISOString()} settings quality.steps ${before} -> ${patch.quality.steps} (renderer)\n`
      );
    } catch {}
  }
  // The agent workspace declares the selected model's capabilities (vision,
  // tools), points the local provider config at it, and rebuilds the always-on
  // v2 core plus the live runtime snapshot. Skill bodies and references stay on
  // disk and load through egglab_read_knowledge, so a settings change never
  // leaves a monolithic prompt out of date.
  if (serviceUrl) {
    try {
      chat.buildWorkspace({ url: serviceUrl, token: TOKEN });
    } catch {}
  }
  return next;
});
ipcMain.handle('opencode:models', async (e, { force } = {}) => {
  return await opencodeModels(force);
});
ipcMain.handle('opencode:report', async (e, { force } = {}) => {
  return await setup.opencodeInfo(Boolean(force));
});
ipcMain.handle('opencode:setPath', async (e, file) => {
  const status = await setup.setOpenCode(file);
  if (serviceUrl) {
    try {
      chat.buildWorkspace({ url: serviceUrl, token: TOKEN });
    } catch {}
  }
  return status;
});
ipcMain.handle('models:setFolder', async (e, folder) => {
  const status = await setup.setModelsFolder(folder);
  if (serviceUrl) {
    try {
      chat.buildWorkspace({ url: serviceUrl, token: TOKEN });
    } catch {}
  }
  return status;
});
ipcMain.handle('models:setPath', async (e, { role, path: file } = {}) => {
  const status = await setup.setModelFile(role, file);
  if (serviceUrl) {
    try {
      chat.buildWorkspace({ url: serviceUrl, token: TOKEN });
    } catch {}
  }
  return status;
});

ipcMain.handle('job:start', (e, payload) => startJob(payload));
ipcMain.handle('job:cancel', (e, id) => cancelJob(id));
ipcMain.handle('job:wait', async (e, id) => {
  const { waitForJob } = await import('./service/engine.mjs');
  return await waitForJob(id);
});
ipcMain.handle('jobs:list', () => listJobs().slice(0, 20));

ipcMain.handle('models:list', () => modelStatus());
ipcMain.handle('models:download', (e, { ids, variant }) => startDownloads(ids, variant));
ipcMain.handle('models:cancel', (e, id) => cancelDownload(id));
ipcMain.handle('models:retry', (e, id) => retryDownload(id));
ipcMain.handle('models:use', (e, { id, file }) => useVariant(id, file));

ipcMain.handle('setup:status', () => setup.setupStatus());
ipcMain.handle('setup:action', async (e, { action, payload } = {}) => {
  switch (action) {
    case 'detect': {
      const status = await setup.refreshDetection();
      if (serviceUrl) {
        try {
          chat.buildWorkspace({ url: serviceUrl, token: TOKEN });
        } catch {}
      }
      return status;
    }
    case 'photocraft': {
      const status = await setup.setPhotoCraft(payload?.path);
      if (serviceUrl) {
        try {
          chat.buildWorkspace({ url: serviceUrl, token: TOKEN });
        } catch {}
      }
      return status;
    }
    case 'engine':
      return await setup.installEngine(payload?.variant || 'auto', Boolean(payload?.force));
    case 'opencode':
      return await setup.installOpencode();
    case 'opencode-desktop':
      return await setup.installOpencodeDesktop();
    case 'import-model':
      return await setup.importModelFile(payload?.path);
    case 'models-folder': {
      const status = await setup.setModelsFolder(payload?.folder);
      if (serviceUrl) {
        try {
          chat.buildWorkspace({ url: serviceUrl, token: TOKEN });
        } catch {}
      }
      return status;
    }
    case 'model-file': {
      const status = await setup.setModelFile(payload?.role, payload?.path);
      if (serviceUrl) {
        try {
          chat.buildWorkspace({ url: serviceUrl, token: TOKEN });
        } catch {}
      }
      return status;
    }
    case 'opencode-path': {
      const status = await setup.setOpenCode(payload?.path);
      if (serviceUrl) {
        try {
          chat.buildWorkspace({ url: serviceUrl, token: TOKEN });
        } catch {}
      }
      return status;
    }
    case 'opencode-report':
      return await setup.opencodeInfo(Boolean(payload?.force));
    case 'complete':
      return await setup.completeSetup();
    default:
      throw new Error(`Unknown setup action: ${action}`);
  }
});
ipcMain.handle('update:status', () => updater.updateStatus());
ipcMain.handle('update:check', async () => await updater.checkForUpdates({ userInitiated: true }));
ipcMain.handle('update:install', () => updater.installUpdate());

ipcMain.handle('dialog:pickApp', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Locate PhotoCraft',
    properties: ['openFile'],
    filters: [{ name: 'Applications', extensions: ['exe'] }],
  });
  return res.canceled ? '' : res.filePaths[0] || '';
});
ipcMain.handle('dialog:pickModel', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Choose a model file',
    properties: ['openFile'],
    filters: [{ name: 'Model files', extensions: ['safetensors', 'gguf'] }],
  });
  return res.canceled ? '' : res.filePaths[0] || '';
});

ipcMain.handle('dialog:pickOpenCode', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'OpenCode executable',
    properties: ['openFile'],
    filters: [{ name: 'Applications', extensions: ['exe'] }],
  });
  return res.canceled ? '' : res.filePaths[0] || '';
});

ipcMain.handle('dialog:pickFolder', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Choose a folder',
    properties: ['openDirectory', 'createDirectory'],
  });
  return res.canceled ? '' : res.filePaths[0] || '';
});

ipcMain.handle('chat:send', async (e, { text, files, refMap }) => {
  // Close the 2.5 s polling gap: if PhotoCraft is already showing another
  // document, send the message to that document's thread instead of the
  // thread the watcher last saw. This is the stale-binding path that used to
  // put a real conversation under the wrong canvas.
  if (!chat.isBusy()) {
    try {
      const state = await pc.projectState();
      const doc = state.document;
      if (doc?.key && doc.key !== chat.documentKey()) {
        chat.useDocument(doc.key, doc.name || null);
        sendToRenderer('egglab:event', {
          type: 'chat',
          action: 'document',
          docKey: doc.key,
          doc,
        });
      }
    } catch {}
  }
  return await chat.send(text, files || [], refMap || {});
});
ipcMain.handle('chat:stop', () => ({ stopped: chat.stop(), canceled: cancelAllJobs(), downloads: cancelAgentDownloads() }));
// Returns false (instead of always true) when the agent is mid-run, so the
// renderer keeps the timeline instead of blanking a reply that never landed.
ipcMain.handle('chat:clear', () => chat.clearHistory());
ipcMain.handle('chat:history', () => chat.getHistory());
ipcMain.handle('sessions:list', () => sessions.list());
// Renderer diagnostics land in main.log: a dead composer names its own error.
ipcMain.handle('ui:error', (e, { message }) => {
  trace(`ui ${String(message || '').slice(0, 500)}`);
  return true;
});
// Inline notice actions: bring the chat's canvas forward, or make a fresh one.
ipcMain.handle('sessions:openDoc', async (e, { docKey }) => {
  const shown = await showDocumentForKey(docKey).catch(() => false);
  return { shown: Boolean(shown) };
});
ipcMain.handle('chat:createCanvas', async (e, { key }) => {
  await pc.newDocument({ source: 'panel' });
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const state = await pc.projectState().catch(() => null);
  const newKey = state?.document?.key;
  if (!newKey) throw new Error('PhotoCraft did not open a new canvas.');
  chat.moveThread(key, newKey, state.document?.name || null);
  chat.clearChatPin();
  return { key: newKey };
});
ipcMain.handle('sessions:rename', (e, { key, title }) => sessions.rename(key, title));
ipcMain.handle('sessions:delete', (e, key) => chat.deleteThread(key));
ipcMain.handle('sessions:move', (e, { key, docKey, title }) => chat.moveThread(key, docKey, title || null));
// Explicit "switch to the chat of the canvas on screen" (Phase A): the watcher
// no longer moves chats on tab changes, so the renderer's canvas badge calls
// this instead.
ipcMain.handle('sessions:useDocument', async (e, { docKey, title }) => {
  if (chat.isBusy()) {
    throw new Error('The agent is still working. Wait for it to finish or press stop before switching chats.');
  }
  const res = chat.useDocument(docKey, title || null);
  if (res.changed) trace(`thread -> ${res.threadId} (canvas badge)`);
  holdSyncUntil = Date.now() + 4000;
  return res;
});
ipcMain.handle('sessions:switch', async (e, { key }) => {
  if (chat.isBusy()) {
    throw new Error('The agent is still working. Wait for it to finish or press stop before switching chats.');
  }
  // `key` is a THREAD id. useThread resolves the document it belongs to, so a
  // secondary conversation (`<doc>#2`) switches to the right document instead
  // of treating the thread id as one.
  const res = chat.useThread(key);
  if (res.changed) trace(`thread -> ${key} (picked in the chat list)`);

  // The chat follows the active PhotoCraft document, so picking a chat has to
  // bring its document forward too. Without this the watcher pulled the thread
  // back to the previous document on its next poll — a session switch that
  // appeared to fail.
  holdSyncUntil = Date.now() + 4000;
  const shown = await showDocumentForKey(chat.documentKey()).catch(() => false);
  // Opening a large project can take longer than the initial hold. Extend it
  // from the completed open, otherwise the 2.5 s watcher can run against the
  // old active tab and pull the chat back — the "switch did nothing" symptom.
  holdSyncUntil = Date.now() + 4000;
  if (shown) trace(`document follows chat -> ${chat.documentKey()}`);
  else if (res.threadId) {
    // The picked chat's canvas could not be opened: pin the conversation so
    // the watcher does not drag it back while the user decides in the popup.
    chat.pinChatSwitch(res.threadId, lastDocKey);
    trace(`chat pinned (canvas unavailable) -> ${res.threadId}`);
  }
  return { ...res, documentOpened: shown, history: chat.getHistory() };
});
ipcMain.handle('sessions:newThread', () => chat.newThread());

ipcMain.handle('pc:status', () => pc.status());
ipcMain.handle('pc:launch', () => pc.launch());
ipcMain.handle('pc:layers', () => pc.layers());
ipcMain.handle('pc:preview', () => pc.preview());
ipcMain.handle('pc:place', async (e, { path: file, options }) => {
  const result = await pc.place(file, options || {});
  return { ...result, save: await pc.autosave('placed a layer') };
});
ipcMain.handle('pc:newDoc', (e, opts) => pc.newDocument(opts || {}));
ipcMain.handle('pc:exportLayers', (e, opts) => pc.exportLayers(opts || {}));
ipcMain.handle('pc:exportActive', () => pc.exportActiveLayer());
ipcMain.handle('pc:exportLayer', (e, { name, makeVisible }) => pc.exportLayerByName(name, { makeVisible }));
ipcMain.handle('pc:exportMentions', (e, { names }) => pc.exportLayersByMentions(names || []));
ipcMain.handle('pc:command', (e, { id, params }) => pc.command(id, params || {}));

ipcMain.handle('pc:project', () => pc.projectState());
ipcMain.handle('pc:save', (e, opts) => pc.save(opts || {}));
ipcMain.handle('pc:openProject', (e, opts) => pc.openProject(opts || {}));
ipcMain.handle('pc:closeDoc', (e, opts) => pc.closeDocument(opts || {}));
ipcMain.handle('pc:recentProjects', (e, limit) => pc.recentProjects(Number(limit) || 20));
ipcMain.handle('pc:projectPath', (e, { name, ext }) => ({ path: pc.projectPathFor(name, { ext }) }));

ipcMain.handle('pc:editActive', async (e, payload) => {
  const exported = await pc.exportActiveLayer();
  const size = exported?.path ? pc.pngSize(exported.path) : null;
  const job = startJob({
    ...payload,
    images: [exported.path],
    width: payload.width || (size ? Math.min(1024, size.width) : undefined),
    height: payload.height || (size ? Math.min(1024, size.height) : undefined),
  });
  const done = await (await import('./service/engine.mjs')).waitForJob(job.id);
  if (done.status !== 'done') return { ok: false, job: done };
  const doc = await pc.inspect();
  const d = doc?.document || doc || {};
  const bounds = exported.layer?.bounds;
  const placed = bounds
    ? await pc.placeAtBounds(done.outPath, bounds, {
        name: exported.layer?.name ? `${exported.layer.name} (EggLab)` : 'EggLab edit',
      })
    : await pc.place(done.outPath, {
        fit: true,
        name: 'EggLab edit',
        center: [(d.width || 0) / 2, (d.height || 0) / 2],
      });
  let hidden = null;
  if (payload.replace !== false && exported.layer?.id !== undefined) {
    try {
      hidden = await pc.command('layer.setProps', { layer: exported.layer.id, visible: false });
    } catch (err) {
      hidden = { error: err.message };
    }
  }
  return { ok: true, job: done, layer: exported.layer, placed, hidden, save: await pc.autosave('edited a layer') };
});

ipcMain.handle('dialog:pickImages', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Add reference images',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tif', 'tiff'] }],
  });
  return res.canceled ? [] : res.filePaths;
});

ipcMain.handle('fs:open', (e, file) => shell.openPath(file));
ipcMain.handle('fs:reveal', (e, file) => shell.showItemInFolder(file));
ipcMain.handle('shell:external', (e, url) => shell.openExternal(url));

ipcMain.handle('window:min', () => win?.minimize());
ipcMain.handle('window:close', () => {
  shellLog('window:close ipc');
  return win?.close();
});
ipcMain.handle('window:pin', (e, value) => {
  pinned = Boolean(value);
  win?.setAlwaysOnTop(pinned, 'floating');
  return pinned;
});
ipcMain.handle('window:dock', () => toggleDock());
ipcMain.handle('window:bounds', () => win?.getBounds() || null);
ipcMain.handle('window:setWidth', () => win?.getBounds() || null);

/* ---- floating egg shell --------------------------------------------- */
ipcMain.handle('egg:state', () => shellPayload());
ipcMain.handle('egg:expand', () => expandShell());
ipcMain.handle('egg:collapse', () => collapseShell());
ipcMain.handle('egg:bounds', () => (win && !win.isDestroyed() ? win.getBounds() : null));
ipcMain.handle('egg:move', (e, point = {}) => {
  if (!win || win.isDestroyed() || shellExpanded) return null;
  const x = Number(point?.x);
  const y = Number(point?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const display = screen.getDisplayNearestPoint({
    x: Math.round(x + EGG.width / 2),
    y: Math.round(y + EGG.height / 2),
  });
  const work = display.workArea;
  const nx = Math.max(work.x, Math.min(Math.round(x), work.x + work.width - EGG.width));
  const ny = Math.max(work.y, Math.min(Math.round(y), work.y + work.height - EGG.height));
  applyBounds({ x: nx, y: ny, width: EGG.width, height: EGG.height });
  eggAnchor = { x: nx, y: ny };
  return eggAnchor;
});
ipcMain.handle('egg:drag-end', () => {
  writeWindowState();
  return shellPayload();
});
