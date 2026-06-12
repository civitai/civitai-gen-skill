---
name: civitai-gen
description: Generate images, videos, audio, and more using Civitai's orchestration API. Use when the user wants text-to-image, video generation (11+ engines), text-to-speech, music, transcription, bulk batches, experiment sweeps, or buzz cost estimation. Not for browsing or searching Civitai models (use the Civitai MCP server).
license: MIT
compatibility: Requires Node.js 18+ (native fetch) and a CIVITAI_API_KEY. Network access required. ffmpeg optional (audio post-processing only).
metadata: { "author": "Civitai", "version": "1.0.5", "homepage": "https://github.com/civitai/civitai-gen-skill" }
---

# civitai-gen

Unified CLI for Civitai's orchestration Workflow API. All generation types share the same workflow lifecycle: submit, poll, download.

## Setup

Requires Node.js 18+. Set `CIVITAI_API_KEY` either as an environment variable or in a `.env` file in this skill's directory (next to `generate.mjs`). Copy `.env.example` to `.env` to start. Get a key at: https://civitai.com/user/account

> Paths below are relative to this skill's directory. Run the scripts from there (`cd` into it), or prefix with the install path your runtime uses.

## Capabilities

| Command | What it does | Details |
|---------|-------------|---------|
| `wait` | Submit + poll + download (default) | All-in-one blocking generation |
| `submit` | Fire-and-forget, returns workflow ID | For async workflows |
| `status` | Check workflow progress | `--poll` for live updates |
| `download` | Fetch completed media | From a workflow ID |
| `cost` | Dry-run buzz estimation | `whatif=true`, 0 buzz spent |
| `engines` | List video engines + live status | 11+ engines |
| `tts` | Text-to-speech | See `docs/tts.md` |
| `music` | Music/song generation (ACE Step 1.5) | See `docs/music.md` |
| `transcribe` | Speech-to-text transcription | See `docs/transcription.md` |

## Quick Examples

```bash
# Image (defaults to Flux.1, 4 images)
node generate.mjs wait --prompt "A knight at sunset" -o ./out

# Multiple concurrent prompts
node generate.mjs wait --prompt "A warrior" --prompt "A mage" -o ./out

# Video (VEO 3)
node generate.mjs wait --engine veo3 --prompt "A robot walking" -o ./out

# Text-to-speech
node generate.mjs tts --text "Hello world" --speaker serena -o ./out

# Music
node generate.mjs music --prompt "upbeat electronic dance track" -o ./out

# Transcription
node generate.mjs transcribe --media-url "https://example.com/audio.mp3" -o ./out

# Cost check (any type, 0 buzz)
node generate.mjs cost --prompt "A cat" -n 100
node generate.mjs cost --engine veo3 --prompt "A robot" --duration 8

# Experiment mode (wildcard expansion)
node experiment.mjs --spec experiment.json -o ./out
```

## Posting What You Generate

Generate an image (the skill saves it locally), then post the local file in one command:

```bash
node generate.mjs wait --prompt "a red apple" -n 1 -o ./out
node mcp-cli.mjs post-image ./out/step_0-0.png --title "My apple"
# -> Post published. URL: https://civitai.com/posts/<id>
```

`post-image` reads the local file, uploads it, and publishes the post — it prints the public URL. Pull `mcp-cli.mjs` first if you don't have it (`curl -fsSL https://mcp.civitai.com/cli -o mcp-cli.mjs`); `CIVITAI_API_KEY` is required.

Flags: `--title` (defaults to the filename), `--detail`, `--nsfw <level>`, `--draft` (leave unpublished), `--json`. For video/audio, or to attach a pre-uploaded image by UUID, call `create_post` directly (`node mcp-cli.mjs schema create_post`) — and prefer posting the local file over the generate output's `remoteUrls[].url`, which is a short-lived signed URL that expires quickly.

## Choosing an Engine & Model

Read [`docs/engines.md`](docs/engines.md) to pick the right generator. The key split:

| Path | Engines | How to pick the model |
|------|---------|----------------------|
| **Open-weight ecosystem** | SD1, SDXL, Pony, Illustrious, Flux.1/2, Qwen, Z-Image, Chroma, Anima | Find a **checkpoint AIR** + compatible LoRAs via the **Civitai MCP** (`search_models` / `get_model_version`) → `--model` / `--resources` |
| **Closed API engine** | OpenAI, Google/Gemini, Seedream, Grok, MAI, ERNIE + all video/audio | Engine name only — no checkpoint search, no LoRA |

**Model discovery uses the Civitai MCP server** (hosted at `https://mcp.civitai.com/mcp`) — call its tools to search checkpoints/LoRAs and get AIR URNs. Don't search inside this skill. A LoRA's base model must match the checkpoint's ecosystem.

If the Civitai MCP isn't connected, add it (browse tools need no API key):
`claude mcp add --transport http civitai https://mcp.civitai.com/mcp`

**Can't add MCP config in your runtime?** Pull the zero-dep CLI (Node 18+) and call tools over the shell instead:
`curl -fsSL https://mcp.civitai.com/cli -o mcp-cli.mjs`
`node mcp-cli.mjs call search_models '{"query":"anime portrait","type":"Checkpoint","supportsGeneration":true,"baseModel":"SDXL 1.0"}'`

```text
# Call these Civitai MCP tools directly (they return AIR URNs ready for --model / --resources):
search_models     { query: "anime portrait", type: "Checkpoint", supportsGeneration: true, baseModel: "SDXL 1.0" }
search_models     { query: "neon style", type: "LORA", baseModel: "SDXL 1.0" }   # LoRA base MUST match checkpoint
get_model_version { ids: [<versionId>] }   # full version details + AIR URN + trigger words
```

Engine availability/params drift — run `node generate.mjs engines` for the live list and see <https://developer.civitai.com/orchestration/recipes> for per-engine parameters.

## Domain-Specific Docs

For detailed parameters, read the relevant doc:

- **Images**: `--prompt`, `--model`, `--resources`, `--aspect`, `--resolution`, `--source-image` (img2img). Run `node generate.mjs --help` for full flag list.
- **Videos**: `--engine`, `--duration`, `--video-aspect`, `--generate-audio`. Run `node generate.mjs engines` for available engines.
- **TTS**: Read [`docs/tts.md`](docs/tts.md) — built-in speakers, voice cloning, style instructions.
- **Music**: Read [`docs/music.md`](docs/music.md) — ACE Step 1.5, lyrics, duration.
- **Transcription**: Read [`docs/transcription.md`](docs/transcription.md) — ASR, timestamps, language hints.
- **Experiments**: Read `experiment.mjs --help` — wildcards, parameter sweeps, naming.

## Workflow Lifecycle

All generation types follow the same pattern:

1. **Build steps** — each job becomes a workflow step with a `$type` (`textToImage`, `videoGen`, `textToSpeech`, `aceStepAudio`, `transcription`)
2. **Submit** — POST to orchestration API, get workflow ID
3. **Poll** — check status until terminal state (succeeded/failed/expired)
4. **Download** — fetch output media (images, videos, audio files)
5. **JSON summary** — clean JSON to stdout with paths, costs, and metadata

Use `cost` (whatif) to estimate buzz before spending. Use `--quiet` for agent-friendly output.

## Guidelines

- Default to 4 images per prompt. Use `-n 1` only when a single image is needed.
- For video: always check `cost` first. Video costs 500-2000+ buzz per clip.
- Multiple `--prompt` flags create concurrent steps in one workflow.
- Use `--bulk file.json` for large batches.
- Use experiment mode for systematic parameter sweeps.

## Developer Guide

See `CLAUDE.md` for architecture, module layout, and how to add new step types.
