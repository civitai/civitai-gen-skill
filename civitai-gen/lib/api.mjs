// lib/api.mjs — Shared API infrastructure for Civitai Orchestration
//
// Used by generate.mjs, experiment.mjs, and future scripts (train.mjs, etc.)
// Provides: env loading, auth, workflow submission/polling/what-if, file downloads.
//
// Zero npm dependencies. Requires Node 18+ (native fetch).

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// ---------------------------------------------------------------------------
// Resolve skill root (parent of lib/)
// ---------------------------------------------------------------------------
const __libdir = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = join(__libdir, '..');

// ---------------------------------------------------------------------------
// .env loader (reads from skill root directory)
// ---------------------------------------------------------------------------
export function loadEnv() {
  try {
    const envPath = join(SKILL_ROOT, '.env');
    const content = readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex === -1) continue;
      const key = trimmed.slice(0, eqIndex).trim();
      const value = trimmed.slice(eqIndex + 1).trim();
      if (!process.env[key]) process.env[key] = value;
    }
  } catch {}
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
export const BASE_URL = 'https://orchestration-new.civitai.com';
export const WORKFLOWS_URL = `${BASE_URL}/v2/consumer/workflows`;
export const CIVITAI_API_URL = 'https://civitai.com/api/trpc';

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------
export function getApiKey() {
  const key = process.env.CIVITAI_API_KEY;
  if (!key) {
    process.stderr.write('Error: CIVITAI_API_KEY not set. Check .env file.\n');
    process.exit(1);
  }
  return key;
}

export function authHeaders(apiKey) {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };
}

// ---------------------------------------------------------------------------
// Workflow API
// ---------------------------------------------------------------------------
export async function apiSubmitWorkflow(apiKey, body, opts = {}) {
  const waitSec = opts.wait;
  const url = waitSec ? `${WORKFLOWS_URL}?wait=${waitSec}` : WORKFLOWS_URL;
  const res = await fetch(url, {
    method: 'POST',
    headers: authHeaders(apiKey),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Submit failed ${res.status} ${res.statusText}: ${text}`);
  }
  return res.json();
}

export async function apiWhatIf(apiKey, body) {
  const res = await fetch(`${WORKFLOWS_URL}?whatif=true`, {
    method: 'POST',
    headers: authHeaders(apiKey),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`What-if failed ${res.status} ${res.statusText}: ${text}`);
  }
  return res.json();
}

export async function apiGetWorkflow(apiKey, workflowId) {
  const url = `${WORKFLOWS_URL}/${workflowId}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Get workflow failed ${res.status}: ${text}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Blob upload — upload binary files to the orchestrator for use as inputs
// ---------------------------------------------------------------------------
const MIME_MAP = {
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
};

/**
 * Upload a file to the orchestrator blob store.
 * Returns { id, available, url, urlExpiresAt }.
 *
 * @param {string} apiKey
 * @param {string} filePath — local file path to upload
 * @returns {Promise<{id: string, available: boolean, url: string, urlExpiresAt: string}>}
 */
export async function uploadBlob(apiKey, filePath) {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  const contentType = MIME_MAP[ext];
  if (!contentType) {
    throw new Error(`Unsupported file type "${ext}". Supported: ${Object.keys(MIME_MAP).join(', ')}`);
  }

  const body = readFileSync(filePath);
  const res = await fetch(`${BASE_URL}/v2/consumer/blobs`, {
    method: 'POST',
    headers: {
      'Content-Type': contentType,
      Authorization: `Bearer ${apiKey}`,
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Blob upload failed ${res.status} ${res.statusText}: ${text}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// File download
// ---------------------------------------------------------------------------
export async function downloadFile(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed ${res.status}: ${url}`);
  const arrayBuf = await res.arrayBuffer();
  writeFileSync(destPath, Buffer.from(arrayBuf));
}

/**
 * Download multiple files with a concurrency limit.
 *
 * @param {Array<{url: string, destPath: string, filename?: string}>} items
 * @param {object} opts
 * @param {number} [opts.concurrency=5] — max parallel downloads
 * @param {boolean} [opts.quiet=false] — suppress per-file progress
 * @returns {Promise<{saved: string[], failed: number}>}
 */
export async function downloadAll(items, opts = {}) {
  const concurrency = opts.concurrency || 5;
  const quiet = opts.quiet || false;
  const saved = [];
  let failed = 0;

  const semaphore = { active: 0, queue: [] };
  function acquire() {
    return new Promise((resolve) => {
      if (semaphore.active < concurrency) {
        semaphore.active++;
        resolve();
      } else {
        semaphore.queue.push(resolve);
      }
    });
  }
  function release() {
    if (semaphore.queue.length > 0) {
      semaphore.queue.shift()();
    } else {
      semaphore.active--;
    }
  }

  await Promise.all(
    items.map(async (item) => {
      await acquire();
      try {
        await downloadFile(item.url, item.destPath);
        saved.push(item.destPath);
        if (!quiet) {
          process.stderr.write(`  Saved: ${item.filename || item.destPath}\n`);
        }
      } catch (err) {
        process.stderr.write(`  Failed: ${item.filename || item.destPath} — ${err.message}\n`);
        failed++;
      } finally {
        release();
      }
    })
  );

  return { saved, failed };
}

// ---------------------------------------------------------------------------
// Workflow polling helper
// ---------------------------------------------------------------------------
const TERMINAL_STATES = ['succeeded', 'failed', 'expired', 'canceled'];

/**
 * Poll a workflow until it reaches a terminal state or timeout.
 *
 * @param {string} apiKey
 * @param {string} workflowId
 * @param {object} opts
 * @param {number} [opts.interval=5000] — poll interval in ms
 * @param {number} [opts.timeout=600000] — max wait in ms
 * @param {function} [opts.onPoll] — callback(workflow) on each poll, for progress display
 * @returns {Promise<{workflow: object, timedOut: boolean}>}
 */
export async function pollWorkflow(apiKey, workflowId, opts = {}) {
  const interval = opts.interval || 5000;
  const timeout = opts.timeout || 600000;
  const startTime = Date.now();

  while (true) {
    await new Promise((r) => setTimeout(r, interval));

    const elapsed = Date.now() - startTime;
    if (elapsed >= timeout) {
      return { workflow: null, timedOut: true };
    }

    const workflow = await apiGetWorkflow(apiKey, workflowId);

    if (opts.onPoll) opts.onPoll(workflow);

    if (TERMINAL_STATES.includes(workflow.status)) {
      return { workflow, timedOut: false };
    }
  }
}

/**
 * Collect downloadable media from a completed workflow's steps.
 * Returns an array of download descriptors for use with downloadAll().
 *
 * @param {object} workflow — workflow response from API
 * @param {object|null} manifest — optional manifest with step labels
 * @param {object} opts
 * @param {string} [opts.outDir] — output directory for destPath
 * @param {string} [opts.format='png'] — image format extension
 * @returns {Array<{url: string, destPath: string, filename: string, mediaType: string}>}
 */
export function collectDownloads(workflow, manifest, opts = {}) {
  const outDir = opts.outDir || './output';
  const format = opts.format || 'png';
  const downloads = [];
  const steps = workflow.steps || [];

  for (let si = 0; si < steps.length; si++) {
    const step = steps[si];
    const stepLabel =
      manifest?.steps?.[si]?.label || step.metadata?.label || step.name || `step${si}`;

    // Video steps: single video blob
    if (step.$type === 'videoGen') {
      const video = step.output?.video;
      if (video?.available && video?.url) {
        const filename = `${stepLabel}.mp4`;
        downloads.push({
          url: video.url,
          filename,
          destPath: join(outDir, filename),
          stepIndex: si,
          mediaType: 'video',
        });
      }
      continue;
    }

    // Audio steps (TTS, music): audioBlob object with { id, available, url }
    if (step.$type === 'textToSpeech' || step.$type === 'aceStepAudio' || step.$type === 'yuE2') {
      const output = step.output || {};
      // audioBlob (TTS) or blob (YuE2) can be an object { id, available, url } or a direct URL string
      const blob = output.audioBlob || output.blob;
      const url = typeof blob === 'object' ? blob?.url :
                  typeof blob === 'string' ? blob :
                  output.blobUrl || output.url;
      if (url) {
        // Detect extension from blob id or URL, fallback to ogg for TTS
        const blobId = typeof blob === 'object' ? blob?.id : '';
        const extMatch = blobId?.match(/\.(ogg|mp3|wav|flac)$/i) ||
                         url?.match(/\.(ogg|mp3|wav|flac)/i);
        const ext = extMatch ? extMatch[1].toLowerCase() : (step.$type === 'textToSpeech' ? 'ogg' : 'mp3');
        const filename = `${stepLabel}.${ext}`;
        downloads.push({
          url,
          filename,
          destPath: join(outDir, filename),
          stepIndex: si,
          mediaType: 'audio',
        });
      }
      continue;
    }

    // Transcription steps: text output, no file to download — emit JSON
    if (step.$type === 'transcription') {
      continue;
    }

    // Image steps: array of image blobs
    const images = step.output?.images || [];
    for (let ii = 0; ii < images.length; ii++) {
      const img = images[ii];
      if (!img.available || !img.url) continue;

      const filename = `${stepLabel}-${ii}.${format}`;
      downloads.push({
        url: img.url,
        filename,
        destPath: join(outDir, filename),
        stepIndex: si,
        imageIndex: ii,
        mediaType: 'image',
      });
    }
  }

  return downloads;
}
