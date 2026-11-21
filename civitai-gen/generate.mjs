#!/usr/bin/env node

// generate.mjs — Unified Civitai Orchestration CLI
//
// Subcommands:
//   wait       Submit, poll until done, then download (default for generation)
//   submit     Fire-and-forget workflow submission
//   status     Check workflow progress
//   download   Fetch completed media from a workflow
//   cost       Dry-run buzz estimation (whatif)
//   engines    List available video generation engines
//   tts        Text-to-speech generation
//   music      Sung song generation (YuE2)
//   transcribe Speech-to-text transcription (alias: stt)
//
// Domain logic split across lib/ modules:
//   lib/api.mjs   — Shared API layer (auth, workflows, downloads)
//   lib/image.mjs — Image step builder, ecosystem configs
//   lib/video.mjs — Video step builder, engine registry
//   lib/audio.mjs — TTS, music, transcription step builders
//
// Zero npm dependencies. Requires Node 18+ (native fetch).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { execFile as execFileCb, spawn } from 'child_process';
import {
  loadEnv,
  CIVITAI_API_URL,
  WORKFLOWS_URL,
  getApiKey,
  authHeaders,
  apiSubmitWorkflow,
  apiWhatIf,
  apiGetWorkflow,
  downloadFile,
  downloadAll,
  pollWorkflow,
  collectDownloads,
  uploadBlob,
} from './lib/api.mjs';
import {
  ECOSYSTEM_CONFIGS,
  DEFAULT_ECOSYSTEM,
  buildImageStep,
  detectEcosystem,
  IMAGE_ARG_HANDLERS,
  IMAGE_HELP,
} from './lib/image.mjs';
import {
  VIDEO_ENGINE_REGISTRY,
  buildVideoStep,
  VIDEO_ARG_HANDLERS,
  VIDEO_HELP,
} from './lib/video.mjs';
import {
  buildTTSStep,
  buildMusicStep,
  buildTranscriptionStep,
  AUDIO_ARG_HANDLERS,
  AUDIO_HELP,
} from './lib/audio.mjs';

loadEnv();

// ---------------------------------------------------------------------------
// Audio playback helpers
// ---------------------------------------------------------------------------
function playAudioFile(filePath) {
  return new Promise((resolve) => {
    execFileCb('ffplay', ['-nodisp', '-autoexit', '-loglevel', 'quiet', filePath], (err) => {
      if (err) {
        process.stderr.write(`  Warning: Could not play audio (ffplay not found or failed): ${err.message}\n`);
      }
      resolve();
    });
  });
}

async function playAudioFiles(files) {
  for (const f of files) {
    process.stderr.write(`  Playing: ${f}\n`);
    await playAudioFile(f);
  }
}

/**
 * Stream a URL directly to ffplay and optionally save to disk.
 * The streaming-blobs URL blocks until segments are ready, then streams in semi-realtime.
 * Returns { firstByteMs, totalMs, savedPath? }
 */
async function streamAudioUrl(url, opts = {}) {
  const { savePath, quiet } = opts;
  const t0 = performance.now();
  let firstByteMs = null;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Stream failed ${res.status}: ${url}`);

  // We need to tee the stream: one to ffplay, one to save to disk
  const reader = res.body.getReader();
  const chunks = [];

  // Spawn ffplay reading from stdin
  const ffplay = spawn('ffplay', ['-nodisp', '-autoexit', '-loglevel', 'quiet', '-i', 'pipe:0'], {
    stdio: ['pipe', 'ignore', 'ignore'],
  });

  const ffplayDone = new Promise((resolve) => {
    ffplay.on('close', resolve);
    ffplay.on('error', () => resolve());
  });

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      if (firstByteMs === null) {
        firstByteMs = Math.round(performance.now() - t0);
        if (!quiet) process.stderr.write(`  First byte: ${firstByteMs}ms\n`);
      }

      chunks.push(value);
      // Feed to ffplay
      if (!ffplay.stdin.destroyed) {
        ffplay.stdin.write(value);
      }
    }
  } finally {
    if (!ffplay.stdin.destroyed) ffplay.stdin.end();
  }

  // Save to disk if requested
  if (savePath) {
    const fullBuf = Buffer.concat(chunks);
    writeFileSync(savePath, fullBuf);
    if (!quiet) process.stderr.write(`  Saved: ${savePath} (${(fullBuf.byteLength / 1024).toFixed(1)}KB)\n`);
  }

  await ffplayDone;
  const totalMs = Math.round(performance.now() - t0);
  return { firstByteMs, totalMs, savedPath: savePath || null, size: chunks.reduce((s, c) => s + c.byteLength, 0) };
}

/**
 * Stream a URL to disk only (no playback). Measures time-to-first-byte.
 */
async function streamToFile(url, savePath, quiet) {
  const t0 = performance.now();
  let firstByteMs = null;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Stream failed ${res.status}: ${url}`);

  const reader = res.body.getReader();
  const chunks = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    if (firstByteMs === null) {
      firstByteMs = Math.round(performance.now() - t0);
      if (!quiet) process.stderr.write(`  First byte: ${firstByteMs}ms\n`);
    }
    chunks.push(value);
  }

  const fullBuf = Buffer.concat(chunks);
  writeFileSync(savePath, fullBuf);
  if (!quiet) process.stderr.write(`  Saved: ${savePath} (${(fullBuf.byteLength / 1024).toFixed(1)}KB)\n`);

  return { firstByteMs, totalMs: Math.round(performance.now() - t0), size: fullBuf.byteLength };
}

/**
 * Submit TTS with ?wait=0 and extract the streaming blob URL.
 * Returns { workflowId, streamUrl, cost, submitMs }
 */
async function submitTTSStreaming(apiKey, step) {
  const t0 = performance.now();
  const body = { tags: ['civitai', 'agent-gen', 'tts'], steps: [step] };
  const res = await fetch(WORKFLOWS_URL, {
    method: 'POST',
    headers: authHeaders(apiKey),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Submit failed ${res.status}: ${text}`);
  }
  const workflow = await res.json();
  const submitMs = Math.round(performance.now() - t0);

  // Extract streaming blob URL from the step output
  const audioStep = workflow.steps?.[0];
  const blob = audioStep?.output?.audioBlob;
  const streamUrl = typeof blob === 'object' ? blob?.url : blob;

  if (!streamUrl) {
    throw new Error('No streaming blob URL in response. Step output: ' + JSON.stringify(audioStep?.output));
  }

  return {
    workflowId: workflow.id,
    streamUrl,
    cost: workflow.cost?.total,
    submitMs,
    blobId: typeof blob === 'object' ? blob?.id : null,
  };
}

// ---------------------------------------------------------------------------
// Step dispatcher — routes to the right builder based on job type
// ---------------------------------------------------------------------------
function buildStep(job, stepIndex) {
  if (job.jobType === 'tts') return buildTTSStep(job, stepIndex);
  if (job.jobType === 'music') return buildMusicStep(job, stepIndex);
  if (job.jobType === 'transcribe') return buildTranscriptionStep(job, stepIndex);
  if (job.engine) return buildVideoStep(job, stepIndex);
  return buildImageStep(job, stepIndex);
}

function detectMediaType(steps) {
  if (steps.length === 0) return 'image';
  const type = steps[0].$type;
  if (type === 'videoGen') return 'video';
  if (type === 'textToSpeech') return 'tts';
  if (type === 'aceStepAudio' || type === 'yuE2') return 'music';
  if (type === 'transcription') return 'transcription';
  return 'image';
}

// ---------------------------------------------------------------------------
// Build job list from CLI args or bulk file
// ---------------------------------------------------------------------------
function buildJobList(opts) {
  if (opts.bulk) {
    const raw = readFileSync(resolve(opts.bulk), 'utf-8');
    const entries = JSON.parse(raw);
    if (!Array.isArray(entries)) throw new Error('Bulk file must be a JSON array');
    return entries.map((entry) => mergeJobDefaults(opts, entry));
  }

  // Audio commands use --text instead of --prompt
  if (opts.jobType === 'tts') {
    if (!opts.text) return [];
    return [mergeJobDefaults(opts, { text: opts.text })];
  }

  if (opts.jobType === 'music') {
    if (opts.prompt.length === 0) return [];
    return opts.prompt.map((p, i) => mergeJobDefaults(opts, {
      prompt: p,
      label: opts.prompt.length > 1 ? `track_${i}` : null
    }));
  }

  if (opts.jobType === 'transcribe') {
    if (!opts.mediaUrl) return [];
    return [mergeJobDefaults(opts, { mediaUrl: opts.mediaUrl })];
  }

  // Image/video: use --prompt
  if (opts.prompt.length > 0) {
    return opts.prompt.map((p, i) => mergeJobDefaults(opts, {
      prompt: p,
      label: opts.prompt.length > 1 ? `prompt_${i}` : null
    }));
  }

  return [];
}

function mergeJobDefaults(defaults, entry) {
  return {
    // Job type routing
    jobType: entry.jobType || defaults.jobType || null,
    // Common
    prompt: entry.prompt || (Array.isArray(defaults.prompt) ? defaults.prompt[0] : defaults.prompt),
    negativePrompt: entry.negativePrompt ?? defaults.negativePrompt,
    label: entry.label || null,
    name: entry.name || null,
    format: entry.format || defaults.format,
    // Image-specific
    model: entry.model || defaults.model,
    resources: entry.resources || defaults.resources,
    quantity: entry.quantity ?? defaults.quantity ?? 4,
    aspect: entry.aspect || defaults.aspect,
    resolution: entry.resolution || defaults.resolution,
    width: entry.width || defaults.width,
    height: entry.height || defaults.height,
    widthExplicit: !!(entry.width || defaults.widthExplicit),
    heightExplicit: !!(entry.height || defaults.heightExplicit),
    steps: entry.steps ?? defaults.steps,
    cfgScale: entry.cfgScale ?? defaults.cfgScale,
    scheduler: entry.scheduler ?? defaults.scheduler,
    seed: entry.seed ?? defaults.seed,
    sourceImage: entry.sourceImage || defaults.sourceImage,
    denoise: entry.denoise ?? defaults.denoise,
    // Video-specific
    engine: entry.engine || defaults.engine,
    duration: entry.duration ?? defaults.duration,
    videoAspect: entry.videoAspect || defaults.videoAspect,
    generateAudio: entry.generateAudio ?? defaults.generateAudio,
    fastMode: entry.fastMode ?? defaults.fastMode,
    version: entry.version || defaults.version,
    videoModel: entry.videoModel || defaults.videoModel,
    enablePromptEnhancer: entry.enablePromptEnhancer ?? defaults.enablePromptEnhancer,
    videoResolution: entry.videoResolution || defaults.videoResolution,
    movementAmplitude: entry.movementAmplitude || defaults.movementAmplitude,
    style: entry.style || defaults.style,
    usePro: entry.usePro ?? defaults.usePro,
    images: entry.images || defaults.images,
    engineParams: entry.engineParams || defaults.engineParams,
    // Audio-specific (TTS)
    text: entry.text || defaults.text,
    speaker: entry.speaker || defaults.speaker,
    instruct: entry.instruct || defaults.instruct,
    language: entry.language || defaults.language,
    refAudioUrl: entry.refAudioUrl || defaults.refAudioUrl,
    refText: entry.refText || defaults.refText,
    xVectorOnly: entry.xVectorOnly ?? defaults.xVectorOnly,
    // Audio-specific (Music)
    lyrics: entry.lyrics || defaults.lyrics,
    // Audio-specific (Transcription)
    mediaUrl: entry.mediaUrl || defaults.mediaUrl,
    context: entry.context || defaults.context,
    timestamps: entry.timestamps ?? defaults.timestamps,
  };
}

// ---------------------------------------------------------------------------
// Argument parsing — merges all domain arg handlers
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    command: null,
    jobType: null,
    prompt: [],
    output: null,
    // Image defaults
    model: null,
    negativePrompt: null,
    steps: null,
    cfgScale: null,
    scheduler: null,
    seed: null,
    format: 'png',
    quantity: 4,
    bulk: null,
    resources: null,
    aspect: null,
    resolution: null,
    width: null,
    height: null,
    widthExplicit: false,
    heightExplicit: false,
    sourceImage: null,
    denoise: null,
    // Workflow
    workflowId: null,
    poll: false,
    interval: 5,
    json: false,
    concurrency: 5,
    tags: [],
    quiet: false,
    timeout: 600,
    play: false,
    // Video
    engine: null,
    duration: null,
    videoAspect: null,
    generateAudio: null,
    fastMode: null,
    version: null,
    videoModel: null,
    enablePromptEnhancer: null,
    videoResolution: null,
    movementAmplitude: null,
    style: null,
    usePro: null,
    images: null,
    engineParams: null,
    // TTS
    text: null,
    speaker: null,
    instruct: null,
    language: null,
    refAudioUrl: null,
    refText: null,
    xVectorOnly: false,
    // Music
    lyrics: null,
    // Transcription / STT
    mediaUrl: null,
    mediaFile: null,   // local file path — auto-uploaded to blob
    micDuration: null,  // --mic <seconds> — record from mic first
    context: null,
    timestamps: false,
    // Upload
    uploadFiles: [],
  };

  // First arg is the command
  if (args.length > 0 && !args[0].startsWith('-')) {
    opts.command = args.shift();
  }

  // Audio subcommands set jobType and map to wait lifecycle
  if (opts.command === 'tts') {
    opts.jobType = 'tts';
    opts.command = 'wait';
  } else if (opts.command === 'music') {
    opts.jobType = 'music';
    opts.command = 'wait';
  } else if (opts.command === 'transcribe' || opts.command === 'stt') {
    opts.jobType = 'transcribe';
    opts.command = 'wait';
  }

  // Merge all arg handlers
  const allHandlers = {
    ...IMAGE_ARG_HANDLERS,
    ...VIDEO_ARG_HANDLERS,
    ...AUDIO_ARG_HANDLERS,
    // Common args handled inline
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = () => args[++i];

    // Common args
    switch (arg) {
      case '--prompt':
      case '-p':
        opts.prompt.push(next());
        continue;
      case '--output':
      case '-o':
        opts.output = next();
        continue;
      case '--bulk':
        opts.bulk = next();
        continue;
      case '--workflow-id':
      case '--id':
        opts.workflowId = next();
        continue;
      case '--poll':
        opts.poll = true;
        continue;
      case '--interval':
        opts.interval = parseInt(next(), 10);
        continue;
      case '--json':
        opts.json = true;
        continue;
      case '--concurrency':
        opts.concurrency = parseInt(next(), 10);
        continue;
      case '--tag':
        opts.tags.push(next());
        continue;
      case '--quiet':
      case '-q':
        opts.quiet = true;
        continue;
      case '--timeout':
        opts.timeout = parseInt(next(), 10);
        continue;
      case '--play':
        opts.play = true;
        continue;
      case '--file':
      case '-f':
        opts.uploadFiles.push(next());
        continue;
      case '--help':
      case '-h':
        showHelp();
        process.exit(0);
    }

    // Domain-specific args
    const handler = allHandlers[arg];
    if (handler) {
      handler(opts, next);
      continue;
    }

    // Upload command: treat non-flag args as file paths
    if (opts.command === 'upload' && !arg.startsWith('-')) {
      opts.uploadFiles.push(arg);
      continue;
    }

    // Transcribe/STT: treat non-flag args as local audio file paths
    if (opts.jobType === 'transcribe' && !arg.startsWith('-')) {
      opts.mediaFile = arg;
      continue;
    }

    process.stderr.write(`Unknown option: ${arg}\n`);
    process.exit(1);
  }

  return opts;
}

// ---------------------------------------------------------------------------
// Submit command
// ---------------------------------------------------------------------------
async function cmdSubmit(opts) {
  const apiKey = getApiKey();
  const jobs = buildJobList(opts);

  if (jobs.length === 0) {
    process.stderr.write('Error: No jobs to submit.\n');
    process.exit(1);
  }

  const steps = jobs.map((job, i) => buildStep(job, i));
  const mediaType = detectMediaType(steps);
  const isVideo = mediaType === 'video';
  const totalMedia = isVideo ? steps.length : jobs.reduce((sum, j) => sum + (j.quantity ?? 1), 0);

  if (mediaType === 'image') {
    const ecosystem = detectEcosystem(opts.model || jobs[0]?.model);
    process.stderr.write(`Ecosystem: ${ECOSYSTEM_CONFIGS[ecosystem]?.label || ecosystem}\n`);
  } else if (isVideo) {
    process.stderr.write(`Video engine: ${jobs[0]?.engine || 'unknown'}\n`);
  } else {
    process.stderr.write(`Type: ${mediaType}\n`);
  }
  process.stderr.write(`Steps: ${steps.length}\n`);

  const videoTags = isVideo ? ['vid', `engine:${jobs[0]?.engine || 'unknown'}`] : [];
  const typeTags = mediaType !== 'image' && mediaType !== 'video' ? [mediaType] : [];
  const workflowBody = {
    tags: ['civitai', 'agent-gen', ...videoTags, ...typeTags, ...(opts.tags || [])],
    steps,
  };

  process.stderr.write('Submitting workflow...\n');
  const workflow = await apiSubmitWorkflow(apiKey, workflowBody);

  const result = {
    workflowId: workflow.id,
    status: workflow.status,
    type: mediaType,
    steps: steps.length,
    cost: workflow.cost,
  };

  if (opts.output) {
    mkdirSync(opts.output, { recursive: true });
    const manifestPath = join(opts.output, 'workflow.json');
    writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          workflowId: workflow.id,
          submittedAt: new Date().toISOString(),
          type: mediaType,
          steps: jobs.map((j, i) => ({
            index: i,
            name: steps[i].name,
            label: j.label || null,
            ...(j.prompt ? { prompt: j.prompt } : {}),
            ...(j.text ? { text: j.text } : {}),
          })),
        },
        null,
        2
      )
    );
    process.stderr.write(`Manifest: ${manifestPath}\n`);
  }

  console.log(JSON.stringify(result, null, 2));
}

// ---------------------------------------------------------------------------
// Status command
// ---------------------------------------------------------------------------
function formatStepStatus(step, index) {
  const status = step.status || 'unknown';
  const jobs = step.jobs || [];
  const totalJobs = jobs.length;
  const completed = jobs.filter((j) => j.status === 'succeeded').length;
  const failed = jobs.filter((j) => j.status === 'failed').length;
  const processing = jobs.filter((j) => j.status === 'processing').length;
  const queued = totalJobs - completed - failed - processing;

  const label = step.metadata?.label || step.name || `step_${index}`;
  const progress = step.estimatedProgressRate;
  const progressStr = progress != null ? ` ${Math.round(progress * 100)}%` : '';

  const imageCount = step.output?.images?.length || 0;
  const hasVideo = step.output?.video?.available;
  const isVideoStep = step.$type === 'videoGen';
  const isAudioStep = step.$type === 'textToSpeech' || step.$type === 'aceStepAudio' || step.$type === 'yuE2';
  const isTranscription = step.$type === 'transcription';

  let line = `  [${index}] ${label}: ${status}${progressStr}`;
  if (totalJobs > 0) {
    const parts = [];
    if (completed > 0) parts.push(`${completed} done`);
    if (processing > 0) parts.push(`${processing} running`);
    if (queued > 0) parts.push(`${queued} queued`);
    if (failed > 0) parts.push(`${failed} failed`);
    line += ` (${parts.join(', ')})`;
  }
  if (imageCount > 0) line += ` [${imageCount} images]`;
  if (hasVideo) line += ` [1 video]`;
  else if (isVideoStep && !hasVideo && status === 'processing') line += ` [video]`;
  if (isAudioStep) line += ` [audio]`;
  if (isTranscription) line += ` [transcription]`;
  return line;
}

async function cmdStatus(opts) {
  const apiKey = getApiKey();
  const workflowId = opts.workflowId;
  if (!workflowId) {
    process.stderr.write('Error: --workflow-id is required for status command.\n');
    process.exit(1);
  }

  const poll = opts.poll || false;
  const interval = (opts.interval || 5) * 1000;

  let done = false;
  while (!done) {
    const workflow = await apiGetWorkflow(apiKey, workflowId);
    const steps = workflow.steps || [];

    let totalMedia = 0;
    let availableMedia = 0;
    let totalJobs = 0;
    let completedJobs = 0;
    let failedJobs = 0;
    let hasVideos = false;
    let hasAudio = false;

    for (const step of steps) {
      const imgs = step.output?.images || [];
      totalMedia += imgs.length;
      availableMedia += imgs.filter((img) => img.available && img.url).length;
      if (step.$type === 'videoGen') {
        hasVideos = true;
        totalMedia += 1;
        if (step.output?.video?.available) availableMedia += 1;
      }
      if (step.$type === 'textToSpeech' || step.$type === 'aceStepAudio' || step.$type === 'yuE2') {
        hasAudio = true;
        totalMedia += 1;
        const output = step.output || {};
        if (output.blobUrl || output.url || output.audioBlob) availableMedia += 1;
      }
      for (const job of step.jobs || []) {
        totalJobs++;
        if (job.status === 'succeeded') completedJobs++;
        if (job.status === 'failed') failedJobs++;
      }
    }

    if (opts.json) {
      const result = {
        workflowId: workflow.id,
        status: workflow.status,
        createdAt: workflow.createdAt,
        startedAt: workflow.startedAt,
        completedAt: workflow.completedAt,
        cost: workflow.cost,
        steps: steps.map((s, i) => ({
          index: i,
          name: s.name,
          type: s.$type,
          label: s.metadata?.label || null,
          status: s.status,
          progress: s.estimatedProgressRate,
          jobs: (s.jobs || []).length,
          completedJobs: (s.jobs || []).filter((j) => j.status === 'succeeded').length,
          failedJobs: (s.jobs || []).filter((j) => j.status === 'failed').length,
          images: (s.output?.images || []).filter((img) => img.available).length,
          video: s.$type === 'videoGen' ? (s.output?.video?.available ? 1 : 0) : undefined,
          audio: (s.$type === 'textToSpeech' || s.$type === 'aceStepAudio' || s.$type === 'yuE2')
            ? ((s.output?.blobUrl || s.output?.url || s.output?.audioBlob) ? 1 : 0) : undefined,
        })),
        summary: { totalJobs, completedJobs, failedJobs, totalMedia, availableMedia },
      };
      console.log(JSON.stringify(result, null, 2));
    } else {
      const lines = [];
      lines.push(`Workflow: ${workflow.id}`);
      lines.push(`Status: ${workflow.status}`);
      if (workflow.cost) {
        const buzzCost = workflow.cost.total ?? workflow.cost.base ?? 0;
        lines.push(`Cost: ${buzzCost} buzz`);
      }
      lines.push(`Steps: ${steps.length}`);
      lines.push('');

      for (let i = 0; i < steps.length; i++) {
        lines.push(formatStepStatus(steps[i], i));
      }

      lines.push('');
      const mediaLabel = hasVideos ? 'media' : hasAudio ? 'audio files' : 'images';
      lines.push(
        `Progress: ${completedJobs}/${totalJobs} jobs` +
          (failedJobs > 0 ? ` (${failedJobs} failed)` : '') +
          ` | ${availableMedia} ${mediaLabel} ready`
      );

      if (poll) {
        process.stderr.write('\x1b[2J\x1b[H');
      }
      process.stderr.write(lines.join('\n') + '\n');
    }

    const terminal = ['succeeded', 'failed', 'expired', 'canceled'];
    if (terminal.includes(workflow.status) || !poll) {
      done = true;
    } else {
      await new Promise((r) => setTimeout(r, interval));
    }
  }
}

// ---------------------------------------------------------------------------
// Download command
// ---------------------------------------------------------------------------
async function cmdDownload(opts) {
  const apiKey = getApiKey();
  const workflowId = opts.workflowId;
  if (!workflowId) {
    process.stderr.write('Error: --workflow-id is required for download command.\n');
    process.exit(1);
  }

  const outDir = opts.output || './output';
  mkdirSync(outDir, { recursive: true });

  const workflow = await apiGetWorkflow(apiKey, workflowId);

  let manifest = null;
  const manifestPath = join(outDir, 'workflow.json');
  if (existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    } catch {}
  }

  const downloads = collectDownloads(workflow, manifest, {
    outDir,
    format: opts.format || 'png',
  });

  // For transcription workflows, output the text directly
  const transcriptionResults = [];
  for (const step of workflow.steps || []) {
    if (step.$type === 'transcription' && step.output) {
      transcriptionResults.push({
        stepIndex: step.metadata?.stepIndex,
        text: step.output.text || '',
        segments: step.output.segments || [],
      });
    }
  }

  if (downloads.length === 0 && transcriptionResults.length === 0) {
    process.stderr.write('No media available for download.\n');
    console.log(JSON.stringify({ success: true, images: [], videos: [], audio: [], transcriptions: [], failed: 0 }));
    return;
  }

  let saved = [];
  let failed = 0;

  if (downloads.length > 0) {
    process.stderr.write(`Downloading ${downloads.length} file(s)...\n`);
    const result = await downloadAll(downloads, {
      concurrency: opts.concurrency || 5,
    });
    saved = result.saved;
    failed = result.failed;
  }

  console.log(
    JSON.stringify({
      success: failed === 0,
      images: saved.filter((p) => !p.endsWith('.mp4') && !p.endsWith('.wav') && !p.endsWith('.mp3') && !p.endsWith('.ogg') && !p.endsWith('.flac')),
      videos: saved.filter((p) => p.endsWith('.mp4')),
      audio: saved.filter((p) => p.endsWith('.wav') || p.endsWith('.mp3') || p.endsWith('.ogg') || p.endsWith('.flac')),
      transcriptions: transcriptionResults,
      // Remote CDN download URLs, parallel to the local paths above. Pass one to
      // the Civitai MCP create_post tool's images[].url. See docs/posting.md.
      remoteUrls: downloads.map((d) => ({
        url: d.url,
        type: d.mediaType,
        path: d.destPath,
      })),
      failed,
      total: downloads.length,
    })
  );
}

// ---------------------------------------------------------------------------
// STT pre-flight — mic recording and local file upload
// ---------------------------------------------------------------------------
async function sttPreflight(opts) {
  if (opts.jobType !== 'transcribe') return;

  const apiKey = getApiKey();

  // --mic: record from microphone using ffmpeg
  if (opts.micDuration && !opts.mediaFile && !opts.mediaUrl) {
    const duration = opts.micDuration;
    const tmpPath = join(resolve('.'), `.mic-recording-${Date.now()}.mp3`);
    process.stderr.write(`Recording from microphone for ${duration}s...\n`);

    await new Promise((resolve, reject) => {
      // Use dshow on Windows, alsa on Linux, avfoundation on macOS
      const platform = process.platform;
      let inputArgs;
      if (platform === 'win32') {
        inputArgs = ['-f', 'dshow', '-i', 'audio=default'];
      } else if (platform === 'darwin') {
        inputArgs = ['-f', 'avfoundation', '-i', ':default'];
      } else {
        inputArgs = ['-f', 'alsa', '-i', 'default'];
      }

      const ffmpeg = spawn('ffmpeg', [
        ...inputArgs,
        '-t', String(duration),
        '-ar', '16000', '-ac', '1',
        '-c:a', 'libmp3lame', '-q:a', '2',
        '-y', tmpPath,
      ], { stdio: ['ignore', 'pipe', 'pipe'] });

      let stderr = '';
      ffmpeg.stderr.on('data', (d) => { stderr += d; });
      ffmpeg.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg mic recording failed (code ${code}): ${stderr.slice(-500)}`));
      });
    });

    process.stderr.write(`Recorded to ${tmpPath}\n`);
    opts.mediaFile = tmpPath;
    opts._cleanupMicFile = tmpPath;
  }

  // --media-file or positional: upload local file to blob, set mediaUrl
  if (opts.mediaFile && !opts.mediaUrl) {
    let filePath = resolve(opts.mediaFile);
    if (!existsSync(filePath)) {
      process.stderr.write(`Error: File not found: ${filePath}\n`);
      process.exit(1);
    }

    // Auto-convert WAV to MP3 (blob API rejects WAV with 415)
    const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
    let convertedPath = null;
    if (ext === '.wav') {
      convertedPath = filePath.replace(/\.wav$/i, '.mp3');
      process.stderr.write(`Converting WAV to MP3...\n`);
      await new Promise((res, rej) => {
        const ff = spawn('ffmpeg', ['-i', filePath, '-c:a', 'libmp3lame', '-q:a', '2', '-y', convertedPath],
          { stdio: ['ignore', 'pipe', 'pipe'] });
        ff.on('close', (code) => code === 0 ? res() : rej(new Error(`ffmpeg conversion failed (${code})`)));
      });
      filePath = convertedPath;
    }

    process.stderr.write(`Uploading ${filePath}...\n`);
    const blob = await uploadBlob(apiKey, filePath);
    process.stderr.write(`  Blob ID: ${blob.id}\n`);
    opts.mediaUrl = blob.url;

    // Clean up temp files
    const { unlinkSync } = await import('fs');
    if (convertedPath) try { unlinkSync(convertedPath); } catch {}
    if (opts._cleanupMicFile) try { unlinkSync(opts._cleanupMicFile); } catch {}
  }
}

// ---------------------------------------------------------------------------
// Wait command — submit + poll + download in one shot
// ---------------------------------------------------------------------------
async function cmdWait(opts) {
  const startTime = Date.now();
  const apiKey = getApiKey();

  // STT: handle mic recording and local file upload before building jobs
  await sttPreflight(opts);

  const jobs = buildJobList(opts);
  const quiet = opts.quiet || false;
  const timeoutSec = opts.timeout ?? 600;

  if (jobs.length === 0) {
    const hint = opts.jobType === 'tts' ? '--text' :
                 opts.jobType === 'transcribe' ? '--media-url, --media-file, --mic, or a file path' : '--prompt or --bulk';
    process.stderr.write(`Error: No jobs to submit. Provide ${hint}.\n`);
    process.exit(1);
  }

  const steps = jobs.map((job, i) => buildStep(job, i));
  const mediaType = detectMediaType(steps);
  const isVideo = mediaType === 'video';
  const isAudio = mediaType === 'tts' || mediaType === 'music';
  const isTranscription = mediaType === 'transcription';
  const totalMedia = isVideo ? steps.length :
                     isAudio ? steps.length :
                     isTranscription ? steps.length :
                     jobs.reduce((sum, j) => sum + (j.quantity ?? 1), 0);

  if (mediaType === 'image') {
    const ecosystem = detectEcosystem(opts.model || jobs[0]?.model);
    process.stderr.write(`Ecosystem: ${ECOSYSTEM_CONFIGS[ecosystem]?.label || ecosystem}\n`);
  } else if (isVideo) {
    const engineName = jobs[0]?.engine || 'unknown';
    const reg = VIDEO_ENGINE_REGISTRY[engineName];
    process.stderr.write(`Video engine: ${reg?.label || engineName}\n`);
  } else {
    process.stderr.write(`Type: ${mediaType}\n`);
  }
  process.stderr.write(`Steps: ${steps.length}\n`);

  // ---------------------------------------------------------------------------
  // Streaming TTS fast-path: submit with no wait, stream blob URL immediately.
  // This gives us audio playback as fast as possible (sub-second first-byte).
  // ---------------------------------------------------------------------------
  if (mediaType === 'tts' && steps.length === 1) {
    const outDir = opts.output || './output';
    const absOutDir = resolve(outDir);
    mkdirSync(absOutDir, { recursive: true });

    process.stderr.write('Submitting (streaming mode)...\n');
    const { workflowId, streamUrl, cost, submitMs, blobId } = await submitTTSStreaming(apiKey, steps[0]);
    process.stderr.write(`Workflow ID: ${workflowId}\n`);
    process.stderr.write(`Submit: ${submitMs}ms\n`);
    if (cost) process.stderr.write(`Cost: ${cost} buzz\n`);

    // Detect extension from blob ID
    const extMatch = blobId?.match(/\.(ogg|mp3|wav|flac)$/i);
    const ext = extMatch ? extMatch[1].toLowerCase() : 'ogg';
    const label = jobs[0].label || 'step_0';
    const filename = `${label}.${ext}`;
    const savePath = join(absOutDir, filename);

    let streamResult;
    if (opts.play) {
      process.stderr.write(`Streaming to ffplay + saving to ${filename}...\n`);
      streamResult = await streamAudioUrl(streamUrl, { savePath, quiet });
    } else {
      process.stderr.write(`Streaming to ${filename}...\n`);
      streamResult = await streamToFile(streamUrl, savePath, quiet);
    }

    const durationSec = Math.round((Date.now() - startTime) / 1000);
    const summary = {
      workflowId,
      status: 'succeeded',
      type: mediaType,
      streaming: true,
      totalMedia: 1,
      downloadedMedia: 1,
      failedDownloads: 0,
      outputDir: absOutDir,
      images: [],
      videos: [],
      audio: [savePath],
      transcriptions: [],
      duration: durationSec,
      timing: {
        submitMs,
        firstByteMs: streamResult.firstByteMs,
        totalStreamMs: streamResult.totalMs,
      },
      cost: cost || null,
    };
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
    return;
  }

  const videoTags = isVideo ? ['vid', `engine:${jobs[0]?.engine || 'unknown'}`] : [];
  const typeTags = mediaType !== 'image' && mediaType !== 'video' ? [mediaType] : [];
  const workflowBody = {
    tags: ['civitai', 'agent-gen', ...videoTags, ...typeTags, ...(opts.tags || [])],
    steps,
  };

  // Audio/transcription workflows use synchronous ?wait=N instead of async polling.
  // The Civitai API requires this for TTS, music, and transcription step types.
  const useSyncWait = isAudio || isTranscription;

  process.stderr.write('Submitting workflow...\n');
  const workflow = await apiSubmitWorkflow(apiKey, workflowBody, useSyncWait ? { wait: 60 } : {});
  const workflowId = workflow.id;
  process.stderr.write(`Workflow ID: ${workflowId}\n`);
  process.stderr.write(`Status: ${workflow.status}\n`);
  if (workflow.cost) {
    process.stderr.write(`Cost: ${workflow.cost.total ?? workflow.cost.base ?? '?'} buzz\n`);
  }

  const outDir = opts.output || './output';
  const absOutDir = resolve(outDir);
  mkdirSync(absOutDir, { recursive: true });
  const manifestPath = join(absOutDir, 'workflow.json');
  writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        workflowId,
        submittedAt: new Date().toISOString(),
        type: mediaType,
        steps: jobs.map((j, i) => ({
          index: i,
          name: steps[i].name,
          label: j.label || null,
          ...(j.prompt ? { prompt: j.prompt } : {}),
          ...(j.text ? { text: j.text } : {}),
          ...(j.mediaUrl ? { mediaUrl: j.mediaUrl } : {}),
        })),
        totalMedia,
      },
      null,
      2
    )
  );

  let finalWorkflow;

  if (useSyncWait) {
    // Synchronous wait: the POST with ?wait=N already returned the completed workflow.
    // If it's not in a terminal state yet, poll for the remainder.
    const terminal = ['succeeded', 'failed', 'expired', 'canceled'];
    if (terminal.includes(workflow.status)) {
      finalWorkflow = workflow;
    } else {
      process.stderr.write('Waiting for completion...\n');
      const { workflow: polled, timedOut: to } = await pollWorkflow(apiKey, workflowId, {
        interval: 3000,
        timeout: timeoutSec * 1000,
      });
      if (to) {
        const durationSec = Math.round((Date.now() - startTime) / 1000);
        process.stderr.write(`Timeout: workflow did not complete within ${timeoutSec}s.\n`);
        const summary = {
          workflowId, status: 'timeout', type: mediaType, totalMedia,
          downloadedMedia: 0, failedDownloads: 0, outputDir: absOutDir,
          images: [], videos: [], audio: [], transcriptions: [],
          duration: durationSec, cost: null,
          error: `Workflow did not complete. Check: node generate.mjs status --workflow-id ${workflowId} --json`,
        };
        process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
        process.exit(1);
      }
      finalWorkflow = polled;
    }
  } else {
    // Async workflow: poll until done
    const onPoll = quiet
      ? undefined
      : (wf) => {
          const wfSteps = wf.steps || [];
          let completedJobs = 0;
          let totalJobs = 0;
          for (const step of wfSteps) {
            for (const job of step.jobs || []) {
              totalJobs++;
              if (job.status === 'succeeded' || job.status === 'failed') completedJobs++;
            }
          }
          process.stderr.write(`  Progress: ${completedJobs}/${totalJobs} jobs | status: ${wf.status}\n`);
        };

    const { workflow: polled, timedOut } = await pollWorkflow(apiKey, workflowId, {
      interval: (opts.interval || 5) * 1000,
      timeout: timeoutSec * 1000,
      onPoll,
    });

    if (timedOut) {
      const durationSec = Math.round((Date.now() - startTime) / 1000);
      process.stderr.write(`Timeout: workflow did not complete within ${timeoutSec}s.\n`);
      const summary = {
        workflowId, status: 'timeout', type: mediaType, totalMedia,
        downloadedMedia: 0, failedDownloads: 0, outputDir: absOutDir,
        images: [], videos: [], audio: [], transcriptions: [],
        duration: durationSec, cost: null,
        error: `Workflow did not complete within ${timeoutSec}s. Check: node generate.mjs status --workflow-id ${workflowId} --json`,
      };
      process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
      process.exit(1);
    }

    finalWorkflow = polled;
  }

  const durationSec = Math.round((Date.now() - startTime) / 1000);
  process.stderr.write(`Workflow ${finalWorkflow.status}. Processing output...\n`);

  // Collect downloads
  let manifest = null;
  if (existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    } catch {}
  }

  const downloads = collectDownloads(finalWorkflow, manifest, {
    outDir: absOutDir,
    format: opts.format || 'png',
  });

  // Collect transcription results
  const transcriptionResults = [];
  for (const step of finalWorkflow.steps || []) {
    if (step.$type === 'transcription' && step.output) {
      transcriptionResults.push({
        stepIndex: step.metadata?.stepIndex,
        text: step.output.text || '',
        segments: step.output.segments || [],
      });
    }
  }

  let savedPaths = [];
  let failedDownloadCount = 0;

  if (downloads.length > 0) {
    process.stderr.write(`Downloading ${downloads.length} file(s)...\n`);
    const result = await downloadAll(downloads, {
      concurrency: opts.concurrency || 5,
      quiet,
    });
    savedPaths = result.saved;
    failedDownloadCount = result.failed;
  } else if (transcriptionResults.length === 0) {
    process.stderr.write('No media available for download.\n');
  }

  const summary = {
    workflowId,
    status: finalWorkflow.status,
    type: mediaType,
    totalMedia,
    downloadedMedia: savedPaths.length,
    failedDownloads: failedDownloadCount,
    outputDir: absOutDir,
    images: savedPaths.filter((p) => !p.endsWith('.mp4') && !p.endsWith('.wav') && !p.endsWith('.mp3') && !p.endsWith('.ogg') && !p.endsWith('.flac')),
    videos: savedPaths.filter((p) => p.endsWith('.mp4')),
    audio: savedPaths.filter((p) => p.endsWith('.wav') || p.endsWith('.mp3') || p.endsWith('.ogg') || p.endsWith('.flac')),
    transcriptions: transcriptionResults,
    // Remote CDN download URLs for each media item (parallel to the local paths
    // above). These are real https URLs on Civitai's CDN — hand one straight to
    // the Civitai MCP `create_post` tool's images[].url to post without any
    // manual upload. See docs/posting.md.
    remoteUrls: downloads.map((d) => ({
      url: d.url,
      type: d.mediaType,
      path: d.destPath,
    })),
    duration: durationSec,
    cost: finalWorkflow.cost || null,
  };
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');

  // Play audio files if --play flag is set
  if (opts.play && summary.audio.length > 0) {
    await playAudioFiles(summary.audio);
  }
}

// ---------------------------------------------------------------------------
// Cost command — dry-run to estimate buzz cost
// ---------------------------------------------------------------------------
async function cmdCost(opts) {
  const apiKey = getApiKey();
  const jobs = buildJobList(opts);

  if (jobs.length === 0) {
    const hint = opts.jobType === 'tts' ? '--text' :
                 opts.jobType === 'transcribe' ? '--media-url, --media-file, --mic, or a file path' : '--prompt or --bulk';
    process.stderr.write(`Error: No jobs to estimate. Provide ${hint}.\n`);
    process.exit(1);
  }

  const steps = jobs.map((job, i) => buildStep(job, i));
  const mediaType = detectMediaType(steps);
  const isVideo = mediaType === 'video';
  const totalMedia = isVideo ? steps.length :
                     (mediaType === 'tts' || mediaType === 'music' || mediaType === 'transcription') ? steps.length :
                     jobs.reduce((sum, j) => sum + (j.quantity ?? 1), 0);

  const workflowBody = { steps };

  process.stderr.write('Estimating cost (dry run)...\n');
  const result = await apiWhatIf(apiKey, workflowBody);

  const cost = result.cost || {};
  const transactions = result.transactions || {};

  let ready = true;
  for (const step of result.steps || []) {
    for (const job of step.jobs || []) {
      if (job.queuePosition?.support !== 'available') ready = false;
    }
  }

  const output = {
    type: mediaType,
    steps: steps.length,
    totalMedia,
    cost: {
      total: cost.total ?? 0,
      base: cost.base ?? 0,
      factors: cost.factors || {},
    },
    insufficientBuzz: transactions.insufficientBuzz ?? false,
    ready,
  };

  if (!opts.json) {
    process.stderr.write(`\n  ${totalMedia} ${mediaType} item(s) across ${steps.length} step(s)\n`);
    process.stderr.write(`  Estimated cost: ${cost.total ?? 0} buzz\n`);
    if (cost.factors) {
      const factorParts = Object.entries(cost.factors)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ');
      if (factorParts) process.stderr.write(`  Factors: ${factorParts}\n`);
    }
    if (transactions.insufficientBuzz) {
      process.stderr.write(`  WARNING: Insufficient buzz balance!\n`);
    }
    process.stderr.write(`  Queue: ${ready ? 'ready' : 'may have wait times'}\n\n`);
  }

  console.log(JSON.stringify(output, null, 2));
}

// ---------------------------------------------------------------------------
// Upload command — upload files to the orchestrator blob store
// ---------------------------------------------------------------------------
async function cmdUpload(opts) {
  const apiKey = getApiKey();
  const files = opts.uploadFiles || [];

  // Collect files from positional args or --file flags
  if (files.length === 0) {
    process.stderr.write('Error: No files to upload. Usage: node generate.mjs upload <file1> [file2] ...\n');
    process.stderr.write('Supported: .mp3, .ogg, .wav, .flac, .png, .jpg, .webp, .mp4\n');
    process.exit(1);
  }

  const results = [];
  for (const filePath of files) {
    process.stderr.write(`Uploading ${filePath}...\n`);
    try {
      const blob = await uploadBlob(apiKey, filePath);
      process.stderr.write(`  Blob ID: ${blob.id}\n`);
      process.stderr.write(`  URL: ${blob.url}\n`);
      results.push({ file: filePath, ...blob });
    } catch (err) {
      process.stderr.write(`  Failed: ${err.message}\n`);
      results.push({ file: filePath, error: err.message });
    }
  }

  process.stdout.write(JSON.stringify(results, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Engines command — dynamic engine discovery
// ---------------------------------------------------------------------------
async function cmdEngines(opts) {
  const apiKey = getApiKey();

  process.stderr.write('Fetching available video engines...\n');
  let liveEngines = [];
  try {
    const res = await fetch(`${CIVITAI_API_URL}/generation.getGenerationEngines`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (res.ok) {
      const data = await res.json();
      liveEngines = data?.result?.data?.json || [];
    }
  } catch (err) {
    process.stderr.write(`Warning: Could not fetch live engine status: ${err.message}\n`);
  }

  const engines = [];
  const seenEngines = new Set();

  for (const [engineId, reg] of Object.entries(VIDEO_ENGINE_REGISTRY)) {
    seenEngines.add(engineId);
    const live = liveEngines.find((e) => e.engine === engineId);
    const available = live ? (!live.disabled && live.status !== 'disabled') : null;

    engines.push({
      engine: engineId,
      label: reg.label,
      available,
      status: live?.status || null,
      message: live?.message || null,
      processes: reg.processes,
      durations: reg.durations,
      aspectRatios: reg.aspectRatios,
      defaults: reg.defaults,
      features: reg.features || [],
      ...(reg.models ? { models: reg.models } : {}),
      ...(reg.versions ? { versions: reg.versions } : {}),
      ...(reg.resolutions ? { resolutions: reg.resolutions } : {}),
      ...(reg.notes ? { notes: reg.notes } : {}),
    });
  }

  for (const live of liveEngines) {
    if (seenEngines.has(live.engine)) continue;
    if (live.engine === 'civitai') continue;
    engines.push({
      engine: live.engine,
      label: live.engine,
      available: !live.disabled && live.status !== 'disabled',
      status: live.status || null,
      message: live.message || null,
      processes: ['txt2vid'],
      durations: [],
      aspectRatios: [],
      defaults: {},
      features: [],
      _note: 'Engine not in local registry — params may vary.',
    });
  }

  if (opts.json) {
    console.log(JSON.stringify({ engines }, null, 2));
  } else {
    const lines = ['Video Generation Engines', ''];
    for (const e of engines) {
      const statusIcon = e.available === true ? '[OK]' : e.available === false ? '[OFF]' : '[?]';
      lines.push(`${statusIcon} ${e.engine} — ${e.label}`);
      if (e.message) lines.push(`     Note: ${e.message}`);
      if (e.processes.length > 0) lines.push(`     Processes: ${e.processes.join(', ')}`);
      if (e.durations.length > 0) lines.push(`     Durations: ${e.durations.join(', ')}s`);
      if (e.aspectRatios.length > 0) lines.push(`     Aspects: ${e.aspectRatios.join(', ')}`);
      if (e.features?.length > 0) lines.push(`     Features: ${e.features.join(', ')}`);
      lines.push('');
    }
    process.stderr.write(lines.join('\n') + '\n');
    console.log(JSON.stringify({ engines }, null, 2));
  }
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------
function showHelp() {
  const text = `
generate.mjs — Unified Civitai Orchestration CLI

PHILOSOPHY
  Civitai generation is extremely cheap. Generating 4 images costs the same as 1
  on most models. Default quantity is 4 to encourage exploration. Use -n 1 only
  when you specifically need a single image.

COMMANDS
  wait       Submit, poll until done, then download (default / all-in-one)
  submit     Submit a workflow and get a workflow ID back immediately
  status     Check the status of a running workflow
  download   Download completed media from a workflow
  cost       Dry-run: estimate buzz cost without spending (what-if)
  engines    List available video generation engines with capabilities
  tts        Text-to-speech synthesis (maps to wait lifecycle)
  music      Sung song generation via YuE2 (maps to wait lifecycle). Never ACE Step.
  transcribe Speech-to-text transcription (alias: stt, maps to wait lifecycle)
${IMAGE_HELP}${VIDEO_HELP}${AUDIO_HELP}
STATUS
  --workflow-id <id>     Workflow ID to check
  --poll                 Keep polling until workflow completes
  --interval <sec>       Poll interval in seconds (default: 5)
  --json                 Output status as JSON

WAIT (additional flags)
  --quiet / -q           Suppress per-poll progress lines (agent-friendly)
  --timeout <sec>        Timeout in seconds (default: 600)
  --play                 Play audio files after download (requires ffplay)

DOWNLOAD
  --workflow-id <id>     Workflow ID to download from
  --output / -o <dir>    Where to save media
  --format <png|jpeg>    Image format (default: png; videos always .mp4)
  --concurrency <num>    Parallel downloads (default: 5)

COMMON
  --prompt <text>        Text prompt (repeatable for multiple workflow steps)
  --bulk <file.json>     JSON array of job definitions
  --output / -o <dir>    Output directory (saves manifest + media)
  --tag <name>           Additional workflow tag (repeatable)

EXAMPLES
  # Image generation (default: wait = submit + poll + download)
  node generate.mjs wait --prompt "A cat at sunset" -o ./out

  # Multiple prompts as separate workflow steps (all concurrent)
  node generate.mjs wait --prompt "A cat" --prompt "A dog" -o ./out

  # Video generation with VEO 3
  node generate.mjs wait --engine veo3 --prompt "A robot walking" -o ./out

  # Text-to-speech with built-in speaker
  node generate.mjs tts --text "Hello world" --speaker Chelsie -o ./out

  # TTS with style instruction
  node generate.mjs tts --text "Welcome to Civitai" --speaker dylan \\
    --instruct "cheerful and enthusiastic" -o ./out

  # TTS with voice cloning from reference audio
  node generate.mjs tts --text "Cloned voice" --ref-audio "https://..." -o ./out

  # Music generation
  node generate.mjs music --prompt "upbeat electronic dance track" \\
    --duration 30 -o ./out

  # Transcription (from URL, local file, or mic)
  node generate.mjs transcribe --media-url "https://example.com/audio.mp3" -o ./out
  node generate.mjs stt recording.mp3 -o ./out
  node generate.mjs stt --mic 10 -o ./out

  # Estimate cost before spending (works for all types)
  node generate.mjs cost --prompt "A cat" -n 100
  node generate.mjs cost --engine veo3 --prompt "A robot" --duration 8

  # List available video engines
  node generate.mjs engines

  # Agent-friendly: quiet mode outputs clean JSON summary
  node generate.mjs wait --prompt "A cat" --quiet -o ./out
`.trimStart();
  console.log(text);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const opts = parseArgs(process.argv);

  if (!opts.command) {
    showHelp();
    process.exit(0);
  }

  try {
    switch (opts.command) {
      case 'submit':
        await cmdSubmit(opts);
        break;
      case 'status':
        await cmdStatus(opts);
        break;
      case 'download':
        await cmdDownload(opts);
        break;
      case 'wait':
        await cmdWait(opts);
        break;
      case 'engines':
        await cmdEngines(opts);
        break;
      case 'cost':
      case 'whatif':
      case 'estimate':
        await cmdCost(opts);
        break;
      case 'upload':
        await cmdUpload(opts);
        break;
      default:
        process.stderr.write(`Unknown command: ${opts.command}\n`);
        showHelp();
        process.exit(1);
    }
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(1);
  }
}

main();
