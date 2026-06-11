# civitai-gen

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-green.svg)](https://nodejs.org)

An [agent skill](https://agentskills.io) that generates images, videos, audio, and more through [Civitai's](https://civitai.com) orchestration Workflow API. Every generation type — text-to-image, video, text-to-speech, music, transcription — shares one async lifecycle: **submit → poll → download**.

Works with any skills-compatible agent runtime (Claude Code, [OpenClaw](https://openclaw.ai), Cursor, Codex, and others). It's a self-contained Node.js CLI with **zero npm dependencies**.

Companion: the [Civitai MCP server](https://mcp.civitai.com) (`https://mcp.civitai.com/mcp`) covers model discovery (`search_models` / AIR URNs) and signed-in write actions (posts, comments, articles, and more). This one is for **generation**.

## What it does

- **Images** — text-to-image (defaults to Flux.1, 4 images), img2img, checkpoint/LoRA selection, aspect & resolution control.
- **Video** — 11+ engines (Veo 3, WAN, Kling, LTX2, Hunyuan, Vidu, Grok, Happy-Horse…), duration, aspect, optional audio.
- **Text-to-speech** — built-in speakers, voice cloning, style instructions.
- **Music** — ACE-Step song generation with lyrics and duration control.
- **Transcription** — speech-to-text with timestamps and language hints.
- **Bulk & experiments** — `--bulk file.json` batches, plus wildcard expansion and parameter sweeps.
- **Cost estimation** — dry-run buzz estimates (`cost`, `whatif=true`) — 0 buzz spent.

## Install

The portable way (auto-detects your runtime and installs to the right place):

```bash
# Install for the current project
npx skills add civitai/civitai-gen-skill

# Install globally, targeting specific runtimes
npx skills add civitai/civitai-gen-skill -g -a claude-code -a openclaw
```

<details>
<summary>Manual install (any runtime)</summary>

Clone the repo and point your runtime's skills directory at the `civitai-gen/` folder (the folder that contains `SKILL.md`):

```bash
git clone https://github.com/civitai/civitai-gen-skill
# then symlink/copy ./civitai-gen-skill/civitai-gen into your runtime's skills dir, e.g.:
#   Claude Code : ~/.claude/skills/civitai-gen
#   OpenClaw    : ~/.agents/skills/civitai-gen   (or ~/.openclaw/skills/civitai-gen)
#   neutral     : ~/.agents/skills/civitai-gen
```
</details>

## Requirements

- **Node.js 18+** (uses native `fetch`; no dependencies to install)
- A **`CIVITAI_API_KEY`** — get one at <https://civitai.com/user/account>
- `ffmpeg` — optional, only for local audio post-processing

## Configuration

Provide the API key either way:

```bash
# Environment variable
export CIVITAI_API_KEY=your_key_here

# …or a .env file in the skill directory
cp civitai-gen/.env.example civitai-gen/.env   # then edit
```

## Usage

Run from the skill directory (`civitai-gen/`):

```bash
node generate.mjs wait --prompt "A knight at sunset" -o ./out            # image
node generate.mjs wait --engine veo3 --prompt "A robot walking" -o ./out # video
node generate.mjs tts --text "Hello world" --speaker serena -o ./out     # speech
node generate.mjs cost --engine veo3 --prompt "A robot" --duration 8     # estimate (0 buzz)
node generate.mjs engines                                                # live engine list
```

See [`civitai-gen/SKILL.md`](civitai-gen/SKILL.md) for the full command table and [`civitai-gen/docs/engines.md`](civitai-gen/docs/engines.md) for engine/model selection guidance.

## Supported runtimes

Distributed in the [AgentSkills](https://agentskills.io) format (`SKILL.md` + scripts), installable via [`skills.sh`](https://skills.sh). The CLI itself is runtime-agnostic — it only needs Node.js — so any runtime that loads agent skills can use it. Tested with Claude Code and OpenClaw.

## Contributing & development

See [`CLAUDE.md`](CLAUDE.md) for architecture, module layout, and how to add new step types. Tests live in `civitai-gen/test/smoke-test.mjs` (`--readonly` runs at 0 buzz).

## License

[MIT](./LICENSE) © Civitai
