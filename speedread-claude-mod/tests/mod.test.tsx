import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const PANE = {
  plugin: 'speedread',
  component: 'Pane',
  requestId: 'speedread-reader',
  props: {
    title: 'SpeedRead',
    isFocused: true,
    bodyColumns: 60,
    placement: 'inline',
    scroll: { offset: 0, bodyRows: 14 },
    view: {},
  },
} as const

// Nothing sits beneath the plugin: these hooks stand for the engine.
function engine(on: On, transcript: { role: 'user' | 'assistant'; text: string; toolUses: never[] }[] = []) {
  on('session.messages', () => ({ value: transcript }))
  on('command.register', () => ({ value: { command: 'sr' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  return mock.clock(on)
}

// What the person typing `/sr <args>` at the composer sends.
const sr = (args = '') => ({
  command: 'sr', args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: false, columns: 120 },
})

const answer = (text: string, extra: Record<string, unknown> = {}) => ({
  answer: text, durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' as const, ...extra,
})

test('captures an answer, opens with /sr and plays word by word on the clock', async ($, on) => {
  const clock = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.complete(answer('Привіт, світе. Це тест.'))
  await $.command.run(sr())

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Answer 1\/1/ }))?.text).toContain('4 words')
  expect((await ui.find({ type: 'Text', text: /PAUSED/ }))?.text).toContain('350 WPM')

  await ui.press({ key: 'sr-p' })
  expect(await ui.find({ type: 'Text', text: /PLAYING/ })).toBeTruthy()
  // "Привіт," is a clause end: 60000 / 350 * 1.4 ≈ 240 ms.
  await clock.advance(250)
  expect(await ui.find({ type: 'Text', text: /block 1\/1 · 4 words · 50%/ })).toBeTruthy()
  await clock.advance(5000)
  // Finished: back at the first word, paused, ready to replay.
  expect(await ui.find({ type: 'Text', text: /4 words · 25%/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /PAUSED/ })).toBeTruthy()
  await ui.unmount()
})

test('j taps one word; held j scrubs at reading speed until released; k goes back', async ($, on) => {
  const clock = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.complete(answer('w1 w2 w3 w4 w5 w6 w7 w8 w9 w10'))
  await $.command.run(sr())
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const at = async (pct: number) => expect((await ui.find({ type: 'Text', text: /10 words/ }))?.text).toContain(`10 words · ${pct}%`)

  await ui.press({ key: 'sr-j' }) // a tap
  await clock.advance(1000)
  await at(20)

  await ui.press({ key: 'sr-j' }) // held: first press, OS delay, then repeats
  await clock.advance(500)
  for (let t = 0; t < 12; t++) { await ui.press({ key: 'sr-j' }); await clock.advance(40) }
  expect(await ui.find({ type: 'Text', text: /FORWARD/ })).toBeTruthy()
  await clock.advance(1000) // released
  await at(80) // 1 at the first repeat, then one per 171 ms word until 250 ms pass with no repeat
  expect(await ui.find({ type: 'Text', text: /PAUSED/ })).toBeTruthy()

  await ui.press({ key: 'sr-k' })
  await clock.advance(1000)
  await at(70)
  await ui.unmount()
})

test('answers from before the mod loaded are read from the transcript', async ($, on) => {
  engine(on, [
    { role: 'user', text: 'q1', toolUses: [] },
    { role: 'assistant', text: 'old answer one', toolUses: [] },
    { role: 'user', text: 'q2', toolUses: [] },
    { role: 'assistant', text: 'old answer two', toolUses: [] },
  ])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.complete(answer('old answer two'))
  await $.command.run(sr())
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Answer 2\/2/ })).toBeTruthy()
  await ui.press({ key: 'sr-u' })
  expect(await ui.find({ type: 'Text', text: /Answer 1\/2 · block 1\/1 · 3 words/ })).toBeTruthy()
  await ui.unmount()
})

test('subagent and aborted turns are not captured', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.complete(answer('from a subagent', { agentId: 'a1' }))
  await $.turn.complete(answer('cut short', { reason: 'aborted', isAborted: true }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /No answer captured yet/ })).toBeTruthy()
  await ui.unmount()
})

test('a new answer never replaces the one being read', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.complete(answer('first answer here'))
  await $.command.run(sr())
  await $.turn.complete(answer('second'))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Answer 1\/2/ }))?.text).toContain('3 words')
  await ui.press({ key: 'sr-d' })
  expect(await ui.find({ type: 'Text', text: /Answer 2\/2/ })).toBeTruthy()
  await ui.unmount()
})

test('code blocks stop autoplay and are shown as code', async ($, on) => {
  const clock = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.complete(answer('Run this:\n\n```ts\nconst a = 1\n```\n\nDone now.'))
  await $.command.run(sr())
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'sr-p' })
  await clock.advance(5000)
  expect(await ui.find({ type: 'Text', text: /CODE \(ts\)/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /PAUSED/ })).toBeTruthy()
  await ui.press({ key: 'sr-n' })
  expect(await ui.find({ type: 'Text', text: /block 3\/3/ })).toBeTruthy()
  await ui.unmount()
})

test('/sr block N jumps, and a bad N says the range', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.complete(answer('# Title\n\nOne.\n\nTwo.'))
  await $.command.run(sr('block 3'))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /block 3\/3/ })).toBeTruthy()
  await ui.unmount()
  const bad = await $.command.run(sr('block 9'))
  expect(bad.text).toContain('1–3')
})
