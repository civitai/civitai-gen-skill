# Engines & Model Selection

How to pick the right generator for a job. Two questions decide everything:

1. **What medium?** image / video / audio / text
2. **Open-weight ecosystem or closed API engine?** — this changes how you pick resources.

> **Source of truth:** engine availability and parameters drift. This file is a curated snapshot for *choosing*. For the live list run `node generate.mjs engines`, and for authoritative per-engine parameters ("recipes") see <https://developer.civitai.com/orchestration/recipes> and <https://developer.civitai.com/llms.txt>.

---

## The two-path model (read this first)

Image generation splits into two paths. Getting this wrong is the #1 mistake.

| Path | Engines | How you pick the model | LoRAs |
|------|---------|------------------------|-------|
| **Open-weight ecosystem** | SD1, SDXL, Pony, Illustrious, NoobAI, Flux.1, Flux.2, Qwen, Chroma, Z-Image, Anima, HiDream | Search Civitai for a **checkpoint AIR URN** + compatible LoRAs. Pass via `--model` / `--resources`. | ✅ Yes — must match base ecosystem |
| **Closed API engine** | OpenAI (GPT-Image/DALL·E), Google (Imagen/Nano Banana), Gemini, Seedream, Grok, MAI Image, ERNIE | Engine name only. No checkpoint search. | ❌ No (engine-baked) |

**Video and audio are always engine-only** — pick an engine, not a checkpoint. Some video engines accept LoRAs (see table).

### Picking checkpoints & LoRAs (open-weight path)

**Use the Civitai MCP server** — it owns model discovery. Do not search inside civitai-gen. If it's not connected: `claude mcp add --transport http civitai https://mcp.civitai.com/mcp` (browse tools need no API key). No way to edit MCP config in your runtime? Pull the CLI: `curl -fsSL https://mcp.civitai.com/cli -o mcp-cli.mjs` then `node mcp-cli.mjs call search_models '{...}'`.

```text
# Call these Civitai MCP tools (hosted at https://mcp.civitai.com/mcp):
search_models     { query: "anime portrait", type: "Checkpoint", supportsGeneration: true, baseModel: "SDXL 1.0" }
search_models     { query: "neon style", type: "LORA", baseModel: "SDXL 1.0" }   # MUST match checkpoint base
get_model_version { ids: [<versionId>] }   # AIR URN + trigger words
```

**Compatibility rule:** a LoRA's base model must match the checkpoint's ecosystem. SDXL LoRA ≠ Flux checkpoint.

> The same Civitai MCP also posts what you generate: `node mcp-cli.mjs post-image <local png>` (see the "Posting What You Generate" section in SKILL.md).

---

## Image — which engine, and why

### Open-weight (checkpoint + LoRA via the Civitai MCP)

| Ecosystem | Prefer for | Notes |
|-----------|-----------|-------|
| **Flux.1** | Default. Strong prompt-following, realism, text rendering | Platform default ecosystem |
| **Flux.2** | Higher fidelity than Flux.1, newer | Klein default; Dev/Flex/Pro/Max tiers |
| **SDXL** | Huge LoRA/community ecosystem, versatile, cheap | 1024². DreamShaper etc. |
| **Pony / Illustrious / NoobAI** | Anime/stylized/character work | SDXL-family; match LoRA to the exact base |
| **SD1** | Legacy, fastest/cheapest, niche LoRAs | 512² only |
| **Qwen** | Strong text-in-image, editing/variants | ~1328² |
| **Z-Image** | Lightweight, fast text-to-image | turbo (default) / base |
| **Chroma / Anima / HiDream** | Specialty ecosystems (Anima = anime-tuned w/ LoRA) | smaller communities |

### Closed API engines (engine name, no LoRA)

| Engine | Prefer for | Notes |
|--------|-----------|-------|
| **Seedream** | Max native resolution (up to 4096), editing | ByteDance |
| **Google (Imagen / Nano Banana)** | Editing, web-search grounding, photoreal | also via `nano-banana` skill |
| **Gemini** | 2.5 Flash Image, fast multimodal | direct API |
| **OpenAI** | GPT-Image 1/1.5, DALL·E 2/3 | hosted |
| **Grok** | 21 aspect ratios, editing | xAI |
| **MAI Image 2.5** | Flat pricing, 11 aspect ratios | Microsoft |
| **ERNIE** | standard / turbo | Baidu |

**Default recommendation:** start with **Flux.1** for general work, **SDXL/Pony/Illustrious** when the user wants community LoRAs or anime, a closed engine (Seedream/Google) when they want max resolution or built-in editing.

---

## Video — which engine, and why

Always run `cost` before video — clips run 500–2000+ buzz. Engine ids are the `--engine` value.

| Engine id | Prefer for | Audio | LoRA | img2vid | Notes |
|-----------|-----------|:----:|:----:|:------:|-------|
| `veo3` | Realism + **synchronized audio**, premium | ✅ | ✅ | ✅ | Veo 3.0/3.1; std/fast/lite tiers. PG-only |
| `wan` | **Best LoRA support**, flexible, cost-effective | — | ✅ | ✅ | v2.1–2.7; interpolation |
| `kling` | **Camera control**, strong motion | — | — | ✅ | v1.6/v2/v2.5-turbo; V3 multi-prompt |
| `ltx2` | Style transfer, **talking-head**, has audio | ✅ | — | ✅ | Lightricks LTX2/2.3 |
| `hunyuan` | Quality + LoRA, but compute-heavy | — | ✅ | — | Tencent |
| `vidu` | **Anime style**, reference-to-video | — | — | ✅ | Vidu 2.0 / Q3 turbo |
| `grok` | xAI Grok-Imagine, edit-video | — | — | ✅ | 480p/720p, per-second pricing |
| `happyHorse` | Multi-character reference, video editing | edit only | — | ✅ | Alibaba via FAL; 720p/1080p |
| `sora` | OpenAI Sora 2, pro mode | — | — | ✅ | 720p/1080p |
| `minimax` | Hailuo, prompt enhancer | — | — | ✅ | |
| `haiper`, `mochi`, `lightricks` | Older/cheaper options | — | — | varies | verify live status |

**Quick picks:**
- Need **sound** → `veo3` (best) or `ltx2`
- Need **LoRA** (custom character/style) → `wan` or `hunyuan`
- Need **camera moves** → `kling`
- **Anime** → `vidu`
- **From a still image** (img2vid) → most support it; `wan`/`kling`/`veo3` are solid

---

## Audio

| Subcommand | Engine | Prefer for |
|-----------|--------|-----------|
| `tts` | text-to-speech | Narration; built-in speakers, style instructions, voice cloning. See [tts.md](tts.md) |
| `music` | ACE-Step | Full songs from a style description; 2B turbo / 4B XL. See [music.md](music.md) |
| `transcribe` | Qwen3-ASR | Speech→text, word-level timestamps, multilingual. See [transcription.md](transcription.md) |

Multi-speaker dialogue (debates/interviews) exists as a recipe but is not yet a skill subcommand — see roadmap in CLAUDE.md.

---

## Not yet wired into this skill

Documented job types the orchestrator supports but the CLI doesn't build yet (see CLAUDE.md roadmap): chat completion, prompt enhancement, image conversion, image/video upscaling, frame interpolation, compose-media, multi-speaker dialogue, and LoRA training. Recipes: <https://developer.civitai.com/orchestration/recipes>.
