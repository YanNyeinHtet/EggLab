// Functional test for the agent's mask gate and argument forwarding. It runs the
// real mcp-server.mjs against a fake panel and checks what the agent is allowed
// to send: rejected prompts never reach the panel, accepted ones arrive with the
// explicit source layer, the mask name, and no mask in any donor list.
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const PANEL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const posts = [];

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  let raw = '';
  req.setEncoding('utf8');
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {};
    const send = (code, payload) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    if (req.method === 'POST') posts.push({ path: url.pathname, body });
    if (req.method === 'POST' && url.pathname === '/api/photocraft/layers') {
      return send(200, { layers: [{ id: 1, name: 'Mask' }, { id: 2, name: 'Layer 0' }] });
    }
    if (req.method === 'POST' && url.pathname === '/api/photocraft/edit-active') {
      return send(200, { ok: true, mode: 'mask' });
    }
    if (req.method === 'POST' && url.pathname === '/api/jobs') {
      return send(200, { job: { id: 'job_test', status: 'running' } });
    }
    if (req.method === 'GET' && url.pathname === '/api/jobs/job_test') {
      return send(200, { job: { id: 'job_test', status: 'done', outPath: 'C:/a/out.png' } });
    }
    return send(404, { error: `No route for ${req.method} ${url.pathname}` });
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const child = spawn(process.execPath, ['mcp-server.mjs'], {
  cwd: PANEL,
  env: {
    ...process.env,
    EGGLAB_URL: `http://127.0.0.1:${port}`,
    EGGLAB_TOKEN: 'test',
    EGGLAB_TOOLSET: 'agent-beta',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});
const lines = createInterface({ input: child.stdout });
const pending = new Map();
child.stderr.on('data', () => {});
lines.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});
let id = 0;
function request(method, params) {
  return new Promise((resolve, reject) => {
    const callId = ++id;
    const timer = setTimeout(() => {
      pending.delete(callId);
      reject(new Error(`MCP ${method} timed out`));
    }, 20000);
    pending.set(callId, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: callId, method, params }) + '\n');
  });
}
async function call(name, args) {
  const msg = await request('tools/call', { name, arguments: args });
  const text = msg.result?.content?.[0]?.text || msg.error?.message || '';
  return { isError: Boolean(msg.result?.isError || msg.error), text };
}

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

const KEEP = 'Keep everything else unchanged.';
const REMOVE_OK = `Remove the text in the marked area and reconstruct the surface behind it, continuing its texture, colour and light. ${KEEP}`;
const REMOVE_WITH_DONOR = `${REMOVE_OK} <image2> supplies the hat design only.`;

try {
  await request('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'mask-gate-test', version: '1' },
  });
  // The beta harness locks production until the routed skill is read and the
  // source has been inspected. Satisfy both gates the way the agent must.
  await call('read_knowledge', { path: 'skills/reference-editing/SKILL.md' });
  await call('inspect', { path: 'C:/a/source.png' });

  const rejects = [
    ['a masked-area prompt names the mask', 'Remove the text in the masked area and reconstruct the surface behind it. ' + KEEP, 'Do not mention the mask'],
    ['"all text" for a masked request is refused', 'Remove all text and lettering and reconstruct the surface behind it. ' + KEEP, 'limited to the marked area'],
    ['"background surface" is refused', 'Remove the text in the marked area and reconstruct the original background surface in its place. ' + KEEP, 'Do not write "background surface"'],
    ['an invented gradient is refused', 'Remove the text in the marked area and reconstruct the warm gradient surface behind it. ' + KEEP, 'Do not invent a material or colour'],
    ['a prompt without a keep clause is refused', 'Remove the text in the marked area and reconstruct the surface behind it, continuing its texture.', 'Add one keep clause'],
    ['a scene description opener is refused', 'A photo of a woman with a title. Remove the text in the marked area and reconstruct the surface behind it. ' + KEEP, 'do not open with a scene description'],
  ];
  for (const [label, prompt, needle] of rejects) {
    const before = posts.length;
    const r = await call('photocraft_edit_active', { prompt, mask_layer: 'Mask', source_layer: 'Layer 0' });
    const forwarded = posts.slice(before).some((p) => p.path === '/api/photocraft/edit-active');
    check(`rejected: ${label}`, r.isError && r.text.includes(needle) && !forwarded, r.text.slice(0, 120));
  }

  // The mask name without mask_layer is still refused (region edits cannot stand in for a painted mask).
  const needsLayer = await call('photocraft_edit_active', { prompt: 'Remove the text in the mask area. ' + KEEP });
  check('a mask prompt without mask_layer is refused', needsLayer.isError && needsLayer.text.includes('mask_layer is required'), needsLayer.text.slice(0, 100));

  // Accepted: forwarded with the explicit source, the mask name and the prompt unchanged.
  const beforeOk = posts.length;
  const ok = await call('photocraft_edit_active', { prompt: REMOVE_OK, mask_layer: 'Mask', source_layer: 'Layer 0' });
  const sent = posts.slice(beforeOk).find((p) => p.path === '/api/photocraft/edit-active');
  check('accepted removal reaches the panel', !ok.isError && Boolean(sent), ok.text.slice(0, 80));
  check('source_layer is forwarded explicitly', sent?.body?.sourceLayer === 'Layer 0', JSON.stringify(sent?.body?.sourceLayer));
  check('the mask layer name is forwarded', sent?.body?.maskLayer === 'Mask');
  check('the prompt is forwarded unchanged', sent?.body?.prompt === REMOVE_OK);
  check('no reference is added for a painted mask', !sent?.body?.references || sent.body.references.length === 0);

  const kitten = await call('photocraft_edit_active', {
    prompt: `Add a small black kitten in the marked area, sitting on the floor with a soft contact shadow. ${KEEP}`,
    mask_layer: 'Mask',
    source_layer: 'Layer 0',
  });
  check('an accepted addition passes the gate', !kitten.isError, kitten.text.slice(0, 80));

  // A region edit with no mask is not gated by the mask rules.
  const region = await call('photocraft_edit_active', { prompt: 'Brighten the sky. Keep everything else unchanged.', region: [0, 0, 10, 10] });
  check('a region edit is not gated as a mask edit', !region.isError, region.text.slice(0, 80));

  // egl_edit with a mask attachment: the mask is never a donor, and the gate applies.
  const beforeEdit = posts.length;
  const edit = await call('edit', {
    prompt: REMOVE_WITH_DONOR,
    init_image: 'C:/a/source.png',
    mask_image: 'C:/a/mask.png',
    images: ['C:/a/donor.png', 'C:/a/mask.png'],
  });
  const jobPost = posts.slice(beforeEdit).find((p) => p.path === '/api/jobs');
  check('egl_edit mask job starts', !edit.isError && Boolean(jobPost), edit.text.slice(0, 100));
  check('egl_edit never lists the mask as a donor', jobPost && !jobPost.body.images.includes('C:/a/mask.png'), JSON.stringify(jobPost?.body?.images));
  check('egl_edit keeps the ordinary donor', jobPost && jobPost.body.images.includes('C:/a/donor.png'));
  check('egl_edit sends the source and the mask as selectors, not donors', jobPost && jobPost.body.initImg === 'C:/a/source.png' && jobPost.body.mask === 'C:/a/mask.png');

  const badEdit = await call('edit', {
    prompt: 'Remove all text and lettering and reconstruct the background surface. ' + KEEP,
    init_image: 'C:/a/source.png',
    mask_image: 'C:/a/mask.png',
  });
  check('egl_edit applies the same prompt gate to a mask', badEdit.isError && badEdit.text.includes('limited to the marked area'), badEdit.text.slice(0, 100));

  // Multi-image edits are positional: an untagged donor is refused before it
  // reaches the panel, and image_roles is the supported alternative.
  const beforeUntagged = posts.length;
  const untagged = await call('edit', {
    prompt: REMOVE_OK,
    init_image: 'C:/a/source.png',
    mask_image: 'C:/a/mask.png',
    images: ['C:/a/donor.png'],
  });
  const untaggedSent = posts.slice(beforeUntagged).some((p) => p.path === '/api/jobs');
  check(
    'a donor without a tag is refused',
    untagged.isError && untagged.text.includes('<image2>') && !untaggedSent,
    untagged.text.slice(0, 120),
  );

  const beforeRoles = posts.length;
  const roleEdit = await call('edit', {
    prompt: REMOVE_OK,
    init_image: 'C:/a/source.png',
    mask_image: 'C:/a/mask.png',
    images: ['C:/a/donor.png'],
    image_roles: [{ index: 2, role: 'clothing_donor' }],
  });
  const rolePost = posts.slice(beforeRoles).find((p) => p.path === '/api/jobs');
  check('image_roles lets an untagged donor through', !roleEdit.isError && Boolean(rolePost), roleEdit.text.slice(0, 100));
  check('the role map is forwarded to the job', rolePost?.body?.imageRoles?.[2] === 'clothing_donor', JSON.stringify(rolePost?.body?.imageRoles));

  const beforeActive = posts.length;
  const activeUntagged = await call('photocraft_edit_active', {
    prompt: `Add the hat in the marked area. ${KEEP}`,
    mask_layer: 'Mask',
    source_layer: 'Layer 0',
    reference_images: ['C:/a/hat.png'],
  });
  const activeSent = posts.slice(beforeActive).some((p) => p.path === '/api/photocraft/edit-active');
  check(
    'edit_active rejects an untagged donor',
    activeUntagged.isError && activeUntagged.text.includes('<image2>') && !activeSent,
    activeUntagged.text.slice(0, 120),
  );

  const beforeActiveOk = posts.length;
  const activeTagged = await call('photocraft_edit_active', {
    prompt: `Add the hat from <image2> in the marked area. ${KEEP}`,
    mask_layer: 'Mask',
    source_layer: 'Layer 0',
    reference_images: ['C:/a/hat.png'],
  });
  const activePost = posts.slice(beforeActiveOk).find((p) => p.path === '/api/photocraft/edit-active');
  check('edit_active accepts a tagged donor', !activeTagged.isError && Boolean(activePost), activeTagged.text.slice(0, 100));
} catch (err) {
  console.log(`FAIL  harness error — ${err.message}`);
  failures++;
} finally {
  child.kill();
  server.close();
}

console.log(`\n${failures ? 'FAILED' : 'OK'} — ${failures} failure(s)`);
process.exit(failures ? 1 : 0);
