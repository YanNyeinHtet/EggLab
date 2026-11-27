// Transport for the OpenCode desktop app's local service.
//
// EggLab no longer spawns `opencode run` for chat turns: the desktop app keeps
// its own service (URL + password in the OpenCode state/config folders) and
// exposes sessions, prompts and events over HTTP. Driving that service gives
// the agent the desktop app's runtime instead of a private CLI process, and
// Stop becomes a real session interrupt instead of a taskkill on a child tree.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const HOME = os.homedir();
const CONFIG_DIR = process.env.XDG_CONFIG_HOME
  ? path.join(process.env.XDG_CONFIG_HOME, 'opencode')
  : path.join(HOME, '.config', 'opencode');
const STATE_DIR = process.env.XDG_STATE_HOME
  ? path.join(process.env.XDG_STATE_HOME, 'opencode')
  : path.join(HOME, '.local', 'state', 'opencode');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** The desktop service publishes its URL in state and its password in config. */
export function serviceInfo() {
  const live = readJson(path.join(STATE_DIR, 'service.json'));
  const cfg = readJson(path.join(CONFIG_DIR, 'service.json'));
  if (!live?.url || !cfg?.password) return null;
  return {
    url: String(live.url).replace(/\/$/, ''),
    password: String(cfg.password),
    pid: live.pid || null,
    version: live.version || null,
  };
}

function authHeader(info) {
  return `Basic ${Buffer.from(`opencode:${info.password}`).toString('base64')}`;
}

export async function ping(info) {
  if (!info) return false;
  try {
    const r = await fetch(`${info.url}/api/info`, {
      headers: { Authorization: authHeader(info) },
      signal: AbortSignal.timeout(4000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

/** Locate the installed desktop app (the CLI bundled inside it is not used). */
export function desktopCandidates() {
  const local = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
  return [
    path.join(local, 'Programs', '@opencode-aidesktop', 'OpenCode.exe'),
    path.join(local, 'Programs', 'OpenCode', 'OpenCode.exe'),
    path.join(HOME, 'Applications', 'OpenCode.exe'),
  ].filter((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });
}

export async function launchDesktop() {
  const exe = desktopCandidates()[0];
  if (!exe) {
    throw new Error(
      'OpenCode desktop is not installed. Open Setup and install the desktop app, then try again.',
    );
  }
  try {
    const child = spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: false });
    child.unref?.();
  } catch (err) {
    throw new Error(`Could not start OpenCode desktop: ${err.message}`);
  }
}

/**
 * Return a live service, starting the desktop app when needed. Signing in is a
 * human step; if the app is installed but not signed in the service may never
 * appear and we surface that instead of silently falling back to the CLI.
 */
export async function ensureService(timeoutMs = 45000) {
  let info = serviceInfo();
  if (info && (await ping(info))) return info;
  await launchDesktop();
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 700));
    info = serviceInfo();
    if (info && (await ping(info))) return info;
  }
  throw new Error(
    'OpenCode desktop started but its local service is not ready. Sign in to OpenCode desktop once, then retry.',
  );
}

/** One authenticated JSON call. Errors keep the provider's body for diagnosis. */
export async function api(info, method, endpoint, body = null) {
  const init = { method, headers: { Authorization: authHeader(info) } };
  if (body !== null) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetch(`${info.url}${endpoint}`, init);
  } catch (err) {
    throw new Error(`OpenCode service unreachable: ${err.message}`);
  }
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!response.ok) {
    const detail =
      json?.error?.message ||
      json?.message ||
      (typeof json === 'string' ? json : '') ||
      text.slice(0, 400) ||
      `HTTP ${response.status}`;
    const err = new Error(detail);
    err.status = response.status;
    err.body = text;
    throw err;
  }
  return json;
}

export async function createSession(info, { agent, model, directory, title }) {
  const body = { agent };
  if (model) body.model = model;
  if (directory) body.location = { directory };
  if (title) body.title = title;
  const result = await api(info, 'POST', '/api/session', body);
  return result?.data || result;
}

export async function getSession(info, id) {
  const result = await api(info, 'GET', `/api/session/${encodeURIComponent(id)}`);
  return result?.data || result;
}

export async function messages(info, id, limit = 200) {
  const result = await api(
    info,
    'GET',
    `/api/session/${encodeURIComponent(id)}/message?limit=${limit}&order=asc`,
  );
  return Array.isArray(result?.data) ? result.data : [];
}

export async function prompt(info, id, text, files = []) {
  const body = {
    text,
    ...(files.length
      ? { files: files.map((p) => ({ uri: pathToFileURL(path.resolve(p)).href })) }
      : {}),
  };
  const result = await api(info, 'POST', `/api/session/${encodeURIComponent(id)}/prompt`, body);
  return result?.data || result;
}

export async function interrupt(info, id) {
  try {
    await api(info, 'POST', `/api/session/${encodeURIComponent(id)}/interrupt`);
  } catch {
    // Already idle or the app was closed; the turn settles locally either way.
  }
}

/** Split `provider/model/with/slashes` into the service's Model.Ref shape. */
export function modelRef(id) {
  const text = String(id || '');
  const slash = text.indexOf('/');
  if (slash < 1) return null;
  return { providerID: text.slice(0, slash), id: text.slice(slash + 1) };
}

export function fileUrl(file) {
  return pathToFileURL(path.resolve(file)).href;
}
