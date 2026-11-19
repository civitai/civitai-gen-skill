import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, cpSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  scanAirs, assertApiGraph, findLocalFiles, withInputs, parseSet, toTimeSpan, buildCustomComfyWorkflow,
  buildSnapshotWorkflow, resolveNodepacks, layerKey, spentOn, checkCaps, settledBuzz,
} from '../lib/comfy.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL = join(HERE, '..');
const example = JSON.parse(readFileSync(join(SKILL, 'examples/upscale-remacri.api.json'), 'utf-8'));
const REMACRI = 'urn:air:other:upscaler:civitai:147759@164821';

test('scanAirs finds the model AIR and nothing else', () => {
  assert.deepEqual(scanAirs(example), [REMACRI]);
});

test('editor-format graphs are refused with a hint', () => {
  assert.throws(() => assertApiGraph({ nodes: [], links: [] }), /Export \(API\)/);
  assert.throws(() => assertApiGraph({ 1: { inputs: {} } }), /not API format/);
});

test('local files and overrides', () => {
  assert.deepEqual(findLocalFiles(example), [{ nodeId: '1', field: 'image', path: './input.png' }]);
  const g = withInputs(example, [parseSet('4.filename_prefix=x'), parseSet('1.image=https://a/b.png')]);
  assert.equal(g[4].inputs.filename_prefix, 'x');
  assert.equal(example[4].inputs.filename_prefix, 'upscaled', 'original untouched');
  assert.deepEqual(parseSet('5.steps=20'), { nodeId: '5', field: 'steps', value: 20 });
  assert.throws(() => withInputs(example, [{ nodeId: '99', field: 'a', value: 1 }]), /No node "99"/);
});

test('timeouts', () => {
  assert.equal(toTimeSpan(600), '00:10:00');
  assert.equal(toTimeSpan(3725), '01:02:05');
  assert.throws(() => toTimeSpan(0));
});

test('customComfy body shape', () => {
  const b = buildCustomComfyWorkflow({ graph: example, timeoutSec: 120, trace: 'logs', sessionId: 's1' });
  const s = b.steps[0];
  assert.equal(s.$type, 'customComfy');
  assert.equal(s.timeout, '00:02:00');
  assert.deepEqual(s.input.resources, [REMACRI]);
  assert.equal(s.input.trace, 'logs');
  assert.equal(s.input.sessionId, 's1');
  assert.equal(s.input.workflow, example);
  assert.ok(!('comfyImage' in s.input));
});

test('customComfy body guards mirror the server', () => {
  const noAir = { 1: { class_type: 'EmptyImage', inputs: { width: 8 } } };
  assert.throws(() => buildCustomComfyWorkflow({ graph: noAir }), /at least one resource/);
  assert.throws(() => buildCustomComfyWorkflow({ graph: example, resources: ['urn:air:comfy:nodepack:comfyregistry:a/b@1'] }), /install-layer/);
  assert.throws(() => buildCustomComfyWorkflow({ graph: example, resources: ['urn:air:oci:image:ghcr:civitai/x@1'] }), /--image/);
  assert.throws(() => buildCustomComfyWorkflow({ graph: example, comfyImage: 'urn:air:oci:image:dockerhub:me/x@1' }), /ghcr:civitai/);
  buildCustomComfyWorkflow({ graph: example, comfyImage: 'urn:air:oci:image:ghcr:civitai/civitai-spine-comfy@v2.5.5' });
});

test('snapshot body + layer cache', () => {
  const pack = 'urn:air:comfy:nodepack:comfyregistry:kijai/comfyui-kjnodes@1.4.0';
  assert.equal(buildSnapshotWorkflow({ nodepacks: [pack] }).steps[0].$type, 'comfyNodepackSnapshot');
  assert.throws(() => buildSnapshotWorkflow({ nodepacks: [REMACRI] }), /nodepack AIR/);
  const cache = { [layerKey(null, pack)]: 'urn:air:comfy:nodepacklayer:x' };
  assert.deepEqual(resolveNodepacks(cache, null, [pack]), { layers: ['urn:air:comfy:nodepacklayer:x'], missing: [] });
  assert.deepEqual(resolveNodepacks(cache, 'urn:air:oci:image:ghcr:civitai/other@1', [pack]).missing, [pack], 'layers are per image');
});

test('ledger: settled replaces reserved; other days ignored', () => {
  const e = [
    { kind: 'reserved', day: '2026-11-19', workflowId: 'a', reservedBuzz: 600 },
    { kind: 'settled', day: '2026-11-19', workflowId: 'a', buzz: 43 },
    { kind: 'reserved', day: '2026-11-19', workflowId: 'b', reservedBuzz: 120 },
    { kind: 'settled', day: '2026-11-18', workflowId: 'c', buzz: 999 },
  ];
  assert.equal(spentOn(e, '2026-11-19'), 163);
});

test('caps', () => {
  assert.equal(checkCaps({ timeoutSec: 600, spentToday: 0 }).ok, true);
  assert.match(checkCaps({ timeoutSec: 601, spentToday: 0 }).reason, /per-run cap/);
  assert.match(checkCaps({ timeoutSec: 600, spentToday: 1500 }).reason, /daily cap/);
  assert.equal(checkCaps({ timeoutSec: 600, spentToday: 1400 }).ok, true);
  assert.equal(checkCaps({ timeoutSec: 3600, spentToday: 1900, overCap: true }).ok, true);
});

test('settledBuzz prefers the charged total, falls back to usage', () => {
  const steps = [{ output: { usage: { estimatedCost: 42.2, runtimeSeconds: 42 } } }];
  assert.equal(settledBuzz({ cost: { total: 50 }, steps }).buzz, 50);
  assert.equal(settledBuzz({ cost: { total: 0 }, steps }).buzz, 43);
});

// --- CLI against a fake orchestrator (no network, no key) -------------------------------------
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'cc-'));
  cpSync(join(SKILL, '..', 'civitai-gen', 'lib'), join(root, 'civitai-gen', 'lib'), { recursive: true });
  mkdirSync(join(root, 'civitai-comfy'));
  for (const f of ['comfy.mjs', 'lib', 'examples', 'test']) cpSync(join(SKILL, f), join(root, 'civitai-comfy', f), { recursive: true });
  writeFileSync(join(root, 'input.png'), Buffer.from([137, 80, 78, 71]));
  return root;
}
function cli(root, args, env = {}) {
  const r = spawnSync(process.execPath, ['--import', join(root, 'civitai-comfy/test/fake-orchestrator.mjs'), join(root, 'civitai-comfy/comfy.mjs'), ...args], {
    cwd: root, encoding: 'utf-8', env: { PATH: process.env.PATH, CIVITAI_COMFY_API_KEY: 'fake-key', FAKE_LOG: join(root, 'requests.jsonl'), ...env },
  });
  const reqs = existsSync(join(root, 'requests.jsonl')) ? readFileSync(join(root, 'requests.jsonl'), 'utf-8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  return { ...r, reqs };
}

test('CLI run: uploads the local file, submits customComfy, downloads, records spend', () => {
  const root = sandbox();
  const r = cli(root, ['run', 'civitai-comfy/examples/upscale-remacri.api.json', '--timeout', '120', '-o', 'out']);
  assert.equal(r.status, 0, r.stderr);
  const res = JSON.parse(r.stdout);
  assert.equal(res.status, 'succeeded');
  assert.equal(res.buzz, 43);
  assert.ok(existsSync(join(root, 'out', 'out-1.png')));
  const submit = r.reqs.find((q) => q.method === 'POST' && q.url.endsWith('/v2/consumer/workflows'));
  const step = submit.body.steps[0];
  assert.equal(step.$type, 'customComfy');
  assert.equal(step.timeout, '00:02:00');
  assert.equal(step.input.workflow['1'].inputs.image, 'https://blobs.fake/blob-in.png', 'file: input replaced by the blob url');
  assert.deepEqual(step.input.resources, [REMACRI]);
  assert.ok(r.reqs.some((q) => q.url.endsWith('/v2/consumer/blobs')));
  const spend = JSON.parse(cli(root, ['spend']).stdout);
  assert.equal(spend.spent, 43);
  rmSync(root, { recursive: true, force: true });
});

test('CLI run: cap refusal happens before any request', () => {
  const root = sandbox();
  const r = cli(root, ['run', 'civitai-comfy/examples/upscale-remacri.api.json', '--timeout', '900']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /per-run cap/);
  assert.equal(r.reqs.length, 0);
  const r2 = cli(root, ['run', 'civitai-comfy/examples/upscale-remacri.api.json'], { CIVITAI_COMFY_DAILY_CAP: '500' });
  assert.match(r2.stderr, /daily cap/);
  rmSync(root, { recursive: true, force: true });
});

test('CLI run: failed workflow exits 2 and still records spend', () => {
  const root = sandbox();
  const r = cli(root, ['run', 'civitai-comfy/examples/upscale-remacri.api.json', '--timeout', '60'], { FAKE_FAIL: '1' });
  assert.equal(r.status, 2, r.stderr);
  assert.equal(JSON.parse(r.stdout).status, 'failed');
  assert.equal(JSON.parse(cli(root, ['spend']).stdout).spent, 43);
  rmSync(root, { recursive: true, force: true });
});

test('CLI dry run: whatif only, no upload, no submit; server 400 surfaces', () => {
  const root = sandbox();
  const r = cli(root, ['run', 'civitai-comfy/examples/upscale-remacri.api.json', '--dry']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /whatif: accepted/);
  assert.deepEqual(r.reqs.map((q) => q.method + ' ' + q.url.replace(/^https:\/\/[^/]+/, '')), ['POST /v2/consumer/workflows?whatif=true']);
  const bad = cli(root, ['run', 'civitai-comfy/examples/upscale-remacri.api.json', '--dry'], { FAKE_WHATIF_400: '1' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /whatif rejected: What-if failed 400/);
  rmSync(root, { recursive: true, force: true });
});

test('CLI snapshot caches the layer; run --nodepack then uses it', () => {
  const root = sandbox();
  const pack = 'urn:air:comfy:nodepack:comfyregistry:kijai/comfyui-kjnodes@1.4.0';
  const miss = cli(root, ['run', 'civitai-comfy/examples/upscale-remacri.api.json', '--nodepack', pack, '--timeout', '60']);
  assert.match(miss.stderr, /No cached install layer/);
  const s = cli(root, ['snapshot', pack], { FAKE_SNAPSHOT: '1' });
  assert.equal(s.status, 0, s.stderr);
  const r = cli(root, ['run', 'civitai-comfy/examples/upscale-remacri.api.json', '--nodepack', pack, '--timeout', '60']);
  assert.equal(r.status, 0, r.stderr);
  const submit = r.reqs.filter((q) => q.method === 'POST' && q.url.endsWith('/v2/consumer/workflows')).pop();
  assert.ok(submit.body.steps[0].input.resources.includes('urn:air:comfy:nodepacklayer:comfyregistry:kijai/comfyui-kjnodes@1.4.0+abc'));
  rmSync(root, { recursive: true, force: true });
});

test('CLI without a key refuses to call the API', () => {
  const root = sandbox();
  const r = cli(root, ['status', 'wf-1'], { CIVITAI_COMFY_API_KEY: '' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /CIVITAI_COMFY_API_KEY is not set/);
  assert.equal(r.reqs.length, 0);
  rmSync(root, { recursive: true, force: true });
});
