// Agent contract gate — runs on every push and before every release.
//
// It does not call a model (CI has no provider credentials); it validates the
// things that broke silently: the 24 benchmark cases, every skill they name,
// every egl_* tool they mention, the root OpenCode config, and the timeout
// chain for long model downloads.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PANEL = path.resolve(HERE, '..');
const REPO = path.resolve(PANEL, '..');

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}
const read = (rel, base = PANEL) => fs.readFileSync(path.join(base, rel), 'utf8');
const exists = (rel, base = PANEL) => fs.existsSync(path.join(base, rel));

// ---- MCP tool registry -------------------------------------------------
const toolSource = read('mcp-server.mjs');
const toolsStart = toolSource.indexOf('const tools = [');
const toolsEnd = toolSource.indexOf('\n];', toolsStart);
const toolsBlock = toolSource.slice(toolsStart, toolsEnd);
const toolNames = new Set([...toolsBlock.matchAll(/name:\s*'([a-z0-9_]+)'/g)].map((m) => m[1]));
check('MCP tool registry parsed', toolNames.size >= 20, `${toolNames.size} tools`);
for (const required of ['status', 'generate', 'edit', 'download_models', 'photocraft_recent_projects', 'read_knowledge']) {
  check(`tool: ${required}`, toolNames.has(required));
}

// The production profile is a curated direct-tool set, not the full registry.
// Parse the same constant the MCP server uses at runtime.
const profileStart = toolSource.indexOf('const AGENT_TOOL_NAMES');
const profileEnd = toolSource.indexOf(']);', profileStart);
const agentTools = new Set(
  profileStart < 0
    ? []
    : [...toolSource.slice(profileStart, profileEnd).matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]),
);
check('agent tool profile parsed', agentTools.size >= 15, `${agentTools.size} tools`);
for (const required of [
  'status',
  'read_knowledge',
  'generate',
  'edit',
  'cancel',
  'check_alpha',
  'photocraft_edit_active',
  'photocraft_save',
  'photocraft_export_flat',
  'photocraft_command',
]) {
  check(`agent tool: ${required}`, agentTools.has(required));
}
for (const hidden of [
  'settings',
  'models',
  'download_models',
  'photocraft_open',
  'photocraft_recent_projects',
  'photocraft_project',
  'photocraft_export_layer',
  'photocraft_export_layers_by_mentions',
]) {
  check(`agent profile hides ${hidden}`, !agentTools.has(hidden));
}

// config/tool-registry.yaml is documentation only, but stale names here caused
// real confusion. Keep it mechanically synchronized with the server.
let toolRegistry = null;
try {
  toolRegistry = yaml.load(read('config/tool-registry.yaml'));
  check('tool registry parses', Boolean(toolRegistry?.agent_tools?.length), `${toolRegistry?.agent_tools?.length || 0} agent tools`);
} catch (err) {
  check('tool registry parses', false, err.message);
}
if (toolRegistry) {
  const registryAgent = new Set(toolRegistry.agent_tools || []);
  const registryFull = new Set(toolRegistry.full_tools || []);
  check(
    'tool registry agent list matches server',
    registryAgent.size === agentTools.size && [...registryAgent].every((name) => agentTools.has(name)),
    `${registryAgent.size} vs ${agentTools.size}`,
  );
  check(
    'tool registry full list matches server',
    registryFull.size === toolNames.size && [...registryFull].every((name) => toolNames.has(name)),
    `${registryFull.size} vs ${toolNames.size}`,
  );
  check(
    'tool registry has no egglab_ names',
    ![...registryAgent, ...registryFull].some((name) => String(name).startsWith('egglab_')),
  );
  check('tool registry uses the egl prefix', toolRegistry?.naming?.opencode === 'egl_prefix');
}

// ---- knowledge skills --------------------------------------------------
const skillNames = new Set(
  fs
    .readdirSync(path.join(PANEL, 'skills'), { withFileTypes: true })
    .filter((d) => d.isDirectory() && exists(`skills/${d.name}/SKILL.md`))
    .map((d) => d.name),
);
check('skills parsed', skillNames.size >= 8, [...skillNames].join(', '));

// ---- manifest ----------------------------------------------------------
let manifest = null;
try {
  manifest = yaml.load(read('manifest.yaml'));
  check('manifest parses', Boolean(manifest?.skills?.length), `${manifest?.skills?.length || 0} skills`);
} catch (err) {
  check('manifest parses', false, err.message);
}
if (manifest) {
  for (const entry of manifest.references || []) {
    check(`manifest reference ${entry}`, exists(entry), entry);
  }
  for (const skill of manifest.skills || []) {
    for (const ref of skill.references || []) {
      check(`manifest ${skill.name} reference ${ref}`, exists(ref), ref);
    }
  }
  const byName = new Map((manifest.skills || []).map((s) => [s.name, s]));
  for (const [skill, refs] of [
    ['image-generation', ['references/research/local/qwen-image-2.1-features.md']],
    [
      'reference-editing',
      [
        'references/research/local/qwen-image-2.1-features.md',
        'references/research/local/qwen-seamless-local-edit.md',
      ],
    ],
    ['transparency', ['references/research/local/qwen-image-2.1-features.md']],
  ]) {
    for (const ref of refs) {
      check(`${skill} loads ${path.basename(ref)}`, (byName.get(skill)?.references || []).includes(ref));
    }
  }
}

// ---- benchmark cases ---------------------------------------------------
const caseText = read('evals/benchmark-cases.yaml');
let benchmarkYaml = null;
try {
  benchmarkYaml = yaml.load(caseText);
  check('benchmark YAML parses', Boolean(benchmarkYaml?.cases?.length), `${benchmarkYaml?.cases?.length || 0} cases`);
} catch (err) {
  check('benchmark YAML parses', false, err.message);
}
const caseBlocks = [];
let current = null;
for (const line of caseText.split(/\r?\n/)) {
  const m = line.match(/^\s{2}- id:\s*(\S+)/);
  if (m) {
    current = { id: m[1], lines: [line] };
    caseBlocks.push(current);
  } else if (current) {
    current.lines.push(line);
  }
}
check('benchmark case count', caseBlocks.length === 26, `${caseBlocks.length} cases`);
const ids = caseBlocks.map((c) => c.id);
check('benchmark ids unique', new Set(ids).size === ids.length, `${ids.length} unique`);

const referencedSkills = new Set();
for (const block of caseBlocks) {
  const text = block.lines.join('\n');
  if (!/\bbrief:/.test(text)) check(`case ${block.id} brief`, false);
  if (!/\bchecks:/.test(text)) check(`case ${block.id} checks`, false);
  for (const field of ['must_load', 'conditional']) {
    const m = text.match(new RegExp(`${field}:\\s*\\[([^\\]]*)\\]`));
    if (!m) continue;
    for (const name of m[1].split(',').map((s) => s.trim()).filter(Boolean)) {
      referencedSkills.add(name);
      if (!skillNames.has(name)) check(`case ${block.id} skill ${name}`, false);
    }
  }
}
check(
  'benchmark skills resolve',
  [...referencedSkills].every((s) => skillNames.has(s)),
  `${referencedSkills.size} skill names`,
);

// ---- agent-upgrade cases ----------------------------------------------
const upgradeText = read('evals/agent-upgrade-cases.yaml');
let upgradeYaml = null;
try {
  upgradeYaml = yaml.load(upgradeText);
  check('agent-upgrade YAML parses', Boolean(upgradeYaml?.cases?.length), `${upgradeYaml?.cases?.length || 0} cases`);
} catch (err) {
  check('agent-upgrade YAML parses', false, err.message);
}
const upgradeBlocks = [];
let upgradeCurrent = null;
for (const line of upgradeText.split(/\r?\n/)) {
  const m = line.match(/^\s{2}- id:\s*(\S+)/);
  if (m) {
    upgradeCurrent = { id: m[1], lines: [line] };
    upgradeBlocks.push(upgradeCurrent);
  } else if (upgradeCurrent) {
    upgradeCurrent.lines.push(line);
  }
}
check('agent-upgrade case count', upgradeBlocks.length >= 10, `${upgradeBlocks.length} cases`);
const allIds = [...ids, ...upgradeBlocks.map((c) => c.id)];
check('all case ids unique', new Set(allIds).size === allIds.length, `${allIds.length} total`);

const TASK_TOOL = {
  text_to_image: 'generate',
  instruction_edit: 'edit',
  marked_edit: 'photocraft_edit_active',
  mask_edit: 'photocraft_edit_active',
  sketch_edit: 'edit',
  multi_reference: 'edit',
  transparent_generate: 'generate',
  transparent_edit: 'edit',
  typography: 'generate',
  text_effect: 'generate',
  creative_direction: 'generate',
  storyboard: 'generate',
  panorama: 'generate',
};
for (const block of upgradeBlocks) {
  const text = block.lines.join('\n');
  const task = (text.match(/\btask:\s*(\S+)/) || [])[1];
  const tool = (text.match(/\bexpected_tool:\s*(\S+)/) || [])[1];
  const primary = (text.match(/\bprimary_skill:\s*(\S+)/) || [])[1];
  const supports = ((text.match(/\bsupporting_skills:\s*\[([^\]]*)\]/) || [])[1] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const includes = ((text.match(/\bprompt_must_include:\s*\[([^\]]*)\]/) || [])[1] || '')
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
  check(`upgrade ${block.id} task`, Boolean(task && TASK_TOOL[task]), task || 'missing');
  check(`upgrade ${block.id} expected tool`, Boolean(tool) && agentTools.has(tool), tool || 'missing');
  if (task && TASK_TOOL[task]) {
    check(`upgrade ${block.id} task/tool`, tool === TASK_TOOL[task], `${task} -> ${tool}`);
  }
  check(`upgrade ${block.id} primary skill`, Boolean(primary) && skillNames.has(primary), primary || 'missing');
  for (const skill of supports) check(`upgrade ${block.id} skill ${skill}`, skillNames.has(skill));
  check(`upgrade ${block.id} prompt evidence`, includes.length > 0, `${includes.length} requirements`);
  if (task === 'mask_edit') {
    check(`upgrade ${block.id} mask_layer arg`, /tool_args:\s*\{[^}]*mask_layer:/.test(text));
  }
  if (task === 'marked_edit') {
    check(`upgrade ${block.id} annotation language`, includes.some((s) => /annotation|mark/i.test(s)));
  }
  if (task === 'multi_reference') {
    check(`upgrade ${block.id} image tags`, includes.includes('<image1>') && includes.includes('<image2>'));
  }
  if (task === 'transparent_generate' || task === 'transparent_edit') {
    check(`upgrade ${block.id} alpha language`, includes.some((s) => /alpha|transparent/i.test(s)));
  }
}

// ---- prompt/tool references -------------------------------------------
const promptFiles = [
  'AGENT.md',
  'ROUTER.md',
  'manifest.yaml',
  'evals/benchmark-cases.yaml',
  'evals/agent-upgrade-cases.yaml',
];
for (const file of promptFiles) {
  const text = read(file);
  const refs = [...new Set([...text.matchAll(/\begl_([a-z0-9_]+)/g)].map((m) => m[1]))];
  for (const ref of refs) {
    check(`${file} tool ${ref}`, agentTools.has(ref));
  }
}
const instructionRefs = [
  ...new Set([...toolSource.matchAll(/\begl_([a-z0-9_]+)/g)].map((m) => m[1])),
];
for (const ref of instructionRefs) check(`MCP instructions tool ${ref}`, toolNames.has(ref));

// ---- no stale bridge-only prompt --------------------------------------
const staleFiles = ['opencode.json', 'README.md', 'PERFORMANCE-RESEARCH.md', 'UI-AUDIT.md', 'panel/AGENT.md'];
for (const file of staleFiles) {
  if (!exists(file, REPO)) continue;
  check(`${file} has no egl_ping`, !read(file, REPO).includes('egl_ping'));
}
check('root AGENT.md removed', !exists('AGENT.md', REPO));

// ---- root OpenCode config ---------------------------------------------
let rootConfig = null;
try {
  rootConfig = JSON.parse(read('opencode.json', REPO));
} catch (err) {
  check('root opencode.json parses', false, err.message);
}
if (rootConfig) {
  const rootAgent = rootConfig?.agents?.egglab || {};
  const prompt = rootAgent?.system || '';
  const m = prompt.match(/\{file:\.\/(.+?)\}/);
  check('root system is a file reference', Boolean(m), prompt);
  if (m) check('root prompt file exists', exists(m[1], REPO), m[1]);
  const timeout = Number(rootConfig?.mcp?.servers?.egl?.timeout) || 0;
  check('root MCP timeout', timeout >= 3_900_000, `${timeout} ms`);
  check('root MCP is direct', rootConfig?.mcp?.servers?.egl?.codemode === false);
  check('root MCP uses the agent profile', rootConfig?.mcp?.servers?.egl?.environment?.EGGLAB_TOOLSET === 'agent');
  const rootPermissions = Array.isArray(rootAgent?.permissions) ? rootAgent.permissions : [];
  check('root agent uses v2 permissions', rootPermissions.length >= 2, `${rootPermissions.length} rules`);
  check(
    'root permissions deny everything by default',
    rootPermissions.some((r) => r.action === '*' && r.resource === '*' && r.effect === 'deny'),
  );
  check(
    'root permissions allow only egl tools',
    rootPermissions.some((r) => r.action === 'egl_*' && r.resource === '*' && r.effect === 'allow'),
  );
}

// ---- generated config / download timeout chain ------------------------
const downloadDeadline = 3_600_000;
const mcpSource = read('mcp-server.mjs');
check(
  'download_models deadline',
  mcpSource.includes(`Date.now() + ${downloadDeadline.toLocaleString('en-US')}`) ||
    mcpSource.includes('Date.now() + 3_600_000'),
  '60 minutes',
);
const chatSource = read('service/chat.mjs');
const chatProfileStart = chatSource.indexOf('const AGENT_CORE_TOOLS');
const chatProfileEnd = chatSource.indexOf(']);', chatProfileStart);
const chatAgentTools = new Set(
  chatProfileStart < 0
    ? []
    : [...chatSource.slice(chatProfileStart, chatProfileEnd).matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]),
);
check(
  'chat and MCP agent tool lists match',
  chatAgentTools.size === agentTools.size && [...chatAgentTools].every((name) => agentTools.has(name)),
  `${chatAgentTools.size} vs ${agentTools.size}`,
);
check('MCP default tool profile is agent', /process\.env\.EGGLAB_TOOLSET \|\| 'agent'/.test(toolSource));
check('MCP full profile is opt-in', /EGGLAB_TOOLSET=full/.test(toolSource) || /EGGLAB_TOOLSET[^\n]*full/.test(toolSource));
check('MCP workflow description is live metadata', !/quality = 40 steps/.test(toolSource) && /applyRuntimeMetadata/.test(toolSource));
check('generated config uses mcp.servers', /mcp:\s*\{[\s\S]*?servers:\s*\{/.test(chatSource));
check('generated config disables Code Mode', /codemode:\s*false/.test(chatSource));
check(
  'generated config selects the agent profile',
  /EGGLAB_TOOLSET:\s*beta \? 'agent-beta' : 'agent'/.test(chatSource),
);
check('generated config has no legacy egglab MCP entry', !/mcp:\s*\{\s*egglab:/.test(chatSource));
check(
  'generated config uses the unique egl server key',
  /egl:\s*\{[\s\S]*?EGGLAB_TOOLSET:\s*beta \? 'agent-beta' : 'agent'/.test(chatSource),
);
check('generated config uses the v2 agents map', /agents:\s*\{/.test(chatSource));
check('generated config uses a system file reference', /system:\s*'\{file:\.\/AGENT\.md\}'/.test(chatSource));
check('generated config uses v2 permissions', /permissions:\s*agentPermissions\(\)/.test(chatSource));
const permissionStart = chatSource.indexOf('function agentPermissions');
const permissionEnd = chatSource.indexOf('\n}', permissionStart);
const permissionBlock = chatSource.slice(permissionStart, permissionEnd);
check('generated permissions deny everything by default', /action:\s*'\*',\s*resource:\s*'\*',\s*effect:\s*'deny'/.test(permissionBlock));
check('generated permissions allow egl tools', /action:\s*'egl_\*'/.test(permissionBlock));
check('generated permissions do not expose read', !/action:\s*'read'/.test(permissionBlock));
check('generated config passes inspect roots', /EGGLAB_READ_ROOTS/.test(chatSource));
check(
  'post-run migration only for a detached chat',
  /savedDuringRun/.test(read('main.mjs')) && /createdForDetachedChat/.test(read('main.mjs')),
);
check(
  'watcher restores the working document when an agent leaves it',
  /agent left document/.test(read('main.mjs')) &&
    /showDocumentForKey\(runDoc\)/.test(read('main.mjs')) &&
    /lastRunDocumentKey/.test(read('service/chat.mjs')),
);
check(
  'new document blocked for an attached chat',
  /source === 'agent'/.test(read('service/http.mjs')) &&
    /chat\.workingDocument\(\)/.test(read('service/http.mjs')) &&
    /doc\|document\|file/.test(read('service/http.mjs')),
);
check(
  'MCP new-document call is tagged as agent',
  /'\/api\/photocraft\/new-document'[\s\S]{0,400}source: 'agent'/.test(read('mcp-server.mjs')),
);
check(
  'agent activation is limited to the working document',
  /document\\\.activate/.test(read('service/http.mjs')) &&
    /targetIsActive/.test(read('service/http.mjs')) &&
    /sameUntitledName/.test(read('service/http.mjs')),
);
check(
  'instructions keep the agent in its working document',
  /Document ownership/.test(read('AGENT.md')) &&
    /Do not create a new document/i.test(read('AGENT.md')) &&
    /never create a second document/i.test(read('skills/photocraft-production/SKILL.md')),
);
check('low-VRAM sub-megapixel retry exists', /lowVramRetry/.test(read('service/engine.mjs')));
// Deleted chats must not come back when the app reopens. The durable part
// (tombstone + registry + transcript) has to happen before the slow OpenCode
// call, and startup repair must never heal a tombstoned transcript.
const sessionsSource = read('service/sessions.mjs');
check(
  'delete persists before OpenCode cleanup',
  /markDeleted\(target\)[\s\S]{0,2600}deleteOpencodeSession/.test(chatSource) &&
    /markDeleted\(target\)[\s\S]{0,2600}forgetThread\(target\)/.test(chatSource),
);
check('startup heal ignores deleted threads', /sessions\.isDeleted\(id\)/.test(chatSource));
check(
  'deleted bindings purge at startup',
  /purgeDeletedThreads/.test(sessionsSource) && /sessions\.purgeDeletedThreads\(\)/.test(read('main.mjs')),
);
check('tombstones are written to disk', /DELETED_FILE/.test(sessionsSource) && /deleted-threads\.json/.test(sessionsSource));
check('OpenCode v2 uses a private server', /if \(major >= 2\) args\.push\('--standalone'\)/.test(chatSource));
check('Stop has a settle watchdog', /current\.finish\?\.\(-1\)/.test(chatSource));
check('Stop covers the retry gap', /let turnRunning/.test(chatSource) && /turnStopped/.test(chatSource));
check('Retry wait aborts on Stop', /if \(turnStopped\) return false/.test(chatSource));
check('Busy includes the retry gap', /Boolean\(active \|\| turnRunning\)/.test(chatSource));
const mainSource = read('main.mjs');
const httpSource = read('service/http.mjs');
const modelsSource = read('service/models.mjs');
check('IPC Stop cancels agent downloads', /cancelAgentDownloads\(\)/.test(mainSource));
check('HTTP Stop cancels agent downloads', /cancelAgentDownloads\(\)/.test(httpSource));
check('agent downloads are tagged', /source:\s*'agent'/.test(read('mcp-server.mjs')));
check('agent download cancel helper exists', /export function cancelAgentDownloads/.test(modelsSource));
const mcpTimeoutMatch = chatSource.match(/mcp:\s*\{[\s\S]*?timeout:\s*([0-9_]+)/);
const generatedTimeout = mcpTimeoutMatch ? Number(mcpTimeoutMatch[1].replace(/_/g, '')) : 0;
check('generated MCP timeout', generatedTimeout >= 3_900_000, `${generatedTimeout} ms`);
const settingsSource = read('service/settings.mjs');
const turnTimeout = Number((settingsSource.match(/timeoutSec:\s*(\d+)/) || [])[1]) || 0;
check('agent turn timeout', turnTimeout * 1000 >= 3_900_000, `${turnTimeout} s`);

// ---- beta agent (egglab-beta) -----------------------------------------
const pathsSource = read('service/paths.mjs');
const betaPromptSource = read('beta-agent/AGENT.md');
check('beta agent has its own knowledge package', exists('beta-agent/AGENT.md') && exists('beta-agent/ROUTER.md') && exists('beta-agent/manifest.yaml'));
check('beta agent package ships skills and evals', exists('beta-agent/skills') && exists('beta-agent/evals'));
check('beta agent identifies itself', /beta agent/i.test(betaPromptSource));
for (const ref of [...new Set([...betaPromptSource.matchAll(/\begl_([a-z0-9_]+)/g)].map((m) => m[1]))]) {
  check(`beta AGENT.md tool ${ref}`, agentTools.has(ref));
}
check('settings default the beta agent off', /betaAgent:\s*false/.test(settingsSource));
check('paths expose the beta workspace and package', /AGENT_BETA_DIR/.test(pathsSource) && /KNOWLEDGE_BETA_DIR/.test(pathsSource));
check('chat runs the beta agent id', /'egglab-beta'/.test(chatSource) && /agent-beta/.test(chatSource));
check('beta chat runs its own workspace', /betaAgent \? AGENT_BETA_DIR : AGENT_DIR/.test(chatSource));
check('beta knowledge root override', /EGGLAB_KNOWLEDGE_ROOT/.test(chatSource) && /EGGLAB_KNOWLEDGE_ROOT/.test(toolSource));
check('beta sessions fork on agent switch', /agentChanged/.test(sessionsSource));
check('session listing covers both agent projects', /AGENT_BETA_DIR/.test(sessionsSource));
check(
  'legacy threads are seeded as official so the agent switch forks',
  /if \(!entry\.agent\) entry\.agent = 'egglab';/.test(sessionsSource),
);

// ---- Phase B: stable chat identities ----------------------------------
check(
  'new conversations mint stable uid identities',
  /const id = `chat_\$\{uid\(\)\}`/.test(sessionsSource) && !/`\$\{doc\}#\$\{n\}`/.test(sessionsSource),
);
check(
  'a document without a chat mints a uid chat, never a doc-key id',
  /sessions\.newThread\(\{ docKey: next, docName: docTitle \}\)/.test(chatSource) &&
    !/threadId = resumed \? resumed\.id : next/.test(chatSource),
);
check(
  'the delete fallback mints a uid chat too',
  /sessions\.newThread\(\{ docKey, docName: docTitle \}\)\.id/.test(chatSource),
);
check('bind records the driving agent on every send', /if \(agent\) entry\.agent = agent;/.test(sessionsSource));

// ---- Phase A: chat/doc management (revised: document-driven chats) -----
check(
  'a document switch opens that document own chat',
  /chat\.useDocument\(key, doc\?\.name \|\| null\)/.test(mainSource) && !/canvasMismatch/.test(mainSource),
);
check(
  'transient renders never become chat scopes',
  /isTransientDocKey\(next\)/.test(chatSource) && /chat\.isTransientKey\(key\)/.test(mainSource),
);
check(
  'context forks are announced in the timeline',
  /Context reset \(/.test(chatSource) && /reasons/.test(sessionsSource) && /role: 'system'/.test(chatSource),
);
check(
  'beta session export and delete use the agent project scope',
  /exportSession\(sessionId, cwd = AGENT_DIR\)/.test(sessionsSource) &&
    /deleteOpencodeSession\(sessionId, cwd = AGENT_DIR\)/.test(sessionsSource) &&
    /agentOfThread === 'egglab-beta' \? AGENT_BETA_DIR : AGENT_DIR/.test(chatSource),
);
check('the canvas badge switch endpoint exists', /sessions:useDocument/.test(mainSource) && /sessionUseDocument/.test(read('preload.cjs')));
const appJs = read('renderer/app.js');
const indexHtml = read('renderer/index.html');
check(
  'no selector or chips: the document drives the chat',
  !/canvasTarget|canvas-switch|link-chip|id="canvasSwitch"|id="linkChip"/.test(indexHtml) &&
    !/renderCanvasSwitch|renderLinkChip|canvasTargetState/.test(appJs),
);
check(
  'a chat whose canvas is gone gets one polite popup at switch time',
  /showCanvasPopup/.test(appJs) && /canvas-popup/.test(indexHtml) && /canvas-popup-scrim\.on/.test(read('renderer/app.css')) &&
    !/canvasNotice|canvas-notice/.test(appJs) && !/canvas-notice/.test(indexHtml),
);
check(
  'the popup offers a blank canvas or continues without asking again',
  /canvasPopupMake/.test(appJs) && /chatCreateCanvas/.test(read('preload.cjs')) &&
    /documentOpened === false/.test(appJs),
);

// ---- Phase C: explicit links + beta canvas creation --------------------
const httpSource2 = read('service/http.mjs');
const mcpSource2 = read('mcp-server.mjs');
check(
  'the popup can rebind the chat via the move endpoint',
  /canvasPopupMake/.test(appJs) && /sessionMove/.test(read('preload.cjs')) && /sessions:move/.test(mainSource),
);
check(
  'a pinned chat switch is not yanked back by the watcher',
  /pinChatSwitch/.test(chatSource) && /pinChatSwitch\(res\.threadId, lastDocKey\)/.test(mainSource) &&
    /chat\.chatPinState\(\)/.test(mainSource) && /pin\.threadKey === chat\.currentThreadId\(\)/.test(mainSource),
);
check(
  'making a canvas clears the pin',
  /clearChatPin\(\)/.test(mainSource) && /export function clearChatPin/.test(chatSource),
);

// ---- Phase 2: harness-enforced production loop -----------------------
check(
  'egl_edit never passes a mask as a donor and gates the mask prompt',
  /const donorImages = maskPath\s+\?\s+images\.filter\(\(p\) => String\(p\) !== initPath && String\(p\) !== maskPath\)/.test(mcpSource2) &&
    /checkMaskPrompt\(args\.prompt\)/.test(mcpSource2) &&
    /images: donorImages/.test(mcpSource2),
);
check(
  'egl_edit carries an explicit edit contract and ordered roles',
  /edit_mode: \{/.test(mcpSource2) && /image_roles: \{/.test(mcpSource2) &&
    /case 'edit': \{/.test(mcpSource2) && /const editMode =/.test(mcpSource2),
);
check(
  'visual_mask is retired; masks use the native mask path',
  /visual_mask is retired/.test(mcpSource2) &&
    !/visual_mask = images\[0\] source/.test(mcpSource2),
);
check(
  'the mask prompt gate rejects the failures measured in real jobs',
  /Do not mention the mask or selection/.test(mcpSource2) &&
    /limited to the marked area/.test(mcpSource2) &&
    /Do not write "background surface"/.test(mcpSource2) &&
    /Do not invent a material or colour for a removal/.test(mcpSource2) &&
    /Add one keep clause/.test(mcpSource2),
);
check(
  'a painted mask is a selector: the engine marks a copy and composites through it',
  /prepareMaskedEdit\(/.test(read('service/engine.mjs')) &&
    /finishMaskedEdit\(/.test(read('service/engine.mjs')) &&
    /mode: 'marked-reference'/.test(read('service/engine.mjs')) &&
    /MARK_TINT = 0\.28/.test(read('service/maskedjob.mjs')) &&
    /sameMaskShape\(d, maskFile\)/.test(read('service/maskedjob.mjs')) &&
    /local\.mask = maskForComposite/.test(httpSource2) &&
    !/markMaskRegion\(exported\.path, maskForComposite/.test(httpSource2) &&
    !/compositeMasked\(exported\.path, done\.outPath, maskForComposite/.test(httpSource2),
);
check(
  'the marked prompt tells Qwen which image is the canvas and which is the guide',
  /<image1> is the source canvas/.test(read('service/maskedjob.mjs')) &&
    /keep <image1> exactly unchanged everywhere outside it/.test(read('service/maskedjob.mjs')),
);
check(
  'source_layer is explicit: the edit does not depend on the active layer',
  /source_layer: \{/.test(mcpSource2) && /sourceLayer: args\.source_layer/.test(mcpSource2) &&
    /body\.sourceLayer/.test(httpSource2) &&
    /did not become the active layer/.test(httpSource2),
);
check(
  'mask attachments are never images or donors in the agent message',
  /painted mask SELECTOR/.test(read('service/chat.mjs')) &&
    /const sendFiles = cleanFiles\.filter\(\(f\) => vision && !isSelector\(f\)\)/.test(read('service/chat.mjs')) &&
    /for \(const file of sendFiles\) args\.push\('--file', file\)/.test(read('service/chat.mjs')) &&
    !/Use these with egl_edit \(images array\)/.test(read('service/chat.mjs')),
);
check(
  'the result reports measured placement, visibility and verification',
  /edit-final result=/.test(httpSource2) &&
    /placement=/.test(httpSource2) &&
    /layer\.select', \{ layer: autoMaskId \}/.test(httpSource2) &&
    /selectorOpaque/.test(read('service/engine.mjs')) &&
    /verify: done\.maskVerify/.test(httpSource2),
);
check(
  'beta references teach the verified masked path, not init image + mask',
  /## Masked edits \(painted mask layer\)/.test(read('beta-agent/references/reference-editing/local-edit-and-seam-control.md')) &&
    /outsideChangedPx/.test(read('beta-agent/references/reference-editing/local-edit-and-seam-control.md')) &&
    /NOT init image \+ mask \+ strength/.test(read('beta-agent/references/engine/qwen-image-2.1-legacy-facts.md')) &&
    !/Path 2 - pixel mask via init image/.test(read('beta-agent/references/engine/qwen-image-2.1-legacy-facts.md')),
);
check(
  'active-layer donors are never the source or the mask',
  /\.filter\(\(p\) => p !== exported\.path\)/.test(httpSource2),
);
check(
  'active-layer donors are never the source or the mask',
  /\.filter\(\(p\) => p !== exported\.path\)/.test(httpSource2),
);

// ---- V2 ticket 4: capability intelligence ------------------------------
const pcSource = read('service/photocraft.mjs');
check(
  'the capability search has three detail levels',
  /detail = ''/.test(pcSource) && /\['names', 'brief', 'full'\]/.test(pcSource) &&
    /detail: args\.detail \|\| 'brief'/.test(mcpSource2),
);
check(
  'commands carry group and risk classes',
  /function commandGroup/.test(pcSource) && /function commandRisk/.test(pcSource) &&
    /risk: commandRisk\(c\.id\)/.test(pcSource) && /destructive/.test(pcSource),
);
check(
  'the agent is told names-first and risk classes',
  /detail:\s*"names"/.test(read('beta-agent/AGENT.md')) && /Ask before destructive/.test(read('beta-agent/AGENT.md')),
);

// ---- V2 ticket 5: designing pipeline ------------------------------------
check(
  'the design pipeline orchestrates brief to delivery',
  exists('beta-agent/skills/design-pipeline/SKILL.md') &&
    /## 1\. Brief/.test(read('beta-agent/skills/design-pipeline/SKILL.md')) &&
    /## 5\. Compose in PhotoCraft/.test(read('beta-agent/skills/design-pipeline/SKILL.md')) &&
    /## 7\. Verify and deliver/.test(read('beta-agent/skills/design-pipeline/SKILL.md')),
);
check(
  'the design job record schema exists and is routed',
  exists('beta-agent/templates/design-job.yaml') &&
    /name: design-pipeline/.test(read('beta-agent/manifest.yaml')) &&
    /required_for: \[designing\]/.test(read('beta-agent/manifest.yaml')) &&
    /skills\/design-pipeline\/SKILL\.md/.test(read('beta-agent/ROUTER.md')),
);

// ---- V2 ticket 6: outcome evals -----------------------------------------
check(
  'outcome graders are executable and wired into the agent suite',
  exists('tools/outcome-checks.mjs') && /outcome-checks\.mjs/.test(read('package.json')),
);
check(
  'outcome eval cases grade deliverables',
  exists('beta-agent/evals/outcome-cases.yaml') &&
    /alphaStats/.test(read('beta-agent/evals/outcome-cases.yaml')) &&
    /projectSaved/.test(read('beta-agent/evals/outcome-cases.yaml')) &&
    /exactCopy/.test(read('beta-agent/evals/outcome-cases.yaml')),
);

// ---- Mask alignment (live bug: cropped layer exports) -------------------
const engineSource = read('service/engine.mjs');
check(
  'layer references are exported full-canvas at their true position',
  /function padToCanvas/.test(pcSource) && /padToCanvas\(file, doc\.width, doc\.height, match\.bounds\)/.test(pcSource) &&
    /path: aligned \|\| file/.test(pcSource),
);
check(
  'misaligned masks are refused, never rendered',
  /Mask is \$\{maskSize\.width\}x\$\{maskSize\.height\}/.test(engineSource) &&
    /A mask must share the image canvas/.test(engineSource),
);
check(
  'agents cannot save-as or rename an existing document',
  /source === 'agent' && target && d\.path/.test(read('service/photocraft.mjs')) &&
    /source: 'agent' \}\)/.test(mcpSource2),
);
check(
  'the router mandates loading the routed skill',
  /Step 0 .* Route and Load Knowledge/.test(read('beta-agent/ROUTER.md')) &&
    /skills\/design-pipeline\/SKILL\.md/.test(read('beta-agent/ROUTER.md')),
);
check(
  'production without a loaded skill is called out',
  /produced work without calling egl_read_knowledge/.test(chatSource) &&
    /Load the routed skill \(ROUTER\.md step 0\)/.test(chatSource),
);
check(
  'agents cannot rename or save-as the open document',
  /must not rename or save-as the current document/.test(httpSource2) &&
    /Never rename or use Save-As/.test(read('beta-agent/AGENT.md')),
);
check(
  'the beta brain routes two jobs and teaches the mask taxonomy',
  /IMAGE EDITING/.test(read('beta-agent/AGENT.md')) &&
    /DESIGNING/.test(read('beta-agent/AGENT.md')) &&
    /`native_mask`/.test(read('beta-agent/ROUTER.md')) &&
    !/`visual_mask`/.test(read('beta-agent/ROUTER.md')) &&
    /never silently (drop|change).*(reorder|input image)/i.test(read('beta-agent/AGENT.md')),
);
check(
  'the beta skill teaches attached masks and drawn descriptions',
  /Separate mask attachment/.test(read('beta-agent/skills/reference-editing/SKILL.md')) &&
    /Drawn descriptions \(annotated photos\)/.test(read('beta-agent/references/engine/qwen-image-2.1-legacy-facts.md')),
);
check(
  'a beta turn that renders without inspecting is called out',
  /doneJobCount > renderedBefore/.test(chatSource) &&
    /never called egl_inspect/.test(chatSource) &&
    /\/inspect\/i\.test\(String\(t\?\.name/.test(chatSource),
);
check(
  'the loop check is beta-only and skips stopped turns',
  /if \(betaAgent && !result\.stopped && doneJobCount > renderedBefore\)/.test(chatSource),
);
check(
  'the chat list marks the canvas on screen',
  /s-onscreen/.test(read('renderer/app.js')),
);
check(
  'the official agent keeps the new-document block',
  /body\.profile !== 'beta'/.test(httpSource2) && /noteRunCanvasSwitch/.test(httpSource2),
);
check(
  'only the beta toolset sends the new-canvas profile',
  /TOOL_PROFILE === 'agent-beta' \? \{ profile: 'beta' \} : \{\}/.test(mcpSource2),
);
check(
  'the watcher relinks the conversation after a beta canvas switch',
  /consumeRunCanvasSwitch/.test(mainSource),
);
check(
  'the beta agent may create a canvas for a separate piece',
  /conversation follows that piece/.test(mcpSource2),
);

// ---- Phase D: assets ---------------------------------------------------
check(
  'finished renders are recorded as chat assets',
  exists('service/assets.mjs') && /recordAsset/.test(chatSource) && /job\.status === 'done' && job\.outPath/.test(chatSource),
);
check(
  'one asset per job, newest-first tray',
  /a\.jobId === jobId/.test(read('service/assets.mjs')) && /assetsForChat/.test(read('service/assets.mjs')),
);
check(
  'the UI shows no asset preview strip (removed by request)',
  !/asset-strip|id="assetStrip"/.test(indexHtml) && !/renderAssetStrip|placeAsset|assetsList/.test(appJs) &&
    !/assets:list|assets:place/.test(mainSource),
);

// ---- Phase E: session UX polish ---------------------------------------
check(
  'context resets are counted per chat',
  /forkCount: existing \? \(existing\.forkCount \|\| 0\) \+ 1 : 0/.test(sessionsSource) &&
    /forkCount: entry\.forkCount \|\| 0/.test(sessionsSource),
);
check(
  'the chat list shows the agent and reset count',
  /' · beta'/.test(read('renderer/app.js')) && /context reset/.test(read('renderer/app.js')),
);
check(
  'the chat list footer describes the new model',
  /independent of canvases/.test(read('renderer/app.js')),
);
check('package ships the beta knowledge package', /"from":\s*"beta-agent"[\s\S]{0,120}"to":\s*"knowledge-beta"/.test(read('package.json')));

console.log(`\n${failures ? 'FAILED' : 'OK'} — ${failures} failure(s)`);
process.exit(failures ? 1 : 0);
