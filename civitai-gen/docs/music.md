# Music Generation (YuE2)

**Always YuE2 for music, never ACE Step.** YuE2's songs are far better. `music` builds a `yuE2` step.
For a launch music video, use the walkthrough-video skill's `scripts/song.mjs` (several takes, one per style) instead;
this command is for a single quick song.

## Quick Start

```bash
# A sung song: style in --prompt, lyrics with section headers
node generate.mjs music --prompt "anthemic electro rock, punchy drums, confident female vocal" \
  --lyrics "[chorus]
Four rounds, one crown
Bring your best and take it down" --duration 30 -o ./out

# Instrumental: leave out --lyrics (sends [instrumental])
node generate.mjs music --prompt "lo-fi hip hop beat, warm keys" --duration 60 -o ./out
```

## Parameters

| Flag | Required | Description |
|------|----------|-------------|
| `--prompt <text>` | yes | Style: genre, instruments, tempo, mood, vocal |
| `--lyrics <text>` | no | `[verse]` / `[chorus]` / `[outro]` headers, one sung line per line, blank line between sections. Omitted = `[instrumental]` |
| `--duration <sec>` | no | Max length, 10-120 (default 90). Takes can end early; ask ~8s longer than you need |

## Output

One `.mp3` per step, downloaded to `-o`. Measured 11/21/2026: a 30s ask cost 13 Buzz, took ~30s, and returned 23s.

## Word times for karaoke

`transcribe --timestamps` returned no word segments on sung audio (11/21/2026). Use the walkthrough-video skill's
`scripts/words.py` (faster-whisper word timestamps) instead.
