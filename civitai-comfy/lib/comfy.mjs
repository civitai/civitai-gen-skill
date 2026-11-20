// lib/comfy.mjs: pure helpers for the customComfy step (no network, no fs writes except the ledger).
// Zero npm dependencies. Node 18+.

import { readFileSync, appendFileSync, existsSync } from 'fs';

export const BUZZ_PER_SECOND = 1; // CustomComfyHandler.BuzzPerRuntimeSecond on the orchestrator
export const DEFAULT_TIMEOUT_SEC = 600; // fork 3A: 10 min per run, at most 600 Buzz
export const DEFAULT_DAILY_CAP = 2000; // fork 3A: skill-side daily cap
export const DEFAULT_COMFY_IMAGE = null; // null = the worker default (civitai-spine-comfy-cloud)

const AIR_RE = /^urn:air:[^\s]+$/i;

/** Every AIR string used as a node input in an API-format graph, deduped, in first-seen order. */
export function scanAirs(graph) {
  const seen = new Set();
  const walk = (v) => {
    if (typeof v === 'string') { if (AIR_RE.test(v)) seen.add(v); return; }
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  for (const node of Object.values(assertApiGraph(graph))) walk(node.inputs);
  return [...seen];
}

/**
 * Throws unless the graph is ComfyUI API format ({ "<id>": { class_type, inputs } }).
 * The editor's saved format ({ nodes: [...], links: [...] }) is not accepted in v1.
 */
export function assertApiGraph(graph) {
  if (!graph || typeof graph !== 'object' || Array.isArray(graph)) throw new Error('Graph must be a JSON object.');
  if (Array.isArray(graph.nodes) && Array.isArray(graph.links)) {
    throw new Error('This is the ComfyUI editor format. Export it with "Export (API)" (Save API Format) and pass that file.');
  }
  const entries = Object.entries(graph);
  if (!entries.length) throw new Error('Graph has no nodes.');
  for (const [id, node] of entries) {
    if (!node || typeof node.class_type !== 'string' || typeof node.inputs !== 'object') {
      throw new Error('Node "' + id + '" is not API format (needs class_type and inputs).');
    }
  }
  return graph;
}

/** Inputs whose value is "file:<path>": local files to upload as blobs before submit. */
export function findLocalFiles(graph) {
  const out = [];
  for (const [id, node] of Object.entries(assertApiGraph(graph))) {
    for (const [field, v] of Object.entries(node.inputs)) {
      if (typeof v === 'string' && v.startsWith('file:')) out.push({ nodeId: id, field, path: v.slice(5) });
    }
  }
  return out;
}

/** Returns a copy of the graph with {nodeId, field} -> value replacements applied. */
export function withInputs(graph, replacements) {
  const g = structuredClone(graph);
  for (const { nodeId, field, value } of replacements) {
    if (!g[nodeId]) throw new Error('No node "' + nodeId + '" in graph.');
    g[nodeId].inputs[field] = value;
  }
  return g;
}

/** "--set 12.text=hello" style overrides: [{nodeId, field, value}]; numbers and booleans are parsed. */
export function parseSet(spec) {
  const m = /^([^.=]+)\.([^=]+)=(.*)$/s.exec(spec);
  if (!m) throw new Error('Bad --set "' + spec + '": use <nodeId>.<input>=<value>');
  let value = m[3];
  if (/^-?\d+(\.\d+)?$/.test(value)) value = Number(value);
  else if (value === 'true' || value === 'false') value = value === 'true';
  return { nodeId: m[1], field: m[2], value };
}

/** Seconds -> .NET TimeSpan string the step's timeout field takes ("00:10:00"). */
export function toTimeSpan(sec) {
  if (!Number.isFinite(sec) || sec <= 0) throw new Error('Timeout must be a positive number of seconds.');
  const s = Math.ceil(sec);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const p = (n) => String(n).padStart(2, '0');
  return p(h) + ':' + p(m) + ':' + p(r);
}

/** The most a run can cost: the step timeout at the per-second rate. */
export function maxBuzzFor(timeoutSec, rate = BUZZ_PER_SECOND) {
  return Math.ceil(timeoutSec * rate);
}

/** Build the workflow body for one customComfy step. */
export function buildCustomComfyWorkflow({ graph, resources = [], timeoutSec = DEFAULT_TIMEOUT_SEC, trace, sessionId, comfyImage, minVramGb, useSageAttention, tags = [] }) {
  assertApiGraph(graph);
  const all = [...new Set([...scanAirs(graph), ...resources])];
  if (!all.length) throw new Error('customComfy needs at least one resource AIR (a model or a nodepack layer). None found in the graph; pass --resource.');
  for (const r of all) {
    if (/^urn:air:comfy:nodepack:/i.test(r)) throw new Error('Declare nodepacks by their install-layer AIR, not "' + r + '". Run: node comfy.mjs snapshot ' + r);
    if (/^urn:air:oci:image:/i.test(r)) throw new Error('A container image goes in --image, not resources: ' + r);
  }
  if (comfyImage && !/^urn:air:oci:image:ghcr:civitai\//i.test(comfyImage)) {
    throw new Error('--image must be urn:air:oci:image:ghcr:civitai/<repo>@<tag> (the server rejects other registries).');
  }
  const input = { resources: all, workflow: graph, trace: trace || 'none' };
  if (sessionId) input.sessionId = sessionId;
  if (comfyImage) input.comfyImage = comfyImage;
  if (minVramGb) input.minVramGb = minVramGb;
  if (useSageAttention) input.useSageAttention = true;
  return {
    tags: ['civitai-comfy', ...tags],
    steps: [{ $type: 'customComfy', name: 'comfy', timeout: toTimeSpan(timeoutSec), input }],
  };
}

export function buildSnapshotWorkflow({ nodepacks, comfyImage, minVramGb }) {
  if (!nodepacks?.length) throw new Error('snapshot needs at least one comfy:nodepack AIR.');
  for (const n of nodepacks) {
    if (!/^urn:air:comfy:nodepack:/i.test(n)) throw new Error('Not a comfy:nodepack AIR: ' + n);
  }
  const input = { nodepacks };
  if (comfyImage) input.comfyImage = comfyImage;
  if (minVramGb) input.minVramGb = minVramGb;
  return { tags: ['civitai-comfy', 'snapshot'], steps: [{ $type: 'comfyNodepackSnapshot', name: 'snapshot', input }] };
}

// --- nodepack layer cache: (image, pack) -> layerAir ------------------------------------------
export function layerKey(image, pack) { return (image || 'default') + ' ' + pack; }

export function resolveNodepacks(cache, image, packs) {
  const layers = [], missing = [];
  for (const p of packs) {
    const hit = cache[layerKey(image, p)];
    if (hit) layers.push(hit); else missing.push(p);
  }
  return { layers, missing };
}

// --- spend ledger (jsonl, one line per finished or submitted run) -----------------------------
export function utcDay(d = new Date()) { return d.toISOString().slice(0, 10); }

export function readLedger(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/**
 * Spend for a UTC day. A run's latest line wins: a "reserved" line (submit) is replaced by its
 * "settled" line (finished, with actual Buzz), so a crashed poll still counts the reservation.
 */
export function spentOn(entries, day = utcDay()) {
  const byWf = new Map();
  for (const e of entries) if (e.day === day) byWf.set(e.workflowId, e);
  let total = 0;
  for (const e of byWf.values()) total += e.kind === 'settled' ? e.buzz : e.reservedBuzz;
  return total;
}

export function appendLedger(path, entry) { appendFileSync(path, JSON.stringify(entry) + '\n'); }

/** Pre-submit gate. Returns {ok, reason}. */
export function checkCaps({ timeoutSec, spentToday, dailyCap = DEFAULT_DAILY_CAP, maxRunSec = DEFAULT_TIMEOUT_SEC, overCap = false }) {
  const worst = maxBuzzFor(timeoutSec);
  if (!overCap && timeoutSec > maxRunSec) {
    return { ok: false, reason: 'Timeout ' + timeoutSec + 's is over the ' + maxRunSec + 's per-run cap (up to ' + worst + ' Buzz). Pass --over-cap to allow it.' };
  }
  if (!overCap && spentToday + worst > dailyCap) {
    return { ok: false, reason: 'Today (UTC) ' + spentToday + ' Buzz spent; this run could add ' + worst + ', over the ' + dailyCap + ' daily cap. Lower --timeout or pass --over-cap.' };
  }
  return { ok: true, worst };
}

/** Actual Buzz for a finished workflow's customComfy steps (usage.estimatedCost is the billed figure). */
export function settledBuzz(workflow) {
  let buzz = 0, seconds = 0;
  for (const s of workflow.steps || []) {
    const u = s.output?.usage;
    if (u) { buzz += Math.ceil(u.estimatedCost || 0); seconds += u.runtimeSeconds || 0; }
  }
  const charged = workflow.cost?.total;
  return { buzz: Number.isFinite(charged) && charged > 0 ? charged : buzz, usageBuzz: buzz, seconds };
}

export function outputBlobs(workflow) {
  const out = [];
  for (const s of workflow.steps || []) for (const b of s.output?.blobs || []) out.push({ step: s.name, ...b });
  return out;
}
