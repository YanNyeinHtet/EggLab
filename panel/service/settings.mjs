import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { AGENT_DIR, BIN_DIR, DATA_DIR, ENGINE_DIR, MODELS_DIR, PACKAGED, ROOT, readJson, writeJson } from './paths.mjs';

const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

export const ASPECTS = {
  '1:1': [1024, 1024],
  '4:3': [1152, 864],
  '3:4': [864, 1152],
  '3:2': [1152, 768],
  '2:3': [768, 1152],
  '16:9': [1152, 640],
  '9:16': [640, 1152],
  '4:5': [1024, 1280],
  '5:4': [1280, 1024],
  '2:1': [1280, 640],
  '1:2': [640, 1280],
};

/* ------------------------------------------------------------------ *
 * Environment detection — no machine-specific paths may be hardcoded:
 * this repo is published and installs must work on any Windows profile.
 * ------------------------------------------------------------------ */

/**
 * PhotoCraft install folder: sibling checkout first (dev), then the usual
 * per-user/Program Files locations. Empty when nothing is found — the
 * first-run wizard then asks the user to locate it (or skip).
 */
export function detectPhotoCraft() {
  const candidates = [
    path.join(ROOT, '..', 'photocraft-app'),
    path.join(ROOT, '..', 'photocraft'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'PhotoCraft'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'photocraft'),
    'C:\\Program Files\\PhotoCraft',
    'C:\\Program Files (x86)\\PhotoCraft',
  ];
  for (const dir of candidates) {
    if (!dir) continue;
    try {
      if (fs.existsSync(path.join(dir, 'photocraft.exe'))) return dir;
    } catch {}
  }
  return '';
}

// OpenCode: prefer the npm global install's real .exe (a .cmd shim cannot be
// spawned without a shell since Node's CVE-2024-27980 hardening), then other
// common locations, then PATH via where.exe. See resolveOpenCode().
function defaultOpenCodeExe() {
  const npmExe = process.env.APPDATA
    ? path.join(process.env.APPDATA, 'npm', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe')
    : '';
  try {
    if (npmExe && fs.existsSync(npmExe)) return npmExe;
  } catch {}
  return '';
}

// The dev workspace root: the checkout's parent (PhotoCraft requires the
// automation roots to contain the projects folder).
const DEV_ROOT = path.dirname(ROOT);
const PHOTO_DIR = detectPhotoCraft();

export const DEFAULTS = {
  // First-run wizard: shown until the user finishes (or dismisses) it.
  setup: { completed: false, at: null },
  // Longest side (px) of reference images sent to the engine. Qwen edits keep
  // identity/style from these; 768 px is already more guidance than the model
  // uses, while a 1080x1700 export turns into ~7300 latent tokens and makes
  // multi-reference edits exceed an 8 GB card's memory during sampling.
  refMaxSide: 768,
  // Packaged installs keep config.json (engine/model locations, written by
  // the installer or the first-run wizard) in the user data folder; dev keeps
  // reading it from the repo root next to egglab.ps1.
  engineRoot: PACKAGED ? DATA_DIR : ROOT,
  modelsDir: MODELS_DIR,
  workflow: 'quality',
  // Qwen-Image-2.1 is specified at 40 steps, CFG 1 (it is meant to be sampled
  // without guidance). 20 steps was the old panel default and produced soft,
  // under-resolved renders.
  quality: { steps: 40, cfg: 1 },
  turbo: { steps: 8, cfg: 1 },
  aspect: '1:1',
  width: 1024,
  height: 1024,
  seed: -1,
  lockSeed: false,
  batch: 1,
  transparent: false,
  offload: true,
  method: 'euler',
  // Rough wall-clock cost per sampling step on this 8 GB card, used for the
  // progress estimate only (the engine has no step counter on stdout).
  perStepSec: { quality: 4.5, turbo: 5.5 },
  photocraft: {
    exe: PHOTO_DIR ? path.join(PHOTO_DIR, 'photocraft.exe') : '',
    cli: PHOTO_DIR ? path.join(PHOTO_DIR, 'photocraft-cli.exe') : '',
    controlPort: 7878,
    tokenFile: path.join(DATA_DIR, 'photocraft.token'),
    // PhotoCraft refuses paths outside the automation roots. Dev anchors them
    // at the workspace (the checkout's parent); packaged installs default to
    // the user profile and let the wizard pick real folders.
    readRoot: PACKAGED ? os.homedir() : DEV_ROOT,
    writeRoot: PACKAGED ? os.homedir() : DEV_ROOT,
    projectRoot: PACKAGED ? path.join(os.homedir(), 'EggLab projects') : path.join(DEV_ROOT, 'projects'),
    autosave: true,
    autoLaunch: true,
    dock: true,
    dockGap: 6,
    width: 440,
  },
  opencode: {
    exe: defaultOpenCodeExe(),
    agent: 'egglab',
    // Beta agent (`egglab-beta`): the developing version of the official
    // agent. Off by default; when on, chats run the beta agent in its own
    // workspace and session scope. The official agent stays unchanged.
    betaAgent: false,
    // No hard-coded paid default. A fresh user may not have OpenCode Go,
    // Console credits, or any provider connected; `opencode models` can list
    // catalog entries that are not actually routable. Setup/Settings choose a
    // model from an activated provider (preferring a free one) after the
    // OpenCode report is available.
    model: '',
    // Providers whose models come from a live list without capability metadata
    // (so opencode would treat them as text-only and drop image attachments).
    customProviders: ['inferx'],
    // Declare image input for the selected custom-provider model.
    vision: true,
    // One turn may hold a render plus several tool round trips. Must exceed
    // download_models' 60-minute wait, so a large model download does not get
    // killed by the turn timeout first.
    timeoutSec: 4200,
    // A healthy run emits its first event in seconds. opencode's own retry is
    // hard-coded to 5 attempts (~68s) and is not configurable, so a silent run
    // is the panel's job to detect and restart.
    firstByteSec: 100,
    // A running tool can legitimately hold the turn for many minutes with no
    // events; the idle watchdog only runs between tool calls.
    idleSec: 600,
    // Capacity ("all replicas at capacity", HTTP 429) is transient. Retry the
    // SAME model with exponential backoff - there is no fallback model.
    retries: 6,
    retryBaseSec: 8,
    retryMaxSec: 60,
    retryBudgetSec: 720,
    // How often the chat bubble reports that it is still waiting.
    heartbeatSec: 15,
  },
};

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function merge(base, patch) {
  if (!isObject(patch)) return base;
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (isObject(value) && isObject(base[key])) out[key] = merge(base[key], value);
    else if (value !== undefined) out[key] = value;
  }
  return out;
}

let settings = merge(DEFAULTS, readJson(SETTINGS_FILE, {}));
let saveTimer = null;

// Keys that were removed from the schema. An older panel process can rewrite
// settings.json with them still present (file values win over defaults), so
// strip them on load and before every save. Leftover keys would otherwise
// silently override the current retry/watchdog defaults.
const REMOVED_OPENCODE_KEYS = [
  'fallbackModel',
  'capacityRetries',
  'capacityBackoffSec',
  'fallbackFirstByteSec',
];

function sanitize(target) {
  if (target?.opencode) {
    for (const key of REMOVED_OPENCODE_KEYS) delete target.opencode[key];
    // The old default was 30 minutes, shorter than download_models' 60-minute
    // wait. Raise it once for configs that still carry the old default.
    if (Number(target.opencode.timeoutSec) === 1800) target.opencode.timeoutSec = 4200;
  }
  // `lockSeed` was written as the string "on" by an older build.
  if (target && target.lockSeed === 'on') target.lockSeed = true;
  return target;
}

sanitize(settings);

export function getSettings() {
  return settings;
}

// Models known to accept image parts. Custom providers are handled separately:
// opencode's live model list carries no capability metadata for them, so the
// panel declares image input itself (see chat.prepareAgent) and this helper
// mirrors that decision for session bookkeeping.
const VISION_CAPABLE = /vl|vision|gpt-4|gemini|claude|qwen.*(vl|omni)|mimo|deepseek[^/]*v4\.1/i;

export function visionForModel(model = settings.opencode.model, current = settings) {
  if (current.opencode?.vision === false) return false;
  const id = String(model || '');
  const slash = id.indexOf('/');
  const provider = slash > 0 ? id.slice(0, slash) : '';
  const custom = (current.opencode?.customProviders || []).map(String);
  if (provider && custom.includes(provider)) return true;
  return VISION_CAPABLE.test(id);
}

export function patchSettings(patch) {
  settings = merge(settings, patch);
  sanitize(settings);
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    writeJson(SETTINGS_FILE, settings);
  }, 150);
  return settings;
}

/** Effective sampling parameters for a workflow, honouring custom steps/cfg. */
export function workflowParams(workflow = settings.workflow) {
  const isTurbo = workflow === 'turbo';
  const base = isTurbo ? settings.turbo : settings.quality;
  return {
    workflow: isTurbo ? 'turbo' : 'quality',
    steps: Number(base.steps) || (isTurbo ? 8 : 40),
    cfg: isTurbo ? Number(base.cfg) || 1 : Number(base.cfg) || 1,
    method: settings.method || 'euler',
  };
}

export function sizeFor(aspect = settings.aspect, width = settings.width, height = settings.height) {
  const preset = ASPECTS[aspect];
  if (preset) return { width: preset[0], height: preset[1] };
  return { width: Number(width) || 1024, height: Number(height) || 1024 };
}

/**
 * Engine paths and model file names, in the shape `egglab.ps1` expects.
 *
 * `config.json` is the authoritative record. The packaged app has no
 * install.ps1 step (the NSIS installer only downloads the engine), so on a
 * fresh install this file does not exist. The old code returned in-memory
 * defaults and made setEngineModel() a no-op: a model that finished
 * downloading was never selected, and setup kept reporting the old default
 * file as "missing" forever. Create/repair the file on first contact instead.
 */
function defaultEngineConfig() {
  return {
    engine: path.join(ENGINE_DIR, 'sd'),
    models: settings.modelsDir || MODELS_DIR,
    diffusion: 'qwen-image-2.1-UC-fp8.safetensors',
    vae: 'qwen_image_2.1_vae_bf16.safetensors',
    llm: 'Qwen3VL-8B-Uncensored-HauhauCS-Balanced-Q6_K.gguf',
    llmVision: 'Qwen3VL-8B-Uncensored-HauhauCS-Balanced-mmproj-f16.gguf',
    turbo: {
      lora: 'qwen_image_2.1_turbo_lora_avg_rank_178_bf16.safetensors',
      steps: 8,
      cfg: 1,
    },
    defaults: {
      width: 1024,
      height: 1024,
      steps: 40,
      cfg: 1,
      method: 'euler',
      offload: true,
    },
  };
}

/**
 * Read the engine config, creating it (or filling missing keys) when needed.
 * Safe to call on every status poll: it only writes when something changed.
 */
export function ensureEngineConfig() {
  const cfgPath = path.join(settings.engineRoot, 'config.json');
  const base = defaultEngineConfig();
  let raw = readJson(cfgPath, null);
  let changed = false;

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    raw = base;
    changed = true;
  } else {
    for (const key of ['engine', 'models', 'diffusion', 'vae', 'llm', 'llmVision']) {
      if (typeof raw[key] !== 'string' || !raw[key].trim()) {
        raw[key] = base[key];
        changed = true;
      }
    }
    if (!raw.turbo || typeof raw.turbo !== 'object' || !raw.turbo.lora) {
      raw.turbo = { ...base.turbo, ...(raw.turbo && typeof raw.turbo === 'object' ? raw.turbo : {}) };
      if (!raw.turbo.lora) raw.turbo.lora = base.turbo.lora;
      changed = true;
    }
    if (!raw.defaults || typeof raw.defaults !== 'object') {
      raw.defaults = base.defaults;
      changed = true;
    }
  }

  if (changed) {
    try {
      writeJson(cfgPath, raw);
    } catch {
      // A read-only profile must not break status; the defaults still work for
      // this session and a later run can persist them.
    }
  }

  // config.json is authoritative. Mirror its models folder into settings so a
  // legacy `settings.modelsDir` (the old default pointed at a folder that no
  // longer existed) can never disagree with the downloader and status.
  if (raw.models && settings.modelsDir !== raw.models) {
    try {
      patchSettings({ modelsDir: raw.models });
    } catch {}
  }
  try {
    fs.mkdirSync(raw.models, { recursive: true });
  } catch {}

  return raw;
}

export function engineConfig() {
  const cfgPath = path.join(settings.engineRoot, 'config.json');
  const raw = ensureEngineConfig();
  return {
    path: cfgPath,
    raw,
    engine: raw.engine,
    models: raw.models,
    diffusion: raw.diffusion,
    vae: raw.vae,
    llm: raw.llm,
    llmVision: raw.llmVision,
    turbo: raw.turbo,
  };
}

/** Point the engine config at a different model file (after a download). */
export function setEngineModel(key, filename) {
  const cfg = engineConfig();
  const raw = cfg.raw || ensureEngineConfig();
  if (!raw) throw new Error('EggLab could not create the engine config file.');
  if (key === 'turbo') {
    raw.turbo = { ...(raw.turbo || {}), lora: filename };
  } else {
    raw[key] = filename;
  }
  try {
    writeJson(cfg.path, raw);
  } catch (err) {
    throw new Error(`Model selected, but EggLab could not write ${cfg.path}: ${err.message}`);
  }
  return raw;
}

export function modelFileFor(key) {
  const cfg = engineConfig();
  if (key === 'turbo') return { dir: cfg.models, file: cfg.turbo.lora };
  return { dir: cfg.models, file: cfg[key] };
}

/**
 * Subfolder for each engine role. Downloads go here, and the Models UI lists
 * the files found in the same folder. A flat folder chosen by the user still
 * works: the resolver and the picker also look in the root.
 */
const ROLE_FOLDERS = {
  diffusion: 'diffusion',
  vae: 'vae',
  llm: 'text_encoder',
  llmVision: 'vision',
  turbo: 'lora',
};

export function roleFolder(key) {
  return ROLE_FOLDERS[key] || '';
}

/**
 * Absolute path of one model role. A role may be a bare filename, a relative
 * path such as `diffusion/file.gguf`, or a full path chosen by the user. When
 * the configured value is a bare filename, also look in the role subfolder so
 * old flat configs keep working after the folder layout changes.
 */
export function resolveModelPath(cfg, key) {
  const value = key === 'turbo' ? cfg?.turbo?.lora : cfg?.[key];
  if (!value) return null;
  const text = String(value);
  if (path.isAbsolute(text)) return text;
  const direct = path.join(cfg.models, text);
  try {
    if (fs.existsSync(direct)) return direct;
  } catch {}
  const folder = roleFolder(key);
  if (folder) {
    const nested = path.join(cfg.models, folder, path.basename(text));
    try {
      if (fs.existsSync(nested)) return nested;
    } catch {}
  }
  return direct;
}

/**
 * Point EggLab at an existing models folder. Existing files named as the
 * configured roles are used in place; nothing is copied. Downloads (if the
 * user asks for them) go into this folder.
 */
export function setModelsFolder(folder) {
  const abs = path.resolve(String(folder || ''));
  let stat = null;
  try {
    stat = fs.statSync(abs);
  } catch {}
  if (!stat || !stat.isDirectory()) throw new Error('That models folder does not exist.');
  const cfg = engineConfig();
  const raw = cfg.raw || ensureEngineConfig();
  raw.models = abs;
  writeJson(cfg.path, raw);
  patchSettings({ modelsDir: abs });
  return { folder: abs, config: cfg.path };
}

/**
 * Use one existing model file without copying it. `role` is the engine role,
 * not a guessed model type: diffusion, vae, llm, llmVision or turbo. EggLab
 * does not inspect the file; a wrong file will fail inside the engine.
 */
export function setModelFile(role, filePath) {
  const key = String(role || '');
  if (!['diffusion', 'vae', 'llm', 'llmVision', 'turbo'].includes(key)) {
    throw new Error(`Unknown model role: ${key}`);
  }
  const abs = path.resolve(String(filePath || ''));
  let stat = null;
  try {
    stat = fs.statSync(abs);
  } catch {}
  if (!stat || !stat.isFile()) throw new Error('That model file does not exist.');
  const cfg = engineConfig();
  const raw = cfg.raw || ensureEngineConfig();
  // Keep files inside the models root as a portable relative path
  // (`diffusion/file.gguf`); files on another drive stay absolute.
  const relative = path.relative(cfg.models, abs);
  const inside = relative && !relative.startsWith('..') && !path.isAbsolute(relative);
  const stored = inside ? relative.split(path.sep).join('/') : abs;
  if (key === 'turbo') {
    raw.turbo = { ...(raw.turbo || {}), lora: stored, dir: path.dirname(abs) };
  } else {
    raw[key] = stored;
  }
  writeJson(cfg.path, raw);
  return raw;
}

/* ------------------------------------------------------------------ */
/* OpenCode model discovery                                           */
/* ------------------------------------------------------------------ */

/* `opencode models` lists every model the connected providers know about,
   one per line as `provider/modelId`. We group by provider so the settings
   drawer can render a provider → model list the user can choose from. The
   result is cached briefly so repeated drawer opens don't re-spawn opencode. */

/**
 * Resolve the OpenCode binary without hardcoding any user profile.
 *
 * Order: the configured path, the npm global install's real .exe, other
 * common install locations (V2 standalone, scoop), then `where.exe` for
 * anything on PATH. A `.cmd`/`.bat` match (npm/shim wrappers) can only be
 * spawned through a shell since Node's CVE-2024-27980 hardening, so callers
 * get the flag back and pass it to spawn/execFile.
 */
let whereCache; // undefined = not probed yet (null = probed, nothing found)
const versionCache = new Map();
/** Forget the PATH probe so the next resolve sees a just-installed OpenCode. */
export function clearOpenCodeCache() {
  whereCache = undefined;
  versionCache.clear();
}

function whereOpenCode() {
  if (whereCache !== undefined) return whereCache;
  whereCache = [];
  try {
    const out = execFileSync('where.exe', ['opencode'], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 5000,
    });
    whereCache = String(out).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  } catch {
    whereCache = [];
  }
  return whereCache;
}

/** Version tuple from `opencode --version` ("1.19.5", "opencode v2.3.0"). */
function probeOpenCodeVersion(exe) {
  if (versionCache.has(exe)) return versionCache.get(exe);
  let version = null;
  try {
    const out = execFileSync(exe, ['--version'], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 10000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const match = String(out).match(/(\d+)\.(\d+)\.(\d+)/);
    if (match) version = [Number(match[1]), Number(match[2]), Number(match[3])];
  } catch {}
  versionCache.set(exe, version);
  return version;
}

function compareVersions(a, b) {
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/** CLIs installed by EggLab's setup/first-run download, newest first. */
function managedOpenCodeCandidates() {
  if (!BIN_DIR) return [];
  const found = [];
  const scan = (dir, depth = 0) => {
    if (depth > 3) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) scan(full, depth + 1);
      else if (/^opencode(-cli)?\.exe$/i.test(entry.name)) found.push(full);
    }
  };
  scan(BIN_DIR);
  return found
    .map((file) => ({ file, version: probeOpenCodeVersion(file) }))
    .filter((entry) => entry.version)
    .sort((a, b) => compareVersions(b.version, a.version))
    .map((entry) => entry.file);
}

/** CLIs bundled with the OpenCode desktop app (newest first). */
function desktopOpenCodeCandidates() {
  const roaming = process.env.APPDATA || '';
  if (!roaming) return [];
  const root = path.join(roaming, 'ai.opencode.desktop', 'cli');
  try {
    return fs
      .readdirSync(root)
      .map((name) => ({ name, file: path.join(root, name, 'opencode-cli.exe') }))
      .filter((entry) => {
        try {
          return fs.statSync(entry.file).isFile();
        } catch {
          return false;
        }
      })
      .sort((a, b) => compareVersions(probeOpenCodeVersion(b.file), probeOpenCodeVersion(a.file)))
      .map((entry) => entry.file);
  } catch {
    return [];
  }
}

export function resolveOpenCode() {
  const configured = String(settings.opencode?.exe || '');
  const home = process.env.USERPROFILE || os.homedir();
  const local = process.env.LOCALAPPDATA || '';
  const roaming = process.env.APPDATA || '';
  const candidates = [
    configured,
    ...managedOpenCodeCandidates(),
    ...desktopOpenCodeCandidates(),
    home && path.join(home, '.opencode', 'bin', 'opencode.exe'),
    roaming && path.join(roaming, 'npm', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe'),
    local && path.join(local, 'Programs', 'opencode', 'opencode.exe'),
    home && path.join(home, 'scoop', 'shims', 'opencode.exe'),
    ...whereOpenCode(),
  ].filter(Boolean);

  // An explicit user choice wins when it is a working v2 binary. Otherwise
  // pick the newest working v2 binary: every OpenCode client shares one data
  // directory, and an older client can fail on a newer schema. Never return a
  // v1 binary just because it exists.
  const working = (candidate) => {
    try {
      if (!fs.existsSync(candidate)) return null;
    } catch {
      return null;
    }
    const version = /\.(cmd|bat)$/i.test(candidate) ? null : probeOpenCodeVersion(candidate);
    return version && version[0] >= 2 ? { candidate, version } : null;
  };

  const explicit = configured ? working(configured) : null;
  if (explicit) {
    return { cmd: explicit.candidate, shell: /\.(cmd|bat)$/i.test(explicit.candidate), version: explicit.version };
  }

  let best = null;
  let bestVersion = null;
  let bestOrder = Number.POSITIVE_INFINITY;
  const seen = new Set();
  candidates.forEach((candidate, order) => {
    if (!candidate || seen.has(candidate)) return;
    seen.add(candidate);
    const found = working(candidate);
    if (!found) return;
    const cmp = compareVersions(found.version, bestVersion);
    if (!best || cmp > 0 || (cmp === 0 && order < bestOrder)) {
      best = found.candidate;
      bestVersion = found.version;
      bestOrder = order;
    }
  });
  if (best) return { cmd: best, shell: /\.(cmd|bat)$/i.test(best), version: bestVersion };
  // Last resort: PATH lookup by CreateProcess (.exe only).
  return { cmd: 'opencode', shell: false, version: null };
}

/** Save the user's own OpenCode binary. Accepts the desktop app and resolves it to its CLI. */
export function setOpenCodePath(file) {
  const abs = path.resolve(String(file || ''));
  let stat = null;
  try {
    stat = fs.statSync(abs);
  } catch {}
  if (!stat || !stat.isFile()) throw new Error('That OpenCode executable does not exist.');
  const version = probeOpenCodeVersion(abs);

  // The OpenCode desktop app is an Electron GUI: `--version` prints nothing
  // and opens the app instead. Users naturally pick it. Resolve it to the CLI
  // that the desktop app itself uses; never store the GUI binary.
  if (!version && /^opencode/i.test(path.basename(abs))) {
    const candidates = [...desktopOpenCodeCandidates(), ...managedOpenCodeCandidates()].filter(
      (candidate) => path.resolve(candidate) !== path.resolve(abs),
    );
    const cli = candidates.find((candidate) => {
      const candidateVersion = probeOpenCodeVersion(candidate);
      return candidateVersion && candidateVersion[0] >= 2 && /cli\.exe$/i.test(candidate);
    });
    if (cli) {
      patchSettings({ opencode: { exe: cli } });
      clearOpenCodeCache();
      modelsCache = null;
      modelsCacheKey = '';
      reportCache = null;
      return { exe: cli, version: probeOpenCodeVersion(cli).join('.'), desktopApp: abs };
    }
    throw new Error(
      'That is the OpenCode desktop app. EggLab needs its CLI (opencode-cli.exe), but none was found. Pick opencode-cli.exe or install the CLI.',
    );
  }

  if (!version) throw new Error('That file did not start as OpenCode. Pick opencode.exe or opencode-cli.exe.');
  if (version[0] < 2) {
    throw new Error(`OpenCode ${version.join('.')} found. EggLab needs OpenCode v2 or newer.`);
  }
  patchSettings({ opencode: { exe: abs } });
  clearOpenCodeCache();
  modelsCache = null;
  modelsCacheKey = '';
  reportCache = null;
  return { exe: abs, version: version.join('.') };
}

/**
 * Report the best default chat model candidate, but do not silently change the
 * user's selection. Provider "free" models can still fail with provider-side
 * balances/limits, so Setup asks the user to choose from the connected list.
 */
export async function chooseDefaultOpenCodeModel(force = false) {
  const report = await opencodeReport(force);
  const current = String(settings.opencode?.model || '');
  if (!report.ok) {
    return {
      selected: current,
      suggested: '',
      changed: false,
      available: false,
      reason: report.error || 'OpenCode unavailable',
      report,
    };
  }
  const connected = (report.providers || []).filter((provider) => provider.connected);
  const pool = connected
    .flatMap((provider) => (provider.models || []).map((model) => ({ ...model, provider: provider.provider })))
    .sort((a, b) => a.id.localeCompare(b.id));
  const free = pool.filter((model) => /-free(?:$|#)/i.test(model.id) || /-free/i.test(model.modelId));
  const fast = pool.filter((model) => /flash/i.test(model.id) || /flash/i.test(model.modelId));
  const suggested = report.suggestedModel || free[0]?.id || fast[0]?.id || pool[0]?.id || '';
  return {
    selected: current,
    suggested,
    changed: false,
    available: Boolean(current && report.selectedAvailable),
    connected: Boolean(current && report.selectedConnected),
    reason: pool.length ? 'Choose a model from a connected provider.' : 'No provider is connected in OpenCode yet.',
    report,
  };
}

let modelsCache = null;
let modelsCacheAt = 0;
let modelsCacheKey = '';
let reportCache = null;
let reportCacheAt = 0;
const MODELS_CACHE_TTL = 30000; // 30 s — fresh enough for auto-sync
const REPORT_CACHE_TTL = 30000;

export async function opencodeModels(force = false, options = {}) {
  const oc = options.oc || resolveOpenCode();
  const cwd = options.cwd || AGENT_DIR;
  const standalone = options.standalone !== false && (oc.version?.[0] ?? 1) >= 2;
  const cacheKey = `${oc.cmd}|${(oc.version || []).join('.')}|${cwd}|${standalone}`;
  const now = Date.now();
  if (!force && modelsCache && modelsCacheKey === cacheKey && now - modelsCacheAt < MODELS_CACHE_TTL) {
    return modelsCache;
  }
  const result = await new Promise((resolve) => {
    // v1 needs --refresh to bypass its cache; v2 has no such flag.
    const major = oc.version?.[0] ?? 1;
    const args = standalone ? ['--standalone', 'models'] : ['models'];
    if (major < 2) args.push('--refresh');
    let child;
    try {
      child = spawn(oc.cmd, args, {
        cwd,
        windowsHide: true,
        shell: oc.shell,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ providers: [], error: err.message, bin: oc.cmd, cwd, standalone, fetchedAt: Date.now() });
      return;
    }
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    // A hung provider discovery must not freeze the settings drawer.
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      finish({
        providers: [],
        error: 'opencode models timed out',
        bin: oc.cmd,
        cwd,
        standalone,
        fetchedAt: Date.now(),
      });
    }, 25000);
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('close', (code) => {
      const byProvider = new Map();
      for (const line of stdout.trim().split(/\r?\n/).filter(Boolean)) {
        const slash = line.indexOf('/');
        if (slash < 0) continue;
        const provider = line.slice(0, slash);
        const modelId = line.slice(slash + 1);
        if (!byProvider.has(provider)) byProvider.set(provider, []);
        byProvider.get(provider).push({ id: line, modelId, provider });
      }
      const providers = [...byProvider.entries()]
        .map(([provider, models]) => ({
          provider,
          models: models.sort((a, b) => a.modelId.localeCompare(b.modelId)),
        }))
        .sort((a, b) => a.provider.localeCompare(b.provider));
      finish({
        providers,
        error: code === 0 ? null : (stderr.trim() || `opencode models exited ${code}`),
        bin: oc.cmd,
        cwd,
        standalone,
        fetchedAt: Date.now(),
      });
    });
    child.on('error', (err) => {
      finish({ providers: [], error: err.message, bin: oc.cmd, cwd, standalone, fetchedAt: Date.now() });
    });
  });
  // Cache only successful listings. A failed scan (opencode busy, provider
  // offline) should be retried on the next drawer open instead of showing an
  // empty list for the whole TTL.
  if (!result.error) {
    modelsCache = result;
    modelsCacheAt = Date.now();
    modelsCacheKey = cacheKey;
  }
  return result;
}

/** Run the selected OpenCode binary and return its text output. */
function runOpenCodeText(oc, args, { cwd = process.env.USERPROFILE, timeout = 20000 } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(oc.cmd, args, {
        cwd,
        windowsHide: true,
        shell: oc.shell,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ ok: false, code: -1, stdout, stderr, error: err.message });
      return;
    }
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      finish({ ok: false, code: -1, stdout, stderr, error: `timed out after ${timeout}ms` });
    }, timeout);
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('close', (code) => {
      finish({ ok: code === 0, code, stdout, stderr, error: code === 0 ? null : stderr.trim() || `exited ${code}` });
    });
    child.on('error', (err) => finish({ ok: false, code: -1, stdout, stderr, error: err.message }));
  });
}

/** `opencode debug paths` → { home, data, config, db, ... }. */
export async function opencodeDebugPaths(oc = resolveOpenCode()) {
  const out = await runOpenCodeText(oc, ['debug', 'paths']);
  const paths = {};
  if (out.ok) {
    for (const line of out.stdout.split(/\r?\n/)) {
      const match = line.match(/^\s*(\w+)\s+(.+?)\s*$/);
      if (match) paths[match[1]] = match[2];
    }
  }
  return { ...paths, ok: out.ok, error: out.error || null };
}

/** `opencode auth list --format json` → provider accounts (never secrets). */
export async function opencodeAuthList(oc = resolveOpenCode()) {
  const major = oc.version?.[0] ?? 1;
  const args = [];
  if (major >= 2) args.push('--standalone');
  args.push('auth', 'list', '--format', 'json');
  const out = await runOpenCodeText(oc, args);
  let providers = [];
  if (out.ok) {
    try {
      const parsed = JSON.parse(out.stdout.trim() || '[]');
      if (Array.isArray(parsed)) {
        providers = parsed
          .filter((entry) => entry && typeof entry === 'object' && entry.id)
          .map((entry) => ({
            id: String(entry.id),
            name: String(entry.name || entry.id),
            connections: Array.isArray(entry.connections) ? entry.connections : [],
            active: Array.isArray(entry.connections) && entry.connections.length > 0,
            raw: entry,
          }));
      }
    } catch (err) {
      return {
        providers,
        activeProviderIds: [],
        ok: false,
        error: `Could not read OpenCode accounts: ${err.message}`,
      };
    }
  }
  return {
    providers,
    activeProviderIds: providers.filter((provider) => provider.active).map((provider) => provider.id),
    ok: out.ok,
    error: out.error || null,
  };
}

/** JSONC (comments/trailing commas) → object, without eval. */
function parseJsonc(text) {
  let out = '';
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (lineComment) {
      if (ch === '\n') {
        lineComment = false;
        out += ch;
      }
      continue;
    }
    if (blockComment) {
      if (ch === '*' && next === '/') {
        blockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      lineComment = true;
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      blockComment = true;
      i++;
      continue;
    }
    out += ch;
  }
  out = out.replace(/,\s*([}\]])/g, '$1');
  return JSON.parse(out);
}

/** Read the user's global OpenCode config (model + provider names). */
export async function opencodeConfigInfo(oc = resolveOpenCode()) {
  const paths = await opencodeDebugPaths(oc);
  const dir = paths.config;
  let file = null;
  if (dir) {
    for (const name of ['opencode.json', 'opencode.jsonc']) {
      const candidate = path.join(dir, name);
      try {
        if (fs.statSync(candidate).isFile()) {
          file = candidate;
          break;
        }
      } catch {}
    }
  }
  if (!file) return { path: null, model: null, providers: {}, error: null };
  try {
    const raw = parseJsonc(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    let model = raw?.model;
    if (model && typeof model === 'object') {
      model = model.providerID && model.model ? `${model.providerID}/${model.model}` : null;
    }
    return {
      path: file,
      model: typeof model === 'string' ? model : null,
      providers: raw?.providers && typeof raw.providers === 'object' ? raw.providers : {},
      error: null,
    };
  } catch (err) {
    return { path: file, model: null, providers: {}, error: `Could not read ${file}: ${err.message}` };
  }
}

/**
 * Everything Setup/Settings needs about the user's OpenCode:
 * binary, real config paths, provider accounts, models and the configured
 * default model. Read-only; no credential is read or returned.
 */
export async function opencodeReport(force = false) {
  const now = Date.now();
  if (!force && reportCache && now - reportCacheAt < REPORT_CACHE_TTL) return reportCache;
  const oc = resolveOpenCode();
  const configuredPath = String(settings.opencode?.exe || '');
  const configuredMissing = Boolean(configuredPath) && !fs.existsSync(configuredPath);
  if (!oc.version || oc.version[0] < 2) {
    return {
      ok: false,
      bin: oc.cmd,
      configuredPath,
      configuredMissing,
      version: oc.version ? oc.version.join('.') : null,
      error: 'OpenCode v2 or newer was not found. Pick an existing opencode.exe or install it.',
      paths: null,
      auth: [],
      activeProviderIds: [],
      configuredProviderIds: [],
      connectedProviderIds: [],
      providers: [],
      connectedModelCount: 0,
      modelsError: null,
      activeModel: null,
      configPath: null,
      selectedModel: settings.opencode?.model || null,
      selectedAvailable: false,
      selectedConnected: false,
      selectedDesktopOnly: false,
      suggestedModel: '',
    };
  }
  const [paths, auth, models, config] = await Promise.all([
    opencodeDebugPaths(oc),
    opencodeAuthList(oc),
    opencodeModels(force, { oc, cwd: AGENT_DIR, standalone: true }),
    opencodeConfigInfo(oc),
  ]);
  const selectedModel = settings.opencode?.model || null;
  const activeProviderIds = new Set(auth.activeProviderIds || []);
  const configuredProviderIds = new Set(Object.keys(config.providers || {}));
  const connectedProviderIds = new Set([...activeProviderIds, ...configuredProviderIds]);
  // Local runtimes need no saved account and stay routable when their models
  // are present. OpenCode's built-in `opencode` catalog is different: those
  // free models work in the desktop app, but the CLI EggLab spawns needs an
  // OpenCode Go credential. Never mark `opencode` connected on the strength of
  // a model listing alone — doing so made every `opencode/<free>` selection
  // fail with a misleading "free limit reached" error, including on fresh
  // installs.
  for (const provider of models.providers || []) {
    if (['ollama', 'lmstudio', 'vllm'].includes(provider.provider) && (provider.models || []).length) {
      connectedProviderIds.add(provider.provider);
    }
  }
  const providers = (models.providers || []).map((provider) => {
    const connected = connectedProviderIds.has(provider.provider);
    return {
      ...provider,
      connected,
      active: connected,
      desktopOnly: provider.provider === 'opencode' && !connected,
    };
  });
  const selectedProvider = selectedModel
    ? providers.find((provider) => (provider.models || []).some((model) => model.id === selectedModel))
    : null;
  const selectedAvailable = Boolean(selectedProvider);
  const selectedConnected = Boolean(selectedProvider?.connected);
  const selectedDesktopOnly = Boolean(selectedProvider?.desktopOnly);
  // The suggested model always comes from a connected provider, preferring a
  // free one. Setup uses this to offer a working model in one click instead of
  // letting the user pick a desktop-only `opencode/<free>` ID.
  const connectedModels = providers
    .filter((provider) => provider.connected)
    .flatMap((provider) => (provider.models || []).map((model) => ({ ...model, provider: provider.provider })))
    .sort((a, b) => a.id.localeCompare(b.id));
  const freeModels = connectedModels
    .filter((model) => /-free(?:$|#)/i.test(model.id) || /-free/i.test(model.modelId))
    // Prefer OpenCode Go: it is OpenCode's own free CLI tier and the model
    // group users reach for when they ask for a free OpenCode model.
    .sort((a, b) => {
      const rank = (m) => (m.provider === 'opencode-go' ? 0 : 1);
      return rank(a) - rank(b) || a.id.localeCompare(b.id);
    });
  const suggestedModel = freeModels[0]?.id || connectedModels[0]?.id || '';
  const value = {
    ok: true,
    bin: oc.cmd,
    configuredPath,
    configuredMissing,
    version: oc.version.join('.'),
    paths,
    auth: auth.providers,
    authError: auth.error,
    activeProviderIds: [...activeProviderIds],
    configuredProviderIds: [...configuredProviderIds],
    connectedProviderIds: [...connectedProviderIds],
    providers,
    modelCount: providers.reduce((sum, provider) => sum + provider.models.length, 0),
    connectedModelCount: providers.reduce(
      (sum, provider) => sum + (provider.connected ? provider.models.length : 0),
      0,
    ),
    modelsError: models.error,
    modelsCwd: models.cwd,
    activeModel: config.model,
    configPath: config.path,
    configError: config.error,
    selectedModel,
    selectedAvailable,
    selectedConnected,
    selectedDesktopOnly,
    suggestedModel,
  };
  if (models.error) return value;
  reportCache = value;
  reportCacheAt = now;
  return value;
}

export function ensureDirs() {
  let modelsDir = settings.modelsDir;
  try {
    modelsDir = engineConfig().models || modelsDir;
  } catch {}
  const dirs = [modelsDir];
  // The managed default gets the role layout up front. A user-provided
  // existing folder is left exactly as it is; downloads create role folders
  // only when needed.
  if (PACKAGED && path.resolve(modelsDir) === path.resolve(MODELS_DIR)) {
    for (const folder of Object.values(ROLE_FOLDERS)) dirs.push(path.join(modelsDir, folder));
  }
  for (const dir of dirs) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {}
  }
}
