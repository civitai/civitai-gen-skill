#!/usr/bin/env node
// civitai-comfy: run raw ComfyUI graphs on Civitai's orchestrator (customComfy step).
// Nothing runs locally. Zero npm dependencies. Node 18+.

import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'fs';
import { join, dirname, extname } from 'path';
import { fileURLToPath } from 'url';
import {
  BASE_URL, WORKFLOWS_URL, authHeaders, apiSubmitWorkflow, apiWhatIf, apiGetWorkflow, uploadBlob, downloadFile,
} from '../civitai-gen/lib/api.mjs';
import {
  DEFAULT_TIMEOUT_SEC, DEFAULT_DAILY_CAP, scanAirs, findLocalFiles, withInputs, parseSet, buildCustomComfyWorkflow,
  buildSnapshotWorkflow, resolveNodepacks, layerKey, readLedger, spentOn, appendLedger, utcDay, checkCaps,
  settledBuzz, outputBlobs, maxBuzzFor,
} from './lib/comfy.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(ROOT, '.env');
const LEDGER = join(ROOT, 'ledger.jsonl');
const CACHE = join(ROOT, 'nodepack-cache.json');
const TERMINAL = ['succeeded', 'failed', 'expired', 'canceled'];

// The skill's own key (fork 2A). It is never printed. The shared civitai-gen key is not used.
function loadKey() {
  if (!process.env.CIVITAI_COMFY_API_KEY && existsSync(ENV_PATH)) {
    for (const line of readFileSync(ENV_PATH, 'utf-8').split('\n')) {
      const m = /^\s*CIVITAI_COMFY_API_KEY\s*=\s*(.+?)\s*$/.exec(line);
      if (m) process.env.CIVITAI_COMFY_API_KEY = m[1];
    }
  }
  const k = process.env.CIVITAI_COMFY_API_KEY;
  if (!k) die('CIVITAI_COMFY_API_KEY is not set. Store it with: node comfy.mjs key < keyfile (or pipe it in).');
  return k;
}

function die(msg, code = 1) { process.stderr.write('Error: ' + msg + '\n'); process.exit(code); }
function log(...a) { process.stderr.write(a.join(' ') + '\n'); }
function out(obj) { process.stdout.write(JSON.stringify(obj, null, 2) + '\n'); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const pos = [], o = { resource: [], set: [], nodepack: [], tag: [] };
  const multi = new Set(['resource', 'set', 'nodepack', 'tag']);
  const flags = new Set(['dry', 'over-cap', 'no-wait', 'sage', 'json', 'help', 'follow', 'raw']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-o') { o.out = argv[++i]; continue; }
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (flags.has(k)) { o[k] = true; continue; }
      const v = argv[++i];
      if (v === undefined) die('--' + k + ' needs a value');
      if (multi.has(k)) o[k].push(v); else o[k] = v;
      continue;
    }
    pos.push(a);
  }
  return { pos, o };
}

function readCache() { return existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf-8')) : {}; }

async function cancelWorkflow(key, id) {
  const res = await fetch(WORKFLOWS_URL + '/' + id, { method: 'PUT', headers: authHeaders(key), body: JSON.stringify({ status: 'canceled' }) });
  return res.status;
}

/** Poll to a terminal state; tails the trace blob when there is one. */
async function follow(key, id, { tail = false, intervalMs = 4000 } = {}) {
  let printed = 0, last = '';
  while (true) {
    const wf = await apiGetWorkflow(key, id);
    const step = wf.steps?.[0];
    const line = wf.status + (step?.output?.usage ? ' runtime ' + Math.round(step.output.usage.runtimeSeconds) + 's ~' + Math.ceil(step.output.usage.estimatedCost) + ' Buzz' : '');
    if (line !== last) { log('[' + new Date().toISOString().slice(11, 19) + '] ' + line); last = line; }
    const traceUrl = step?.output?.traceUrl;
    if (tail && traceUrl) {
      try {
        const r = await fetch(traceUrl, { headers: printed ? { Range: 'bytes=' + printed + '-' } : {} });
        if (r.ok || r.status === 206) {
          const t = await r.text();
          const fresh = r.status === 206 ? t : t.slice(printed);
          if (fresh) { process.stderr.write(fresh); printed += Buffer.byteLength(fresh); }
        }
      } catch {}
    }
    if (TERMINAL.includes(wf.status)) return wf;
    await sleep(intervalMs);
  }
}

async function downloadBlobs(wf, dir) {
  mkdirSync(dir, { recursive: true });
  const files = [];
  for (const b of outputBlobs(wf)) {
    if (!b.url) { log('blob ' + b.id + ' has no url (available=' + b.available + (b.blockedReason ? ', blocked: ' + b.blockedReason : '') + ')'); continue; }
    const ext = extname(b.id) ? '' : (extname(new URL(b.url).pathname) || '.' + (b.type || 'bin'));
    const dest = join(dir, b.id + ext);
    await downloadFile(b.url, dest);
    files.push(dest);
  }
  return files;
}

function settle(wf) {
  const s = settledBuzz(wf);
  appendLedger(LEDGER, { kind: 'settled', day: utcDay(), workflowId: wf.id, status: wf.status, buzz: s.buzz, seconds: s.seconds, at: new Date().toISOString() });
  return s;
}

// ---------------------------------------------------------------------------------------------
async function cmdRun(pos, o) {
  const file = pos[0] || die('usage: node comfy.mjs run <graph.api.json> [options]');
  let graph = JSON.parse(readFileSync(file, 'utf-8'));
  graph = withInputs(graph, o.set.map(parseSet));
  const timeoutSec = Number(o.timeout || DEFAULT_TIMEOUT_SEC);
  const dailyCap = Number(process.env.CIVITAI_COMFY_DAILY_CAP || DEFAULT_DAILY_CAP);

  const cache = readCache();
  const { layers, missing } = resolveNodepacks(cache, o.image || null, o.nodepack);
  if (missing.length) die('No cached install layer for: ' + missing.join(', ') + '. Run: node comfy.mjs snapshot ' + missing.join(' ') + (o.image ? ' --image ' + o.image : ''));

  const locals = findLocalFiles(graph);
  const body0 = { graph, resources: [...o.resource, ...layers], timeoutSec, trace: o.trace, sessionId: o.session, comfyImage: o.image, minVramGb: o['min-vram'] ? Number(o['min-vram']) : undefined, useSageAttention: o.sage, tags: o.tag };

  if (o.dry) {
    // Validate locally, then ask the server (whatif quotes 0 for customComfy; it still validates the body).
    const body = buildCustomComfyWorkflow({ ...body0, graph: withInputs(graph, locals.map((l) => ({ ...l, value: 'https://example.invalid/' + l.path }))) });
    if (locals.length) log('dry: ' + locals.length + ' local file(s) would be uploaded: ' + locals.map((l) => l.path).join(', '));
    log('dry: resources = ' + body.steps[0].input.resources.join(', '));
    log('dry: worst case ' + maxBuzzFor(timeoutSec) + ' Buzz (timeout ' + timeoutSec + 's at 1 Buzz/s)');
    if (o.json) out(body);
    const key = loadKey();
    try { const w = await apiWhatIf(key, body); log('whatif: accepted (quoted ' + (w.cost?.total ?? 0) + ' Buzz; customComfy is billed on runtime after the run)'); }
    catch (e) { die('whatif rejected: ' + e.message); }
    return;
  }

  const spentToday = spentOn(readLedger(LEDGER));
  const gate = checkCaps({ timeoutSec, spentToday, dailyCap, overCap: o['over-cap'] });
  if (!gate.ok) die(gate.reason);

  const key = loadKey();
  const uploads = [];
  for (const l of locals) {
    const blob = await uploadBlob(key, l.path);
    log('uploaded ' + l.path + ' -> ' + blob.id);
    // The worker mounts declared resources and rewrites their AIRs to file paths; a URL in LoadImage is rejected by ComfyUI.
    uploads.push({ ...l, value: 'urn:air:other:other:orchestrator:blob@' + blob.id });
  }
  const body = buildCustomComfyWorkflow({ ...body0, graph: withInputs(graph, uploads) });
  const sub = await apiSubmitWorkflow(key, body);
  appendLedger(LEDGER, { kind: 'reserved', day: utcDay(), workflowId: sub.id, reservedBuzz: gate.worst, at: new Date().toISOString() });
  log('workflow ' + sub.id + ' submitted (worst case ' + gate.worst + ' Buzz; ' + spentToday + ' spent today of ' + dailyCap + ')');
  if (o['no-wait']) { out({ workflowId: sub.id }); return; }

  let stopping = false;
  process.on('SIGINT', async () => {
    if (stopping) process.exit(130);
    stopping = true; log('\ncanceling ' + sub.id + ' ...');
    log('cancel -> HTTP ' + (await cancelWorkflow(key, sub.id)));
  });
  const wf = await follow(key, sub.id, { tail: !!o.trace && o.trace !== 'none' });
  const s = settle(wf);
  const files = wf.status === 'succeeded' && o.out ? await downloadBlobs(wf, o.out) : [];
  out({ workflowId: wf.id, status: wf.status, runtimeSeconds: Math.round(s.seconds), buzz: s.buzz, files, blobs: outputBlobs(wf).map((b) => ({ id: b.id, type: b.type, url: b.url })), traceUrl: wf.steps?.[0]?.output?.traceUrl ?? null });
  if (wf.status !== 'succeeded') process.exitCode = 2;
}

async function cmdSnapshot(pos, o) {
  if (!pos.length) die('usage: node comfy.mjs snapshot <urn:air:comfy:nodepack:...> [...] [--image AIR]');
  const key = loadKey();
  const body = buildSnapshotWorkflow({ nodepacks: pos, comfyImage: o.image, minVramGb: o['min-vram'] ? Number(o['min-vram']) : undefined });
  if (o.dry) { if (o.json) out(body); const w = await apiWhatIf(key, body); log('whatif: quoted ' + (w.cost?.total ?? 0) + ' Buzz'); return; }
  const sub = await apiSubmitWorkflow(key, body);
  appendLedger(LEDGER, { kind: 'reserved', day: utcDay(), workflowId: sub.id, reservedBuzz: sub.cost?.total ?? 0, at: new Date().toISOString() });
  log('snapshot workflow ' + sub.id);
  const wf = await follow(key, sub.id);
  settle(wf);
  if (wf.status !== 'succeeded') { out(wf.steps?.[0] ?? wf); die('snapshot ' + wf.status, 2); }
  const cache = readCache();
  const results = wf.steps[0].output?.results ?? [];
  for (const r of results) cache[layerKey(o.image || null, r.nodepack)] = r.layerAir;
  writeFileSync(CACHE, JSON.stringify(cache, null, 2));
  out(results.map((r) => ({ nodepack: r.nodepack, layerAir: r.layerAir, objectInfo: r.objectInfo?.url ?? null })));
}

async function cmdStatus(pos, o) {
  const id = pos[0] || die('usage: node comfy.mjs status <workflowId> [--follow]');
  const key = loadKey();
  const wf = o.follow ? await follow(key, id, { tail: true }) : await apiGetWorkflow(key, id);
  const st = wf.steps?.[0];
  if (o.raw) { const c = structuredClone(wf); for (const s of c.steps || []) if (s.input) s.input.workflow = '<graph omitted>'; out(c); return; }
  out({ id: wf.id, status: wf.status, step: st?.status, usage: st?.output?.usage ?? null, blobs: outputBlobs(wf).length, traceUrl: st?.output?.traceUrl ?? null });
}

async function cmdDownload(pos, o) {
  const id = pos[0] || die('usage: node comfy.mjs download <workflowId> -o <dir>');
  const key = loadKey();
  const wf = await apiGetWorkflow(key, id);
  if (TERMINAL.includes(wf.status) && !readLedger(LEDGER).some((e) => e.workflowId === id && e.kind === 'settled')) settle(wf);
  out({ status: wf.status, files: await downloadBlobs(wf, o.out || '.') });
}

async function cmdCancel(pos) {
  const id = pos[0] || die('usage: node comfy.mjs cancel <workflowId>');
  const status = await cancelWorkflow(loadKey(), id);
  out({ id, http: status });
  if (status >= 300) process.exitCode = 1;
}

function cmdAirs(pos) {
  const file = pos[0] || die('usage: node comfy.mjs airs <graph.api.json>');
  const g = JSON.parse(readFileSync(file, 'utf-8'));
  out({ resources: scanAirs(g), localFiles: findLocalFiles(g) });
}

function cmdSpend(pos, o) {
  const entries = readLedger(LEDGER);
  const day = o.day || utcDay();
  const cap = Number(process.env.CIVITAI_COMFY_DAILY_CAP || DEFAULT_DAILY_CAP);
  out({ day, spent: spentOn(entries, day), cap, runs: entries.filter((e) => e.day === day) });
}

async function cmdKey() {
  // Reads the key from stdin and writes .env (mode 600). The key is never echoed.
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const k = Buffer.concat(chunks).toString('utf-8').trim();
  if (!k || /\s/.test(k)) die('Pipe exactly one key on stdin.');
  writeFileSync(ENV_PATH, 'CIVITAI_COMFY_API_KEY=' + k + '\n', { mode: 0o600 });
  try { chmodSync(ENV_PATH, 0o600); } catch {}
  log('Stored key (' + k.length + ' chars) in ' + ENV_PATH);
}

const HELP = 'civitai-comfy: raw ComfyUI graphs on Civitai (customComfy). See SKILL.md.\n' +
  '  run <graph.api.json> [-o dir] [--set id.input=v]... [--resource AIR]... [--nodepack AIR]...\n' +
  '      [--timeout sec (600)] [--trace logs|binary] [--session id] [--image AIR] [--min-vram GB] [--sage]\n' +
  '      [--dry [--json]] [--no-wait] [--over-cap] [--tag t]\n' +
  '  snapshot <nodepack AIR>... [--image AIR] [--dry]\n' +
  '  status <id> [--follow] | download <id> -o dir | cancel <id>\n' +
  '  airs <graph.api.json> | spend [--day YYYY-MM-DD] | key  (key from stdin)\n';

const [cmd, ...rest] = process.argv.slice(2);
const { pos, o } = parseArgs(rest);
const cmds = { run: cmdRun, snapshot: cmdSnapshot, status: cmdStatus, download: cmdDownload, cancel: cmdCancel, airs: cmdAirs, spend: cmdSpend, key: cmdKey };
if (!cmd || cmd === 'help' || o.help || !cmds[cmd]) { process.stdout.write(HELP); process.exit(cmd && !cmds[cmd] && cmd !== 'help' ? 1 : 0); }
Promise.resolve(cmds[cmd](pos, o)).catch((e) => die(e.message));
