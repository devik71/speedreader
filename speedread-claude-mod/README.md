# SpeedRead × Claude Code — Mod v0.2

A native **Claude Code Mod** that reads the last Claude answer word-by-word inside a terminal pane. It uses no external service, no local server, and no LLM calls for reading.

**Requirements**: Claude Code **v2.1.287+** with Mods enabled; Node.js 22.18+ (type stripping) only for the core tests. Validated with `claude plugin validate`, type-checked against the 2.1.319 Mod API, and tested with `claude plugin test` (the engine's own test host). Terminal rendering and key focus still need a smoke test in a live session.

## Install

At the prompt of a Claude Code terminal session:

```text
/plugin install speedread --marketplace devik71/speedreader
```

Answer `y` to add the marketplace, then pick a scope (user scope first). From a shell:

```powershell
claude plugin install speedread --marketplace devik71/speedreader
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `devik71/speedreader`, then Add plugin.

### Run from a checkout (development)

```powershell
git clone https://github.com/devik71/speedreader
cd speedreader
claude plugin validate .\speedread-claude-mod
claude --plugin-dir .\speedread-claude-mod
```

Then ask Claude a question. After it finishes, launch the reader with **`/sr`** at the Claude Code prompt. In terminals supporting the mod's `AbovePrompt` band, **`1`** also opens SpeedRead when the prompt is empty and the shortcut is active.

You can also run:

```text
/sr previous
/sr block 3
```

`/sr previous` opens the previous answer held in the current session's history. `/sr block 3` opens block #3 of the latest answer, where blocks are paragraphs, headings, list items, and code fences.

## Keyboard controls (when the reader pane is focused)

| Key | Action |
|---|---|
| `p` | Play / Pause (focused on open) |
| `j` / `k` | Hold: scroll forward / back at reading speed; tap: one word |
| `h` / `l` | Previous / next word |
| `b` / `n` | Previous / next block |
| `s` / `f` | Slower / faster by 25 WPM |
| `r` | Restart this answer (also automatic when it ends) |
| `u` / `d` | Older / newer answer |
| `Esc` | Close and pause |

Default speed: **350 WPM**, bounded **100–900 WPM**. Commas/colons/semicolons (incl. CJK `、，`) give a brief pause; sentence punctuation (incl. `。！？`) a longer one; long words and the last word of a block get extra time. Weights live in `DEFAULT_TIMING`, not as magic numbers. Each word is drawn with its **optimal recognition point** (red letter) at a fixed column between `▾`/`▴` markers, so the eye never moves. Fenced code stops autoplay and is shown highlighted (first 8 lines) until you press `n`. Markdown tables drop their `|---|` divider rows.

## How it works

- `turn.complete` captures `e.answer` only when `e.reason === 'answer'` and there is no `agentId` (main conversation; aborted, refused, errored and subagent turns are skipped). Capturing never interrupts Claude or starts a model call.
- `session.start` registers `/sr` and comes back paused after a hot reload.
- Playback is one `$.clock.after` per word (no busy polling); manual moves pause.
- All drawing state (history, position, WPM, play state) is in the session's `$.state` (`types/index.d.ts` is the contract), so a hot reload keeps your place. Drawings subscribe to it, so there are no manual redraws.
- `ui.render` draws the `Pane` and a launch row above the prompt (hidden while the pane is open or a survey is up).
- Opening the reader also pulls earlier answers from the session transcript (`$.session.messages()`), so answers from before the mod loaded, or from a resumed session, are there too.
- `ui.close` (Esc) pauses. A new answer while the reader is open **never replaces** the current one.
- Keeps the latest **10** answers, max **80,000 characters** each, for the session only. Nothing is transmitted or written to disk.

## Architecture

```text
speedread-claude-mod/
  .claude-plugin/plugin.json  # manifest (names the state contract)
  hooks/hooks.json            # mod entry point
  hooks/register.tsx          # Claude-specific adapter, clock and native UI
  types/index.d.ts            # $.state contract
  src/reader-core.ts          # pure TS: parsing, timing, ORP, navigation
  tests/reader-core.test.mjs  # core tests (node --test)
  tests/mod.test.tsx          # mod tests (claude plugin test)
```

`src/reader-core.ts` is intentionally platform-independent (erasable TypeScript only), so the same engine can later be used by a mobile web or native iOS view.

## Known MVP limitations

- This version captures the **final answer per completed turn**, not partial streaming responses, tool output, or independently clickable individual paragraphs in the transcript. It *does* split that answer into logical blocks that can be navigated.
- An actual live Claude Code version may have rendering/focus differences and should be tested before relying on it. The reader is a **pane** (sidebar or above the prompt), not a fullscreen central overlay.
- Markdown tables are handled as basic text rows; code blocks are skipped only with manual navigation; links are displayed by their labels. Sentence-aware rewind is not implemented yet.
- The mod API is relatively new and may change; check the docs for your Claude Code version.
- No persistent reading position, phone sync, TTS, or Windows global hotkeys yet.

## Run tests

```powershell
node --test .\speedread-claude-mod\tests\*.test.mjs   # core
claude plugin test .\speedread-claude-mod              # mod, in the engine's test host
```

## Roadmap

1. ~~Align with the real Mod API (2.1.319)~~ done in v0.2; finish the live smoke test in Windows Terminal (focus, key repeat for hold-to-scrub).
2. Add one-click `Read` controls on individual transcript answer blocks and opt-in persistent position.
3. Add a local transport adapter for future iPhone sync, without coupling it to the reading core.

Official documentation: https://code.claude.com/docs/en/plugins/mods/overview and https://code.claude.com/docs/en/plugins/mods/reference
