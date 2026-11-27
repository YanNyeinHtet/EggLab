/* EggLab panel renderer — no framework, talks to the main process only. */
const $ = (sel) => document.querySelector(sel);
const api = window.egglab;

const ASPECTS = {
  '1:1': [1024, 1024],
  '4:3': [1152, 864],
  '3:4': [864, 1152],
  '3:2': [1152, 768],
  '2:3': [768, 1152],
  '16:9': [1152, 640],
  '9:16': [640, 1152],
  '2:1': [1280, 640],
  '1:2': [640, 1280],
};

const S = {
  settings: null,
  engine: null,
  models: null,
  pc: null,
  items: [],
  refs: [],
  refMentions: new Map(),
  mention: { open: false, items: [], index: 0, token: null },
  egg: { scale: 1, ratio: '1:1', customW: '', customH: '' },
  pcLayerCache: [],
  pcLayerSeq: 0,
  docKey: 'no-document',
  threadKey: null,
  visibleCanvas: null,
  threadTitle: null,
  pcDoc: null,
  sessions: { currentKey: null, docs: [] },
  jobs: new Map(),
  busy: false,
  pinned: false,
  outDir: '',
  nodeIndex: new Map(),
  modelDl: new Map(),
  setup: null,
  providers: null,
  providersLoaded: false,
  ocSearch: '',
  ocToggled: new Set(),
  ocExpanded: new Set(),
};

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function md(text) {
  let t = esc(text);
  t = t.replace(/```([\s\S]*?)```/g, (_m, code) => `<code class="block">${code.trim()}</code>`);
  t = t.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  t = t.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  const lines = t.split('\n');
  let out = '';
  let inList = false;
  for (const line of lines) {
    const li = line.match(/^\s*[-*•]\s+(.*)$/);
    if (li) {
      if (!inList) {
        out += '<ul>';
        inList = true;
      }
      out += `<li>${li[1]}</li>`;
      continue;
    }
    if (inList) {
      out += '</ul>';
      inList = false;
    }
    if (!line.trim()) continue;
    out += `<p>${line}</p>`;
  }
  if (inList) out += '</ul>';
  return out || '<p></p>';
}

function friendly(err) {
  let msg = err?.message || String(err);
  msg = msg.replace(/^Error invoking remote method '[^']+':\s*/i, '');
  msg = msg.replace(/^Error:\s*/i, '');
  // OpenCode keeps its sessions in one shared SQLite database and a newer
  // client migrates it forward. The old binary then fails on every run; say so
  // in words instead of surfacing "no such column: project_id".
  if (/no such column|no such table/i.test(msg) && /project|session/i.test(msg)) {
    return 'EggLab found an outdated OpenCode binary for the current OpenCode data. Open Setup and install OpenCode again (or update OpenCode), then retry.';
  }
  return msg;
}

let toastTimer = 0;
function toast(message, kind = '') {
  const box = document.createElement('div');
  box.className = `toast ${kind}`;
  box.textContent = message;
  $('#toasts').appendChild(box);
  setTimeout(() => box.remove(), 3800);
}

function fmtTime(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`;
}

/* ------------------------------------------------------------------ */
/* floating egg shell                                                  */
/* ------------------------------------------------------------------ */

const shell = { expanded: false, switching: false };

/**
 * Switch the DOM between the egg and the chat surface. The Electron window
 * itself is resized by the main process; this only animates the contents.
 */
function applyShellExpanded(expanded, { focus = true } = {}) {
  shell.expanded = Boolean(expanded);
  document.body.classList.toggle('shell-expanded', shell.expanded);
  document.body.classList.toggle('shell-collapsed', !shell.expanded);
  const orb = $('#eggOrb');
  if (shell.expanded) {
    orb?.classList.remove('has-news');
    if (focus) {
      setTimeout(() => {
        if (document.querySelector('.modal.on')) return;
        const input = $('#input');
        if (input) input.focus();
      }, 240);
    }
  } else {
    // Never leave keyboard focus trapped in a window that just became an egg.
    const active = document.activeElement;
    if (active && typeof active.blur === 'function') active.blur();
    closeSessions();
    if ($('#drawer')?.classList.contains('open')) closeDrawer();
  }
}

async function expandEgg() {
  if (shell.expanded || shell.switching) return;
  shell.switching = true;
  try {
    const res = await api.eggExpand();
    applyShellExpanded(Boolean(res?.expanded));
  } catch (err) {
    toast(friendly(err), 'error');
  } finally {
    shell.switching = false;
  }
}

async function collapseEgg() {
  if (!shell.expanded || shell.switching) return;
  shell.switching = true;
  // Fade the panel before the window shrinks so the resize never clips it.
  document.body.classList.add('shell-leaving');
  await new Promise((resolve) => setTimeout(resolve, 120));
  document.body.classList.remove('shell-leaving');
  try {
    const res = await api.eggCollapse();
    applyShellExpanded(Boolean(res?.expanded));
  } catch (err) {
    applyShellExpanded(false);
    toast(friendly(err), 'error');
  } finally {
    shell.switching = false;
  }
}

function toggleEgg() {
  return shell.expanded ? collapseEgg() : expandEgg();
}

function markEggNews() {
  if (!shell.expanded) $('#eggOrb')?.classList.add('has-news');
}

/** Click vs drag on the egg. The threshold keeps tiny hand jitters clickable. */
function initEggDrag() {
  const orb = $('#eggOrb');
  if (!orb) return;
  let drag = null;

  orb.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || shell.expanded) return;
    e.preventDefault();
    try {
      orb.setPointerCapture(e.pointerId);
    } catch {}
    drag = {
      pointerId: e.pointerId,
      startX: e.screenX,
      startY: e.screenY,
      // clientX/Y are viewport-relative, so screenX - clientX is the window x.
      offsetX: e.clientX,
      offsetY: e.clientY,
      moved: false,
    };
    document.body.classList.add('egg-dragging');
  });

  orb.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const dx = e.screenX - drag.startX;
    const dy = e.screenY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    api.eggMove(e.screenX - drag.offsetX, e.screenY - drag.offsetY).catch(() => {});
  });

  const finish = async (e) => {
    if (!drag) return;
    if (e && e.pointerId !== undefined && e.pointerId !== drag.pointerId) return;
    const moved = drag.moved;
    const pointerId = drag.pointerId;
    drag = null;
    document.body.classList.remove('egg-dragging');
    try {
      orb.releasePointerCapture(pointerId);
    } catch {}
    if (moved) {
      try {
        await api.eggDragEnd();
      } catch {}
    } else {
      expandEgg();
    }
  };

  orb.addEventListener('pointerup', finish);
  orb.addEventListener('pointercancel', finish);
  window.addEventListener('pointerup', finish);
  window.addEventListener('pointercancel', finish);
  window.addEventListener('blur', () => {
    if (!drag) return;
    const moved = drag.moved;
    drag = null;
    document.body.classList.remove('egg-dragging');
    if (moved) api.eggDragEnd().catch(() => {});
  });
  orb.addEventListener('lostpointercapture', (e) => {
    if (drag) finish(e);
  });
  orb.addEventListener('contextmenu', (e) => e.preventDefault());
}

async function newChat() {
  try {
    // A new chat is a NEW THREAD: the previous conversation stays in the chat
    // list with its transcript and OpenCode session. (This used to call
    // chatClear, which wiped the transcript — "new chat" destroyed history.)
    const res = await api.sessionNew();
    S.docKey = res?.key || S.docKey;
    S.threadKey = res?.threadId || res?.key || S.threadKey;
    S.threadTitle = res?.title || null;
    S.items = [];
    S.nodeIndex.clear();
    renderTimeline();
    renderThreadLabel();
    updateEmpty();
    closeSessions();
    if ($('#sessions')?.classList.contains('on')) renderSessions();
    toast('Started a new chat — the previous one is still in the chat list', 'ok');
    $('#input')?.focus();
  } catch (err) {
    toast(friendly(err), 'error');
  }
}

function initShell() {
  document.body.classList.add('shell-collapsed');
  initEggDrag();
  $('#btnCollapse').onclick = () => collapseEgg();
  $('#btnNewThread').onclick = (e) => {
    e.stopPropagation();
    newChat();
  };
  api.onShell?.((payload) => {
    if (typeof payload?.expanded === 'boolean') {
      applyShellExpanded(payload.expanded, { focus: payload.expanded });
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !shell.expanded) return;
    if (document.querySelector('.modal.on')) return;
    if ($('#drawer')?.classList.contains('open')) return;
    if (S.mention.open) return;
    if ($('#sessions')?.classList.contains('on')) {
      closeSessions();
      return;
    }
    collapseEgg();
  });
}

/* ------------------------------------------------------------------ */
/* boot                                                                */
/* ------------------------------------------------------------------ */

async function boot() {
  // Any uncaught renderer error is reported to main.log, not lost.
  window.addEventListener('error', (e) => {
    try {
      api.uiError?.(`window error: ${e.message} @ ${e.filename}:${e.lineno}`);
    } catch {}
  });
  // Each boot step is isolated: one broken wiring step must never leave the
  // composer dead. Failures are reported to main.log with the step name.
  const step = async (name, fn) => {
    try {
      await fn();
    } catch (err) {
      try {
        await api.uiError(`boot:${name}: ${err && err.message ? err.message : err}`);
      } catch {}
    }
  };
  await step('state', async () => applyState(await api.state()));
  await step('events', async () => api.onEvent(handleEvent));
  // The egg's click wiring goes FIRST: a failure anywhere later in bind()
  // must never leave the shell unclickable (the "egg does not expand" bug).
  await step('shell', initShell);
  await step('bind', bind);
  await step('shellSync', async () => {
    // The renderer may reload while the OS window is already expanded.
    const shellState = await api.eggState();
    applyShellExpanded(Boolean(shellState?.expanded), { focus: false });
  });
  await step('ui', async () => {
    syncUI();
    renderTimeline();
    renderModels();
    renderAspects();
    renderPc();
    setBusy(false);
    initSetup();
    loadSetup();
    initUpdates();
    if (shell.expanded) $('#input').focus();
  });
  try {
    await api.uiError('boot:complete');
  } catch {}
}

function applyState(state) {
  S.settings = state.settings;
  S.engine = state.engine;
  S.models = state.models;
  S.pc = state.photocraft;
  S.busy = state.busy;
  S.pinned = state.pinned;
  S.outDir = state.outDir;
  S.items = state.chat?.items || [];
  S.docKey = state.chat?.docKey || 'no-document';
  S.threadKey = state.chat?.threadId || state.chat?.docKey || 'no-document';
  S.threadTitle = state.chat?.title || null;
  S.pcDoc = state.photocraft?.document || null;
  for (const job of state.jobs || []) S.jobs.set(job.id, job);

  $('#ver').textContent = state.version || '0.1.0';
  $('#enginePath').textContent = state.engine?.engineRoot || '';
  syncUI();
  renderModels();
  renderPc();
  setBusy(S.busy);
  updateEnginePill();
}

/* ------------------------------------------------------------------ */
/* events                                                              */
/* ------------------------------------------------------------------ */

function handleEvent(ev) {
  if (!ev) return;
  switch (ev.type) {
    case 'chat':
      handleChatEvent(ev);
      break;
    case 'job':
    case 'job:finished':
      upsertJobEvent(ev.job);
      break;
    case 'model':
      if (ev.download) {
        S.modelDl.set(ev.id, ev.download);
        updateModelRow(ev.id, ev.download);
        renderSetup();
      }
      break;
    case 'models':
      S.models = ev.status;
      renderModels();
      renderSetup();
      break;
    case 'setup':
      handleSetupEvent(ev);
      if (ev.step === 'opencode') {
        if (ev.status === 'done' || ev.status === 'error') {
          S.ocReport = null;
          S.providersLoaded = false;
          refreshRuntime();
          refreshProviders(ev.status === 'done');
        }
        renderOcStatus();
      }
      break;
    case 'update':
      paintUpdate(ev.update);
      break;
    case 'settings':
      // Settings changed outside this window (an MCP tool or the HTTP API).
      if (ev.settings) {
        S.settings = ev.settings;
        syncUI();
        renderProviders();
        // Keep the beta toggle/pill in step when the setting is changed from
        // the HTTP API or another surface.
        const betaChk = $('#chkBetaAgent');
        if (betaChk) {
          const on = Boolean(S.settings?.opencode?.betaAgent);
          if (betaChk.checked !== on) betaChk.checked = on;
          const pill = $('#betaAgentPill');
          if (pill) {
            pill.textContent = on ? 'Beta on' : 'Off';
            pill.classList.toggle('on', on);
          }
        }
      }
      break;
    default:
      break;
  }
}

function handleChatEvent(ev) {
  switch (ev.action) {
    case 'append':
      S.items.push(ev.item);
      renderItem(ev.item);
      scrollChat(true);
      break;
    case 'start':
      setBusy(true);
      break;
    case 'delta': {
      const item = S.items.find((i) => i.id === ev.id);
      if (item) {
        item.text = ev.text;
        item.pending = true;
      }
      updateAgentNode(ev.id, ev.text, ev.tools || item?.tools || [], true, item?.note);
      scrollChat();
      break;
    }
    case 'tools': {
      const item = S.items.find((i) => i.id === ev.id);
      if (item) item.tools = ev.tools;
      updateAgentNode(ev.id, item?.text || '', ev.tools || [], true, item?.note);
      break;
    }
    case 'done': {
      const idx = S.items.findIndex((i) => i.id === ev.item.id);
      if (idx >= 0) S.items[idx] = ev.item;
      else S.items.push(ev.item);
      renderItem(ev.item, true);
      setBusy(false);
      markEggNews();
      scrollChat(true);
      break;
    }
    case 'job': {
      const idx = S.items.findIndex((i) => i.role === 'job' && i.jobId === ev.item.jobId);
      if (idx >= 0) S.items[idx] = ev.item;
      else S.items.push(ev.item);
      upsertJobEvent(ev.item.job);
      // A finished render is also an asset: refresh the tray cheaply (it only
      // lists, so this stays light even during long runs).
      break;
    }
    case 'cleared':
      S.items = [];
      S.nodeIndex.clear();
      $('#items').innerHTML = '';
      updateEmpty();
      break;
    case 'busy':
      setBusy(ev.busy);
      break;
    case 'notice':
      toast(ev.text);
      break;
    case 'status': {
      const item = S.items.find((i) => i.id === ev.id);
      if (item) {
        item.note = ev.note;
        updateAgentNode(ev.id, item.text || '', item.tools || [], item.pending, ev.note);
      }
      break;
    }
    case 'session':
      break;
    case 'thread':
      // The service switched the on-screen thread (new chat, a chat picked in
      // the list, or the agent creating a document). `threadId` is the
      // transcript; `docKey` is its document — they differ for threads beyond
      // a document's primary one.
      S.docKey = ev.docKey || 'no-document';
      S.threadKey = ev.threadId || ev.docKey || 'no-document';
      S.threadTitle = ev.title || null;
      S.items = ev.items || [];
      S.visibleCanvas = null;
      S.nodeIndex.clear();
      renderTimeline();
      renderThreadLabel();
      
      break;
    case 'document':
      // PhotoCraft changed the active document. Phase A: the canvas no longer
      // moves the chat — when the visible canvas differs from the chat's
      // canvas, show an explicit "switch" affordance instead.
      S.pcDoc = ev.doc ? { ...ev.doc } : null;
      S.visibleCanvas = ev.canvasMismatch
        ? { key: ev.visibleDocKey || null, name: ev.visibleDocName || null }
        : null;
      renderThreadLabel();
      
      refreshPc();
      if (ev.docKey && ev.docKey !== S.docKey) loadThread();
      break;
    default:
      break;
  }
}

/** Pull the current document's thread into the timeline. */
async function loadThread() {
  try {
    const hist = await api.chatHistory();
    S.docKey = hist.docKey || 'no-document';
    S.threadKey = hist.threadId || hist.docKey || 'no-document';
    S.threadTitle = hist.title || null;
    S.items = hist.items || [];
    S.nodeIndex.clear();
    renderTimeline();
    renderThreadLabel();
    updateEmpty();
  } catch (err) {
    toast(friendly(err), 'error');
  }
}


/** The small line under the brand showing which project this chat belongs to. */
function renderThreadLabel() {
  const el = $('#threadLabel');
  if (!el) return;
  // The label describes the thread you are READING, which is not always the
  // document PhotoCraft has focused — you can read an older chat while working
  // on something else. The pcbar already shows the active document.
  const title = S.threadTitle || S.pcDoc?.name || null;
  el.textContent = title || 'No document open';
  el.title = title ? (S.pcDoc?.path || 'Open the chat list') : 'Open the chat list';
  // Only claim "unsaved" when the thread belongs to the focused document,
  // because that is the only dirty flag we actually have.
  el.classList.toggle('dirty', Boolean(S.docKey && S.pcDoc?.key === S.docKey && S.pcDoc.dirty));
}

/**
 * The canvas popup: shown only when switching to a chat whose canvas cannot be
 * brought forward. One polite question — make a fresh blank canvas, or keep
 * chatting without one (the agent can create a canvas when it needs to).
 */
function showCanvasPopup(s) {
  const wrap = $('#canvasPopup');
  if (!wrap) return;
  const title = s?.title || S.threadTitle || 'This chat';
  $('#canvasPopupText').innerHTML =
    `<b>${esc(title)}</b> works on a canvas that isn't open in PhotoCraft anymore.`;
  wrap.classList.add('on');
}

function closeCanvasPopup() {
  const wrap = $('#canvasPopup');
  if (wrap) wrap.classList.remove('on');
}

/** "Make blank canvas" from the popup: create it and bind this chat to it. */
async function canvasPopupCreate() {
  try {
    closeCanvasPopup();
    toast('Creating a canvas…', 'ok');
    await api.chatCreateCanvas(S.threadKey);
    await refreshPc();
    await loadThread();
    toast('Blank canvas ready — this chat now works on it.', 'ok');
  } catch (err) {
    toast(friendly(err), 'error');
  }
}

/* ------------------------------------------------------------------ */
/* sessions (one chat per PhotoCraft document)                         */
/* ------------------------------------------------------------------ */

async function openSessions() {
  const box = $('#sessions');
  const on = box.classList.toggle('on');
  box.setAttribute('aria-hidden', on ? 'false' : 'true');
  if (on) await renderSessions();
}

function sessionDocLabel(s) {
  // Derive the label from the document KEY, never from docName: older entries
  // stored a chat title there when the thread had no document, which made the
  // "No document" group read like a conversation.
  const key = String(s?.docKey || '');
  if (!key || key === 'no-document') return 'No document';
  if (key.startsWith('untitled:')) {
    const [, name = 'Untitled', size = ''] = key.split(':');
    return size ? `${name} · ${size}` : `Draft · ${name}`;
  }
  const base = key.split(/[\\/]/).pop() || key;
  return base.replace(/\.[^.]+$/, '') || key;
}

function timeAgo(ts) {
  const seconds = Math.round((Date.now() - Number(ts || 0)) / 1000);
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  if (seconds < 90) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

async function renderSessions() {
  const list = $('#sessionsList');
  const foot = $('#sessionsFoot');
  let data;
  try {
    data = await api.sessionsList();
  } catch (err) {
    list.innerHTML = `<div class="sessions-empty">${esc(friendly(err))}</div>`;
    return;
  }
  S.sessions = data;
  const docs = data.docs || [];
  if (!docs.length) {
    list.innerHTML = '<div class="sessions-empty">No chats yet.</div>';
    foot.textContent = '';
    return;
  }

  // Group by PhotoCraft document: a chat belongs to a canvas, like the
  // document-scoped sidebar in Notion / Google Docs. The active document's
  // group comes first; render/tmp artefacts share one "Generated images"
  // group at the end; inside a group the newest conversation is first.
  const groups = new Map();
  for (const s of docs) {
    const key = s.transient ? '__generated' : s.docKey || s.key || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  const latest = (rows) => Math.max(...rows.map((s) => Number(s.updatedAt) || 0));
  const ordered = [...groups.entries()].sort((a, b) => {
    if (a[0] === '__generated') return 1;
    if (b[0] === '__generated') return -1;
    const aCurrent = a[1].some((s) => s.current);
    const bCurrent = b[1].some((s) => s.current);
    if (aCurrent !== bCurrent) return aCurrent ? -1 : 1;
    return latest(b[1]) - latest(a[1]);
  });

  list.innerHTML = '';
  for (const [groupKey, rows] of ordered) {
    const head = document.createElement('div');
    head.className = `s-group${groupKey === S.docKey ? ' current' : ''}`;
    head.textContent = groupKey === '__generated' ? 'Generated images' : sessionDocLabel(rows[0]);
    head.title = groupKey === '__generated' ? 'Chats opened on renders and previews' : groupKey;
    list.appendChild(head);

    for (const s of rows) {
      const row = document.createElement('div');
      row.className = `session-row${s.current ? ' current' : ''}`;
      row.innerHTML = `
        <div class="s-main">
          <div class="s-title">${esc(s.title || 'Untitled chat')}</div>
          <div class="s-sub">
            <span class="s-dot${s.exists ? '' : ' dead'}">${s.exists ? '●' : '○'}</span>
            ${esc(timeAgo(s.updatedAt) || 'new')} · ${esc((s.model || '').split('/').pop() || 'no model')}${
              s.agent === 'egglab-beta' ? ' · beta' : ''
            }${s.forkCount ? ` · ${s.forkCount} context reset${s.forkCount === 1 ? '' : 's'}` : ''}
            ${s.docKey && s.docKey === S.pcDoc?.key ? '<span class="s-onscreen">on screen</span>' : ''}
          </div>
        </div>
        <div class="s-acts">
          <button class="icon" data-act="rename" title="Rename">
            <svg viewBox="0 0 16 16"><path d="M11.2 2.2a1.4 1.4 0 0 1 2 0l.6.6a1.4 1.4 0 0 1 0 2l-7.6 7.6-3 .8.8-3Z" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>
          </button>
          <button class="icon danger" data-act="delete" title="Delete chat">
            <svg viewBox="0 0 16 16"><path d="M3.5 4.5h9M6.5 4.5V3h3v1.5M5 4.5l.6 8h4.8l.6-8" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>
          </button>
        </div>`;
      row.onclick = async (e) => {
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (act === 'rename') return renameSession(s);
        if (act === 'delete') return deleteSession(s);
        if (s.current) return closeSessions();
        await switchSession(s);
      };
      list.appendChild(row);
    }
  }
  const current = docs.find((d) => d.current);
  foot.innerHTML = current
    ? 'Chats are independent of canvases: the badge marks the canvas PhotoCraft shows. Click a chat to resume it.'
    : '';
}

async function switchSession(s) {
  try {
    const res = await api.sessionSwitch(s.key);
    const hist = res.history || {};
    S.docKey = hist.docKey || s.docKey || 'no-document';
    S.threadKey = hist.threadId || s.threadId || s.key;
    S.threadTitle = hist.title || s.title || null;
    S.items = hist.items || [];
    S.nodeIndex.clear();
    renderTimeline();
    renderThreadLabel();
    updateEmpty();
    closeSessions();
    await refreshPc();
    toast(`Switched to ${hist.title || s.title || 'chat'}`, 'ok');
    // The document could not be brought forward (draft gone, file missing):
    // offer a fresh blank canvas for this chat in a small in-chat popup.
    if (res.documentOpened === false && S.docKey !== 'no-document' && S.pc?.running) {
      showCanvasPopup(s);
    }
  } catch (err) {
    toast(friendly(err), 'error');
  }
}

async function renameSession(s) {
  const title = await askText({
    title: 'Rename chat',
    note: 'Only EggLab knows this name — OpenCode cannot rename a session.',
    value: s.title || '',
    placeholder: 'Poster with the ladybug',
  });
  if (!title) return;
  try {
    await api.sessionRename(s.key, title);
    await renderSessions();
    renderThreadLabel();
  } catch (err) {
    toast(friendly(err), 'error');
  }
}

async function deleteSession(s) {
  const sure = await askConfirm({
    title: 'Delete this chat?',
    note: `Removes the conversation history for “${s.title || s.key}”. PhotoCraft projects on disk are not touched.`,
    ok: 'Delete chat',
    cancel: 'Keep it',
  });
  if (!sure) return;
  try {
    await api.sessionDelete(s.key);
    if (s.current) {
      S.items = [];
      S.nodeIndex.clear();
      renderTimeline();
    }
    await renderSessions();
    toast('Chat deleted', 'ok');
  } catch (err) {
    toast(friendly(err), 'error');
  }
}

function closeSessions() {
  const box = $('#sessions');
  box.classList.remove('on');
  box.setAttribute('aria-hidden', 'true');
}

function setBusy(busy) {
  S.busy = Boolean(busy);
  document.body.classList.toggle('is-busy', S.busy);
  $('#btnSend').classList.toggle('hidden', S.busy);
  $('#btnStop').classList.toggle('hidden', !S.busy);
  $('#btnDirect').disabled = S.busy;
  $('#btnShowCanvas').disabled = S.busy;
  if (S.settings) updateHint();
  else $('#hint').textContent = S.busy ? 'Working…' : 'Enter to send';
}

/* ------------------------------------------------------------------ */
/* timeline                                                            */
/* ------------------------------------------------------------------ */

function updateEmpty() {
  const empty = $('#empty');
  const noItems = S.items.length === 0;
  empty.classList.toggle('hidden', !noItems);
}

function scrollChat(force = false) {
  const chat = $('#chat');
  const near = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 160;
  if (force || near) chat.scrollTop = chat.scrollHeight;
}

function renderTimeline() {
  const box = $('#items');
  box.innerHTML = '';
  S.nodeIndex.clear();
  for (const item of S.items) renderItem(item);
  updateEmpty();
  requestAnimationFrame(() => scrollChat(true));
}

function renderItem(item, replace = false) {
  if (!item) return;
  if (replace) {
    const old = S.nodeIndex.get(item.id);
    if (old && old.isConnected) old.remove();
    S.nodeIndex.delete(item.id);
  }
  const node = itemNode(item);
  const existing = S.nodeIndex.get(item.id);
  if (existing && existing.isConnected) existing.replaceWith(node);
  else $('#items').appendChild(node);
  S.nodeIndex.set(item.id, node);
  updateEmpty();
}

function itemNode(item) {
  if (item.role === 'user') {
    const wrap = document.createElement('div');
    wrap.className = 'msg user';
    wrap.dataset.id = item.id;
    wrap.innerHTML = `<div class="bubble">${esc(item.text)}</div>`;
    return wrap;
  }
  if (item.role === 'system') {
    const wrap = document.createElement('div');
    wrap.className = 'msg system';
    wrap.dataset.id = item.id;
    wrap.innerHTML = `<div class="bubble">${esc(item.text)}</div>`;
    return wrap;
  }
  if (item.role === 'job') {
    return jobNode(item.job);
  }
  const wrap = document.createElement('div');
  wrap.className = 'msg agent';
  wrap.dataset.id = item.id;
  wrap.innerHTML = `
    <div class="agent-body">
      <div class="avatar"><span></span></div>
      <div class="md" data-md></div>
    </div>`;
  // Register the node before the first update: updateAgentNode resolves it
  // through the index, and a restored timeline builds nodes while detached.
  S.nodeIndex.set(item.id, wrap);
  updateAgentNode(item.id, item.text || '', item.tools || [], item.pending);
  if (item.error) {
    const err = document.createElement('div');
    err.className = 'err';
    err.textContent = item.error;
    wrap.appendChild(err);
  }
  return wrap;
}

function updateAgentNode(id, text, tools, pending, note) {
  const node = S.nodeIndex.get(id) || document.querySelector(`.msg.agent[data-id="${id}"]`);
  if (!node) return;
  S.nodeIndex.set(id, node);
  const mdBox = node.querySelector('[data-md]');
  const toolBox = node.querySelector('.tools') || document.createElement('div');
  if (!toolBox.parentElement) {
    toolBox.className = 'tools';
    node.querySelector('.agent-body').insertBefore(toolBox, mdBox);
  }
  if (tools && tools.length) {
    toolBox.innerHTML = tools
      .map(
        (t) => `<span class="tool">${t.status === 'running' ? '<i class="spin"></i>' : '✓'} <b>${esc(t.name)}</b>${t.arg ? ` · ${esc(t.arg)}` : ''}</span>`,
      )
      .join('');
    toolBox.style.display = '';
  } else {
    toolBox.style.display = 'none';
  }
  const body = text ? md(text) : pending ? '<span class="typing"><i></i><i></i><i></i></span>' : '';
  if (mdBox.dataset.raw !== body) {
    mdBox.dataset.raw = body;
    mdBox.innerHTML = body;
  }
  const noteBox = node.querySelector('.agent-note') || document.createElement('div');
  if (!noteBox.parentElement) {
    noteBox.className = 'agent-note';
    node.querySelector('.agent-body').appendChild(noteBox);
  }
  noteBox.textContent = note || '';
  noteBox.style.display = note ? '' : 'none';
}

/* ---------------------------- job cards ---------------------------- */

function upsertJobEvent(job) {
  if (!job) return;
  S.jobs.set(job.id, job);
  let item = S.items.find((i) => i.role === 'job' && i.jobId === job.id);
  if (!item) {
    item = { id: `live_${job.id}`, role: 'job', jobId: job.id, job, at: job.startedAt || Date.now() };
    S.items.push(item);
    $('#items').appendChild(jobNode(job));
    S.nodeIndex.set(item.id, $('#items').lastElementChild);
    updateEmpty();
    scrollChat(true);
    return;
  }
  item.job = job;
  const node = S.nodeIndex.get(item.id) || document.querySelector(`.job[data-job="${job.id}"]`);
  if (node) {
    updateJobNode(node, job);
    S.nodeIndex.set(item.id, node);
  } else {
    renderItem(item, true);
  }
  if (job.status === 'done') scrollChat();
}

function jobNode(job) {
  const node = document.createElement('div');
  node.className = 'job';
  node.dataset.job = job.id;
  node.innerHTML = `
    <div class="job-media"></div>
    <div class="job-body">
      <div class="job-title"></div>
      <div class="job-prompt"></div>
      <div class="job-meta"></div>
      <div class="job-actions"></div>
    </div>`;
  updateJobNode(node, job);
  return node;
}

/** Short, human-readable name for a diffusion checkpoint. */
function shortModel(file) {
  const s = String(file || '');
  if (/Q4_K_M/i.test(s)) return 'Q4_K_M';
  if (/Q5_K_M/i.test(s)) return 'Q5_K_M';
  if (/Q4_K_S/i.test(s)) return 'Q4_K_S';
  if (/Q8/i.test(s)) return 'Q8';
  if (/fp8/i.test(s)) return 'FP8';
  if (/bf16/i.test(s)) return 'BF16';
  return s.replace(/\.[^.]+$/, '').slice(0, 14);
}

function updateJobNode(node, job) {
  node.classList.toggle('running', job.status === 'running');
  node.classList.toggle('error', job.status === 'error');
  const media = node.querySelector('.job-media');
  const actions = node.querySelector('.job-actions');

  if (job.status === 'running') {
    if (!media.querySelector('.job-skeleton')) {
      media.innerHTML = `
        <div class="job-skeleton">
          <div class="job-phase"></div>
          <div class="bar"><span></span></div>
          <div class="job-time"></div>
        </div>`;
    }
    media.querySelector('.job-phase').textContent = job.phase === 'canceling' ? 'Stopping…' : job.detail || 'Working…';
    media.querySelector('.bar span').style.width = `${Math.max(2, job.percent || 0)}%`;
    media.querySelector('.job-time').textContent = `${fmtTime(job.elapsedMs)} · ~${fmtTime(job.expectedMs)} estimate · seed ${job.seed}`;
  } else if (job.status === 'done' && job.outPath) {
    const src = api.fileUrl(job.outPath);
    const img = media.querySelector('img');
    if (!img || img.dataset.src !== src) {
      media.innerHTML = '';
      const image = document.createElement('img');
      image.dataset.src = src;
      image.src = src;
      image.alt = job.prompt;
      media.appendChild(image);
    }
  } else if (job.status === 'error' || job.status === 'canceled') {
    media.innerHTML = `<div class="job-skeleton"><div class="job-phase">${job.status === 'canceled' ? 'Canceled' : 'Failed'}</div></div>`;
  }

  const title = node.querySelector('.job-title');
  const tagClass = job.status === 'error' ? 'err' : job.workflow === 'turbo' ? 'turbo' : '';
  title.innerHTML = `<span class="tag ${tagClass}">${esc(job.workflow || '')}</span>
    ${job.model ? `<span class="tag model" title="${esc(job.model)}">${esc(shortModel(job.model))}</span>` : ''}
    <span>${job.width}×${job.height} · ${job.steps} steps${job.transparent ? ' · RGBA' : ''}</span>`;
  node.querySelector('.job-prompt').textContent = job.promptUsed || job.prompt || '';

  const meta = node.querySelector('.job-meta');
  if (job.status === 'running') {
    meta.textContent = `phase ${job.phase} · ${fmtTime(job.elapsedMs)} · seed ${job.seed}`;
    actions.innerHTML = '';
    const cancel = document.createElement('button');
    cancel.className = 'mini';
    cancel.textContent = 'Cancel';
    cancel.onclick = async () => {
      await api.cancelJob(job.id);
    };
    actions.appendChild(cancel);
  } else {
    meta.textContent = `${fmtTime(job.elapsedMs)} · seed ${job.seed} · ${job.kind === 'edit' ? `${job.images.length} reference${job.images.length > 1 ? 's' : ''}` : 'text to image'}`;
    actions.innerHTML = '';
    if (job.status === 'done' && job.outPath) {
      actions.appendChild(miniButton('Place in PhotoCraft', async () => {
        try {
          await ensurePc();
          await api.pcPlace(job.outPath, { fit: true });
          toast('Placed as a new layer', 'ok');
          refreshPc();
        } catch (err) {
          toast(friendly(err), 'error');
        }
      }, 'primary'));
      actions.appendChild(miniButton('Use as reference', () => addRef(job.outPath)));
      actions.appendChild(miniButton('Open', () => api.openPath(job.outPath)));
      actions.appendChild(miniButton('Folder', () => api.revealPath(job.outPath)));
    }
    if (job.status === 'error') {
      const err = document.createElement('div');
      err.className = 'err';
      err.textContent = job.error || 'Render failed.';
      node.querySelector('.job-body').appendChild(err);
    }
  }
  node.querySelector('.job-actions').classList.toggle('hidden', !actions.children.length);
}

function miniButton(label, onClick, kind = '') {
  const btn = document.createElement('button');
  btn.className = `mini ${kind}`;
  btn.textContent = label;
  btn.onclick = (e) => {
    e.stopPropagation();
    onClick();
  };
  return btn;
}

/* ------------------------------------------------------------------ */
/* references                                                          */
/* ------------------------------------------------------------------ */

function addRef(file, mention = '') {
  if (!file) return;
  if (S.refs.includes(file)) return;
  // Every export writes a NEW timestamped filename, so the path check above
  // never catches a layer the user already attached. Dedupe on the layer name
  // too, or picking @girl twice stacks two chips for the same pixels.
  if (mention) {
    const dup = S.refs.find((f) => (S.refMentions.get(f) || '').toLowerCase() === String(mention).toLowerCase());
    if (dup) return;
  }
  if (S.refs.length >= 10) return toast('Up to 10 reference images', 'error');
  S.refs.push(file);
  if (mention) S.refMentions.set(file, mention);
  renderRefs();
}

function removeRef(file) {
  S.refs = S.refs.filter((f) => f !== file);
  S.refMentions.delete(file);
  renderRefs();
}

function renderRefs() {
  const box = $('#refs');
  box.innerHTML = '';
  for (const file of S.refs) {
    const chip = document.createElement('div');
    chip.className = 'ref';
    const mention = S.refMentions.get(file);
    chip.title = mention ? `@${mention} — ${file}` : file;
    chip.innerHTML = `<img src="${api.fileUrl(file)}" alt="" /><button title="Remove">×</button>${
      mention ? `<span class="ref-name">@${esc(mention)}</span>` : ''
    }`;
    chip.querySelector('button').onclick = () => removeRef(file);
    box.appendChild(chip);
  }
}

/* ------------------------------------------------------------------ */
/* @mention layer picker                                               */
/* ------------------------------------------------------------------ */

function flatLayers(list = []) {
  const out = [];
  const walk = (arr, depth) => {
    for (const layer of arr || []) {
      out.push({ ...layer, depth });
      if (Array.isArray(layer.children) && layer.children.length) walk(layer.children, depth + 1);
    }
  };
  walk(list, 0);
  return out.filter((l) => l && l.name);
}

/** The `@query` token immediately before the caret, or null. */
function mentionToken() {
  const el = $('#input');
  const pos = el.selectionStart ?? el.value.length;
  const before = el.value.slice(0, pos);
  const at = before.lastIndexOf('@');
  if (at < 0) return null;
  if (at > 0 && !/[\s(\[{]/.test(before[at - 1])) return null;
  const query = before.slice(at + 1);
  if (query.length > 70 || query.includes('\n') || query.includes('@')) return null;
  return { start: at, end: pos, query };
}

async function updateMentionPicker() {
  const token = mentionToken();
  if (!token) return closeMention();

  const seq = ++S.pcLayerSeq;
  let data;
  try {
    S.pc = (await api.pcStatus()) || S.pc;
    data = await api.pcLayers();
  } catch (err) {
    if (seq !== S.pcLayerSeq) return;
    return openMention(token, [], null);
  }
  if (seq !== S.pcLayerSeq) return;
  const layers = flatLayers(data?.layers || []);
  S.pcLayerCache = layers;
  S.pcLayerDoc = data?.document?.name || null;
  const q = token.query.trim().toLowerCase();
  const items = (q ? layers.filter((l) => String(l.name).toLowerCase().includes(q)) : layers).slice(0, 40);
  // The whole flattened canvas is referenceable even though it is not a layer:
  // without this synthetic row a user cannot attach @canvas from the picker.
  if (String(token.query || '').toLowerCase() === 'canvas' && !items.some((l) => String(l.name || '').toLowerCase() === 'canvas')) {
    items.unshift({ name: 'canvas', canvas: true, visible: true });
  }
  openMention(token, items, S.pcLayerDoc);
}

function openMention(token, items, docName) {
  S.mention = { open: true, items, index: 0, token };
  const box = $('#mentionList');
  box.classList.add('open');
  box.setAttribute('aria-hidden', 'false');
  box.innerHTML = '';

  const head = document.createElement('div');
  head.className = 'mention-head';
  head.innerHTML = `<span>Reference a layer</span>${
    docName ? `<b>· ${esc(docName)}</b>` : ''
  }<span style="margin-left:auto">${items.length}${items.length === 1 ? ' layer' : ' layers'}</span>`;
  box.appendChild(head);

  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'mention-empty';
    empty.textContent = S.pc?.running
      ? token.query
        ? `No layer matches “${token.query}”.`
        : 'This document has no layers.'
      : 'PhotoCraft is not connected — start it from the panel.';
    box.appendChild(empty);
    return;
  }

  items.forEach((layer, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `mention-item${i === 0 ? ' active' : ''}${layer.visible === false ? ' hidden-layer' : ''}`;
    btn.innerHTML = `<span class="dot"></span><span class="m-name">${esc(layer.name)}</span><span class="m-meta">${
      layer.canvas ? 'canvas' : layer.visible === false ? 'hidden' : 'layer'
    }</span>`;
    btn.onmousedown = (e) => e.preventDefault();
    btn.onclick = () => pickMention(layer);
    box.appendChild(btn);
  });
}

function closeMention() {
  S.mention = { open: false, items: [], index: 0, token: null };
  const box = $('#mentionList');
  box.classList.remove('open');
  box.setAttribute('aria-hidden', 'true');
}

function moveMention(delta) {
  if (!S.mention.open || !S.mention.items.length) return;
  S.mention.index = (S.mention.index + delta + S.mention.items.length) % S.mention.items.length;
  const btns = $('#mentionList').querySelectorAll('.mention-item');
  btns.forEach((b, i) => b.classList.toggle('active', i === S.mention.index));
  btns[S.mention.index]?.scrollIntoView({ block: 'nearest' });
}

function pickMention(layer) {
  const token = S.mention.token;
  if (!token) return;
  const el = $('#input');
  const name = String(layer.name || '');
  const insert = `@${name} `;
  el.value = el.value.slice(0, token.start) + insert + el.value.slice(token.end);
  const caret = token.start + insert.length;
  el.setSelectionRange(caret, caret);
  closeMention();
  el.focus();
  autoGrow();
  if (layer?.canvas) {
    showCanvas();
    return;
  }
  attachMentionRef(name);
}

/* ------------------------------------------------------------------ */
/* canvas preview (agent sees current canvas)                          */
/* ------------------------------------------------------------------ */

async function showCanvas() {
  try {
    await ensurePc();
    const res = await api.pcPreview();
    if (!res || !res.path) return toast('No canvas preview available.', 'error');
    addRef(res.path, 'canvas');
    toast('Canvas sent to agent as reference', 'ok');
  } catch (err) {
    toast(friendly(err), 'error');
  }
}

async function attachMentionRef(name) {
  try {
    await ensurePc();
    const res = await api.pcExportLayer(name);
    addRef(res.path, res.layer?.name || name);
    toast(`@${res.layer?.name || name} → reference image`, 'ok');
  } catch (err) {
    toast(friendly(err), 'error');
  }
}

function escapeRe(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Layer names mentioned as @name in the text, longest first (so @Red Hat wins over @Red). */
function mentionedLayerNames(text, layers = S.pcLayerCache) {
  const found = [];
  const names = layers
    .map((l) => String(l.name || ''))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  for (const name of names) {
    const re = new RegExp(`@${escapeRe(name)}(?=$|[\\s.,;:!?)\\]}])`, 'i');
    if (re.test(text) && !found.some((f) => f.toLowerCase() === name.toLowerCase())) found.push(name);
  }
  // @canvas is the whole flattened composite, not a layer — the mention picker
  // only lists layers, so it has to be matched here by hand. Without this the
  // composer exported nothing for a canvas reference.
  if (text.includes('@canvas') && !found.some((f) => f.toLowerCase() === 'canvas')) {
    found.push('canvas');
  }
  return found;
}

/**
 * Make sure every @layer in the message is attached as a reference PNG.
 * Returns { files, refMap, unresolved } for the chat request.
 */
async function resolveMentionRefs(text) {
  const files = S.refs.slice();
  const refMap = {};
  for (const file of files) {
    const mention = S.refMentions.get(file);
    if (mention) refMap[file] = mention;
  }

  // Refresh the layer list on every send so mentions typed by hand resolve too.
  if (text.includes('@')) {
    try {
      const data = await api.pcLayers();
      S.pcLayerCache = flatLayers(data?.layers || []);
    } catch {}
  }

  let names = mentionedLayerNames(text, S.pcLayerCache);
  if (!names.length) return { files, refMap, unresolved: [] };

  // A mention whose pixels are already attached does not need another export.
  const attached = new Set(Object.values(refMap).map((n) => n.toLowerCase()));
  names = names.filter((n) => !attached.has(n.toLowerCase()));

  const unresolved = [];
  const hasCanvas = names.some((n) => String(n).toLowerCase() === 'canvas');
  if (hasCanvas) {
    // @canvas is the whole flattened composite — the "Show canvas" ref — not a
    // PhotoCraft layer, so it needs the preview render instead of an export.
    if (!attached.has('canvas')) {
      try {
        await ensurePc();
        const res = await api.pcPreview();
        if (res?.path) {
          files.push(res.path);
          refMap[res.path] = 'canvas';
          renderRefsFrom(files, refMap);
        } else unresolved.push('canvas');
      } catch {
        unresolved.push('canvas');
      }
    }
    names = names.filter((n) => String(n).toLowerCase() !== 'canvas');
  }
  if (!names.length) return { files, refMap, unresolved };

  try {
    await ensurePc();
    const res = await api.pcExportMentions(names);
    for (const item of res.resolved || []) {
      if (!files.includes(item.path)) files.push(item.path);
      refMap[item.path] = item.layer?.name || item.mention;
    }
    unresolved.push(...(res.unresolved || []));
    renderRefsFrom(files, refMap);
  } catch (err) {
    unresolved.push(...names);
  }
  return { files, refMap, unresolved };
}

function renderRefsFrom(files, refMap) {
  S.refs = files.filter(Boolean);
  for (const file of S.refs) {
    if (refMap[file]) S.refMentions.set(file, refMap[file]);
  }
  renderRefs();
}

/* ------------------------------------------------------------------ */
/* composer                                                            */
/* ------------------------------------------------------------------ */

async function sendMessage() {
  const input = $('#input');
  const text = input.value.trim();
  if (!text) return;
  if (S.busy) {
    try {
      api.uiError?.('send blocked: renderer thinks a turn is running');
    } catch {}
    return;
  }
  if (S.mention.open) return;

  // /egg — direct generate, bypasses the agent. Asks back for scale & ratio.
  if (/^\/egg(\s|$)/i.test(text)) {
    const prompt = text.replace(/^\/egg\s*/i, '').trim();
    if (!prompt) return toast('Write a prompt after /egg.', 'error');
    input.value = '';
    autoGrow();
    closeMention();
    S.refs = [];
    S.refMentions = new Map();
    renderRefs();
    await eggGenerate(prompt);
    return;
  }

  let payload;
  try {
    payload = await resolveMentionRefs(text);
  } catch (err) {
    toast(friendly(err), 'error');
    payload = { files: S.refs.slice(), refMap: {}, unresolved: [] };
  }
  if (payload.unresolved.length) {
    toast(`No layer named ${payload.unresolved.map((n) => `@${n}`).join(', ')}`, 'error');
  }

  input.value = '';
  autoGrow();
  closeMention();
  const files = payload.files;
  const refMap = payload.refMap;
  S.refs = [];
  S.refMentions = new Map();
  renderRefs();
  try {
    await api.chatSend(text, files, refMap);
  } catch (err) {
    toast(friendly(err), 'error');
    setBusy(false);
  }
}

function autoGrow() {
  const input = $('#input');
  input.style.height = 'auto';
  input.style.height = `${Math.min(132, input.scrollHeight)}px`;
}

async function directRender() {
  const input = $('#input');
  const prompt = input.value.trim();
  if (!prompt) return toast('Write a prompt first.', 'error');
  if (S.busy) return;
  if (S.mention.open) return;
  const s = S.settings;
  const count = Math.max(1, Math.min(4, Number(s.batch) || 1));
  let payload;
  try {
    payload = await resolveMentionRefs(prompt);
  } catch {
    payload = { files: S.refs.slice(), refMap: {}, unresolved: [] };
  }
  try {
    for (let i = 0; i < count; i++) {
      const job = await api.startJob({
        prompt,
        workflow: s.workflow,
        width: s.width,
        height: s.height,
        steps: s.workflow === 'turbo' ? s.turbo.steps : s.quality.steps,
        cfg: s.workflow === 'turbo' ? s.turbo.cfg : s.quality.cfg,
        // A reference edit gets a FRESH seed every run: re-using one resurrects
        // the t2i initial noise and replays it (broadband noise, confirmed as
        // the Qwen-Image-2.1 edit failure mode), regardless of the lock. Text-only
        // renders keep the locked seed for reproducibility.
        seed: Array.isArray(payload.files) && payload.files.length
          ? undefined
          : s.seed >= 0 ? Number(s.seed) + i : undefined,
        transparent: $('#chkTransparent').checked,
        images: payload.files,
      });
      if (count > 1) await api.waitJob(job.id);
    }
    input.value = '';
    autoGrow();
    S.refs = [];
    S.refMentions = new Map();
    renderRefs();
  } catch (err) {
    toast(friendly(err), 'error');
  }
}

/* ------------------------------------------------------------------ */
/* /egg — direct generate (bypasses the agent)                        */
/* ------------------------------------------------------------------ */

const EGG_RATIOS = [
  { ratio: '1:1', w: 1, h: 1 },
  { ratio: '3:4', w: 3, h: 4 },
  { ratio: '4:3', w: 4, h: 3 },
  { ratio: '16:9', w: 16, h: 9 },
  { ratio: '9:16', w: 9, h: 16 },
  { ratio: '3:2', w: 3, h: 2 },
  { ratio: '2:3', w: 2, h: 3 },
];

function snap32(v) {
  return Math.max(256, Math.min(2048, Math.round(Number(v || 0) / 32) * 32));
}

function computeEggSize({ ratio, scale, customW, customH }, baseW, baseH) {
  if (ratio === 'custom') {
    return { width: snap32(customW || baseW), height: snap32(customH || baseH) };
  }
  const r = EGG_RATIOS.find((x) => x.ratio === ratio) || EGG_RATIOS[0];
  const longSide = snap32(Math.max(baseW, baseH) * scale);
  // shortSide = longSide scaled DOWN by the smaller dimension ratio, always:
  // portrait ratios (w < h) must get width < height, landscape the reverse.
  const shortSide = snap32(longSide * (Math.min(r.w, r.h) / Math.max(r.w, r.h)));
  return r.w >= r.h ? { width: longSide, height: shortSide } : { width: shortSide, height: longSide };
}

function openEgg() {
  const scaleSeg = $('#eggScaleSeg');
  const ratioSeg = $('#eggRatioSeg');
  const custom = $('#eggCustom');
  scaleSeg.querySelectorAll('button').forEach((b) => {
    b.classList.toggle('active', b.dataset.scale === String(S.egg.scale));
  });
  ratioSeg.querySelectorAll('button').forEach((b) => {
    const active = b.dataset.ratio === S.egg.ratio;
    b.classList.toggle('active', active);
  });
  custom.style.display = S.egg.ratio === 'custom' ? 'block' : 'none';
  $('#eggW').value = S.egg.customW || '';
  $('#eggH').value = S.egg.customH || '';
  $('#eggScrim').classList.add('on');
  $('#eggModal').classList.add('on');
  $('#eggModal').setAttribute('aria-hidden', 'false');
  $('#eggOk').focus();
}

function closeEgg() {
  $('#eggScrim').classList.remove('on');
  $('#eggModal').classList.remove('on');
  $('#eggModal').setAttribute('aria-hidden', 'true');
}

async function eggGenerate(prompt) {
  if (S.busy) return toast('EggLab is working.', 'error');

  // Resolve @layers into reference images first.
  let payload;
  try {
    payload = await resolveMentionRefs(prompt);
  } catch (err) {
    toast(friendly(err), 'error');
    return;
  }
  if (payload.unresolved.length) {
    toast(`No layer named ${payload.unresolved.map((n) => `@${n}`).join(', ')}`, 'error');
    return;
  }

  const s = S.settings;
  const baseW = s.width || 1024;
  const baseH = s.height || 1024;

  // Ask for scale & ratio (blocks until the user confirms or cancels).
  const size = await new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      closeEgg();
      $('#eggOk').onclick = null;
      $('#eggCancel').onclick = null;
      $('#eggScaleSeg').onclick = null;
      $('#eggRatioSeg').onclick = null;
      $('#eggW').oninput = null;
      $('#eggH').oninput = null;
      resolve(value);
    };

    const applyChoice = () => {
      const scaleBtn = $('#eggScaleSeg').querySelector('.active');
      const ratioBtn = $('#eggRatioSeg').querySelector('.active');
      if (!scaleBtn || !ratioBtn) { done(null); return; }
      S.egg.scale = Number(scaleBtn.dataset.scale);
      S.egg.ratio = ratioBtn.dataset.ratio;
      if (S.egg.ratio === 'custom') {
        S.egg.customW = $('#eggW').value.trim();
        S.egg.customH = $('#eggH').value.trim();
      } else {
        S.egg.customW = ''; S.egg.customH = '';
      }
      done(computeEggSize(S.egg, baseW, baseH));
    };

    $('#eggOk').onclick = () => applyChoice();
    $('#eggCancel').onclick = () => done(null);
    $('#eggScaleSeg').onclick = (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      $('#eggScaleSeg').querySelectorAll('button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
    };
    $('#eggRatioSeg').onclick = (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      $('#eggRatioSeg').querySelectorAll('button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      $('#eggCustom').style.display = b.dataset.ratio === 'custom' ? 'block' : 'none';
    };
    $('#eggW').oninput = () => { S.egg.customW = $('#eggW').value.trim(); };
    $('#eggH').oninput = () => { S.egg.customH = $('#eggH').value.trim(); };

    openEgg();
  });

  if (!size) return; // cancelled

  try {
    setBusy(true);
    const hasRefs = Array.isArray(payload.files) && payload.files.length;
    const job = await api.startJob({
      prompt,
      workflow: s.workflow,
      width: size.width,
      height: size.height,
      steps: s.workflow === 'turbo' ? s.turbo.steps : s.quality.steps,
      cfg: s.workflow === 'turbo' ? s.turbo.cfg : s.quality.cfg,
      transparent: $('#chkTransparent').checked,
      images: payload.files,
      // Text-only jobs keep the locked seed for reproducibility; edit jobs get
      // a fresh random one every run — the same seed replayed across the t2i->edit
      // chain is the documented Qwen-Image-2.1 edit failure mode (noise replay).
      seed: hasRefs ? undefined : (s.seed >= 0 ? Number(s.seed) : undefined),
    });
    const done = await api.waitJob(job.id);
    S.refs = [];
    S.refMentions = new Map();
    renderRefs();
    if (done.status === 'done') {
      upsertJobEvent(done);
      toast(`Direct render done: ${done.width}×${done.height}`, 'ok');
    } else {
      toast(`Direct generate failed: ${done.error || 'unknown'}`, 'error');
    }
  } catch (err) {
    toast(friendly(err), 'error');
  } finally {
    setBusy(false);
  }
}

/* ------------------------------------------------------------------ */
/* workflow + settings UI                                              */
/* ------------------------------------------------------------------ */

function setWorkflow(wf, patch = true) {
  if (!S.settings) return;
  S.settings.workflow = wf;
  if (patch) queuePatch({ workflow: wf });
  syncUI();
}

let patchQueue = {};
let patchTimer = 0;
function queuePatch(patch) {
  patchQueue = deepMerge(patchQueue, patch);
  clearTimeout(patchTimer);
  patchTimer = setTimeout(flushPatch, 260);
}

async function flushPatch() {
  const patch = patchQueue;
  patchQueue = {};
  if (!Object.keys(patch).length) return;
  try {
    S.settings = await api.patchSettings(patch);
    syncUI();
    renderModels();
    updateEnginePill();
  } catch (err) {
    toast(friendly(err), 'error');
  }
}

function deepMerge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(a?.[k] || {}, v) : v;
  }
  return out;
}

function syncUI() {
  const s = S.settings;
  if (!s) return;

  $('#wfSeg').dataset.wf = s.workflow;
  $('#wfSeg').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.wf === s.workflow));
  $('#wfQuality').textContent = s.quality.steps;
  $('#wfTurbo').textContent = s.turbo.steps;
  const qMeta = $('#wfQualityMeta');
  if (qMeta) qMeta.textContent = `${s.quality.steps} steps · CFG ${s.quality.cfg}`;
  const tMeta = $('#wfTurboMeta');
  if (tMeta) tMeta.textContent = `${s.turbo.steps} steps · CFG ${s.turbo.cfg}`;

  setVal('#qSteps', s.quality.steps);
  setVal('#qCfg', s.quality.cfg);
  setVal('#tSteps', s.turbo.steps);
  setVal('#tCfg', s.turbo.cfg);
  document.querySelectorAll('[data-wf-card]').forEach((card) => card.classList.toggle('active', card.dataset.wfCard === s.workflow));

  $('#inWidth').value = s.width;
  $('#inHeight').value = s.height;
  $('#inSeed').value = s.seed;
  $('#inBatch').value = s.batch;
  $('#inRefMax').value = s.refMaxSide || 768;
  $('#chkLockSeed').checked = Boolean(s.lockSeed);
  $('#chkOffload').checked = Boolean(s.offload);
  $('#chkTransparent').checked = Boolean(s.transparent);

  $('#pcPort').value = s.photocraft.controlPort;
  $('#pcWidth').value = s.photocraft.width;
  $('#pcExe').value = s.photocraft.exe;
  $('#chkDock').checked = Boolean(s.photocraft.dock);
  $('#pcRoots').textContent = `read root ${s.photocraft.readRoot} · write root ${s.photocraft.writeRoot}`;
  const modelsDir = S.engine?.modelsDir || s.modelsDir || '';
  const modelsDirEl = $('#modelsDir');
  if (modelsDirEl) {
    modelsDirEl.textContent = modelsDir || 'Not set';
    modelsDirEl.title = modelsDir || '';
  }
  const ocExeEl = $('#ocExe');
  if (ocExeEl) {
    // Only the desktop app is the user-facing OpenCode runtime; the bundled
    // CLI is an internal diagnostic binary and must not be shown as a choice.
    const selected = S.ocReport?.desktopExe || s.opencode?.desktopExe || '';
    ocExeEl.value = selected;
    ocExeEl.title = selected;
  }

  renderAspects();
  renderModels();
  renderProviders();
  updateHint();
}

function setVal(sel, value) {
  const node = $(sel);
  if (node && document.activeElement !== node) node.value = value;
}

function updateHint() {
  const s = S.settings;
  if (!s) return;
  const steps = s.workflow === 'turbo' ? s.turbo.steps : s.quality.steps;
  const mode = s.workflow === 'turbo' ? `turbo ${steps}` : `${steps} steps`;
  // Keep it short enough to sit on one line in the 440px panel; the full
  // workflow and CFG live in the settings drawer.
  $('#hint').textContent = S.busy ? 'Working…' : `${s.width}×${s.height} · ${mode}`;
  $('#hint').title = S.busy
    ? 'EggLab is working'
    : `${s.workflow} · ${steps} steps · CFG ${s.workflow === 'turbo' ? s.turbo.cfg : s.quality.cfg}`;
}

function updateEnginePill() {
  const engine = S.engine;
  const pill = $('#enginePill');
  if (!engine) return;
  const missing = Object.entries(engine.models || {}).filter(([, ok]) => !ok).map(([k]) => k);
  if (!engine.engineExists) {
    pill.textContent = 'engine missing';
    pill.className = 'pill err';
  } else if (missing.length) {
    pill.textContent = `${missing.length} model${missing.length > 1 ? 's' : ''} missing`;
    pill.className = 'pill warn';
  } else {
    pill.textContent = 'ready';
    pill.className = 'pill on';
  }
}

function renderAspects() {
  const s = S.settings;
  if (!s) return;
  const box = $('#aspects');
  box.innerHTML = '';
  for (const [label, size] of Object.entries(ASPECTS)) {
    const btn = document.createElement('button');
    btn.innerHTML = `${label}<em>${size[0]}×${size[1]}</em>`;
    btn.classList.toggle('on', s.aspect === label);
    btn.onclick = () => {
      S.settings.aspect = label;
      S.settings.width = size[0];
      S.settings.height = size[1];
      queuePatch({ aspect: label, width: size[0], height: size[1] });
      renderAspects();
      $('#inWidth').value = size[0];
      $('#inHeight').value = size[1];
      updateHint();
    };
    box.appendChild(btn);
  }
}

/* ------------------------------ models ----------------------------- */

async function selectRoleModel(role, file) {
  if (!role || !file) return;
  try {
    await api.setModelFile(role, file);
    S.models = await api.models();
    renderModels();
    if (S.setup) await loadSetup();
    toast('Model selected.', 'ok');
  } catch (err) {
    toast(friendly(err), 'error');
  }
}

function renderModelRoles(containerId, entries) {
  const box = document.getElementById(containerId);
  if (!box || !Array.isArray(entries)) return;
  box.innerHTML = '';
  for (const entry of entries) {
    const row = document.createElement('div');
    row.className = 'model-role';
    const files = Array.isArray(entry.files) ? entry.files : [];
    const options = files.length
      ? files
          .map(
            (file) =>
              `<option value="${esc(file.path)}" ${file.current ? 'selected' : ''}>${esc(file.name)}</option>`,
          )
          .join('')
      : '<option value="">No files found</option>';
    row.innerHTML = `
      <span class="model-role-label">${esc(entry.label)}</span>
      <select data-role-select="${esc(entry.key)}" ${files.length ? '' : 'disabled'}>${options}</select>
      <button class="mini" data-role-browse="${esc(entry.key)}">Browse…</button>`;
    box.appendChild(row);
    const select = row.querySelector('select');
    if (select) {
      select.onchange = () => selectRoleModel(entry.key, select.value);
    }
    const browse = row.querySelector('button');
    browse.onclick = async () => {
      const file = await api.pickModel();
      if (!file) return;
      await selectRoleModel(entry.key, file);
    };
  }
}

function renderModels() {
  const data = S.models;
  const box = $('#models');
  if (!box) return;
  if (!data?.entries) {
    box.innerHTML = '<p class="note">Model status unavailable.</p>';
    return;
  }
  // A failed download that the user repaired outside the app (or a finished
  // transfer whose models refresh raced its event) must not stay red forever.
  for (const entry of data.entries) {
    const dl = S.modelDl.get(entry.id);
    if (dl && ['error', 'done'].includes(dl.status) && !entry.download) S.modelDl.delete(entry.id);
  }
  box.innerHTML = '';
  for (const entry of data.entries) {
    const row = document.createElement('div');
    row.className = 'model';
    row.dataset.model = entry.id;
    box.appendChild(row);
    paintModelRow(row, entry);
    const dl = S.modelDl.get(entry.id) || entry.download;
    if (dl) paintDownload(row, entry, dl);
  }
}

function paintModelRow(row, entry) {
  const activeDl = S.modelDl.get(entry.id) || entry.download || null;
  const busy = Boolean(activeDl && ['running', 'queued'].includes(activeDl.status));
  const currentVariant = entry.variants.find((v) => v.current) || null;
  const beta = currentVariant?.beta ? '<span class="model-beta">BETA</span>' : '';
  const noteAttr = entry.note ? ` title="${esc(entry.note)}"` : '';
  const statusClass = entry.exists ? 'ok' : entry.required ? 'miss' : 'warn';
  const statusText = entry.exists
    ? entry.sizeText || 'Ready'
    : entry.required
      ? 'Missing'
      : 'Optional';
  row.innerHTML = `
    <div class="model-head"${noteAttr}>
      <span class="dot ${entry.exists ? 'on' : entry.required ? 'bad' : 'warn'}"></span>
      <span class="model-label">${esc(entry.label)}${beta}</span>
      <span class="model-status ${statusClass}">${esc(statusText)}</span>
    </div>
    <div class="model-select-row">
      <select class="model-file-select" aria-label="${esc(entry.label)} file"></select>
      <button class="mini" data-role="browse" title="Use a file from anywhere">Browse…</button>
    </div>
    <div class="model-file-path ${entry.exists ? '' : 'missing'}" title="${esc(entry.path || '')}">${esc(entry.path || '')}</div>`;

  const select = row.querySelector('.model-file-select');
  const browse = row.querySelector('[data-role="browse"]');

  // One dropdown does everything: pick an existing file from the model
  // folders, or start a missing variant download from the same place.
  const files = Array.isArray(entry.files) ? entry.files : [];
  const knownNames = new Set(files.map((file) => file.name.toLowerCase()));
  const fileOptions = files
    .map(
      (file) =>
        `<option value="${esc(file.path)}" ${file.current ? 'selected' : ''}>${esc(file.name)}${
          file.sizeText ? ` · ${esc(file.sizeText)}` : ''
        }</option>`,
    )
    .join('');
  const variants = Array.isArray(entry.variants) ? entry.variants : [];
  const missingVariants = variants.filter(
    (v) => v.downloadable && !knownNames.has(String(v.file || '').toLowerCase()),
  );
  const variantOptions = missingVariants
    .map((v) => `<option value="variant:${esc(v.id)}">Download ${esc(v.label)}${v.beta ? ' · Beta' : ''}</option>`)
    .join('');
  select.innerHTML = `
    ${fileOptions ? `<optgroup label="In this folder">${fileOptions}</optgroup>` : ''}
    ${variantOptions ? `<optgroup label="Download">${variantOptions}</optgroup>` : ''}
    ${!fileOptions && !variantOptions ? '<option value="">No files found</option>' : ''}
  `;
  if (!entry.exists) {
    const wanted = String(entry.file || '').split('/').pop().toLowerCase();
    const match = missingVariants.find((v) => String(v.file || '').toLowerCase() === wanted);
    if (match) select.value = `variant:${match.id}`;
  }
  select.disabled = busy;
  browse.disabled = busy;
  select.onchange = async () => {
    const value = select.value;
    if (!value) return;
    if (value.startsWith('variant:')) {
      try {
        await api.downloadModels([entry.id], value.slice('variant:'.length));
        toast(`Downloading ${entry.label}…`);
      } catch (err) {
        toast(friendly(err), 'error');
      }
      return;
    }
    try {
      await api.setModelFile(entry.key, value);
      S.models = await api.models();
      renderModels();
      toast(`${entry.label} selected.`, 'ok');
    } catch (err) {
      toast(friendly(err), 'error');
    }
  };
  browse.onclick = async () => {
    const file = await api.pickModel();
    if (!file) return;
    try {
      await api.setModelFile(entry.key, file);
      S.models = await api.models();
      renderModels();
      toast(`${entry.label} selected.`, 'ok');
    } catch (err) {
      toast(friendly(err), 'error');
    }
  };
}

function updateModelRow(id, dl) {
  const row = document.querySelector(`.model[data-model="${id}"]`);
  if (!row) return;
  const entry = S.models?.entries?.find((e) => e.id === id);
  if (entry) paintModelRow(row, entry);
  paintDownload(row, entry, dl);
}

function paintDownload(row, entry, dl) {
  let wrap = row.querySelector('.dl');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.className = 'dl';
    wrap.style.width = '100%';
    wrap.innerHTML = '<div class="bar"><span></span></div><div class="model-note"></div>';
    row.appendChild(wrap);
  }
  const bar = wrap.querySelector('.bar span');
  const note = wrap.querySelector('.model-note');
  const retryBtn = wrap.querySelector('.dl-retry');
  if (retryBtn) retryBtn.remove();
  if (dl.status === 'running') {
    note.className = 'model-note';
    bar.style.width = `${dl.percent || 0}%`;
    note.textContent = `${dl.receivedText || ''} / ${dl.totalText || ''} · ${dl.speedText || ''}`;
    if (!wrap.querySelector('.dl-cancel')) {
      const cancel = document.createElement('button');
      cancel.className = 'mini dl-cancel';
      cancel.textContent = 'Cancel';
      cancel.style.marginTop = '4px';
      cancel.onclick = () => api.cancelDownload(entry?.id || dl.id);
      wrap.appendChild(cancel);
    }
  } else if (dl.status === 'queued') {
    note.className = 'model-note';
    bar.style.width = '0%';
    note.textContent = 'Waiting for another download…';
    if (!wrap.querySelector('.dl-cancel')) {
      const cancel = document.createElement('button');
      cancel.className = 'mini dl-cancel';
      cancel.textContent = 'Cancel';
      cancel.style.marginTop = '4px';
      cancel.onclick = () => api.cancelDownload(entry?.id || dl.id);
      wrap.appendChild(cancel);
    }
  } else if (dl.status === 'error') {
    wrap.querySelector('.dl-cancel')?.remove();
    bar.style.width = '0%';
    // A user-initiated cancel is a terminal download state, not a failure.
    // Keep it neutral so it does not read like a broken render.
    const canceled = /^canceled$/i.test(String(dl.error || ''));
    note.className = canceled ? 'model-note' : 'model-err';
    note.textContent = canceled ? 'Canceled' : dl.error || 'Download failed';
    const retry = document.createElement('button');
    retry.className = 'mini primary dl-retry';
    retry.textContent = 'Retry';
    retry.style.marginTop = '4px';
    retry.onclick = async () => {
      retry.disabled = true;
      try {
        await api.retryDownload(entry?.id || dl.id);
        toast(`Retrying ${entry?.label || 'download'}…`);
      } catch (err) {
        toast(friendly(err), 'error');
        retry.disabled = false;
      }
    };
    wrap.appendChild(retry);
  } else if (dl.status === 'done') {
    wrap.querySelector('.dl-cancel')?.remove();
    note.className = 'model-note';
    bar.style.width = '100%';
    note.textContent = 'download complete';
    setTimeout(() => {
      wrap?.remove();
      refreshModels();
    }, 600);
  }
}

async function refreshModels() {
  try {
    S.models = await api.models();
    renderModels();
  } catch {}
}

/* --------------------------- agent models --------------------------- */

let providerTimer = 0;

async function refreshProviders(force = false) {
  try {
    const report = await api.opencodeReport(force);
    S.ocReport = report;
    S.providers = report.providers || [];
    S.providersLoaded = true;
    renderProviders();
  } catch (err) {
    const box = $('#providersList');
    if (box) box.innerHTML = `<div class="providers-error">Could not load models: ${friendly(err)}</div>`;
    S.providersLoaded = true;
  }
}

// Keep the list in step with OpenCode while the drawer is open: if the user
// connects/disconnects a provider in another window, the list updates itself.
function startProviderSync() {
  stopProviderSync();
  providerTimer = setInterval(() => refreshProviders(false), 60000);
}

function stopProviderSync() {
  clearInterval(providerTimer);
  providerTimer = 0;
}

function renderOcStatus() {
  const box = $('#ocStatus');
  if (!box) return;
  const report = S.ocReport;
  const selected = S.settings?.opencode?.model || '';
  const rows = [];
  const add = (text, cls = '') => rows.push(`<div class="oc-status-row ${cls}">${esc(text)}</div>`);
  if (!report) {
    box.innerHTML = '<div class="oc-status-row">Checking OpenCode…</div>';
    return;
  }
  if (!report.ok) {
    add(report.error || 'OpenCode v2 or newer was not found.', 'bad');
    const shown = report.desktopExe || S.settings?.opencode?.desktopExe;
    if (shown) add(`Selected path: ${shown}`, 'dim');
    box.innerHTML = rows.join('');
    return;
  }
  const version = report.version || '2.x';
  const shownPath = report.desktopExe || S.settings?.opencode?.desktopExe || '';
  add(`OpenCode ${version}${shownPath ? ` · ${shownPath}` : ' · desktop app path not set'}`);
  add(
    S.settings?.opencode?.betaAgent
      ? 'Agent: beta (egglab-beta) — developing version'
      : 'Agent: official (egglab)',
    'dim',
  );
  add(
    `${report.providers?.length || 0} providers · ${report.modelCount || 0} models · ${
      report.auth?.length || 0
    } accounts`,
  );
  const connectedCount = report.connectedProviderIds?.length || 0;
  if (!connectedCount) {
    add('No provider is connected in OpenCode yet. Connect a provider, then refresh.', 'warn');
  } else {
    add(`${connectedCount} connected provider${connectedCount === 1 ? '' : 's'}`);
  }
  if (report.modelsError) add(report.modelsError, 'bad');
  if (report.authError) add(`Accounts unavailable: ${report.authError}`, 'warn');
  if (selected) {
    if (report.selectedDesktopOnly) {
      add(`Selected model works only in the OpenCode desktop app: ${selected}`, 'warn');
    } else if (!report.selectedAvailable) {
      add(`Selected model is not in the current list: ${selected}`, 'warn');
    } else if (!report.selectedConnected) {
      add(`Selected model provider is not connected: ${selected}`, 'warn');
    } else {
      add(`Selected model available: ${selected}`, 'dim');
    }
    if (!report.selectedConnected && report.suggestedModel) {
      add(`Suggested free model: ${report.suggestedModel}`, 'warn');
    }
    if (/(?:^|\/)[^/]*-free(?:$|#)/i.test(selected) || /-free/i.test(selected)) {
      add('Free model selected. Provider/free limits can pause chats.', 'warn');
    }
  } else {
    add('No chat model selected yet. Connect a provider, then choose one.', 'warn');
  }
  if (report.configError) add(report.configError, 'warn');
  box.innerHTML = rows.join('');
}

function renderProviders() {
  const box = $('#providersList');
  if (!box) return;
  renderOcStatus();
  const s = S.settings;
  const current = s?.opencode?.model || '';
  const currentProvider = current.split('/')[0] || '';
  const providerPill = $('#ocProviderPill');
  if (providerPill) providerPill.textContent = currentProvider || '—';

  if (!S.providersLoaded) {
    box.innerHTML = '<div class="providers-loading">Loading models from OpenCode…</div>';
    return;
  }

  // Show every provider OpenCode knows, including ones without a connected
  // account. Filtering them out left a fresh install with a single row (the
  // current selection) and no way to see what is available or why. Disconnected
  // models stay visible but are marked and refused on click by selectModel().
  const all = S.providers || [];
  if (!all.length) {
    const report = S.ocReport;
    const detail = report?.modelsError
      ? `<div class="providers-error">${esc(report.modelsError)}</div>`
      : '';
    box.innerHTML = `<div class="providers-empty">No OpenCode models found. Connect a provider in OpenCode first.</div>${detail}`;
    return;
  }

  const q = S.ocSearch.trim().toLowerCase();
  const searching = Boolean(q);
  // Always keep the currently selected model visible, even when its provider
  // is temporarily absent from the live list (custom provider, offline
  // discovery, or a model configured in OpenCode but not returned right now).
  const currentModel = current;
  const currentModelRow = currentModel && !all.some((provider) =>
    provider.models.some((model) => model.id === currentModel),
  )
    ? {
        provider: currentModel.split('/')[0] || 'current',
        connected: false,
        models: [{ id: currentModel, modelId: currentModel.split('/').slice(1).join('/') || currentModel, provider: currentModel.split('/')[0] || 'current' }],
      }
    : null;
  const allWithCurrent = currentModelRow ? [currentModelRow, ...all] : all;
  const providers = allWithCurrent
    .map((p) => ({
      provider: p.provider,
      models: q
        ? p.models.filter(
            (m) => m.modelId.toLowerCase().includes(q) || p.provider.toLowerCase().includes(q),
          )
        : p.models,
    }))
    .filter((p) => p.models.length > 0);

  if (!providers.length) {
    box.innerHTML = '<div class="providers-empty">No models match that filter.</div>';
    return;
  }

  box.innerHTML = '';
  if (!all.some((provider) => provider.connected)) {
    const hint = document.createElement('div');
    hint.className = 'providers-error';
    hint.textContent =
      'No provider is connected in OpenCode yet. Connect one in OpenCode desktop, then click Refresh here.';
    box.appendChild(hint);
  }
  for (const prov of providers) {
    // Default: the provider of the current model is open, the rest collapsed.
    // Once the user toggles a group their choice wins.
    const expanded = searching
      ? true
      : S.ocToggled.has(prov.provider)
        ? S.ocExpanded.has(prov.provider)
        : prov.provider === currentProvider;
    const group = document.createElement('div');
    group.className = `provider-group${expanded ? '' : ' collapsed'}`;

    const head = document.createElement('button');
    head.className = 'provider-head';
    head.type = 'button';
    head.innerHTML = `
      <span class="provider-chev">${expanded ? '▾' : '▸'}</span>
      <span class="provider-id">${esc(prov.provider)}</span>
      <span class="provider-state${prov.connected ? ' connected' : ''}">${
        prov.connected ? 'connected' : 'not connected'
      }</span>
      <span class="model-count">${prov.models.length}</span>`;
    head.onclick = () => {
      if (searching) return;
      const nowExpanded = S.ocExpanded.has(prov.provider);
      S.ocToggled.add(prov.provider);
      if (nowExpanded) S.ocExpanded.delete(prov.provider);
      else S.ocExpanded.add(prov.provider);
      renderProviders();
    };
    group.appendChild(head);

    if (expanded) {
      const rows = document.createElement('div');
      rows.className = 'model-rows';
      for (const m of prov.models) {
        const selected = m.id === current;
        const row = document.createElement('div');
        row.className = `model-row${selected ? ' model-selected' : ''}`;
        row.dataset.model = m.id;
        row.dataset.provider = prov.provider;
        row.tabIndex = 0;
        row.role = 'button';
        row.ariaLabel = `Select model ${m.id}`;
        row.innerHTML = `
          <span class="model-id">${esc(m.modelId)}</span>
          <span class="model-badge">${selected ? 'selected' : ''}${prov.connected ? '' : ' · not connected'}</span>
        `;
        row.onclick = () => selectModel(m.id);
        row.onkeydown = (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            selectModel(m.id);
          }
        };
        rows.appendChild(row);
      }
      group.appendChild(rows);
    }
    box.appendChild(group);
  }
}

async function selectModel(modelId) {
  if (!modelId || modelId === (S.settings?.opencode?.model || '')) return;
  const providerId = modelId.split('/')[0];
  const provider = (S.providers || []).find((p) => p.provider === providerId);
  if (provider && !provider.connected) {
    toast(
      'That provider is not connected in OpenCode. Connect it in OpenCode desktop, then click Refresh here.',
      'error',
    );
    return;
  }
  try {
    S.settings = await api.patchSettings({ opencode: { model: modelId } });
    // Reveal the newly selected model's provider group.
    const prov = modelId.split('/')[0];
    S.ocToggled.add(prov);
    S.ocExpanded.add(prov);
    renderProviders();
    syncUI();
    toast(`Chat model: ${modelId}`, 'ok');
  } catch (err) {
    toast(friendly(err), 'error');
  }
}

/* --------------------------- photocraft ---------------------------- */

function renderPc() {
  const pc = S.pc || {};
  const dot = $('#pcDot');
  dot.className = 'dot';
  const name = $('#pcName');
  const doc = $('#pcDoc');
  const action = $('#pcAction');

  // The status payload carries the active document's dirty flag too, so the
  // thread label can show "unsaved" without a second round-trip.
  if (pc.document) S.pcDoc = { ...(S.pcDoc || {}), ...pc.document };
  else if (!pc.running) S.pcDoc = null;
  renderThreadLabel();

  if (pc.running && pc.document) {
    dot.classList.add('on');
    name.textContent = 'PhotoCraft';
    doc.textContent = `${pc.document.name} · ${pc.document.width}×${pc.document.height} · ${pc.document.layers} layers`;
    action.textContent = 'Refresh';
    action.onclick = refreshPc;
  } else if (pc.running) {
    dot.classList.add('warn');
    name.textContent = 'PhotoCraft';
    doc.textContent = 'no document open';
    action.textContent = 'New 1080²';
    action.onclick = async () => {
      try {
        await api.pcNewDoc({ width: 1080, height: 1080, background: 'white', name: 'EggLab' });
        toast('Document created', 'ok');
        refreshPc();
      } catch (err) {
        toast(friendly(err), 'error');
      }
    };
  } else if (pc.exeExists || pc.cliExists) {
    dot.classList.add('bad');
    name.textContent = 'PhotoCraft';
    doc.textContent = pc.error ? String(pc.error).slice(0, 60) : 'not connected';
    action.textContent = 'Connect';
    action.onclick = async () => {
      try {
        await api.pcLaunch();
        toast('PhotoCraft started', 'ok');
        setTimeout(refreshPc, 1200);
      } catch (err) {
        toast(friendly(err), 'error');
      }
    };
  } else {
    dot.classList.add('bad');
    name.textContent = 'PhotoCraft';
    doc.textContent = 'app not found';
    action.textContent = 'Settings';
    action.onclick = () => openDrawer();
  }

  const pill = $('#pcPill');
  if (pill) {
    pill.textContent = pc.running ? (pc.document ? 'connected' : 'idle') : 'offline';
    pill.className = `pill ${pc.running ? (pc.document ? 'on' : 'warn') : 'err'}`;
  }

  // Save button: only useful with an open document, and it doubles as the
  // "this work is unsaved" warning when the document has never been written out.
  const save = $('#pcSave');
  if (save) {
    const hasDoc = Boolean(pc.running && pc.document);
    save.classList.toggle('hidden', !hasDoc);
    if (hasDoc) {
      const dirty = pc.document.dirty !== false;
      const untitled = !pc.document.path;
      save.textContent = untitled ? 'Save as…' : dirty ? 'Save' : 'Saved';
      save.classList.toggle('primary', dirty);
      save.title = untitled
        ? 'This document has never been saved — pick a project folder.'
        : dirty
          ? `Unsaved changes · ${pc.document.path}`
          : `Saved · ${pc.document.path}`;
      save.onclick = () => saveDocument(untitled);
    }
  }
}

/**
 * Keep Tab inside a modal while it is open, and return focus where it came
 * from on close. Without this `aria-modal="true"` is a lie to screen readers.
 */
function trapFocus(modal) {
  const previous = document.activeElement;
  const selector = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
  const onKey = (e) => {
    if (e.key !== 'Tab') return;
    const items = [...modal.querySelectorAll(selector)].filter((el) => !el.disabled && el.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
  modal.addEventListener('keydown', onKey);
  return () => {
    modal.removeEventListener('keydown', onKey);
    if (previous && previous.isConnected) previous.focus();
  };
}

/**
 * Ask for a single line of text. Electron has no `window.prompt`, so the panel
 * draws its own dialog. Resolves to the trimmed value, or null on cancel.
 */
function askText({ title, note = '', value = '', placeholder = '', preview = null }) {
  const scrim = $('#promptScrim');
  const modal = $('#promptModal');
  const input = $('#promptInput');
  const pathEl = $('#promptPath');
  $('#promptTitle').textContent = title;
  $('#promptNote').textContent = note;
  $('#promptNote').classList.toggle('hidden', !note);
  input.value = value;
  input.placeholder = placeholder;

  const showPreview = () => {
    const next = preview ? preview(input.value.trim()) : '';
    pathEl.textContent = next || '';
    pathEl.classList.toggle('hidden', !next);
  };
  showPreview();

  return new Promise((resolve) => {
    let settled = false;
    let untrap = () => {};
    const done = (value) => {
      if (settled) return;
      settled = true;
      scrim.classList.remove('on');
      modal.classList.remove('on');
      modal.setAttribute('aria-hidden', 'true');
      scrim.onclick = null;
      $('#promptOk').onclick = null;
      $('#promptCancel').onclick = null;
      input.onkeydown = null;
      input.oninput = null;
      untrap();
      resolve(value);
    };

    scrim.classList.add('on');
    modal.classList.add('on');
    modal.setAttribute('aria-hidden', 'false');
    input.focus();
    input.select();
    untrap = trapFocus(modal);

    input.oninput = showPreview;
    $('#promptOk').onclick = () => {
      const v = input.value.trim();
      done(v || null);
    };
    $('#promptCancel').onclick = () => done(null);
    scrim.onclick = () => done(null);
    input.onkeydown = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const v = input.value.trim();
        done(v || null);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        done(null);
      }
    };
  });
}

/**
 * Yes/no confirmation in the panel's own style. Electron's native
 * showMessageBox would work but blocks the whole app and looks nothing like
 * the rest of EggLab. Resolves to true on confirm, false on cancel/dismiss.
 */
function askConfirm({ title = 'Are you sure?', note = '', ok = 'Confirm', cancel = 'Cancel', danger = true }) {
  const scrim = $('#confirmScrim');
  const modal = $('#confirmModal');
  $('#confirmTitle').textContent = title;
  $('#confirmNote').textContent = note;
  $('#confirmNote').classList.toggle('hidden', !note);
  const okBtn = $('#confirmOk');
  okBtn.textContent = ok;
  okBtn.classList.toggle('danger', danger);
  okBtn.classList.toggle('primary', !danger);
  $('#confirmCancel').textContent = cancel;

  return new Promise((resolve) => {
    let settled = false;
    let untrap = () => {};
    const done = (value) => {
      if (settled) return;
      settled = true;
      scrim.classList.remove('on');
      modal.classList.remove('on');
      modal.setAttribute('aria-hidden', 'true');
      scrim.onclick = null;
      okBtn.onclick = null;
      $('#confirmCancel').onclick = null;
      modal.onkeydown = null;
      untrap();
      resolve(value);
    };

    scrim.classList.add('on');
    modal.classList.add('on');
    modal.setAttribute('aria-hidden', 'false');
    $('#confirmCancel').focus();
    untrap = trapFocus(modal);

    okBtn.onclick = () => done(true);
    $('#confirmCancel').onclick = () => done(false);
    scrim.onclick = () => done(false);
    modal.onkeydown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        done(false);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        done(true);
      }
    };
  });
}

/** Save the active document; untitled ones are prompted for a project name. */
async function saveDocument(forcePrompt) {
  try {
    if (forcePrompt) {
      const suggested = (S.pc?.document?.name || 'Untitled')
        .replace(/\.(pcraft|psd|psb)$/i, '')
        .replace(/\s+/g, '-')
        .trim();
      const name = await askText({
        title: 'Save as a project',
        note: 'This document has never been saved, so nothing on the canvas is on disk yet. Pick a project name and EggLab will create projects/<name>/<name>.pcraft.',
        value: suggested,
        placeholder: 'my-poster',
        preview: (v) => (v ? `projects/${v}/${v}.pcraft` : ''),
      });
      if (!name) return;
      const made = await api.pcProjectPath(name);
      await api.pcSave({ path: made.path });
      toast(`Saved to ${made.path}`, 'ok');
    } else {
      const res = await api.pcSave({});
      toast(`Saved · ${res.name}`, 'ok');
    }
    await refreshPc();
  } catch (err) {
    toast(friendly(err), 'error');
  }
}

async function refreshPc() {
  try {
    S.pc = await api.pcStatus();
    renderPc();
  } catch (err) {
    toast(friendly(err), 'error');
  }
}

async function ensurePc() {
  const status = S.pc || (await api.pcStatus());
  S.pc = status;
  renderPc();
  if (!status.running) {
    throw new Error('PhotoCraft is not connected. Press "Connect" first.');
  }
  return status;
}

/* ------------------------------------------------------------------ */
/* bindings                                                            */
/* ------------------------------------------------------------------ */

function bind() {
  $('#btnMin').onclick = () => api.winMin();
  $('#btnClose').onclick = () => api.winClose();
  $('#btnPin').onclick = async () => {
    S.pinned = !S.pinned;
    await api.winPin(S.pinned);
    $('#btnPin').classList.toggle('on', S.pinned);
  };

  $('#wfSeg').querySelectorAll('button').forEach((btn) => {
    btn.onclick = () => setWorkflow(btn.dataset.wf);
  });

  const openDrawer = () => {
    $('#drawer').classList.add('open');
    $('#drawer').setAttribute('aria-hidden', 'false');
    $('#scrim').classList.add('on');
    // Refresh the OpenCode model list each time the drawer opens (cached for a
    // few seconds) and keep it in sync while it stays open. Also re-read engine
    // models: a canceled/failed download may have been repaired or installed
    // outside this window while the drawer was closed.
    refreshModels();
    refreshProviders();
    startProviderSync();
  };
  window.openDrawer = openDrawer;
  $('#btnDrawer').onclick = openDrawer;
  $('#btnDrawerClose').onclick = closeDrawer;
  $('#scrim').onclick = closeDrawer;

  $('#threadLabel').onclick = (e) => {
    e.stopPropagation();
    openSessions();
  };
  $('#canvasPopupMake').onclick = canvasPopupCreate;
  $('#canvasPopupLater').onclick = closeCanvasPopup;
  $('#canvasPopup').onclick = (e) => {
    if (e.target === $('#canvasPopup')) closeCanvasPopup();
  };
  $('#btnSessionNew').onclick = async (e) => {
    e.stopPropagation();
    await newChat();
  };
  document.addEventListener('click', (e) => {
    if (!$('#sessions').classList.contains('on')) return;
    if (e.target.closest('#sessions') || e.target.closest('#threadLabel')) return;
    closeSessions();
  });

  $('#input').addEventListener('input', () => {
    autoGrow();
    updateMentionPicker();
  });
  $('#input').addEventListener('click', updateMentionPicker);
  $('#input').addEventListener('keydown', (e) => {
    if (S.mention.open) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        moveMention(1);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        moveMention(-1);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeMention();
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const layer = S.mention.items[S.mention.index];
        if (layer) pickMention(layer);
        else closeMention();
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  document.addEventListener('mousedown', (e) => {
    if (!S.mention.open) return;
    if (e.target.closest('#mentionList') || e.target.closest('#input')) return;
    closeMention();
  });
  $('#btnSend').onclick = sendMessage;
  $('#btnStop').onclick = () => api.chatStop();
  $('#btnAttach').onclick = async () => {
    const files = await api.pickImages();
    for (const f of files) addRef(f);
  };
  $('#btnDirect').onclick = directRender;
  $('#btnShowCanvas').onclick = showCanvas;

  $('#chkTransparent').onchange = (e) => queuePatch({ transparent: e.target.checked });

  $('#empty').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-fill]');
    if (!btn) return;
    $('#input').value = btn.dataset.fill;
    autoGrow();
    if (btn.dataset.transparent === '1') {
      $('#chkTransparent').checked = true;
      queuePatch({ transparent: true });
    }
    $('#input').focus();
  });

  // drawer fields
  on('#qSteps', 'change', (v) => queuePatch({ quality: { steps: clampInt(v, 4, 60) } }));
  on('#qCfg', 'change', (v) => queuePatch({ quality: { cfg: clampNum(v, 1, 12) } }));
  on('#tSteps', 'change', (v) => queuePatch({ turbo: { steps: clampInt(v, 4, 8) } }));
  on('#inWidth', 'change', (v) => {
    const width = snap(v);
    queuePatch({ width, aspect: 'custom' });
  });
  on('#inHeight', 'change', (v) => {
    const height = snap(v);
    queuePatch({ height, aspect: 'custom' });
  });
  on('#inSeed', 'change', (v) => queuePatch({ seed: Number.isFinite(Number(v)) ? Number(v) : -1 }));
  on('#inBatch', 'change', (v) => queuePatch({ batch: clampInt(v, 1, 4) }));
  on('#inRefMax', 'change', (v) => queuePatch({ refMaxSide: clampInt(v, 256, 2048) }));
  on('#chkLockSeed', 'change', (v) => queuePatch({ lockSeed: v }));
  on('#chkOffload', 'change', (v) => queuePatch({ offload: v }));
  on('#pcPort', 'change', (v) => queuePatch({ photocraft: { controlPort: clampInt(v, 1, 65535) } }));
  on('#pcWidth', 'change', async (v) => {
    const width = clampInt(v, 380, 720);
    await api.winSetWidth(width);
    queuePatch({ photocraft: { width } });
  });
  on('#pcExe', 'change', (v) => queuePatch({ photocraft: { exe: v.trim() } }));
  $('#chkDock').onchange = async (e) => {
    await api.winDock(e.target.checked);
    queuePatch({ photocraft: { dock: e.target.checked } });
  };
  const refreshBtn = $('#btnRefreshModels');
  if (refreshBtn) {
    refreshBtn.onclick = async () => {
      refreshBtn.disabled = true;
      try {
        await refreshProviders(true);
        toast('Model list refreshed', 'ok');
      } finally {
        refreshBtn.disabled = false;
      }
    };
  }
  const ocSearch = $('#ocSearch');
  if (ocSearch) {
    ocSearch.oninput = (e) => {
      S.ocSearch = e.target.value;
      renderProviders();
    };
  }

  $('#btnDownloadMissing').onclick = async () => {
    const missing = (S.models?.entries || []).filter((e) => !e.exists && e.required).map((e) => e.id);
    if (!missing.length) return toast('All required models are installed.');
    try {
      await api.downloadModels(missing);
      toast(`Downloading ${missing.length} model${missing.length > 1 ? 's' : ''}…`);
    } catch (err) {
      toast(friendly(err), 'error');
    }
  };

  const modelsFolderBtn = $('#btnModelsFolder');
  if (modelsFolderBtn) {
    modelsFolderBtn.onclick = async () => {
      const folder = await api.pickFolder();
      if (!folder) return;
      try {
        await api.setModelsFolder(folder);
        await refreshRuntime();
        toast('Models folder updated.', 'ok');
      } catch (err) {
        toast(friendly(err), 'error');
      }
    };
  }
  const openModelsBtn = $('#btnOpenModels');
  if (openModelsBtn) {
    openModelsBtn.onclick = () => {
      const dir = S.engine?.modelsDir || S.settings?.modelsDir;
      if (dir) api.openPath(dir);
    };
  }
  const useOpenCodeBtn = $('#btnUseOpenCode');
  if (useOpenCodeBtn) {
    useOpenCodeBtn.onclick = async () => {
      const file = await api.pickOpenCode();
      if (!file) return;
      try {
        const result = await api.setOpenCode(file);
        S.ocReport = null;
        S.providersLoaded = false;
        await refreshRuntime();
        await refreshProviders(true);
        if (result?.desktopApp) {
          toast(result?.desktopApp ? `Using OpenCode desktop: ${result.desktopApp}` : 'OpenCode linked.', 'ok');
        } else {
          toast('OpenCode linked. Providers and models loaded.', 'ok');
        }
      } catch (err) {
        toast(friendly(err), 'error');
      }
    };
  }
  const installOpenCodeBtn = $('#btnInstallOpenCode');
  if (installOpenCodeBtn) {
    installOpenCodeBtn.onclick = async () => {
      installOpenCodeBtn.disabled = true;
      try {
        await api.setupAction('opencode-desktop');
        toast('Downloading the installer — complete the OpenCode setup in the window that opens.', 'ok');
      } catch (err) {
        toast(friendly(err), 'error');
        installOpenCodeBtn.disabled = false;
      }
    };
  }
  const openOcConfigBtn = $('#btnOpenOcConfig');
  if (openOcConfigBtn) {
    openOcConfigBtn.onclick = async () => {
      try {
        const report = await api.opencodeReport(false);
        if (report.configPath) api.revealPath(report.configPath);
        else toast('No global OpenCode config found yet.', 'error');
      } catch (err) {
        toast(friendly(err), 'error');
      }
    };
  }

  // Beta agent toggle: chats then run egglab-beta (the developing agent) in
  // its own workspace and session scope. Session forking on switch is handled
  // panel-side (sessions.bind), so a plain settings patch is all that is needed.
  const betaAgentPill = $('#betaAgentPill');
  const renderBetaState = () => {
    const on = Boolean(S.settings?.opencode?.betaAgent);
    const chk = $('#chkBetaAgent');
    if (chk) chk.checked = on;
    if (betaAgentPill) {
      betaAgentPill.textContent = on ? 'Beta on' : 'Off';
      betaAgentPill.classList.toggle('on', on);
    }
  };
  const betaAgentChk = $('#chkBetaAgent');
  if (betaAgentChk) {
    renderBetaState();
    betaAgentChk.onchange = async () => {
      try {
        S.settings = await api.patchSettings({ opencode: { betaAgent: betaAgentChk.checked } });
        renderBetaState();
        renderOcStatus();
        toast(
          betaAgentChk.checked
            ? 'Beta agent enabled. New chats run egglab-beta and start fresh sessions.'
            : 'Beta agent off. New chats run the official agent again.',
          'ok',
        );
      } catch (err) {
        renderBetaState();
        toast(friendly(err), 'error');
      }
    };
  }

  $('#btnLaunchPc').onclick = async () => {
    try {
      await api.pcLaunch();
      toast('PhotoCraft started with the EggLab bridge', 'ok');
      setTimeout(refreshPc, 1200);
    } catch (err) {
      toast(friendly(err), 'error');
    }
  };
  $('#btnRefreshPc').onclick = refreshPc;

  $('#btnNewChat').onclick = async () => {
    try {
      const ok = await api.chatClear();
      if (ok === false) {
        toast('The agent is still working — press stop before starting a new chat.', 'error');
        return;
      }
      // Repaint here too: clearing the file but leaving the old messages on
      // screen made the chat look like it had not been cleared at all.
      S.items = [];
      S.nodeIndex.clear();
      renderTimeline();
      toast('Fresh chat');
      closeDrawer();
    } catch (err) {
      toast(friendly(err), 'error');
    }
  };
  $('#btnOutDir').onclick = () => {
    if (S.outDir) api.revealPath(S.outDir);
  };

  $('#pcBar').querySelector('.pc-name').onclick = refreshPc;

  // drag & drop references
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
    dragDepth++;
    $('#drop').classList.add('on');
  });
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) $('#drop').classList.remove('on');
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('#drop').classList.remove('on');
    const files = [...(e.dataTransfer?.files || [])]
      .filter((f) => /\.(png|jpe?g|webp|bmp|tiff?)$/i.test(f.name))
      .map((f) => f.path)
      .filter(Boolean);
    for (const f of files) addRef(f);
    if (files.length) toast(`${files.length} reference${files.length > 1 ? 's' : ''} added`);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDrawer();
  });
}

function on(sel, event, handler) {
  const node = $(sel);
  if (!node) return;
  node.addEventListener(event, () => handler(node.value, node));
}

function closeDrawer() {
  $('#drawer').classList.remove('open');
  $('#drawer').setAttribute('aria-hidden', 'true');
  $('#scrim').classList.remove('on');
  stopProviderSync();
}

function clampInt(value, min, max) {
  return Math.max(min, Math.min(max, Math.round(Number(value) || min)));
}
function clampNum(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || min));
}
function snap(value) {
  // Generator size envelope: 256 floor, 2048 ceiling, multiples of 32.
  return Math.min(2048, Math.max(256, Math.round(Number(value || 1024) / 32) * 32));
}

/* ------------------------------------------------------------------ */
/* first-run setup wizard                                              */
/* ------------------------------------------------------------------ */

function showSetup() {
  $('#setup').classList.add('on');
  $('#setupScrim').classList.add('on');
  $('#setup').setAttribute('aria-hidden', 'false');
  $('#setupScrim').setAttribute('aria-hidden', 'false');
}

function hideSetup() {
  $('#setup').classList.remove('on');
  $('#setupScrim').classList.remove('on');
  $('#setup').setAttribute('aria-hidden', 'true');
  $('#setupScrim').setAttribute('aria-hidden', 'true');
}

function initSetup() {
  $('#btnSetup').onclick = () => {
    showSetup();
    loadSetup();
  };
  $('#setupClose').onclick = hideSetup;
  $('#setupScrim').onclick = hideSetup;
  $('#setupRescan').onclick = async () => {
    try {
      await api.setupAction('detect');
      await loadSetup();
      toast('Re-scanned local components.');
    } catch (err) {
      toast(friendly(err), 'error');
    }
  };
  $('#setupDone').onclick = async () => {
    try {
      await api.setupAction('complete');
      applyState(await api.state());
      hideSetup();
      toast('Setup saved - have fun.');
    } catch (err) {
      toast(friendly(err), 'error');
    }
  };
  $('#setupBody').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-setup]');
    if (btn) onSetupAction(btn.dataset.setup);
  });
  $('#setupBody').addEventListener('change', (e) => {
    if (e.target.id === 'setupVariant') S.setupVariant = e.target.value;
  });
}

async function loadSetup() {
  try {
    S.setup = await api.setupStatus();
  } catch (err) {
    toast(friendly(err), 'error');
    return;
  }
  try {
    await loadSetupModels(false);
  } catch {}
  renderSetup();
  if (S.setup.firstRun) showSetup();
}

// Setup only offers models from connected providers. Desktop-only OpenCode
// free models (`opencode/<free>`) fail from the CLI, so they are never shown
// as a fresh choice — an invalid current selection is kept for replacement.
async function loadSetupModels(force = false) {
  const report = await api.opencodeReport(force);
  S.setupOcReport = report;
  const models = [];
  let connectedCount = 0;
  for (const provider of report.providers || []) {
    if (!provider.connected) continue;
    connectedCount++;
    for (const model of provider.models || []) models.push(model.id);
  }
  const current = S.settings?.opencode?.model || '';
  if (current && !models.includes(current)) models.unshift(current);
  S.setupOcModels = models;
  return { report, connectedCount, models };
}

function setupBadge(ok, onText = 'Ready', offText = 'Missing') {
  return `<span class="setup-pill ${ok ? 'ok' : 'miss'}">${ok ? onText : offText}</span>`;
}

function renderSetup() {
  const st = S.setup;
  if (!st) return;
  const pc = st.photocraft;
  const oc = st.opencode;
  const en = st.engine;
  const mo = st.models;
  const ocPercent = oc.total ? Math.min(100, Math.floor((oc.received / oc.total) * 100)) : 0;
  const missing = mo.missing || [];
  const modelLine = mo.entries
    .map(
      (entry) =>
        `<span class="${entry.exists ? 'ok' : entry.required ? 'miss' : 'opt'}">${entry.exists ? '✓' : '✗'} ${esc(entry.label)}${
          entry.exists && entry.sizeText ? ` · ${esc(entry.sizeText)}` : ''
        }</span>`
    )
    .join('');
  const engineLog = (en.log || []).slice(-5).join('\n');
  const ocPhase =
    oc.phase === 'downloading'
      ? oc.total
        ? `Downloading… ${ocPercent}%`
        : 'Downloading…'
      : oc.phase === 'extracting'
        ? 'Extracting…'
        : '';
  const pick = S.setupVariant || 'auto';
  const opt = (value, label) => `<option value="${value}" ${pick === value ? 'selected' : ''}>${label}</option>`;
  const currentModel = S.settings?.opencode?.model || '';
  const ocReport = S.setupOcReport || null;
  const modelChoices = Array.isArray(S.setupOcModels) ? S.setupOcModels : [];
  const setupModelOptions = (modelChoices.length ? modelChoices : currentModel ? [currentModel] : [])
    .map((m) => {
      const stale = m === currentModel && ocReport && !ocReport.selectedConnected;
      return `<option value="${esc(m)}" ${m === currentModel ? 'selected' : ''}>${esc(m)}${stale ? ' (not connected)' : ''}</option>`;
    })
    .join('');

  $('#setupBody').innerHTML = `
    <div class="setup-step ${pc.found ? 'ok' : 'miss'}">
      <div class="setup-step-head"><span class="setup-dot"></span><b>PhotoCraft</b>${setupBadge(pc.found, 'Found', 'Not found')}</div>
      <p class="setup-note">${pc.found ? esc(pc.exe) : 'The canvas app EggLab places renders into. Install PhotoCraft, then re-scan or locate its executable.'}</p>
      <div class="setup-actions">
        ${pc.found ? '' : '<button class="mini" data-setup="get-pc">Download PhotoCraft…</button>'}
        <button class="mini" data-setup="locate-pc">Locate…</button>
        ${pc.found ? '<button class="mini" data-setup="launch-pc">Launch</button>' : ''}
      </div>
    </div>
    <div class="setup-step ${oc.running ? 'busy' : oc.found ? 'ok' : 'miss'}">
      <div class="setup-step-head"><span class="setup-dot"></span><b>OpenCode</b>${oc.running ? '<span class="setup-pill">Working…</span>' : setupBadge(oc.found, 'Found', 'Not installed')}</div>
      <p class="setup-note">${oc.desktop?.installed ? `Desktop app installed${oc.desktop.service ? ' · service ready' : ' · start the app and sign in once'}` : 'The agent runs inside the OpenCode desktop app. Download it here, then sign in once.'}${oc.error ? `<br><span class="setup-err">${esc(oc.error)}</span>` : ''}</p>
      ${oc.running ? `<div class="setup-progress"><i style="width:${ocPercent}%"></i></div><p class="setup-note">${esc(ocPhase || 'Preparing…')}</p>` : ''}
      <div class="setup-actions">
        <button class="mini" data-setup="use-opencode">Use existing…</button>
        <button class="mini" data-setup="install-oc" ${oc.running ? 'disabled' : ''}>${oc.desktop?.installed ? 'Start desktop app' : 'Download desktop app'}</button>
        <button class="mini" data-setup="refresh-setup-models" ${oc.found ? '' : 'disabled'}>Refresh models</button>
      </div>
      <div class="setup-model">
        <select id="setupOcModel" ${oc.found ? '' : 'disabled'}>${setupModelOptions}</select>
        <button class="mini" data-setup="save-setup-model" ${oc.found ? '' : 'disabled'}>Use this model</button>
      </div>
      ${ocReport ? `<p class="setup-note">${ocReport.providers?.length || 0} providers · ${ocReport.modelCount || 0} models · ${ocReport.auth?.length || 0} accounts${ocReport.modelsError ? ` · <span class="setup-err">${esc(ocReport.modelsError)}</span>` : ''}</p>` : ''}
      ${ocReport?.selectedDesktopOnly ? `<p class="setup-note"><span class="setup-err">This model's provider is not connected in OpenCode, so the agent cannot use it.</span> Choose a model from a connected provider.</p>` : ''}
      ${ocReport?.suggestedModel && (!ocReport.selectedConnected || !currentModel)
        ? `<p class="setup-note">Suggested free model: <b>${esc(ocReport.suggestedModel)}</b></p>
           <div class="setup-actions"><button class="mini" data-setup="use-suggested-model">Use ${esc(ocReport.suggestedModel)}</button></div>`
        : ''}
      <p class="setup-note">${S.settings?.opencode?.model ? `Current model: ${esc(S.settings.opencode.model)}` : 'Choose the chat model after OpenCode is connected.'}</p>
    </div>
    <div class="setup-step ${en.running ? 'busy' : en.installed ? 'ok' : 'miss'}">
      <div class="setup-step-head"><span class="setup-dot"></span><b>Image engine</b>${en.running ? '<span class="setup-pill">Downloading…</span>' : setupBadge(en.installed, en.variant ? `Installed · ${esc(en.variant)}` : 'Installed', 'Not installed')}</div>
      <p class="setup-note">${en.installed ? esc(en.dir) : 'The local Stable Diffusion engine (stable-diffusion.cpp). Downloaded once: CUDA is fastest on NVIDIA, Vulkan works everywhere, CPU is the fallback.'}${en.error ? `<br><span class="setup-err">${esc(en.error)}</span>` : ''}</p>
      ${en.running ? `<div class="setup-log">${esc(engineLog || 'Starting…')}</div>` : ''}
      <div class="setup-actions">
        <select id="setupVariant" ${en.running ? 'disabled' : ''}>
          ${opt('auto', 'Auto-detect')}
          ${opt('cuda', 'CUDA (NVIDIA, ~900 MB)')}
          ${opt('vulkan', 'Vulkan (any GPU, ~29 MB)')}
          ${opt('cpu', 'CPU (~17 MB)')}
        </select>
        <button class="mini" data-setup="install-engine" ${en.running ? 'disabled' : ''}>${en.installed ? 'Reinstall / switch' : 'Download engine'}</button>
      </div>
    </div>
    <div class="setup-step ${missing.length ? 'miss' : 'ok'}">
      <div class="setup-step-head"><span class="setup-dot"></span><b>Models</b>${setupBadge(missing.length === 0, 'All present', `${missing.length} missing`)}</div>
      <p class="setup-note">${esc(mo.dir)}</p>
      <div class="setup-model">${modelLine}</div>
      <div class="model-roles" id="setupModelRoles"></div>
      <div class="setup-actions">
        <button class="mini" data-setup="use-models-folder">Use existing folder…</button>
        <button class="mini" data-setup="choose-model-files">Choose files…</button>
        <button class="mini" data-setup="download-models" ${missing.length ? '' : 'disabled'}>Download missing</button>
        <button class="mini" data-setup="open-models">Open folder</button>
      </div>
    </div>
  `;
  renderModelRoles('setupModelRoles', mo.entries);
}

async function refreshRuntime() {
  try {
    applyState(await api.state());
  } catch {}
}

async function chooseModelFilesInteractive() {
  const roles = [
    ['diffusion', 'diffusion model'],
    ['vae', 'VAE'],
    ['llm', 'text encoder'],
    ['llmVision', 'vision projector'],
    ['turbo', 'turbo LoRA (optional)'],
  ];
  for (const [role, label] of roles) {
    const want = await askConfirm({
      title: `Choose the ${label}?`,
      note: 'Optional. EggLab uses the file as-is and does not inspect or validate its contents.',
      ok: 'Choose file',
      cancel: 'Skip',
      danger: false,
    });
    if (!want) continue;
    const file = await api.pickModel();
    if (!file) continue;
    await api.setModelFile(role, file);
  }
}

async function onSetupAction(action) {
  const st = S.setup;
  if (!st) return;
  try {
    switch (action) {
      case 'locate-pc': {
        const file = await api.pickApp();
        if (!file) return;
        await api.setupAction('photocraft', { path: file });
        await loadSetup();
        await refreshRuntime();
        toast('PhotoCraft linked.');
        break;
      }
      case 'get-pc':
        await api.openExternal('https://getartcraft.com/');
        break;
      case 'launch-pc':
        await api.pcLaunch();
        toast('Launching PhotoCraft…');
        break;
      case 'install-oc':
        await api.setupAction('opencode-desktop');
        toast(st.opencode?.desktop?.installed ? 'Starting OpenCode desktop…' : 'Downloading installer — you will complete the OpenCode setup.');
        break;
      case 'install-engine': {
        // The select is rendered dynamically with the engine card.
        const variant = document.getElementById('setupVariant')?.value || 'auto';
        S.setupVariant = variant;
        await api.setupAction('engine', { variant, force: Boolean(st.engine.installed) });
        toast('Engine download started - keep EggLab open.');
        break;
      }
      case 'download-models': {
        const ids = st.models.missing || [];
        if (!ids.length) return;
        await api.downloadModels(ids);
        toast(`Downloading ${ids.length} model${ids.length === 1 ? '' : 's'}…`);
        break;
      }
      case 'use-models-folder': {
        const folder = await api.pickFolder();
        if (!folder) return;
        await api.setupAction('models-folder', { folder });
        await loadSetup();
        await refreshRuntime();
        toast('Models folder updated.');
        break;
      }
      case 'choose-model-files': {
        await chooseModelFilesInteractive();
        await loadSetup();
        await refreshRuntime();
        toast('Model files updated.');
        break;
      }
      case 'use-opencode': {
        const file = await api.pickOpenCode();
        if (!file) return;
        const result = await api.setupAction('opencode-path', { path: file });
        if (result?.selected?.desktopApp) {
          toast(result?.selected?.desktopExe ? `Using OpenCode desktop: ${result.selected.desktopExe}` : 'OpenCode linked.', 'ok');
        } else {
          toast('OpenCode linked. Providers and models loaded.', 'ok');
        }
        S.ocReport = null;
        S.providersLoaded = false;
        S.setupOcModels = [];
        S.setupOcReport = null;
        await loadSetup();
        await refreshRuntime();
        await refreshProviders(true);
        break;
      }
      case 'refresh-setup-models': {
        const { report, connectedCount, models } = await loadSetupModels(true);
        renderSetup();
        if (report.modelsError) toast(report.modelsError, 'error');
        else toast(`${models.length} model${models.length === 1 ? '' : 's'} from ${connectedCount} connected provider${connectedCount === 1 ? '' : 's'}.`, 'ok');
        break;
      }
      case 'use-suggested-model': {
        const model = S.setupOcReport?.suggestedModel || '';
        if (!model) return toast('No connected model was found. Connect a provider in OpenCode, then refresh.', 'error');
        S.settings = await api.patchSettings({ opencode: { model } });
        renderSetup();
        toast(`Chat model: ${model}`, 'ok');
        break;
      }
      case 'save-setup-model': {
        const model = document.getElementById('setupOcModel')?.value || '';
        if (!model) return toast('Choose a model first.', 'error');
        const report = S.setupOcReport;
        if (report?.providers?.length) {
          const usable = report.providers.some(
            (p) => p.connected && (p.models || []).some((m) => m.id === model),
          );
          if (!usable) {
            return toast('That model has no connected provider in OpenCode. Use a suggested free model instead.', 'error');
          }
        }
        S.settings = await api.patchSettings({ opencode: { model } });
        renderSetup();
        toast('Agent model saved.', 'ok');
        break;
      }
      case 'import-model': {
        const file = await api.pickModel();
        if (!file) return;
        toast('Copying model file…');
        await api.setupAction('import-model', { path: file });
        await loadSetup();
        await refreshRuntime();
        toast('Model added.');
        break;
      }
      case 'open-models':
        await api.openPath(st.models.dir);
        break;
      default:
        break;
    }
  } catch (err) {
    toast(friendly(err), 'error');
  }
}

function handleSetupEvent(ev) {
  if (!S.setup) {
    loadSetup();
    return;
  }
  const st = S.setup;
  if (ev.step === 'engine') {
    st.engine.running = ev.status === 'running';
    if (ev.line) st.engine.log = [...(st.engine.log || []), ev.line].slice(-6);
    if (ev.status === 'done' || ev.status === 'error') {
      st.engine.error = ev.error || null;
      loadSetup();
      refreshRuntime();
      if (ev.status === 'done') toast('Image engine ready.');
      else toast(ev.error || 'Engine download failed.', 'error');
      return;
    }
  } else if (ev.step === 'opencode') {
    st.opencode.running = ev.status === 'downloading' || ev.status === 'extracting';
    if (ev.status === 'downloading') st.opencode.phase = 'downloading';
    if (ev.status === 'extracting') st.opencode.phase = 'extracting';
    if (ev.received !== undefined) st.opencode.received = ev.received;
    if (ev.total !== undefined) st.opencode.total = ev.total;
    if (ev.status === 'done' || ev.status === 'error') {
      st.opencode.error = ev.error || null;
      loadSetup();
      refreshRuntime();
      if (ev.status === 'done') toast('OpenCode installed.');
      else toast(ev.error || 'OpenCode install failed.', 'error');
      return;
    }
  } else if (ev.step === 'import') {
    if (ev.status === 'done' || ev.status === 'error') {
      if (ev.error) toast(ev.error, 'error');
      loadSetup();
      return;
    }
  }
  renderSetup();
}

/* ------------------------------------------------------------------ */
/* auto-update status                                                  */
/* ------------------------------------------------------------------ */

let updateManual = false;
let updateNotified = '';

function initUpdates() {
  $('#btnUpdateCheck').onclick = async () => {
    updateManual = true;
    try {
      paintUpdate(await api.updateCheck());
    } catch (err) {
      toast(friendly(err), 'error');
    } finally {
      updateManual = false;
    }
  };
  api.updateStatus().then(paintUpdate).catch(() => {});
}

function paintUpdate(st) {
  if (!st) return;
  const pill = document.getElementById('updatePill');
  if (pill) {
    const labels = {
      idle: 'Updates',
      dev: 'Dev build',
      checking: 'Checking…',
      current: 'Up to date',
      available: `Update ${st.version || ''} found`,
      downloading: `Downloading ${st.percent || 0}%`,
      downloaded: `Update ${st.version || ''} ready`,
      error: 'Update failed',
    };
    pill.textContent = st.packaged === false ? 'Dev build' : labels[st.status] || 'Updates';
    pill.title = st.error || (st.packaged === false ? 'Auto-update is disabled in dev builds.' : '');
  }
  const tag = `${st.status}:${st.version || ''}:${st.percent || ''}`;
  if (tag === updateNotified) return;
  updateNotified = tag;
  if (st.status === 'downloaded') toast(`Update ${st.version} ready — restart EggLab to install.`);
  else if (st.status === 'available') toast(`Downloading EggLab ${st.version}…`);
  else if (st.status === 'current' && updateManual) toast('EggLab is up to date.');
  else if (st.status === 'error' && updateManual && st.error) toast(`Update check failed: ${st.error}`, 'error');
}

boot();
