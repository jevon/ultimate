import { expect, it } from 'vitest'
import type { OverviewRow } from '../../extensions/conversations/types.ts'
import { cuesOf, listener } from '../../extensions/sounds/cues.ts'
import type { Watched } from '../../extensions/sounds/cues.ts'

const agent = 7
const answered = (answerId: number, extra: Partial<OverviewRow> = {}): OverviewRow => ({
  runState: 'answered',
  inputId: answerId - 1,
  answerId,
  ...extra,
})
const watched = (extra: Partial<Watched> = {}): Watched => ({ agent, messages: [], ...extra })
const sounds = (state: Watched) => cuesOf(state).map((cue) => cue.sound)

it('tells a question, a finished answer and a failed run apart', () => {
  expect(cuesOf(watched({ row: answered(10) }))).toEqual([{ key: '7:10', sound: 'finished' }])
  expect(cuesOf(watched({ row: { runState: 'error', inputId: 4 } }))).toEqual([
    { key: '7:4', sound: 'failed' },
  ])
  const messages = [
    { id: 1, from: agent, to: 'user' as const, reply: true },
    { id: 2, from: agent, to: 'user' as const, reply: false },
  ]
  expect(cuesOf(watched({ messages }))).toEqual([
    { key: 'message:1', sound: 'input' },
    { key: 'message:2', sound: 'finished' },
  ])
})

it('stays quiet for everything that is not @ultimate talking to the user', () => {
  // Answering another agent's message, not the user.
  expect(sounds(watched({ row: answered(10, { internalInput: true }) }))).toEqual([])
  // Messages from other agents to the user, and @ultimate's messages to branches.
  const messages = [
    { id: 1, from: 30726, to: 'user' as const, reply: true },
    { id: 2, from: 110108, to: 'user' as const, reply: false },
    { id: 3, from: agent, to: 158849, reply: true },
    { id: 4, from: 'user' as const, to: agent, reply: false },
  ]
  expect(sounds(watched({ messages }))).toEqual([])
  expect(sounds(watched({ row: { runState: 'working', inputId: 9 } }))).toEqual([])
  expect(cuesOf({ messages })).toEqual([])
})

it('takes what is there at first as heard, and sounds later news once', () => {
  const hear = listener()
  const message = { id: 1, from: agent, to: 'user' as const, reply: true }
  expect(hear(watched({ messages: [message] }))).toEqual([])
  expect(hear(watched({ messages: [message] }))).toEqual([])
  const next = { id: 2, from: agent, to: 'user' as const, reply: true }
  expect(hear(watched({ messages: [message, next] })).map((cue) => cue.key)).toEqual(['message:2'])
  expect(hear(watched({ messages: [message, next] }))).toEqual([])
  expect(hear(watched({ row: { runState: 'error', inputId: 30 } }))).toEqual([
    { key: '7:30', sound: 'failed' },
  ])
})

it('sounds each landing once, and not those that arrive while catching up', () => {
  const hear = listener()
  expect(hear(watched({ landings: [{ id: 1 }] }))).toEqual([])
  expect(hear(watched({ landings: [{ id: 2 }, { id: 1 }] }))).toEqual([
    { key: 'landed:2', sound: 'landed' },
  ])
  expect(hear(watched({ landings: [{ id: 2 }, { id: 1 }] }))).toEqual([])
  expect(hear(watched({ landings: [{ id: 3 }, { id: 2 }] }), true)).toEqual([])
  expect(hear(watched({ landings: [{ id: 3 }, { id: 2 }] }))).toEqual([])
})
