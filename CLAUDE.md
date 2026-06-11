# civitai-gen Developer Guide

This file is for agents working on the skill itself. If you're just using the skill, see SKILL.md.

**Keep this file updated** when you add, move, or change files.

## Architecture

```
civitai-gen/
├── lib/
│   ├── api.mjs             # Shared API layer (auth, workflows, downloads)
│   ├── image.mjs            # Image step builder, ecosystem configs, AIR URN parsing
│   ├── video.mjs            # Video step builder, engine registry
│   └── audio.mjs            # TTS, music (ACE Step), transcription step builders
├── docs/
│   ├── engines.md           # Engine catalog + model selection (two-path model)
│   ├── tts.md               # TTS parameter reference (for agents)
│   ├── music.md             # Music generation reference (for agents)
│   └── transcription.md     # Transcription reference (for agents)
├── test/
│   └── smoke-test.mjs       # Smoke tests (--readonly for 0 buzz, full ~16 buzz)
├── generate.mjs              # Unified CLI — thin dispatcher over lib/ modules
├── experiment.mjs            # Wildcard expansion, wraps generate.mjs via child_process
├── wildcards/                # Pre-built wildcard files (.txt, .json)
├── SKILL.md                  # User-facing docs — lean router to domain docs
├── CLAUDE.md                 # This file (developer guide)
└── .env                      # API key (CIVITAI_API_KEY)
```

## Module Responsibilities

### lib/api.mjs — Shared API Layer

Domain-agnostic infrastructure shared by all generation types.

| Export | Description |
|--------|-------------|
| `loadEnv()` | Reads `.env` from skill root into `process.env` |
| `BASE_URL` | Orchestrator base URL |
| `WORKFLOWS_URL` | Workflow submission endpoint |
| `CIVITAI_API_URL` | Civitai tRPC API base URL |
| `getApiKey()` | Returns `CIVITAI_API_KEY` or exits |
| `authHeaders(apiKey)` | Returns `{ Authorization, Content-Type }` headers |
| `apiSubmitWorkflow(apiKey, body)` | POST workflow, returns workflow object |
| `apiWhatIf(apiKey, body)` | POST workflow with `?whatif=true`, returns cost estimate |
| `apiGetWorkflow(apiKey, workflowId)` | GET workflow status |
| `downloadFile(url, destPath)` | Download a single file |
| `downloadAll(items, opts)` | Download multiple files with concurrency limit |
| `pollWorkflow(apiKey, workflowId, opts)` | Poll until terminal state or timeout |
| `collectDownloads(workflow, manifest, opts)` | Extract downloadable media (images, videos, audio) from workflow response |

### lib/image.mjs — Image Generation

| Export | Description |
|--------|-------------|
| `ECOSYSTEM_CONFIGS` | Aspect ratio presets per base model (SD1.5, SDXL, Flux, etc.) |
| `DEFAULT_ECOSYSTEM` | Default ecosystem (`flux1`) |
| `RESOLUTION_MULTIPLIERS` | Scale factors: small (0.75x), medium (1.0x), large (1.5x) |
| `buildImageStep(job, index)` | Builds `$type: 'textToImage'` workflow step |
| `detectEcosystem(modelUrn)` | Detect ecosystem from AIR URN |
| `parseResources(resourceStr)` | Parse comma-separated LoRA/embedding AIR URNs |
| `resolveDimensions(opts)` | Resolve width/height from aspect + ecosystem + resolution |
| `parseAirUrn(urn)` | Parse AIR URN into components |
| `IMAGE_ARG_HANDLERS` | CLI arg handler map for image-specific flags |
| `IMAGE_HELP` | Help text for image generation flags |

### lib/video.mjs — Video Generation

| Export | Description |
|--------|-------------|
| `VIDEO_ENGINE_REGISTRY` | Static capabilities for 11 video engines |
| `buildVideoStep(job, index)` | Builds `$type: 'videoGen'` workflow step |
| `VIDEO_ARG_HANDLERS` | CLI arg handler map for video-specific flags |
| `VIDEO_HELP` | Help text for video generation flags |

### lib/audio.mjs — Audio: TTS, Music, Transcription

| Export | Description |
|--------|-------------|
| `buildTTSStep(job, index)` | Builds `$type: 'textToSpeech'` workflow step |
| `buildMusicStep(job, index)` | Builds `$type: 'aceStepAudio'` workflow step |
| `buildTranscriptionStep(job, index)` | Builds `$type: 'transcription'` workflow step |
| `AUDIO_ARG_HANDLERS` | CLI arg handler map for audio-specific flags |
| `AUDIO_HELP` | Help text for audio flags |

### generate.mjs — Unified CLI Dispatcher

**Subcommands:** wait, submit, status, download, cost, engines, tts, music, transcribe (alias: stt)

The CLI is a thin orchestrator. Domain logic lives in `lib/` modules:

1. `parseArgs()` merges arg handlers from all domains (`IMAGE_ARG_HANDLERS`, `VIDEO_ARG_HANDLERS`, `AUDIO_ARG_HANDLERS`)
2. Audio subcommands (`tts`, `music`, `transcribe`) set `opts.jobType` and remap to the `wait` lifecycle
3. `buildStep()` dispatches to the right builder based on `job.jobType` or `job.engine`
4. `detectMediaType()` determines output type from step `$type` for status/download logic
5. `collectDownloads()` (in api.mjs) handles images, videos, and audio blob outputs

### experiment.mjs — Wildcard Expansion

Wraps generate.mjs via `child_process.execFile`. Does not import from it directly.
Handles template expansion (product, zip, random modes), wildcard resolution, and meaningful file naming.

## Canonical Documentation

Civitai now ships official developer docs — prefer these over reverse-engineering:

- **Docs site:** <https://developer.civitai.com>
- **LLM index:** <https://developer.civitai.com/llms.txt> (all pages, link list)
- **Recipes** (per-engine parameters, kept in sync with the live API): <https://developer.civitai.com/orchestration/recipes>
- **Official MCP server:** <https://developer.civitai.com/orchestration/mcp> — an alternative to this CLI for MCP-capable hosts. This skill remains the CLI path for agents.
- **Site API** (browse models/images): <https://developer.civitai.com/site> — wrapped by the **Civitai MCP server** (`https://mcp.civitai.com/mcp`).

> "Recipes" ≠ workflow job types. A recipe is a per-model parameter guide; a job type is a `$type` workflow step (see table below). One job type (e.g. `videoGen`) covers many recipes (wan, kling, veo3, …).

Model/checkpoint/LoRA discovery is **delegated to the Civitai MCP server** (`search_models` / `get_model` / `get_model_version` at `https://mcp.civitai.com/mcp`) — do not duplicate search here.

## Orchestrator API

- **Base URL:** `https://orchestration-new.civitai.com`
- **Submit:** `POST /v2/consumer/workflows` with `{ tags, steps }` body
- **Status:** `GET /v2/consumer/workflows/{id}`
- **What-if:** `POST /v2/consumer/workflows?whatif=true` (dry run, no buzz spent)
- **Auth:** `Authorization: Bearer {CIVITAI_API_KEY}`
- **Engine discovery:** `POST https://civitai.com/api/trpc/generation.getGenerationEngines`

### Supported Workflow Step Types

| `$type` | Builder | Module |
|---------|---------|--------|
| `textToImage` | `buildImageStep()` | lib/image.mjs |
| `videoGen` | `buildVideoStep()` | lib/video.mjs |
| `textToSpeech` | `buildTTSStep()` | lib/audio.mjs |
| `aceStepAudio` | `buildMusicStep()` | lib/audio.mjs |
| `transcription` | `buildTranscriptionStep()` | lib/audio.mjs |

### Roadmap — documented but not yet built

These job types have official recipes but no builder in this skill yet (deferred — implement one at a time, each needs a builder + arg handlers + readonly/write tests). See <https://developer.civitai.com/orchestration/recipes>.

| Job type / feature | Recipe |
|--------------------|--------|
| Chat completion | `recipes/chat-completion.md` |
| Prompt enhancement | `recipes/prompt-enhancement.md` |
| Image conversion (format/resize/blur) | `recipes/convert-image.md` |
| Image upscaling | `recipes/image-upscaler.md` |
| Video upscaling | `recipes/video-upscaler.md` |
| Video frame interpolation | `recipes/video-interpolation.md` |
| Compose media (overlay/PiP/audio) | `recipes/compose-media-video.md` |
| Multi-speaker dialogue | `recipes/multi-speaker-dialogue.md` |
| LoRA training (SDXL/SD1, Flux1, Flux2 Klein, Wan, LTX2, Chroma/ERNIE/Qwen/Z-Image) | `recipes/training-*.md` |

Other types in the API not yet covered: `comfy`, `videoEnhancement`, `mediaRating`, `wdTagging`. Full OpenAPI spec: `https://orchestration.civitai.com/openapi/v2-consumers.json`.

## Conventions

- Zero npm dependencies. Node 18+ only (native fetch).
- All user-facing output to stderr. JSON results to stdout.
- `--quiet` suppresses progress, leaves stdout clean for agents.
- Exit code 1 on any failure.
- Manifest files (`workflow.json`) saved to output dir for later download/resume.
- Each domain module exports `*_ARG_HANDLERS` (map of flag → handler) and `*_HELP` (help text string).

## Testing

Smoke tests verify all commands against the live Civitai API.

```bash
# Full suite (~16 buzz, ~45 seconds)
node test/smoke-test.mjs

# Read-only (0 buzz — only tests that don't generate)
node test/smoke-test.mjs --readonly

# Keep temp output dirs for inspection
node test/smoke-test.mjs --keep
```

**23 tests** covering:
- **Image/Video (11 readonly):** help output, engines (human + JSON), cost estimation (image, video, multi-prompt, bulk), error handling (missing prompt, unknown command, missing workflow-id)
- **Audio (6 readonly):** help sections for TTS/music/transcribe, error handling (missing text, missing speaker, missing media-url, missing prompt)
- **Write tests (6):** submit, status (human + JSON), download, end-to-end wait (single + multi-prompt)

When adding new features, add corresponding tests to `test/smoke-test.mjs`. Use `--readonly` tests with the `whatif` API for zero-cost validation.

## Adding a New Step Type

1. Create or extend a builder function in the appropriate `lib/*.mjs` module
2. Export `*_ARG_HANDLERS` entries for any new CLI flags
3. Update `*_HELP` string with flag documentation
4. Add routing in `generate.mjs`:
   - `buildStep()` for job→step dispatch
   - `detectMediaType()` for output type detection
   - `parseArgs()` command mapping (if adding a new subcommand)
5. Extend `collectDownloads()` in `lib/api.mjs` if the output format differs
6. Add tests to `test/smoke-test.mjs` (readonly + write)
7. Add domain docs in `docs/` if the type has many parameters
8. Update SKILL.md routing table
9. Update this CLAUDE.md
