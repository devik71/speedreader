import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { SavedDoc } from '../types'
import {
  activeBlock, activeWord, advanceOne, atBlockEnd, DEFAULT_WPM, elapsedWordMs,
  jumpBlock, makeDocument, orpParts, previousOne, progress, seek, setWpm, WPM_STEP,
} from '../src/reader-core.ts'
import type { ReaderDocument } from '../src/reader-core.ts'

const PANE = 'speedread-reader'
const HISTORY_LIMIT = 10
const MAX_CHARS = 80_000
const PIVOT_COLUMN = 10

// Everything a drawing reads lives in $.state, so a hot reload keeps the
// history and the reading position. Bump `shape` when SavedDoc changes.
const docs = atom({ plugin: 'speedread', key: 'docs' } as const, [], { shape: 'docs-1' })
const selected = atom({ plugin: 'speedread', key: 'selected' } as const, -1)
const wpmAtom = atom({ plugin: 'speedread', key: 'wpm' } as const, DEFAULT_WPM)
const playing = atom({ plugin: 'speedread', key: 'playing' } as const, false)
const paneOpen = atom({ plugin: 'speedread', key: 'paneOpen' } as const, false)
const scrub = atom({ plugin: 'speedread', key: 'scrub' } as const, 0)
const sequence = atom({ plugin: 'speedread', key: 'sequence' } as const, 0)

// Parsing is pure and deterministic: cache by id; a reload just re-parses.
const parsed = new Map<number, ReaderDocument>()
function toReader(saved: SavedDoc): ReaderDocument {
  let base = parsed.get(saved.id)
  if (!base) {
    base = makeDocument(saved.raw, saved.id)
    parsed.set(saved.id, base)
    if (parsed.size > HISTORY_LIMIT * 2) parsed.delete(parsed.keys().next().value!)
  }
  const doc = { ...base }
  seek(doc, saved)
  return doc
}

const clampIndex = (i: number, len: number) => Math.max(0, Math.min(len - 1, i))

/** Applies `move` to the selected answer's position and stores it. */
async function moveSelected($: EngineInterface, move: (doc: ReaderDocument) => void): Promise<ReaderDocument | null> {
  const index = await read($, selected)
  let result: ReaderDocument | null = null
  await update($, docs, list => list.map((saved, i) => {
    if (i !== index) return saved
    const doc = toReader(saved)
    move(doc)
    result = doc
    return { ...saved, blockIndex: doc.blockIndex, wordIndex: doc.wordIndex }
  }))
  return result
}

async function currentDoc($: EngineInterface): Promise<ReaderDocument | null> {
  const list = await read($, docs)
  const saved = list[await read($, selected)]
  return saved ? toReader(saved) : null
}

// ---- The clock: one `$.clock.after` per word, never a busy poll. ----------

let timer: Timer | null = null
let generation = 0

function stopTimer() {
  generation += 1
  timer?.cancel()
  timer = null
}

async function pause($: EngineInterface) {
  stopTimer()
  await stopScrub($)
  await update($, playing, () => false)
}

/** Waits the active word's time, then advances one word and waits again. */
async function scheduleNext($: EngineInterface) {
  stopTimer()
  const mine = generation
  if (!(await read($, playing)) || !(await read($, paneOpen))) return
  const doc = await currentDoc($)
  const word = activeWord(doc)
  if (!doc || word === null) { await pause($); return }
  const ms = elapsedWordMs(word, await read($, wpmAtom), { blockEnd: atBlockEnd(doc) })
  if (mine !== generation) return
  timer = $.clock.after(ms, () => { void step($, mine) })
}

async function step($: EngineInterface, mine: number) {
  if (mine !== generation) return
  timer = null
  let advanced = false
  const doc = await moveSelected($, d => { advanced = advanceOne(d) })
  if (!doc) { await pause($); return }
  // Finished: rewind to the start, paused, ready for another pass.
  if (!advanced) {
    await pause($)
    await moveSelected($, d => seek(d, { blockIndex: 0, wordIndex: 0 }))
    return
  }
  // Stop on reaching a code block: code is read, not flashed.
  if (activeBlock(doc)?.kind === 'code') { await pause($); return }
  await scheduleNext($)
}

async function togglePlay($: EngineInterface) {
  const now = !(await read($, playing))
  await stopScrub($)
  await update($, playing, () => now)
  if (now) await scheduleNext($)
  else stopTimer()
}

// ---- Hold-to-scrub (j forward, k back) ------------------------------------
// A hotkey held down arrives as the terminal's key repeat: one press, a pause
// (the OS repeat delay), then a stream of presses. A lone press moves one word;
// once the repeats start, words move at reading speed until they stop coming.

const REPEAT_WINDOW_MS = 700 // longer than the usual OS repeat delay
const RELEASE_MS = 250 // no repeat for this long: the key was let go

let scrubTimer: Timer | null = null
let scrubGeneration = 0
let lastScrubPress = 0
let scrubHeld = false

async function stopScrub($: EngineInterface) {
  scrubGeneration += 1
  scrubTimer?.cancel()
  scrubTimer = null
  scrubHeld = false
  if ((await read($, scrub)) !== 0) await update($, scrub, () => 0)
}

/** One word in `dir`; jumps over a code block whole. False at either end. */
function scrubMove(doc: ReaderDocument, dir: number): boolean {
  if (activeBlock(doc)?.kind === 'code') return jumpBlock(doc, dir)
  return dir > 0 ? advanceOne(doc) : previousOne(doc)
}

async function scrubPress($: EngineInterface, dir: 1 | -1) {
  const now = await $.clock.now()
  const isRepeat = (await read($, scrub)) === dir && now - lastScrubPress < REPEAT_WINDOW_MS
  lastScrubPress = now
  if (isRepeat) {
    if (!scrubHeld) {
      scrubHeld = true
      void scrubTick($, dir, scrubGeneration)
    }
    return
  }
  // A fresh press: stop playback, move one word, wait to see if it repeats.
  stopTimer()
  await stopScrub($)
  await update($, playing, () => false)
  await update($, scrub, () => dir)
  await moveSelected($, d => { scrubMove(d, dir) })
  const mine = scrubGeneration
  scrubTimer = $.clock.after(REPEAT_WINDOW_MS, () => {
    if (mine === scrubGeneration && !scrubHeld) void stopScrub($)
  })
}

async function scrubTick($: EngineInterface, dir: number, mine: number) {
  if (mine !== scrubGeneration) return
  if ((await $.clock.now()) - lastScrubPress > RELEASE_MS) { await stopScrub($); return }
  let moved = false
  const doc = await moveSelected($, d => { moved = scrubMove(d, dir) })
  if (!doc || !moved) { await stopScrub($); return }
  const ms = elapsedWordMs(activeWord(doc) ?? '', await read($, wpmAtom))
  if (mine !== scrubGeneration) return
  scrubTimer?.cancel()
  scrubTimer = $.clock.after(ms, () => { void scrubTick($, dir, mine) })
}

/** A manual move pauses, so the person never races the clock. */
async function manual($: EngineInterface, move: (doc: ReaderDocument) => void) {
  await pause($)
  await moveSelected($, move)
}

async function changeWpm($: EngineInterface, delta: number) {
  await update($, wpmAtom, w => setWpm(w + delta))
  if (await read($, playing)) await scheduleNext($)
}

async function selectDoc($: EngineInterface, choose: (current: number, length: number) => number) {
  await pause($)
  const length = (await read($, docs)).length
  if (!length) return
  await update($, selected, i => clampIndex(choose(i, length), length))
}

// ---- Capture --------------------------------------------------------------

async function capture($: EngineInterface, text: string) {
  if (!text.trim()) return
  const raw = text.slice(0, MAX_CHARS)
  const list = await read($, docs)
  if (list[list.length - 1]?.raw === raw) return
  if (makeDocument(raw).blocks.length === 0) return
  const id = (await read($, sequence)) + 1
  await update($, sequence, () => id)
  const saved: SavedDoc = { id, raw, capturedAt: await $.clock.now(), blockIndex: 0, wordIndex: 0 }
  const oldSelected = await read($, selected)
  const oldId = list[oldSelected]?.id
  let next: SavedDoc[] = []
  await update($, docs, l => (next = [...l, saved].slice(-HISTORY_LIMIT)))
  // A new answer never replaces the one being read: keep pointing at it.
  const isReading = await read($, paneOpen)
  const keep = isReading && oldId !== undefined ? next.findIndex(d => d.id === oldId) : -1
  await update($, selected, () => (keep >= 0 ? keep : next.length - 1))
}

/**
 * Answers already in the transcript (from before the mod loaded, or a resumed
 * session): each assistant message with text and no tool call is a turn's
 * final answer. Merged in transcript order; known ones keep their position.
 */
async function seedFromTranscript($: EngineInterface) {
  let messages: Awaited<ReturnType<EngineInterface['session']['messages']>>
  try { messages = await $.session.messages() } catch { return }
  if (!Array.isArray(messages)) return
  const answers = messages
    .filter(m => m.role === 'assistant' && m.toolUses.length === 0 && m.text.trim())
    .map(m => m.text.slice(0, MAX_CHARS))
    .filter(raw => makeDocument(raw).blocks.length > 0)
  if (!answers.length) return
  const list = await read($, docs)
  const same = (a: string, b: string) => a.trim() === b.trim()
  const fromTranscript = answers.filter(raw => !list.some(d => same(d.raw, raw)))
  if (!fromTranscript.length) return
  const oldId = list[await read($, selected)]?.id
  let id = await read($, sequence)
  const now = await $.clock.now()
  const added: SavedDoc[] = fromTranscript.map(raw => ({ id: ++id, raw, capturedAt: now, blockIndex: 0, wordIndex: 0 }))
  await update($, sequence, () => id)
  // Order by place in the transcript; captured answers it no longer holds
  // (compacted away) go first.
  const order = (d: SavedDoc) => answers.findIndex(raw => same(raw, d.raw))
  let next: SavedDoc[] = []
  await update($, docs, l => (next = [...l, ...added]
    .map((d, i) => ({ d, key: order(d), i }))
    .sort((a, b) => a.key - b.key || a.i - b.i)
    .map(x => x.d)
    .slice(-HISTORY_LIMIT)))
  const keep = next.findIndex(d => d.id === oldId)
  await update($, selected, () => (keep >= 0 ? keep : next.length - 1))
}

async function open($: EngineInterface, choose?: (length: number) => number) {
  await seedFromTranscript($)
  const length = (await read($, docs)).length
  if (!length) {
    $.ui.toast('SpeedRead: ask Claude a question first, then run /sr.')
    return
  }
  await pause($)
  await update($, selected, i => clampIndex(choose ? choose(length) : i < 0 ? length - 1 : i, length))
  await update($, paneOpen, () => true)
  const opened = await $.ui.open({ id: PANE, title: 'SpeedRead', focus: true, closeOnEscape: true, rows: 14 })
  if (!opened.isPlaced) $.ui.toast(`SpeedRead: pane not shown (${opened.reason})`)
}

// ---- Hooks ----------------------------------------------------------------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'sr',
      description: 'Read the latest Claude answer with SpeedRead (RSVP)',
      argumentHint: '[latest | previous | block N]',
      immediate: true,
    })
    // A reload cancels pending timers: come back paused, never mid-flash.
    stopTimer()
    await update($, playing, () => false)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined && e.reason === 'answer') await capture($, e.answer)
    return next(e)
  })

  on('command.run', { command: 'sr' }, async ($, e) => {
    const [mode = '', arg = ''] = String(e.args ?? '').trim().toLowerCase().split(/\s+/u)
    if (mode === 'previous' || mode === 'prev') {
      await open($, length => length - 2)
    } else if (mode === 'block') {
      await open($, length => length - 1)
      const n = Number.parseInt(arg, 10)
      const doc = await moveSelected($, d => {
        if (Number.isInteger(n) && n >= 1 && n <= d.blocks.length) seek(d, { blockIndex: n - 1, wordIndex: 0 })
      })
      if (doc && !(n >= 1 && n <= doc.blocks.length)) {
        return { text: `SpeedRead: block must be 1–${doc.blocks.length}.`, isTextDisplayOnly: true }
      }
    } else if (mode === '' || mode === 'latest' || mode === 'last') {
      await open($, length => length - 1)
    } else {
      return { text: 'Usage: /sr [latest | previous | block N]', isTextDisplayOnly: true }
    }
    return {}
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) {
      stopTimer()
      await update($, playing, () => false)
      await update($, paneOpen, () => false)
    }
    return next(e)
  }).catch(($, e, next) => next(e)) // Never hold a pane open because of our own failure.

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, docs)
    if (!list.length || e.props.hasSurvey || (await read($, paneOpen))) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {await next(e)}
        <Box flexDirection="row" columnGap={2}>
          <Button key="speedread-launch" hotkey="1" plain label="SpeedRead" onPress={() => open($, l => l - 1)} />
          <Text dimColor>{`${list.length} answer(s) ready · /sr`}</Text>
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Code } = $.ui.resolve(e)
    const list = await read($, docs)
    const index = await read($, selected)
    const wpm = await read($, wpmAtom)
    const isPlaying = await read($, playing)
    const scrubDir = await read($, scrub)
    const saved = list[index]
    if (!saved) return <Text dimColor>No answer captured yet. Ask Claude something, then /sr.</Text>

    const doc = toReader(saved)
    const b = activeBlock(doc)
    const word = activeWord(doc)
    const isCode = b?.kind === 'code'
    const percent = Math.round(progress(doc) * 100)
    const width = Math.max(20, e.props.bodyColumns)
    const pivotColumn = Math.min(PIVOT_COLUMN, Math.floor(width / 3))
    const parts = orpParts(word ?? 'End', pivotColumn)
    const kindLabel = isCode ? `CODE${b?.lang ? ` (${b.lang})` : ''} — press n to continue`
      : b?.kind && b.kind !== 'paragraph' ? b.kind.toUpperCase() : ''

    const cmd = (key: string, label: string, run: () => Promise<unknown>, autoFocus = false) => (
      <Button key={`sr-${key}`} hotkey={key} plain label={label} onPress={run} {...(autoFocus ? { autoFocus: true as const } : {})} />
    )
    const codeLines = isCode ? (b?.text ?? '').split('\n') : []

    return (
      <Box flexDirection="column" rowGap={1} paddingX={1}>
        <Text dimColor wrap="truncate">
          {`Answer ${index + 1}/${list.length} · block ${doc.blockIndex + 1}/${doc.blocks.length} · ${doc.totalWords} words · ${percent}%`}
        </Text>
        {isCode ? (
          <Box flexDirection="column">
            <Text dimColor>{kindLabel}</Text>
            <Code source={codeLines.slice(0, 8).join('\n') + (codeLines.length > 8 ? `\n… ${codeLines.length - 8} more lines` : '')} language={b?.lang || undefined} />
          </Box>
        ) : (
          <Box flexDirection="column">
            <Text dimColor>{kindLabel || ' '}</Text>
            <Text dimColor>{' '.repeat(pivotColumn) + '▾'}</Text>
            <Text bold wrap="truncate">
              {parts.pad + parts.before}
              <Text color="red" bold>{parts.pivot}</Text>
              {parts.after}
            </Text>
            <Text dimColor>{' '.repeat(pivotColumn) + '▴'}</Text>
          </Box>
        )}
        <Text dimColor wrap="truncate">{`${scrubDir > 0 ? '▶▶ FORWARD' : scrubDir < 0 ? '◀◀ BACK' : isPlaying ? '▶ PLAYING' : '❚❚ PAUSED'} · ${wpm} WPM · ${isCode ? '' : b?.text ?? ''}`}</Text>
        <Box flexDirection="row" columnGap={2} flexWrap="wrap">
          {cmd('p', isPlaying ? 'Pause' : 'Play', () => togglePlay($), true)}
          {cmd('k', 'Hold: back', () => scrubPress($, -1))}
          {cmd('j', 'Hold: forward', () => scrubPress($, 1))}
          {cmd('h', 'Prev word', () => manual($, previousOne))}
          {cmd('l', 'Next word', () => manual($, advanceOne))}
          {cmd('b', 'Prev block', () => manual($, d => jumpBlock(d, -1)))}
          {cmd('n', 'Next block', () => manual($, d => jumpBlock(d, +1)))}
        </Box>
        <Box flexDirection="row" columnGap={2} flexWrap="wrap">
          {cmd('s', 'Slower', () => changeWpm($, -WPM_STEP))}
          {cmd('f', 'Faster', () => changeWpm($, +WPM_STEP))}
          {cmd('r', 'Restart', () => manual($, d => seek(d, { blockIndex: 0, wordIndex: 0 })))}
          {cmd('u', 'Older answer', () => selectDoc($, i => i - 1))}
          {cmd('d', 'Newer answer', () => selectDoc($, i => i + 1))}
        </Box>
      </Box>
    )
  })
}
