# SpeedRead

Local-first RSVP speed reading for AI answers: one word at a time, at a fixed point, at the speed you set. The first client is a native **Claude Code mod** that reads Claude's answers in a pane beside the conversation, with no external service, no server and no extra model calls.

## Install the Claude Code mod

At the prompt of a Claude Code terminal session (v2.1.287+):

```text
/plugin install speedread --marketplace devik71/speedreader
```

Answer `y` to add the marketplace, then pick a scope. From a shell: `claude plugin install speedread --marketplace devik71/speedreader`.

Then ask Claude anything and run **`/sr`**.

| Key | Action |
|---|---|
| `p` | Play / Pause |
| `j` / `k` | Hold: scroll forward / back at reading speed; tap: one word |
| `h` / `l` | Previous / next word |
| `b` / `n` | Previous / next block |
| `s` / `f` | Slower / faster by 25 WPM |
| `r` | Restart (also automatic at the end) |
| `u` / `d` | Older / newer answer |
| `Esc` | Close and pause |

Full details: [speedread-claude-mod/README.md](speedread-claude-mod/README.md).

## Repository

```text
.claude-plugin/marketplace.json   # makes this repo installable with /plugin install
speedread-claude-mod/             # the Claude Code mod (self-contained plugin)
  hooks/register.tsx              #   Claude adapter: capture, clock, pane UI
  src/reader-core.ts              #   pure TS reading core: Markdown blocks, timing, ORP, navigation
  types/index.d.ts                #   the mod's $.state contract
  tests/                          #   core tests (node --test) + mod tests (claude plugin test)
SPEEDREAD_ARCHITECTURE_v1.md      # target architecture (UA): CLI/TUI, web/PWA, iOS, sync bridge
```

`src/reader-core.ts` has no DOM, Node or Claude dependencies, so the same engine is meant to drive the future CLI/TUI, web and iOS clients described in the architecture document.

## Development

```powershell
node --test .\speedread-claude-mod\tests\*.test.mjs   # core (Node 22.18+)
claude plugin test .\speedread-claude-mod              # mod, in Claude Code's test host
claude plugin validate .                               # marketplace + manifest + hooks
claude --plugin-dir .\speedread-claude-mod             # run it live
```

## Status

- **v0.2**: Claude Code mod, validated, type-checked and tested against the 2.1.319 Mod API; live terminal smoke test in progress.
- Next (see the architecture doc): sentence-aware navigation, persistent position, `sr` CLI/TUI, web reader on the same core, iPhone.
