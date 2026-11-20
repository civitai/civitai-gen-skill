---
name: civitai-comfy
description: Run any ComfyUI workflow on Civitai's GPUs (customComfy step) and use it as your lab. Use it to try a model or LoRA from Civitai, compare checkpoints, samplers or settings side by side, test a custom node pack, prototype or debug a ComfyUI graph, or process media (upscale, img2img, inpaint, ControlNet, video) with a hand-built graph. Nothing runs locally; runs cost about 1 Buzz per GPU second. For one-line txt2img/video/audio recipes use civitai-gen instead.
license: MIT
compatibility: Node.js 18+ (native fetch), network access, CIVITAI_COMFY_API_KEY. Needs the sibling civitai-gen skill (shares its lib/api.mjs).
metadata: { "author": "Civitai", "version": "0.1.0" }
---

# civitai-comfy

Sends a ComfyUI **API-format** graph to Civitai's orchestrator as one `customComfy` step, waits, and downloads what it saved. Every GPU second runs on Civitai; nothing runs on this machine.

## Use it to experiment

This is a full ComfyUI on a rented GPU, billed by the second. If ComfyUI can do it and the model is on Civitai, you can try it, usually for a few Buzz. Prefer trying over guessing: when a question is "would model X / setting Y / node Z work for this?", run a small graph and look at the output.

Things that work:

- **Any Civitai model by AIR.** Checkpoints, LoRAs, VAEs, upscalers, ControlNets and embeddings go straight into the node's model field as an AIR (`urn:air:<ecosystem>:<type>:civitai:<modelId>@<versionId>`). Find them with civitai-browse or the Civitai MCP server. The worker downloads them; no install step.
- **Compare things side by side.** Rerun one graph with `--set` overrides to sweep checkpoints, LoRA strengths, samplers, steps, CFG or seeds. Hold the seed fixed when comparing models. Several samplers or several SaveImage nodes in one graph all run in one job.
- **Image work on your own inputs.** img2img, inpainting, ControlNet, upscaling, face fixes: point `LoadImage` at `file:./photo.png`.
- **Custom nodes.** Any pack on the Comfy registry: `snapshot` it once, then pass `--nodepack`. This is how to try a new node or a workflow someone posted.
- **Debug a graph.** `--dry` validates for free; `--trace logs` streams ComfyUI's own log (model loads, errors, timings) while it runs.
- **Video, audio and big models** run too when the default image has the nodes and the GPU has the memory; pin a bigger GPU with `--min-vram`.

Verified live on 2026-11-19: SDXL text-to-image at 1024 px in about 15 to 17 s (15 to 17 Buzz), a 4x Remacri upscale in 2 s (2 Buzz), and a rerun with `--set` prompt and seed overrides. Custom node packs, `--session` reuse and `cancel` have only been tested offline so far; the first agent to use them live should say how it went.

Keep it cheap: start at low resolution and few steps, use `--timeout` near what you expect, and check `spend`. Show the user what you made; do not post it anywhere.

## Cost and caps (read first)

- Billed at **1 Buzz per second of ComfyUI runtime**, after the run. Infrastructure failures are not charged.
- A whatif (`--dry`) always quotes 0 for customComfy, and the API key's Buzz budget is **not** checked for it on the server. The caps below are the only per-run stop besides the account balance.
- **Per run:** `--timeout` seconds, default and maximum 600 (at most 600 Buzz). The orchestrator kills the step at the timeout.
- **Per day (UTC):** 2,000 Buzz, tracked in `ledger.jsonl` next to this file. A submit reserves its worst case (the timeout) until the run settles with the real charge. Override the cap with `CIVITAI_COMFY_DAILY_CAP`.
- `--over-cap` lifts both caps for one run. Only use it when the user asked for it.
- Ctrl-C during `run` cancels the workflow on the server (a second Ctrl-C exits without waiting).
- Never publish outputs to Civitai from this skill.

## Key

The skill uses its **own** key, `CIVITAI_COMFY_API_KEY`, not the shared civitai-gen key, so the spend is only this skill's. It is read from the environment, or from `.env` in this directory. Do not open or print `.env`. To store a key: `node comfy.mjs key < file-with-key`. On hub seats, run through the vault: `node ~/.claude/hub-channel/hub-secret.mjs run CIVITAI_COMFY_API_KEY -- node comfy.mjs <command> ...`. A seat outside the key holder's lineage (e.g. on the desk) gets a grant card for Justin on its first `run`, where he picks 24h or standing access; do not copy the key to other agents.

## Commands

| Command | What it does |
|---|---|
| `run <graph.api.json>` | Upload `file:` inputs, submit, follow, download outputs (`-o dir`), print status, runtime and Buzz |
| `run ... --dry` | Validate locally, then whatif on the server (free). `--json` prints the body |
| `snapshot <nodepack AIR>...` | Install custom node packs on a real worker once; caches each install-layer AIR in `nodepack-cache.json` |
| `status <id> [--follow]` | Workflow status and usage; `--follow` polls and tails the trace |
| `download <id> -o dir` | Download a finished workflow's outputs |
| `cancel <id>` | Cancel a running workflow |
| `airs <graph.api.json>` | List the AIRs and `file:` inputs the graph uses |
| `spend [--day YYYY-MM-DD]` | Today's Buzz from the ledger, with each run |

### `run` options

| Option | Meaning |
|---|---|
| `-o dir` | Where to save outputs |
| `--set <node>.<input>=<value>` | Override a node input (repeatable): prompts, seeds, steps |
| `--resource AIR` | Extra resource; model AIRs used as node inputs are found automatically |
| `--nodepack AIR` | Custom node pack (`urn:air:comfy:nodepack:...`); needs a cached `snapshot` first |
| `--timeout sec` | Hard runtime limit, default 600 |
| `--trace logs\|binary` | Record ComfyUI's websocket activity; `logs` is tailed to stderr while it runs |
| `--session id` | Prefer a worker that already holds this session's ComfyUI container (warm reruns) |
| `--image AIR` | Pin the comfy container, `urn:air:oci:image:ghcr:civitai/<repo>@<tag>` (default: the worker's, civitai-spine-comfy-cloud) |
| `--min-vram GB`, `--sage` | Worker VRAM floor; launch with sage attention |
| `--no-wait` | Submit and print the workflow id |

## Writing graphs

- **API format only.** In ComfyUI use *Export (API)*. The editor's saved format (`nodes` + `links`) is refused with a hint.
- **Models are AIRs** in the node's model field, e.g. `"model_name": "urn:air:other:upscaler:civitai:147759@164821"`, `"ckpt_name": "urn:air:sdxl:checkpoint:civitai:257749@290640"`. The worker downloads them. Every AIR found in node inputs is added to `resources` automatically.
- **Local inputs:** write `"image": "file:./photo.png"` (path relative to where you run the command). The file is uploaded as a blob, replaced with its blob AIR (`urn:air:other:other:orchestrator:blob@<id>`) and declared as a resource; the worker mounts it and hands ComfyUI a file path. A plain URL in `LoadImage` fails: ComfyUI answers 400. Supported: png, jpg, webp, mp4, mp3, wav, ogg, flac.
- **Custom nodes:** `snapshot` the pack (once per pack and image), then pass `--nodepack` with the same AIR. Bare nodepack AIRs in resources are refused by the server.
- Outputs are whatever the graph's save nodes write.

## What failures look like (seen live, 2026-11-19)

- **Graph rejected by ComfyUI** (bad input value, missing node): fails in seconds; the trace shows `[error] ... 400 (Bad Request)`. The few seconds of runtime are charged (3 Buzz in the test).
- **A model AIR that does not exist:** the step sits in `preparing` until `--timeout`, then ends `expired` with 0 Buzz. Check AIRs with `airs` before a long timeout.

## Dev loop

```bash
node comfy.mjs airs my.api.json                         # what it needs
node comfy.mjs run my.api.json --dry                    # free server-side validation
node comfy.mjs run my.api.json --timeout 120 --trace logs --session dev1 -o out
node comfy.mjs run my.api.json --timeout 120 --session dev1 --set 6.text="a red fox" -o out   # warm rerun
node comfy.mjs spend
```

Example graphs in `examples/`:

- `txt2img-sdxl.api.json`: SDXL base 1.0, 1024 px, 25 steps (node 2 is the prompt, node 5 the sampler: `--set 2.text="..." --set 5.seed=7`).
- `upscale-remacri.api.json`: LoadImage from `file:./input.png`, 4x-Remacri, SaveImage.

To try a different checkpoint or add a LoRA, copy an example and edit it: swap `ckpt_name` for another AIR, or insert a `LoraLoader` node (`lora_name` = the LoRA's AIR) between the checkpoint and the sampler.

## Tests

`node --test test/comfy.test.mjs` runs the CLI end to end against a fake orchestrator (no network, no key, no Buzz).
