import type { EntryRecord } from '@earendil-works/pi-durable'
import { describe, expect, it } from 'vitest'
import { reply, threading, threadsOf } from '../../extensions/threads/threads.tsx'
import type { Message } from '../../extensions/messages/refs.ts'
import { threadStream } from '../../web/src/app/compact.ts'

// Shapes as @ultimate's stored history has them: inputs carry `input`, a response its tool calls, a result its call id.
const ULTIMATE = 10
let next = 1
const entry = (kind: string, rest: Partial<EntryRecord> = {}) =>
  ({ id: next++, conversationId: ULTIMATE, kind, ...rest }) as EntryRecord
const prompt = () =>
  entry('pi.user', { input: true, model: [{ role: 'user', content: '', timestamp: 0 }] })
const fromBranch = (from: number | 'user', id: number, kind = 'board.message', input = true) =>
  entry(kind, { ...(input ? { input: true } : {}), data: { id, from } })
const landed = (branch: number) =>
  entry('workspaces.lander-report', {
    input: true,
    data: {
      id: `${branch}-x`,
      outcome: { outcome: 'landed', conversationId: branch, sha: 'abc1234def' },
    },
  })
const respond = (calls: { id: string; name: string; to?: string }[] = []) =>
  entry('pi.assistant', {
    model: [
      {
        role: 'assistant',
        stopReason: calls.length ? 'toolUse' : 'stop',
        content: calls.map(({ id, name, to }) => ({
          type: 'toolCall',
          id,
          name,
          arguments: { to },
        })),
      },
    ],
  } as unknown as Partial<EntryRecord>)
const result = (call: string, toolName: string, text = '') =>
  entry('pi.tool-result', {
    model: [
      {
        role: 'toolResult',
        toolCallId: call,
        toolName,
        content: [{ type: 'text', text }],
        isError: false,
      },
    ],
  } as unknown as Partial<EntryRecord>)
const message = (m: Partial<Message> & Pick<Message, 'id' | 'from' | 'to'>): Message => ({
  text: '',
  at: 0,
  reply: false,
  state: 'delivered',
  ...m,
})

describe('threadsOf', () => {
  it('buckets three interleaving branches, their turns, the answers to their questions and a landing', () => {
    next = 1
    const entries = [
      prompt(), // 1: the user asks for three features
      respond([
        { id: 'b1', name: 'branch' },
        { id: 'b2', name: 'branch' },
        { id: 'b3', name: 'branch' },
      ]), // 2
      result('b1', 'branch', 'Branch #21 started; message 1 sent.'), // 3
      result('b2', 'branch', 'Branch #22 started; message 2 sent.'), // 4
      result('b3', 'branch', 'Branch #23 started; message 3 sent.'), // 5
      respond(), // 6: "started all three"
      fromBranch(22, 4, 'board.reply'), // 7: #22 reports
      respond([{ id: 'q', name: 'message', to: 'user' }]), // 8: asks the user about #22
      result('q', 'message'), // 9
      fromBranch(21, 6), // 10: #21 steps in between
      fromBranch(21, 7, 'board.message', false), // 11: and leaves a note
      respond([{ id: 'c', name: 'codemode' }]), // 12
      result('c', 'codemode'), // 13
      respond(), // 14
      fromBranch('user', 8), // 15: the user answers the question about #22
      respond([{ id: 'go', name: 'message', to: '#22' }]), // 16: relays the go
      result('go', 'message'), // 17
      landed(23), // 18
      respond(), // 19
      prompt(), // 20: something else entirely
      respond(), // 21
    ]
    const messages = [
      message({ id: 5, from: ULTIMATE, to: 'user', reply: true, call: 'q' }),
      message({ id: 8, from: 'user', to: ULTIMATE, re: 5 }),
      message({ id: 9, from: ULTIMATE, to: 22, call: 'go' }),
    ]
    const threaded = threadsOf(entries, messages, ULTIMATE)
    const { of, threads } = threaded
    const at = (id: number) => of.get(id) ?? []
    // Starting them: the user's prompt woke that turn, so all of it stays in no thread; the threads begin there.
    expect([1, 2, 3, 6].map(at)).toEqual([[], [], [], []])
    expect(threads.map((thread) => thread.first)).toEqual([2, 2, 2])
    // #22's report wakes a turn; the question asked in it, and the user's answer, are #22's.
    expect([7, 8, 9].map(at)).toEqual([[22], [22], [22]])
    expect(at(15)).toEqual([22])
    // The answer wakes a turn of #22's from its first token, so relaying the go stays there.
    expect([16, 17].map(at)).toEqual([[22], [22]])
    // #21 interleaves: its message, note and the turn they wake are #21's alone.
    expect([10, 11, 12, 13, 14].map(at)).toEqual([[21], [21], [21], [21], [21]])
    // A landing and the turn it wakes.
    expect([18, 19].map(at)).toEqual([[23], [23]])
    expect(threads.find((thread) => thread.id === 23)?.landed).toEqual({
      entry: 18,
      sha: 'abc1234def',
    })
    // The user's unrelated prompt belongs to no thread.
    expect([20, 21].map(at)).toEqual([[], []])
    expect(threads.map((thread) => thread.id)).toEqual([21, 22, 23])
    // The question asked about #22 is the thread's, so its open question waits on the user there.
    expect(threads.find((thread) => thread.id === 22)?.asks).toEqual([5])

    // The main stream: the turn that started all three stays, with their roots after its answer; each thread's later
    // traffic leaves for its thread; the unrelated prompt stays.
    const stream = threading(entries, threaded)
    expect([...stream.roots]).toEqual([
      [21, 6],
      [22, 6],
      [23, 6],
    ])
    const main = entries.filter((e) => !stream.hidden.has(e.id)).map((e) => e.id)
    expect(main).toEqual([1, 2, 3, 4, 5, 6, 20, 21])
  })

  it('puts a reply typed in a thread, and the turn it wakes, in that thread', () => {
    next = 1
    const entries = [
      prompt(),
      respond([{ id: 'b', name: 'branch' }]),
      result('b', 'branch', 'Branch #31 started; message 1 sent.'),
      respond(),
      entry('pi.user', {
        input: true,
        model: [{ role: 'user', content: reply(31, 'make it blue'), timestamp: 0 }],
      }),
      respond([{ id: 'm', name: 'message', to: '#31' }]),
      result('m', 'message'),
      respond(),
    ]
    const { of } = threadsOf(entries, [], ULTIMATE)
    expect([5, 6, 7, 8].map((id) => of.get(id))).toEqual([[31], [31], [31], [31]])
  })

  it('knows a branch started from a script before it reports, so its card shows while it works', () => {
    next = 1
    // As a fresh @ultimate does it: one codemode script starts three branches; the result names none of them.
    const entries = [
      prompt(),
      respond([{ id: 's', name: 'codemode' }]),
      result('s', 'codemode', 'Script completed'),
      respond(),
    ]
    const messages = [21, 22, 23].map((to, index) =>
      message({ id: index + 1, from: ULTIMATE, to, call: `s/${index}` }),
    )
    const threaded = threadsOf(entries, messages, ULTIMATE)
    expect(threaded.threads.map((thread) => thread.id)).toEqual([21, 22, 23])
    expect([...threading(entries, threaded).roots.values()]).toEqual([4, 4, 4])
  })

  it("keeps a turn the user's own prompt woke in main, even when a branch report woke it too", () => {
    next = 1
    const entries = [
      prompt(),
      respond([{ id: 'b', name: 'branch' }]),
      result('b', 'branch', 'Branch #51 started; message 1 sent.'),
      respond(),
      fromBranch(51, 2, 'board.reply'), // 5: a report and
      prompt(), // 6: the user's prompt, both before @ultimate answers
      respond(), // 7: its answer is to the user
    ]
    const { of, live } = threadsOf(entries, [], ULTIMATE)
    expect(of.get(5)).toEqual([51])
    expect([6, 7].map((id) => of.get(id))).toEqual([undefined, undefined])
    expect(live).toEqual([])
  })

  it('places a turn the same once the message log has dropped its messages', () => {
    next = 1
    // #61 asks through @ultimate; the user's answer wakes a turn of #61's. The log no longer holds messages 3 and 4.
    const entries = [
      prompt(),
      respond([{ id: 'b', name: 'branch' }]),
      result('b', 'branch', 'Branch #61 started; message 1 sent.'),
      respond(),
      fromBranch(61, 2, 'board.reply'),
      respond([{ id: 'q', name: 'message', to: 'user' }]),
      result('q', 'message', 'Message 3 sent.'),
      entry('board.message', { input: true, data: { id: 4, from: 'user', re: 3 } }),
      respond(), // 9: answered in #61's thread
    ]
    const pruned = threadsOf(entries, [], ULTIMATE)
    const logged = threadsOf(
      entries,
      [
        message({ id: 3, from: ULTIMATE, to: 'user', reply: true, call: 'q' }),
        message({ id: 4, from: 'user', to: ULTIMATE, re: 3 }),
      ],
      ULTIMATE,
    )
    expect([8, 9].map((id) => pruned.of.get(id))).toEqual([[61], [61]])
    expect([...pruned.of]).toEqual([...logged.of])
    // The transcript shows a call's result inside its call, so the stream it renders has no result rows; the threads
    // still come from every loaded entry, and the answer's turn stays out of the main stream.
    const stream = threadStream(
      entries.filter((e) => e.kind !== 'pi.tool-result'),
      threading(entries, pruned),
      undefined,
    ).map((e) => e.id)
    expect(stream).not.toContain(8)
    expect(stream).not.toContain(9)
  })

  it('decides a running turn by what woke it, and never moves it after', () => {
    next = 1
    // A branch reports, and @ultimate is mid-run: its thread is known before the first response streams.
    const woken = [
      prompt(),
      respond([{ id: 'b', name: 'branch' }]),
      result('b', 'branch', 'Branch #41 started; message 1 sent.'),
      respond(),
      fromBranch(41, 2, 'board.reply'),
    ]
    expect(threadsOf(woken, [], ULTIMATE).live).toEqual([41])
    // The user's own prompt wakes a turn that then messages #41 from a script: it stays in main throughout.
    const typed = [...woken, respond(), prompt()]
    expect(threadsOf(typed, [], ULTIMATE).live).toEqual([])
    const messages = [message({ id: 3, from: ULTIMATE, to: 41, call: 's/1' })]
    const after = [
      ...typed,
      respond([{ id: 's', name: 'codemode' }]),
      result('s', 'codemode'),
      respond(),
    ]
    const { of, live } = threadsOf(after, messages, ULTIMATE)
    expect(live).toEqual([])
    expect([7, 8, 9, 10].map((id) => of.get(id))).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ])
  })
})
