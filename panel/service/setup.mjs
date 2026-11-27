/**
 * First-run setup: detect the pieces EggLab needs and fetch the ones that can
 * be installed automatically.
 *
 *   PhotoCraft   companion app; detect + let the user locate its exe
 *   OpenCode     agent runtime; standalone zip from the pinned release
 *   Engine       stable-diffusion.cpp; the same resumable downloader the
 *                installer uses (engine-install.ps1)
 *   Models       never bundled; HF downloads (resumable) or a manual file
 *
 * Everything reports through the bus (`setup` events) so the wizard can show
 * live progress while the HTTP API and the renderer stay decoupled.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { emit } from './bus.mjs';
import {
  BIN_DIR,
  ENGINE_DIR,
  ENGINE_INSTALL_PS1,
  TMP_DIR,
  humanBytes,
  readJson,
  writeJson,
} from './paths.mjs';
import {
  chooseDefaultOpenCodeModel,
  clearOpenCodeCache,
  detectPhotoCraft,
  engineConfig,
  getSettings,
  opencodeReport,
  patchSettings,
  resolveOpenCode,
  roleFolder,
  setModelFile as storeModelFile,
  setModelsFolder as storeModelsFolder,
  setOpenCodePath as storeOpenCodePath,
} from './settings.mjs';
import { modelStatus, useVariant, variantForFile } from './models.mjs';
import {
  desktopCandidates,
  ensureService,
  launchDesktop,
  ping,
  serviceInfo,
} from './opencode-service.mjs';

const execFileAsync = promisify(execFile);

/* ------------------------------------------------------------------ */
/* volatile state (progress of long-running setup actions)             */
/* ------------------------------------------------------------------ */

const state = {
  engine: { running: false, variant: '', error: null, log: [] },
  opencode: { running: false, phase: '', received: 0, total: 0, error: null },
  importing: { running: false, file: '', received: 0, total: 0, error: null },
};

function engineInfo() {
  const cfg = engineConfig();
  return readJson(path.join(cfg.engine, 'engine-info.json'), null);
}

function opencodeFound() {
  const oc = resolveOpenCode();
  if (!oc || !oc.cmd || oc.cmd === 'opencode') return null;
  // The setup wizard pins OpenCode v2 because v1 cannot read the v2 session
  // schema. Unknown-version shims are not trusted as ready; install v2.
  if (!oc.version || oc.version[0] < 2) return null;
  try {
    if (!fs.existsSync(oc.cmd)) return null;
  } catch {
    return null;
  }
  return oc;
}

/* ------------------------------------------------------------------ */
/* status                                                              */
/* ------------------------------------------------------------------ */

export async function setupStatus() {
  const s = getSettings();
  const cfg = engineConfig();
  const status = modelStatus();
  const info = engineInfo();
  const oc = opencodeFound();
  const desktopExe = desktopCandidates()[0] || '';
  const svc = serviceInfo();
  const serviceLive = Boolean(svc && (await ping(svc)));
  const pcExe = String(s.photocraft?.exe || '');
  let pcFound = false;
  try {
    pcFound = Boolean(pcExe) && fs.existsSync(pcExe);
  } catch {}

  const missing = status.entries
    .filter((entry) => entry.required && !entry.exists)
    .map((entry) => entry.id);

  const engineInstalled = Boolean(status.engineReady);
  const done = Boolean(s.setup?.completed);

  return {
    done,
    firstRun: !done,
    ready: pcFound && (serviceLive || Boolean(oc)) && engineInstalled && missing.length === 0,
    photocraft: {
      found: pcFound,
      exe: pcExe,
      projectRoot: s.photocraft?.projectRoot || '',
    },
    opencode: {
      found: Boolean(oc),
      exe: oc?.cmd || '',
      version: oc?.version ? oc.version.join('.') : null,
      desktop: {
        installed: Boolean(desktopExe),
        exe: desktopExe,
        service: serviceLive,
      },
      running: state.opencode.running,
      phase: state.opencode.phase,
      received: state.opencode.received,
      total: state.opencode.total,
      error: state.opencode.error,
    },
    engine: {
      installed: engineInstalled,
      dir: cfg.engine,
      variant: info?.variant || null,
      release: info?.release || null,
      running: state.engine.running,
      error: state.engine.error,
      log: state.engine.log.slice(-6),
    },
    models: {
      dir: cfg.models,
      config: cfg.path,
      ready: missing.length === 0,
      missing,
      entries: status.entries.map((entry) => ({
        id: entry.id,
        label: entry.label,
        key: entry.key,
        required: entry.required,
        exists: entry.exists,
        sizeText: entry.sizeText,
        file: entry.file,
        path: entry.path,
        dir: entry.dir,
        files: entry.files,
      })),
      importing: { ...state.importing },
    },
  };
}

/**
 * Re-run detection (fresh machine, app installed after boot, PATH changed).
 * Only real findings are persisted; "not found" keeps whatever the user set.
 */
export async function refreshDetection() {
  const s = getSettings();
  const patch = {};
  if (!s.photocraft?.exe || !fs.existsSync(s.photocraft.exe)) {
    const dir = detectPhotoCraft();
    if (dir) {
      const cli = path.join(dir, 'photocraft-cli.exe');
      patch.photocraft = {
        exe: path.join(dir, 'photocraft.exe'),
        ...(fs.existsSync(cli) ? { cli } : {}),
      };
    }
  }
  clearOpenCodeCache();
  // Remember the desktop app when it is installed. Do not persist the CLI that
  // ships inside it: that is an internal diagnostic binary, not the runtime the
  // user selected, and showing it as "OpenCode path" was the source of the
  // "why does it say CLI?" report.
  const desktopExe = desktopCandidates()[0];
  if (desktopExe && desktopExe !== s.opencode?.desktopExe) {
    patch.opencode = { ...(patch.opencode || {}), desktopExe };
  }
  if (Object.keys(patch).length) patchSettings(patch);
  return setupStatus();
}

/* ------------------------------------------------------------------ */
/* PhotoCraft                                                          */
/* ------------------------------------------------------------------ */

export async function setPhotoCraft(filePath) {
  const exe = path.resolve(String(filePath || ''));
  let stat = null;
  try {
    stat = fs.statSync(exe);
  } catch {}
  if (!stat || !stat.isFile()) throw new Error('That PhotoCraft executable does not exist.');
  if (!/\.exe$/i.test(exe)) throw new Error('Pick the PhotoCraft .exe file.');
  const cli = path.join(path.dirname(exe), 'photocraft-cli.exe');
  patchSettings({
    photocraft: {
      exe,
      ...(fs.existsSync(cli) ? { cli } : {}),
    },
  });
  emit('settings', { settings: getSettings() });
  return setupStatus();
}

/* ------------------------------------------------------------------ */
/* Engine                                                              */
/* ------------------------------------------------------------------ */

export async function installEngine(variant = 'auto', force = false) {
  if (state.engine.running) return { started: false, running: true };
  if (!fs.existsSync(ENGINE_INSTALL_PS1)) {
    throw new Error(`Engine downloader missing: ${ENGINE_INSTALL_PS1}`);
  }
  const wanted = ['auto', 'cuda', 'vulkan', 'cpu'].includes(variant) ? variant : 'auto';
  state.engine = { running: true, variant: wanted, error: null, log: [] };
  emit('setup', { step: 'engine', status: 'running', variant: wanted });

  const args = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    ENGINE_INSTALL_PS1,
    '-EngineDir',
    ENGINE_DIR,
    '-Variant',
    wanted,
  ];
  if (force) args.push('-Force');

  const child = spawn('powershell.exe', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const push = (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (!line.trim()) continue;
      state.engine.log.push(line);
      if (state.engine.log.length > 300) state.engine.log.shift();
      emit('setup', { step: 'engine', status: 'running', line });
    }
  };
  child.stdout.on('data', push);
  child.stderr.on('data', push);
  child.on('error', (err) => {
    state.engine.running = false;
    state.engine.error = err.message;
    emit('setup', { step: 'engine', status: 'error', error: err.message });
  });
  child.on('exit', (code) => {
    state.engine.running = false;
    if (code !== 0) {
      state.engine.error = `Engine download failed (exit ${code}).`;
      emit('setup', { step: 'engine', status: 'error', error: state.engine.error });
    } else {
      state.engine.error = null;
      // setup.installEngine always installs to ENGINE_DIR. If config.json still
      // points at an old/missing custom engine folder, the app would keep
      // reporting "engine missing" after a successful download. Re-point it.
      const cfg = engineConfig();
      if (cfg.raw) {
        cfg.raw.engine = path.join(ENGINE_DIR, 'sd');
        writeJson(cfg.path, cfg.raw);
      }
      emit('setup', { step: 'engine', status: 'done' });
    }
    emit('models', { status: modelStatus() });
  });
  return { started: true, variant: wanted };
}

/* ------------------------------------------------------------------ */
/* OpenCode                                                            */
/* ------------------------------------------------------------------ */

// OpenCode v2 (also shipped inside the desktop app). v1.x cannot read the v2
// session schema, so the wizard installs a version that can.
const OPENCODE_VERSION = '2.3.0';
const OPENCODE_ZIP = `https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_VERSION}/opencode-windows-x64.zip`;

function systemTar() {
  const root = process.env.SystemRoot || 'C:\\Windows';
  return path.join(root, 'System32', 'tar.exe');
}

function spawnWait(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, ...options });
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(cmd)} exited ${code}${stderr ? `: ${stderr.trim().slice(0, 300)}` : ''}`));
    });
  });
}

/** Curl fallback for GitHub release assets, with resume and a stall guard. */
function curlDownload(url, dest, resume) {
  return new Promise((resolve, reject) => {
    const args = [
      '-L',
      '--fail',
      '--ssl-no-revoke',
      '--retry',
      '5',
      '--retry-all-errors',
      '--connect-timeout',
      '20',
      '--speed-limit',
      '1024',
      '--speed-time',
      '60',
    ];
    if (resume) args.push('-C', '-');
    args.push('-o', dest, '--', url);
    const child = spawn('curl.exe', args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.length > 8000) stderr = stderr.slice(-4000);
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else {
        const last = stderr.trim().split(/\r?\n/).filter(Boolean).slice(-1)[0] || '';
        reject(new Error(`curl exited ${code}${last ? `: ${last}` : ''}`));
      }
    });
  });
}

async function downloadWithCurl(url, part, dest, onProgress) {
  let lastError = null;
  for (const resume of [true, false]) {
    try {
      let offset = 0;
      try {
        offset = fs.statSync(part).size;
      } catch {}
      onProgress?.(offset, 0);
      await curlDownload(url, part, resume && offset > 0);
      const size = fs.statSync(part).size;
      if (!size) throw new Error('Downloaded file is empty.');
      try {
        fs.rmSync(dest, { force: true });
      } catch {}
      fs.renameSync(part, dest);
      onProgress?.(size, size);
      return dest;
    } catch (err) {
      lastError = err;
      if (resume) {
        try {
          fs.rmSync(part, { force: true });
        } catch {}
      }
    }
  }
  throw lastError || new Error('Download failed.');
}

/** Download with `.part` resume; reports progress through `onProgress`. */
async function downloadFile(url, dest, onProgress) {
  const part = `${dest}.part`;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  let offset = 0;
  try {
    offset = fs.statSync(part).size;
  } catch {}
  const headers = { 'user-agent': 'EggLab/0.1' };
  if (offset > 0) headers.range = `bytes=${offset}-`;
  // Abort a stalled transfer instead of leaving the setup wizard spinning
  // forever. The .part file is kept, so the next click resumes.
  const controller = new AbortController();
  let idleTimer = null;
  const armIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(), 120000);
  };
  armIdle();
  let res;
  try {
    res = await fetch(url, { redirect: 'follow', headers, signal: controller.signal });
  } catch (err) {
    clearTimeout(idleTimer);
    if (err?.name === 'AbortError') {
      throw new Error('Download stalled. Press install again to resume from the partial file.');
    }
    // GitHub release assets reset Node/Chromium TLS on some networks; curl with
    // --ssl-no-revoke is the same transport the updater and engine use.
    return await downloadWithCurl(url, part, dest, onProgress);
  }
  try {
    if (res.status === 416) {
      try {
        fs.rmSync(part, { force: true });
      } catch {}
      throw new Error('The partial download does not match the remote file. Press install again.');
    }
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`);
    let append = false;
    let total = 0;
    if (res.status === 206) {
      append = offset > 0;
      const found = String(res.headers.get('content-range') || '').match(/\/(\d+)\s*$/);
      total = found ? Number(found[1]) : offset + (Number(res.headers.get('content-length')) || 0);
    } else {
      total = Number(res.headers.get('content-length')) || 0;
    }
    let received = append ? offset : 0;
    onProgress?.(received, total);

    const out = fs.createWriteStream(part, append ? { flags: 'a' } : undefined);
    const reader = res.body.getReader();
    let lastEmit = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      armIdle();
      if (!out.write(Buffer.from(value))) {
        await new Promise((resolve) => out.once('drain', resolve));
      }
      received += value.length;
      const now = Date.now();
      if (now - lastEmit > 300) {
        lastEmit = now;
        onProgress?.(received, total);
      }
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
    const finalSize = fs.statSync(part).size;
    if (total && finalSize !== total) {
      throw new Error(`Download incomplete (${humanBytes(finalSize)} of ${humanBytes(total)}).`);
    }
    try {
      fs.rmSync(dest, { force: true });
    } catch {}
    fs.renameSync(part, dest);
    return dest;
  } finally {
    clearTimeout(idleTimer);
  }
}

function findFile(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = findFile(full, name);
      if (hit) return hit;
    } else if (entry.name.toLowerCase() === name.toLowerCase()) {
      return full;
    }
  }
  return null;
}

async function extractZip(zip, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  if (fs.existsSync(systemTar())) {
    await spawnWait(systemTar(), ['-xf', zip, '-C', destDir]);
    return;
  }
  await spawnWait('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`,
  ]);
}

async function openCodeVersion(exe) {
  try {
    const { stdout } = await execFileAsync(exe, ['--version'], {
      windowsHide: true,
      timeout: 20000,
      maxBuffer: 1024 * 1024,
    });
    return String(stdout).trim().split(/\r?\n/)[0] || 'unknown';
  } catch {
    return null;
  }
}

export async function installOpencode() {
  if (state.opencode.running) return { started: false, running: true };
  state.opencode = { running: true, phase: 'downloading', received: 0, total: 0, error: null };
  emit('setup', { step: 'opencode', status: 'downloading' });

  (async () => {
    const zip = path.join(TMP_DIR, `opencode-windows-x64-${OPENCODE_VERSION}.zip`);
    await downloadFile(OPENCODE_ZIP, zip, (received, total) => {
      state.opencode.received = received;
      state.opencode.total = total;
      emit('setup', { step: 'opencode', status: 'downloading', received, total });
    });

    state.opencode.phase = 'extracting';
    emit('setup', { step: 'opencode', status: 'extracting' });
    // Never delete a directory that a running OpenCode process may be using.
    // Install into a fresh folder and switch the configured path; old versions
    // are cleaned up best-effort after the switch.
    const dest = path.join(
      BIN_DIR,
      `opencode-${OPENCODE_VERSION}-${Date.now().toString(36)}`,
    );
    fs.mkdirSync(dest, { recursive: true });
    await extractZip(zip, dest);

    const exe = findFile(dest, 'opencode.exe');
    if (!exe) throw new Error('opencode.exe was not found inside the downloaded archive.');
    const version = await openCodeVersion(exe);
    if (!version) throw new Error('The downloaded OpenCode binary did not start correctly.');
    if (Number(String(version).match(/(\d+)\./)?.[1] || 0) < 2) {
      throw new Error(`OpenCode ${version} is too old; EggLab requires v2 or newer.`);
    }

    patchSettings({ opencode: { exe } });
    clearOpenCodeCache();
    // Best effort: remove older extracts once the new one is selected.
    try {
      for (const name of fs.readdirSync(BIN_DIR)) {
        if (/^opencode(?:-|$)/.test(name) && name !== path.basename(dest)) {
          fs.rmSync(path.join(BIN_DIR, name), { recursive: true, force: true });
        }
      }
    } catch {}
    state.opencode.phase = 'done';
    state.opencode.received = state.opencode.total;
    emit('setup', { step: 'opencode', status: 'done', exe, version });
    emit('settings', { settings: getSettings() });
  })()
    .catch((err) => {
      state.opencode.error = err.message;
      state.opencode.phase = 'error';
      emit('setup', { step: 'opencode', status: 'error', error: err.message });
    })
    .finally(() => {
      state.opencode.running = false;
      try {
        fs.rmSync(path.join(TMP_DIR, `opencode-windows-x64-${OPENCODE_VERSION}.zip`), { force: true });
      } catch {}
    });

  return { started: true, url: OPENCODE_ZIP };
}

// The chat runtime is the OpenCode desktop app, not a private CLI process.
// Setup installs the desktop app from the official latest-stable endpoint;
// a private mirror can be supplied for offline/enterprise installs.
const OPENCODE_DESKTOP_URL =
  process.env.EGGLAB_OPENCODE_DESKTOP_URL ||
  'https://opencode.ai/update/api/latest/desktop/opencode/opencode-desktop-win-x64.exe';

export async function installOpencodeDesktop() {
  if (state.opencode.running) return { started: false, running: true };
  const existing = desktopCandidates()[0];
  if (existing) {
    // Already installed: remember where, start it and wait for its service.
    patchSettings({ opencode: { desktopExe: existing } });
    try {
      await launchDesktop();
      await ensureService(45000);
    } catch (err) {
      return { started: false, error: err.message };
    }
    emit('settings', { settings: getSettings() });
    return { started: false, alreadyInstalled: true, service: true, exe: existing };
  }
  state.opencode = { running: true, phase: 'downloading', received: 0, total: 0, error: null };
  emit('setup', { step: 'opencode', status: 'downloading' });
  (async () => {
    const installer = path.join(TMP_DIR, 'opencode-desktop-win-x64.exe');
    await downloadFile(OPENCODE_DESKTOP_URL, installer, (received, total) => {
      state.opencode.received = received;
      state.opencode.total = total;
      emit('setup', { step: 'opencode', status: 'downloading', received, total });
    });
    state.opencode.phase = 'installing';
    emit('setup', {
      step: 'opencode',
      status: 'installing',
      message: 'Installer opened. Finish the OpenCode setup in the window that appears.',
    });
    // The installer is opened for the user, not run silently: they choose the
    // install location. A custom folder is linked afterwards with "Use existing…".
    try {
      const child = spawn(installer, [], { detached: true, stdio: 'ignore', windowsHide: false });
      child.unref?.();
    } catch (err) {
      throw new Error(`Could not open the OpenCode installer: ${err.message}`);
    }
    state.opencode.phase = 'awaiting-user';
    state.opencode.received = state.opencode.total;
    emit('setup', {
      step: 'opencode',
      status: 'awaiting-user',
      installer,
      message:
        'Complete the install. If you chose a custom folder, use "Use existing…" in the agent model settings to point at OpenCode.exe.',
    });
  })()
    .catch((err) => {
      state.opencode.error = err.message;
      state.opencode.phase = 'error';
      emit('setup', { step: 'opencode', status: 'error', error: err.message });
    })
    .finally(() => {
      state.opencode.running = false;
    });
  return { started: true, url: OPENCODE_DESKTOP_URL, needsUser: true };
}

/* ------------------------------------------------------------------ */
/* Models                                                              */
/* ------------------------------------------------------------------ */

/**
 * Install a model the user already has on disk (wizard "add from file" or
 * drag-and-drop). Only files EggLab's engine config can point at are accepted;
 * the copy is streamed so a 14 GB weight file does not sit in memory.
 */
export async function importModelFile(filePath) {
  const src = path.resolve(String(filePath || ''));
  let stat = null;
  try {
    stat = fs.statSync(src);
  } catch {}
  if (!stat || !stat.isFile()) throw new Error('That model file does not exist.');

  const base = path.basename(src);
  const target = variantForFile(base);
  if (!target) {
    throw new Error(
      `"${base}" is not a file EggLab can use. Expected one of the model files listed in the Models card.`
    );
  }

  const cfg = engineConfig();
  const dest = path.join(cfg.models, roleFolder(target.key), base);
  if (path.resolve(dest) !== src) {
    state.importing = { running: true, file: base, received: 0, total: stat.size, error: null };
    emit('setup', { step: 'import', status: 'copying', file: base, received: 0, total: stat.size });
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const part = `${dest}.part`;
      const input = fs.createReadStream(src);
      const output = fs.createWriteStream(part);
      let received = 0;
      let lastEmit = 0;
      await new Promise((resolve, reject) => {
        input.on('data', (chunk) => {
          received += chunk.length;
          const now = Date.now();
          if (now - lastEmit > 400) {
            lastEmit = now;
            state.importing.received = received;
            emit('setup', {
              step: 'import',
              status: 'copying',
              file: base,
              received,
              total: stat.size,
            });
          }
        });
        input.on('error', reject);
        output.on('error', reject);
        output.on('finish', resolve);
        input.pipe(output);
      });
      const copied = fs.statSync(part).size;
      if (stat.size && copied !== stat.size) {
        throw new Error(`Copy incomplete (${humanBytes(copied)} of ${humanBytes(stat.size)}).`);
      }
      try {
        fs.rmSync(dest, { force: true });
      } catch {}
      fs.renameSync(part, dest);
    } catch (err) {
      state.importing = { ...state.importing, running: false, error: err.message };
      emit('setup', { step: 'import', status: 'error', file: base, error: err.message });
      throw err;
    }
  }

  // Point the engine config at the imported file (validates it exists on disk).
  const status = useVariant(target.entryId, target.file);
  state.importing = { running: false, file: base, received: stat.size, total: stat.size, error: null };
  emit('setup', { step: 'import', status: 'done', file: base });
  return status;
}

/* ------------------------------------------------------------------ */
/* completion                                                          */
/* ------------------------------------------------------------------ */

/**
 * Point the models folder at an existing directory without copying anything.
 * Existing files with the configured names are used in place; downloads go
 * into this folder when the user asks for them.
 */
export async function setModelsFolder(folder) {
  storeModelsFolder(folder);
  emit('settings', { settings: getSettings() });
  emit('models', { status: modelStatus() });
  return setupStatus();
}

/** Use one existing model file in place (advanced role-by-role mapping). */
export async function setModelFile(role, file) {
  storeModelFile(role, file);
  emit('settings', { settings: getSettings() });
  emit('models', { status: modelStatus() });
  return setupStatus();
}

/** Use the user's own OpenCode binary. Rejects v1/non-binaries. */
export async function setOpenCode(file) {
  const selected = storeOpenCodePath(file);
  emit('settings', { settings: getSettings() });
  return { ...(await setupStatus()), selected };
}

/**
 * Suggest a default chat model from connected providers, but never silently
 * change the user's selection: provider-side free models can still be blocked
 * by balances/limits. The Setup/Settings UI asks the user to choose.
 */
export async function chooseDefaultModel(force = false) {
  return await chooseDefaultOpenCodeModel(force);
}

/** Provider/model report for the selected OpenCode binary. */
export async function opencodeInfo(force = false) {
  return await opencodeReport(force);
}

export async function completeSetup() {
  patchSettings({ setup: { completed: true, at: new Date().toISOString() } });
  return setupStatus();
}
