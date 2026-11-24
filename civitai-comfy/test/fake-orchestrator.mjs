// Preload for tests: replaces fetch with a fake orchestrator. Records requests to FAKE_LOG.
import { appendFileSync } from 'fs';
const log = (o) => process.env.FAKE_LOG && appendFileSync(process.env.FAKE_LOG, JSON.stringify(o) + '\n');
let polls = 0;
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, init = {}) => {
  url = String(url); const method = init.method || 'GET';
  let body = init.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch {} } else if (body) body = '<' + body.length + ' bytes>';
  log({ method, url, body });
  if (url.endsWith('/v2/consumer/blobs')) return json(200, { id: 'blob-in', available: true, url: 'https://blobs.fake/blob-in.png' });
  if (url.includes('/v2/consumer/workflows?whatif=true')) {
    if (process.env.FAKE_WHATIF_400) return json(400, { errors: { resources: ['bad'] } });
    return json(200, { cost: { total: 0 } });
  }
  if (method === 'POST' && /\/v2\/consumer\/workflows$/.test(url)) return json(200, { id: 'wf-1', status: 'unassigned' });
  if (method === 'PUT') return json(200, {});
  if (/\/v2\/consumer\/workflows\/wf-1$/.test(url)) {
    polls++;
    const done = polls >= 2;
    const status = done ? (process.env.FAKE_FAIL ? 'failed' : 'succeeded') : 'processing';
    const isSnap = process.env.FAKE_SNAPSHOT;
    const output = isSnap
      ? { results: [{ nodepack: 'urn:air:comfy:nodepack:comfyregistry:kijai/comfyui-kjnodes@1.4.0', layerAir: 'urn:air:comfy:nodepacklayer:comfyregistry:kijai/comfyui-kjnodes@1.4.0+abc', objectInfo: { url: 'https://blobs.fake/oi.json' } }] }
      : { blobs: done ? [{ id: 'out-1', type: 'image', available: true, url: 'https://blobs.fake/out-1.png' }] : [], tempBlobs: [], usage: { buzzPerSecond: 1, runtimeSeconds: done ? 42.3 : 10, estimatedCost: done ? 43 : 10, computedAt: new Date().toISOString() } };
    return json(200, { id: 'wf-1', status, cost: { total: done ? 43 : 0 }, steps: [{ name: 'comfy', status, output }] });
  }
  if (url.startsWith('https://blobs.fake/')) return new Response(new Uint8Array([137, 80, 78, 71]), { status: 200 });
  return json(404, { url });
};
