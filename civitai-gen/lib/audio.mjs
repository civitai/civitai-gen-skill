// lib/audio.mjs — Audio step builders: TTS, music generation, transcription
//
// Exports: buildTTSStep, buildMusicStep, buildTranscriptionStep,
//          AUDIO_ARG_HANDLERS, AUDIO_HELP
//
// Zero npm dependencies. Requires Node 18+.

// ---------------------------------------------------------------------------
// TTS — Text-to-Speech via Qwen TTS
// ---------------------------------------------------------------------------

// Two modes:
// 1. CustomVoice — use a built-in speaker name (e.g. "Chelsie", "dylan")
// 2. Base — voice cloning from a reference audio file

export function buildTTSStep(job, stepIndex) {
  if (!job.text) throw new Error('TTS requires --text');

  const input = {
    text: job.text,
    language: job.language || 'English',
  };

  if (job.refAudioUrl) {
    // Base mode: voice cloning
    input.refAudioUrl = job.refAudioUrl;
    if (job.refText) input.refText = job.refText;
    if (job.xVectorOnly) input.xVectorOnlyMode = true;
  } else {
    // CustomVoice mode: built-in speaker
    if (!job.speaker) throw new Error('TTS requires --speaker (built-in voice name) or --ref-audio (voice cloning)');
    input.speaker = job.speaker;
    if (job.instruct) input.instruct = job.instruct;
  }

  return {
    $type: 'textToSpeech',
    name: job.name || `step_${stepIndex}`,
    metadata: {
      stepIndex,
      ...(job.label ? { label: job.label } : {}),
    },
    input,
  };
}

// ---------------------------------------------------------------------------
// Music — YuE2 sung songs. Always YuE2, never ACE Step: YuE2's songs are far better.
// ---------------------------------------------------------------------------

export function buildMusicStep(job, stepIndex) {
  if (!job.prompt) throw new Error('Music generation requires --prompt');

  // YuE2 wants lyrics with [verse]/[chorus]/[outro] headers, one sung line per line; [instrumental] for no vocals.
  const input = {
    style: job.prompt,
    lyrics: job.lyrics || '[instrumental]',
    seed: job.seed ?? Math.floor(Math.random() * 2 ** 31),
    maxDuration: Math.min(120, Math.max(10, Number(job.duration ?? 90))),
    mode: 'full',
  };

  return {
    $type: 'yuE2',
    name: job.name || `step_${stepIndex}`,
    metadata: {
      stepIndex,
      ...(job.label ? { label: job.label } : {}),
    },
    input,
  };
}

// ---------------------------------------------------------------------------
// Transcription — Speech-to-text / ASR
// ---------------------------------------------------------------------------

export function buildTranscriptionStep(job, stepIndex) {
  if (!job.mediaUrl) throw new Error('Transcription requires --media-url');

  const input = {
    mediaUrl: job.mediaUrl,
  };

  if (job.language) input.language = job.language;
  if (job.context) input.context = job.context;
  if (job.timestamps) input.returnTimeStamps = true;

  return {
    $type: 'transcription',
    name: job.name || `step_${stepIndex}`,
    metadata: {
      stepIndex,
      ...(job.label ? { label: job.label } : {}),
    },
    input,
  };
}

// ---------------------------------------------------------------------------
// Audio-specific CLI arg extensions
// ---------------------------------------------------------------------------
export const AUDIO_ARG_HANDLERS = {
  // TTS
  '--text': (opts, next) => { opts.text = next(); },
  '--speaker': (opts, next) => { opts.speaker = next(); },
  '--instruct': (opts, next) => { opts.instruct = next(); },
  '--language': (opts, next) => { opts.language = next(); },
  '--ref-audio': (opts, next) => { opts.refAudioUrl = next(); },
  '--ref-text': (opts, next) => { opts.refText = next(); },
  '--x-vector-only': (opts) => { opts.xVectorOnly = true; },
  // Music
  '--lyrics': (opts, next) => { opts.lyrics = next(); },
  // Transcription / STT
  '--media-url': (opts, next) => { opts.mediaUrl = next(); },
  '--media-file': (opts, next) => { opts.mediaFile = next(); },
  '--mic': (opts, next) => {
    const val = next();
    opts.micDuration = val ? parseInt(val, 10) : 10;
  },
  '--context': (opts, next) => { opts.context = next(); },
  '--timestamps': (opts) => { opts.timestamps = true; },
};

export const AUDIO_HELP = `
TEXT-TO-SPEECH (tts)
  --text <text>          Text to synthesize into speech (required)
  --speaker <name>       Built-in speaker name (e.g. "Chelsie", "dylan")
  --instruct <text>      Style/tone instruction (e.g. "cheerful and enthusiastic")
  --language <lang>      Language (default: English)
  --ref-audio <url>      Reference audio URL for voice cloning (Base mode)
  --ref-text <text>      Transcript of reference audio (improves cloning quality)
  --x-vector-only        Use speaker embedding only (no ref transcript needed)

MUSIC GENERATION (music)
  --prompt <text>        Text description of the music to generate (required)
  --lyrics <text>        Structured lyrics for the song
  --duration <sec>       Duration in seconds
  --model <air>          Model identifier (AIR format)

TRANSCRIPTION / STT (transcribe, stt)
  --media-url <url>      URL or AIR URN of audio/media file
  --media-file <path>    Local audio file (auto-uploaded to blob)
  --mic <seconds>        Record from microphone first (default: 10s)
  --language <lang>      Language hint (e.g. "en") — improves accuracy
  --context <text>       Context about the audio (e.g. "Technical podcast")
  --timestamps           Return word-level timestamps
  Positional args are treated as local file paths for transcription.
`;
