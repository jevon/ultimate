import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import type { JsonValue } from '@earendil-works/chord'
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { configure, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type {
  ConversationId,
  TaskGraph,
  TaskGraphNode,
  TaskId,
  Tx,
} from '@earendil-works/pi-durable'
import { afterEach, expect, it, vi } from 'vitest'
import { writeJson } from '../lib/json-file.ts'
import { prepareHarness } from '../server/harness.ts'
import type { OpenHost } from '../server/harness.ts'
import type { ExtensionHost } from '../server/extensions.ts'
import type { ActionContext } from '../server/actions.ts'
import { Metadata } from '../server/metadata.ts'
import { docs as lineageDocs } from '../extensions/lineage/server.ts'
import { Messages } from '../extensions/messages/api.ts'
import { Todos } from '../extensions/todos/server.ts'
import { Standing } from '../extensions/subagents/api.ts'
import { Compacted } from '../extensions/conversations/refs.ts'
import { ContextUsageDoc } from '../extensions/conversations/api.ts'
import automations, {
  actions as automationActions,
  Automations,
} from '../extensions/automations/server.ts'
import dream, {
  actions,
  fileJournal,
  Sessions,
  startDreamIn,
  startSession,
} from '../extensions/dream/server.ts'
import {
  ASLEEP_AFTER,
  asleepAfter,
  AUTOMATION_NAME,
  BuiltInDoc,
  compactionDream,
  DREAM_LOOK_MS,
  DREAM_WAIT_MS,
  ensureAutomation,
  HANDOFF_WAIT_MS,
  PAUSE_NAME,
  PauseDoc,
} from '../extensions/dream/before-compaction.ts'
import type { Origin } from '../extensions/dream/before-compaction.ts'
import { buildSeed } from '../extensions/dream/seed.ts'
import { apis, eventHost, temp, until } from './helpers.ts'

const openedHosts: OpenHost[] = []
/** The extensions' close callbacks: automations' minute timer stops before its harness closes. */
const closers: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of closers.splice(0)) await close()
  for (const opened of openedHosts.splice(0)) await opened.close()
  vi.useRealTimers()
})

/** A live task as the task graph lists it. */
function node(
  id: number,
  conversationId: number,
  state: TaskGraphNode['state'],
  background = false,
): TaskGraphNode {
  return {
    id: id as TaskId,
    kind: 'pi.generation',
    conversationId: conversationId as ConversationId,
    background,
    abortRequested: false,
    state,
    conversations: [],
  }
}

async function fixture() {
  const home = await temp('ultimate-dream-compaction-')
  const prepared = await prepareHarness({
    ultimateRoot: home,
    userHome: home,
    home,
    faux: fauxProvider(),
  })
  let opened: OpenHost
  const openers: (() => Promise<void>)[] = []
  const tokens = [...lineageDocs, Messages, Todos, Sessions]
  const resources = new Map<string, unknown>()
  const events = eventHost(() => opened.harness, 'test')
  let busy: { id: number; busy: boolean; title: string; parentConversationId?: number }[] = []
  /** The live tasks the wait reads; by default each busy conversation runs a model response. */
  let tasks: TaskGraph['tasks'] | undefined
  const graphOf = (): TaskGraph['tasks'] =>
    tasks ??
    Object.fromEntries(
      busy
        .filter((item) => item.busy)
        .map((item, index) => [
          String(900 + index),
          node(900 + index, item.id, { status: 'running', phase: 'request' }),
        ]),
    )
  const notes: { to: number; text: string }[] = []
  const leaveNote = vi.fn<
    (to: number, text: string, options?: { requestId: string }) => Promise<void>
  >(async (to, text) => void notes.push({ to, text }))
  const notices: string[] = []
  const services = apis(
    new Map<string, unknown>([
      ['messages', { send: async () => ({}) }],
      [
        'lineage',
        {
          rootOf: async () => undefined,
          leaveNote,
        },
      ],
      [
        'subagents',
        {
          standing: async () =>
            (await opened.harness.snapshot(Standing, ROOT_CONVERSATION_ID, context))!.ultimate,
        },
      ],
    ]),
  )
  const invoke = vi.fn<ExtensionHost['invoke']>(async (extension, action, args) => {
    if (extension !== 'automations') throw new Error(`Unexpected ${extension}/${action}`)
    return automationActions[action as 'list'](args, { host } as ActionContext)
  })
  const host = {
    ...prepared,
    ...events,
    ...services,
    get chapter() {
      return prepared.chapter
    },
    harness: () => opened.harness,
    resource: (key: string, create: () => unknown) => {
      if (!resources.has(key)) resources.set(key, create())
      return resources.get(key)
    },
    metadata: Metadata,
    onRelease: () => {},
    onClose: (callback: () => Promise<void>) => void closers.push(callback),
    onOpen: (callback: () => Promise<void>) => void openers.push(callback),
    projectSetup: async () => ({ decision: false }),
    projectSettings: async () => ({}),
    extensions: () => [
      { name: 'subagents', enabled: true },
      { name: 'automations', enabled: true },
    ],
    conversations: () => busy,
    doc: (kind: string) =>
      tokens.find((token) => token.definition.kind === kind) ?? events.doc(kind),
    notice: (message: string) => void notices.push(message),
    invoke,
  } as unknown as ExtensionHost
  prepared.registry.install(automations(host))
  prepared.registry.install(dream(host))
  opened = await prepared.open(false)
  openedHosts.push(opened)
  const ultimate = await opened.harness.commit(async (tx) => {
    const created = await tx.createConversation({ ownership: { kind: 'ownerless' } })
    await configure(tx, created.id, {})
    ;(await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate = created.id
    return created.id
  }, context)
  for (const open of openers) await open()
  await events.start()
  const harness = opened.harness
  const call = { host } as ActionContext
  const sessions = async () =>
    (await harness.snapshot(Sessions, ROOT_CONVERSATION_ID, context))?.sessions ?? []
  const own = async () => (await harness.snapshot(BuiltInDoc, ROOT_CONVERSATION_ID, context))?.id
  const ownPause = async () => (await harness.snapshot(PauseDoc, ROOT_CONVERSATION_ID, context))?.id
  /** Every automation's id: the two built-ins, and whatever a test made. */
  const ids = async () => Object.keys((await harness.snapshot(Automations, context))!.automations)
  const record = async (id: string) =>
    (await harness.snapshot(Automations, context))!.automations[id]
  const compact = (conversation: number) =>
    harness.commit(async (tx) => {
      const entry = await tx.appendEntry(conversation as ConversationId, {
        kind: 'pi.compaction',
        data: { reason: 'threshold' },
        model: [
          {
            role: 'user',
            content:
              'The conversation history before this point was compacted into the following summary:\n\n<summary>\nI was building dream after compaction (#355131).\n\n<project_memory root="#1">\nabout-daniel\n</project_memory>\n</summary>',
            timestamp: 0,
          },
        ],
      })
      await host.emit(tx, Compacted, {
        conversation,
        entry: entry.id,
      })
    }, context)
  /** @ultimate's context usage, as conversations measures it after an answer. */
  const usage = (percent: number) =>
    harness.commit(async (tx) => {
      Object.assign(await tx.doc(ContextUsageDoc, ultimate), {
        percent,
        tokens: percent * 10000,
        window: 1000000,
        at: Date.now(),
      })
    }, context)
  const waiting = async () =>
    (await harness.snapshot(Sessions, ROOT_CONVERSATION_ID, context))?.waiting
  /** The submission of a dream delivery to @ultimate by its request id. */
  const submitted = (requestId: string) =>
    harness.commit((tx) => tx.submissionByRequest(ultimate, requestId), context)
  const waits = () =>
    harness.commit(
      async (tx) =>
        (
          await tx.scanTasks(
            { conversationId: ROOT_CONVERSATION_ID, kind: 'dream.handoff-wait' },
            10,
          )
        ).items,
      context,
    )
  const deps = {
    Sessions,
    switching: () =>
      (resources.get('dream.switching') as { busy: boolean } | undefined)?.busy ?? false,
    start:
      vi.fn<(tx: Tx, origin: Origin, tasks: TaskGraph['tasks']) => Promise<{ session: number }>>(),
    tasks: async () => graphOf(),
  }
  return {
    host,
    harness,
    home,
    ultimate,
    call,
    sessions,
    own,
    ownPause,
    ids,
    record,
    compact,
    usage,
    waiting,
    submitted,
    waits,
    notes,
    leaveNote,
    notices,
    invoke,
    deps,
    busy: (items: typeof busy) => {
      busy = items
    },
    tasks: (items: TaskGraph['tasks'] | undefined) => {
      tasks = items
    },
    settle: () => until(events.settled),
    action: (name: keyof typeof automationActions, args: JsonValue = {}) =>
      automationActions[name](args, {
        host,
        conversationId: ultimate,
      } as unknown as ActionContext),
  }
}

it('ships one enabled "Dream before compaction" automation that wakes @ultimate, and keeps a deletion', async () => {
  const f = await fixture()
  const id = (await f.own())!
  const made = await f.record(id)
  expect(made).toMatchObject({
    name: AUTOMATION_NAME,
    enabled: true,
    condition: { metric: 'context', of: '@ultimate', above: 70, armed: true },
    subscribers: [f.ultimate],
  })
  expect(made.event).toBeUndefined()
  // Opening again (a facet reload, a restart) makes no second one.
  const pause = (await f.ownPause())!
  await ensureAutomation(f.host)
  expect(await f.ids()).toEqual([id, pause])
  // The user deletes it: it stays deleted.
  await f.action('delete', { id })
  await ensureAutomation(f.host)
  expect(await f.ids()).toEqual([pause])
  expect(await f.harness.snapshot(BuiltInDoc, ROOT_CONVERSATION_ID, context)).toMatchObject({
    deleted: true,
  })
})

it('migrates the old "Dream after compaction" in place: same id, enabled state and subscribers', async () => {
  const f = await fixture()
  const id = (await f.own())!
  // The record as it was before this feature, paused by the user.
  await f.harness.commit(async (tx) => {
    const a = (await tx.doc(Automations)).automations[id]
    a.name = 'Dream after compaction'
    delete a.condition
    a.event = {
      name: 'conversations.compacted',
      where: { conversation: '@ultimate' },
      sinceEvent: 0,
    }
  }, context)
  await f.action('pause', { id })
  await ensureAutomation(f.host)
  const migrated = await f.record(id)
  expect(migrated).toMatchObject({
    id,
    name: AUTOMATION_NAME,
    enabled: false,
    subscribers: [f.ultimate],
    condition: { metric: 'context', of: '@ultimate', above: 70 },
  })
  expect(migrated.event).toBeUndefined()
  // A migration whose receipt was lost (the old record, no id in dream's document) is migrated, not duplicated.
  await f.harness.commit(async (tx) => {
    const a = (await tx.doc(Automations)).automations[id]
    a.name = 'Dream after compaction'
    delete a.condition
    a.event = {
      name: 'conversations.compacted',
      where: { conversation: '@ultimate' },
      sinceEvent: 0,
    }
    delete (await tx.doc(BuiltInDoc, ROOT_CONVERSATION_ID)).id
  }, context)
  await ensureAutomation(f.host)
  expect(await f.own()).toBe(id)
  expect(await f.ids()).toEqual([id, await f.ownPause()])
  expect((await f.record(id)).condition?.above).toBe(70)
  // The user's threshold stays: a later check leaves a migrated automation as it is.
  await f.action('update', { id, condition: { metric: 'context', of: '@ultimate', above: 60 } })
  await ensureAutomation(f.host)
  expect((await f.record(id)).condition?.above).toBe(60)
})

it('fires once at 70% and re-arms below 60%, asking for one handoff per fire', async () => {
  const f = await fixture()
  const id = (await f.own())!
  f.busy([{ id: 50, busy: true, title: 'A branch at work' }])
  // The scheduler runs the deliveries and the wait, as on a real host.
  f.host.harness().resume()
  await f.usage(69)
  await until(async () => (await f.record(id)).condition?.value === 69)
  expect(await f.waiting()).toBeUndefined()
  await f.usage(71)
  await f.settle()
  await until(async () => (await f.waiting()) !== undefined)
  const first = (await f.waiting())!
  expect(first.automation).toEqual({ id, name: AUTOMATION_NAME })
  // The fire's own input wakes @ultimate; the handoff ask is a passive write in that run, so it costs one turn.
  await until(async () => (await f.submitted(`dream.handoff:${first.task}`)) !== undefined)
  expect((await f.submitted(`dream.handoff:${first.task}`))?.type).toBe('write')
  // Still above: no second fire, no second request.
  await f.usage(75)
  await until(async () => (await f.record(id)).condition?.value === 75)
  expect((await f.record(id)).fires).toBe(1)
  expect(await f.waits()).toHaveLength(1)
  // Below 60 re-arms it; a second fire while the first request waits makes no second request.
  await f.usage(59)
  await until(async () => (await f.record(id)).condition?.armed === true)
  expect((await f.waiting())?.task).toBe(first.task)
})

it('starts the analysis once the handoff is recorded and nothing else works, carrying the handoff', async () => {
  const f = await fixture()
  const { look, request } = compactionDream(f.host, f.deps)
  f.deps.start.mockImplementation((tx, origin, tasks) => startDreamIn(f.host, tx, origin, tasks))
  const id = (await f.own())!
  const { task } = await f.harness.commit(
    (tx) => request(tx, 0, f.ultimate, { id, name: AUTOMATION_NAME }),
    context,
  )
  // No handoff yet, and well within the 30 minutes: it keeps waiting, even with nothing else at work.
  expect(await look(task, 10)).toBe('look')
  await expect(actions.handoff({ text: '' }, f.call)).rejects.toThrow('nonempty')
  await expect(actions.handoff({ text: 'x'.repeat(12_001) }, f.call)).rejects.toThrow('12000')
  expect(
    await actions.handoff({ text: 'I was moving the dream before compaction.' }, f.call),
  ).toEqual({ task })
  // Another conversation at work holds it off; @ultimate's own turn does not.
  f.busy([{ id: 50, busy: true, title: 'A branch at work' }])
  expect(await look(task, 20)).toBe('look')
  f.busy([{ id: f.ultimate, busy: true, title: '@ultimate' }])
  expect(await look(task, 30)).toBe('started')
  const [started] = await f.sessions()
  expect(started.handoff).toEqual({
    task,
    text: 'I was moving the dream before compaction.',
    at: expect.any(Number),
  })
  expect(started.beforeCompaction).toEqual({ automation: id, name: AUTOMATION_NAME, at: 30 })
  expect(await f.waiting()).toBeUndefined()
  await until(async () => (await f.submitted('dream.started:1')) !== undefined)
  // A handoff with nothing waiting is refused.
  await expect(actions.handoff({ text: 'Late' }, f.call)).rejects.toThrow('No dream waits')
  // The old wait looks again: its request is gone, so it does nothing.
  expect(await look(task, 40)).toBe('done')
  expect(await f.sessions()).toHaveLength(1)
})

it('starts without a handoff after 30 minutes and says so, and gives up after two hours with a quiet note', async () => {
  const f = await fixture()
  const { look, request } = compactionDream(f.host, f.deps)
  f.deps.start.mockImplementation((tx, origin, tasks) => startDreamIn(f.host, tx, origin, tasks))
  const first = await f.harness.commit((tx) => request(tx, 0, f.ultimate), context)
  expect(await look(first.task, HANDOFF_WAIT_MS - 1)).toBe('look')
  expect(await look(first.task, HANDOFF_WAIT_MS)).toBe('started')
  const [started] = await f.sessions()
  expect(started.handoff).toEqual({ task: first.task, missing: expect.stringContaining('30') })
  // Pressed by the user: no built-in automation on the session.
  expect(started.beforeCompaction).toBeUndefined()
  await f.action('delete', { id: (await f.own())! })
  await actions.end({ session: 1 }, f.call)
  // Other conversations kept working: past two hours it gives up, starts nothing, and leaves a note.
  const second = await f.harness.commit((tx) => request(tx, 0, f.ultimate), context)
  f.busy([{ id: 50, busy: true, title: 'A branch at work' }])
  expect(await look(second.task, HANDOFF_WAIT_MS)).toBe('look')
  // The note fails: the wait looks again instead of ending, the request stays marked, and the next look leaves it.
  f.leaveNote.mockRejectedValueOnce(new Error('Crashed'))
  expect(await look(second.task, DREAM_WAIT_MS)).toBe('look')
  expect(await f.waiting()).toMatchObject({ task: second.task, gaveUp: true })
  f.busy([])
  expect(await look(second.task, DREAM_WAIT_MS + 1)).toBe('done')
  // Left again on the retry (and by the wait task itself, which the first start resumed), always under the same
  // request id, so lineage records the note once.
  const keys = f.leaveNote.mock.calls.map(([, , options]) => options?.requestId)
  expect(keys.length).toBeGreaterThanOrEqual(2)
  expect(new Set(keys)).toEqual(new Set([`dream.handoff-wait:${second.task}`]))
  expect(f.notes.at(-1)).toEqual({ to: f.ultimate, text: expect.stringContaining('did not start') })
  expect(await f.sessions()).toHaveLength(1)
  expect(await f.waiting()).toBeUndefined()
})

it('waits only for conversations actively working: a coordinator parked on its worker does not hold it', async () => {
  const f = await fixture()
  const { look, request } = compactionDream(f.host, f.deps)
  f.deps.start.mockImplementation((tx, origin, tasks) => startDreamIn(f.host, tx, origin, tasks))
  const { task: wait } = await f.harness.commit((tx) => request(tx, 0, f.ultimate), context)
  await actions.handoff({ text: 'Handoff' }, f.call)
  f.busy([
    { id: 50, busy: true, title: 'A coordinator' },
    { id: 51, busy: true, title: 'Its worker', parentConversationId: 50 },
  ])
  const response = (on: number) =>
    node(1, 50, {
      status: 'waiting',
      phase: 'tools',
      on: [on as TaskId],
      policy: 'failFast',
    })
  // Its response waits on its own tool call, which runs (a polling bash, a foreground subagent wait): it works.
  f.tasks({
    1: response(2),
    2: { ...node(2, 50, { status: 'running', phase: 'execute' }), kind: 'pi.tool' },
  })
  expect(await look(wait, 10)).toBe('look')
  // Its response waits only on its worker's run, and its own background tasks wait: it does not work. The running
  // worker is not top-level, as before.
  f.tasks({
    1: response(3),
    3: node(3, 51, { status: 'running', phase: 'request' }),
    4: node(4, 50, { status: 'sleeping', phase: 'look', until: 1 }, true),
  })
  expect(await look(wait, 20)).toBe('started')
  expect(await f.sessions()).toHaveLength(1)
})

it('does not count a Pause or a stopped host against the wait: a late look moves both deadlines', async () => {
  const f = await fixture()
  const { look, request, Wait } = compactionDream(f.host, f.deps)
  const { task: wait } = await f.harness.commit((tx) => request(tx, 0, f.ultimate), context)
  /** The wait task's own look at `now`, due at `due`, as the scheduler runs it: its next sleep, or `ended`. */
  const run = async (now: number, due?: number) => {
    const runtime = {
      now: () => now,
      sleepUntil: vi.fn<(...args: unknown[]) => Promise<void>>(async () => {}),
      commit: vi.fn<() => Promise<void>>(async () => {}),
    }
    const checkpoint = { phase: 'look' as const, ...(due === undefined ? {} : { due }) }
    await Wait.definition.phases.look(
      { id: String(wait), state: { status: 'running', checkpoint } } as never,
      runtime as never,
      context,
    )
    return runtime.sleepUntil.mock.calls[0]?.slice(0, 2) ?? 'ended'
  }
  expect(await run(10)).toEqual([10 + DREAM_LOOK_MS, { phase: 'look', due: 10 + DREAM_LOOK_MS }])
  // Held by Pause for ten hours, 25 minutes after the request: that look comes ten hours late. It does not give up,
  // and no handoff yet still means waiting for one: neither deadline counted the pause.
  const pause = 10 * 3600_000
  const at = 25 * 60_000
  expect(await run(at + pause, at)).toEqual([at + pause + DREAM_LOOK_MS, expect.anything()])
  expect(await f.waiting()).toMatchObject({ task: wait, unseen: pause })
  expect((await f.waiting())?.gaveUp).toBeUndefined()
  // Another conversation keeps working. A look a little late (a busy host) changes nothing.
  f.busy([{ id: 50, busy: true, title: 'A branch at work' }])
  const late = pause + HANDOFF_WAIT_MS
  expect(await run(late, late - 30_000)).not.toBe('ended')
  expect((await f.waiting())?.unseen).toBe(pause)
  // Two hours of looking after the request, it still gives up.
  expect(await look(wait, pause + DREAM_WAIT_MS - 1)).toBe('look')
  expect(await look(wait, pause + DREAM_WAIT_MS)).toBe('done')
  expect(f.notes.at(-1)).toEqual({ to: f.ultimate, text: expect.stringContaining('did not start') })
  expect(await f.waiting()).toBeUndefined()
  expect(f.deps.start).not.toHaveBeenCalled()
})

it('gives a request whose wait faulted a new wait, keeping its handoff, and ends one whose wait was aborted', async () => {
  const f = await fixture()
  const { healed } = compactionDream(f.host, f.deps)
  // The live wait faulted when a reload changed its contract mid-edit: its request blocked every later dream.
  const lost = { at: 5, task: 424242, handoff: { text: 'Handoff', at: 6 } }
  await f.harness.commit(async (tx) => {
    ;(await tx.doc(Sessions, ROOT_CONVERSATION_ID)).waiting = { ...lost }
  }, context)
  // The user presses Dream: the request looks again, and still waits.
  await expect(actions.start(null, f.call)).rejects.toThrow('already waits')
  const [wait] = await f.waits()
  expect(await f.waiting()).toEqual({ ...lost, task: Number(wait.id) })
  // A live wait stays as it is.
  await f.harness.commit((tx) => healed(tx).then(() => undefined), context)
  expect(await f.waits()).toHaveLength(1)
  expect((await f.waiting())?.task).toBe(Number(wait.id))
  // Aborted by hand: the request goes, and a new one may start.
  f.host.harness().resume()
  await f.harness.abortTask(wait.id, context)
  await until(
    async () =>
      (await f.harness.commit((tx) => tx.task(wait.id), context))?.state.status === 'terminal',
  )
  await f.harness.commit((tx) => healed(tx).then(() => undefined), context)
  expect(await f.waiting()).toBeUndefined()
})

it('asks for a handoff when the user presses Dream, and refuses a second while one waits', async () => {
  const f = await fixture()
  const { task } = await actions.start(null, f.call)
  expect(await f.waiting()).toEqual({ at: expect.any(Number), task })
  await until(async () => (await f.submitted(`dream.handoff:${task}`)) !== undefined)
  expect((await f.submitted(`dream.handoff:${task}`))?.type).toBe('input')
  await expect(actions.start(null, f.call)).rejects.toThrow('already waits')
  expect(await f.sessions()).toEqual([])
})

it('does nothing while a chapter change runs or a sleep is under way', async () => {
  const f = await fixture()
  const { look, request } = compactionDream(f.host, f.deps)
  const { task } = await f.harness.commit((tx) => request(tx, 0, f.ultimate), context)
  await actions.handoff({ text: 'Handoff' }, f.call)
  const lock = f.host.resource('dream.switching', () => ({ busy: false }))
  lock.busy = true
  expect(await look(task, 10)).toBe('done')
  expect(await f.waiting()).toBeUndefined()
  await expect(f.harness.commit((tx) => request(tx, 0, f.ultimate), context)).rejects.toThrow(
    'chapter change',
  )
  lock.busy = false
  await f.harness.commit(async (tx) => {
    await startSession(tx, 1)
    const doc = await tx.doc(Sessions, ROOT_CONVERSATION_ID)
    doc.sessions[0].endedAt = 2
    doc.sessions[0].sleep = { chapter: 'next', phase: 'checking', at: 2 }
  }, context)
  await expect(f.harness.commit((tx) => request(tx, 0, f.ultimate), context)).rejects.toThrow(
    'falling asleep',
  )
  expect(f.deps.start).not.toHaveBeenCalled()
})

it('starts nothing once its automation is paused or deleted', async () => {
  const f = await fixture()
  const { look, request } = compactionDream(f.host, f.deps)
  const id = (await f.own())!
  const automation = { id, name: AUTOMATION_NAME }
  const first = await f.harness.commit((tx) => request(tx, 0, f.ultimate, automation), context)
  await actions.handoff({ text: 'Handoff' }, f.call)
  await f.action('pause', { id })
  expect(await look(first.task, 10)).toBe('done')
  await f.action('resume', { id })
  const second = await f.harness.commit((tx) => request(tx, 0, f.ultimate, automation), context)
  await actions.handoff({ text: 'Handoff' }, f.call)
  await f.action('delete', { id })
  expect(await look(second.task, 20)).toBe('done')
  expect(f.deps.start).not.toHaveBeenCalled()
})

/** A compaction's session with `applied` applied proposals and the rest rejected, all settled. */
async function settledSession(
  f: Awaited<ReturnType<typeof fixture>>,
  applied: number,
  pause?: number,
) {
  await f.harness.commit(async (tx) => {
    await startSession(tx, 1, {
      beforeCompaction:
        pause === undefined
          ? { automation: (await f.own())!, name: AUTOMATION_NAME, at: 1 }
          : { automation: (await f.ownPause())!, name: PAUSE_NAME, at: 1, pause },
      handoff: { task: 9, missing: 'no handoff within 30 minutes of the request' },
    })
    await fileJournal(
      tx,
      {
        session: 1,
        learned: ['One', 'Two', 'Three'],
        text: 'Journal',
        chapter: 'fresh-roots',
        proposals: Array.from({ length: 6 }, (_, index) => ({
          id: `p${index}`,
          pass: 'memory',
          title: `Proposal ${index}`,
        })),
      },
      2,
    )
  }, context)
  for (let index = 0; index < 6; index++)
    await actions.decide(
      {
        session: 1,
        proposal: `p${index}`,
        status: index < applied ? 'applied' : 'rejected',
      },
      f.call,
    )
}

it.each([
  [ASLEEP_AFTER - 1, 'stay'],
  [ASLEEP_AFTER, 'ask'],
] as const)('settles %i changes as %s, and never switches by itself', async (applied, result) => {
  const f = await fixture()
  const { settle } = compactionDream(f.host, f.deps)
  await settledSession(f, applied)
  const [found] = await f.sessions()
  // The last decide settled the session and created its check exactly once.
  expect(found.endedAt).toBeDefined()
  expect(found.beforeCompaction?.settling).toBeTypeOf('number')
  await settle(1)
  const [after] = await f.sessions()
  expect(after.beforeCompaction?.outcome).toMatchObject({
    changes: applied,
    threshold: ASLEEP_AFTER,
    result,
  })
  expect((await f.sessions())[0].sleep).toBeUndefined()
  // Only asking wakes @ultimate; the other outcomes are passive.
  const submitted = () =>
    f.harness.commit((tx) => tx.submissionByRequest(f.ultimate, 'dream.settled:1'), context)
  await until(async () => (await submitted()) !== undefined)
  expect((await submitted())?.type).toBe(result === 'ask' ? 'input' : 'write')
})

it('ships "Dream after a pause" at 50% after 8 h idle; its fire carries the pause and its dream always offers a fresh chapter', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const f = await fixture()
  const id = (await f.ownPause())!
  expect(await f.record(id)).toMatchObject({
    name: PAUSE_NAME,
    enabled: true,
    condition: { of: '@ultimate', above: 50, idleFor: 8 * 3600_000 },
    subscribers: [f.ultimate],
  })
  // Eight hours and a bit without the user's input, at 55%: it fires and asks for a handoff that names the pause.
  vi.setSystemTime(Date.now() + 9 * 3600_000)
  await f.usage(55)
  await f.settle()
  await until(async () => (await f.waiting()) !== undefined)
  const waiting = (await f.waiting())!
  expect(waiting.automation).toMatchObject({ id, name: PAUSE_NAME })
  expect(waiting.automation!.pause).toBeGreaterThanOrEqual(9 * 3600_000)
  // Its session settles with fewer changes than dream.asleepAfter, and still asks the user.
  await f.harness.commit(async (tx) => {
    delete (await tx.doc(Sessions, ROOT_CONVERSATION_ID)).waiting
  }, context)
  const { settle } = compactionDream(f.host, f.deps)
  await settledSession(f, 0, 9 * 3600_000)
  await settle(1)
  expect((await f.sessions())[0].beforeCompaction?.outcome).toMatchObject({
    changes: 0,
    result: 'ask',
  })
  expect((await f.sessions())[0].sleep).toBeUndefined()
  const submitted = () =>
    f.harness.commit((tx) => tx.submissionByRequest(f.ultimate, 'dream.settled:1'), context)
  await until(async () => (await submitted()) !== undefined)
  expect((await submitted())?.type).toBe('input')
})

it('never adopts a same-name automation that watches something else', async () => {
  const f = await fixture()
  await f.action('delete', { id: (await f.own())! })
  await f.harness.commit(async (tx) => {
    const doc = await tx.doc(BuiltInDoc, ROOT_CONVERSATION_ID)
    delete doc.id
    delete doc.deleted
  }, context)
  const other = (await f.action('create', {
    name: AUTOMATION_NAME,
    event: { name: 'conversations.compacted' },
  })) as { id: string }
  await ensureAutomation(f.host)
  const id = (await f.own())!
  expect(id).not.toBe(other.id)
  expect((await f.record(id)).condition?.of).toBe('@ultimate')
  expect((await f.record(other.id)).event?.name).toBe('conversations.compacted')
})

it('adopts its own automation after a lost receipt, even with changed subscribers, threshold and paused', async () => {
  const f = await fixture()
  const id = (await f.own())!
  // Made at the old default of 80%, or set so by hand.
  await f.action('update', { id, condition: { metric: 'context', of: '@ultimate', above: 80 } })
  await f.action('unsubscribe', { id })
  await f.action('pause', { id })
  // The create committed but its receipt was lost.
  await f.harness.commit(async (tx) => {
    delete (await tx.doc(BuiltInDoc, ROOT_CONVERSATION_ID)).id
  }, context)
  await ensureAutomation(f.host)
  expect(await f.own()).toBe(id)
  expect(await f.ids()).toEqual([id, await f.ownPause()])
  expect((await f.record(id)).enabled).toBe(false)
  expect((await f.record(id)).condition?.above).toBe(80)
})

it('keeps a chapter seed paused whichever check runs first', async () => {
  const f = await fixture()
  // A fresh chapter whose seed carried the automation paused, before any check made it.
  await f.action('delete', { id: (await f.own())! })
  await f.harness.commit(async (tx) => {
    const doc = await tx.doc(BuiltInDoc, ROOT_CONVERSATION_ID)
    delete doc.id
    delete doc.deleted
  }, context)
  await writeJson(`${f.host.chapter.dir}/seed.json`, { builtIn: { enabled: false } })
  // The standing reactor's check runs without the seed in hand: it reads the seed itself.
  await ensureAutomation(f.host)
  const id = (await f.own())!
  expect((await f.record(id)).enabled).toBe(false)
  // A seed whose chapter had deleted it makes none.
  await f.action('delete', { id })
  await f.harness.commit(async (tx) => {
    const doc = await tx.doc(BuiltInDoc, ROOT_CONVERSATION_ID)
    delete doc.id
  }, context)
  await writeJson(`${f.host.chapter.dir}/seed.json`, { builtIn: null })
  await ensureAutomation(f.host)
  expect(await f.ids()).toEqual([await f.ownPause()])
})

it('makes it in a chapter whose seed predates the feature', async () => {
  const f = await fixture()
  await f.action('delete', { id: (await f.own())! })
  await f.harness.commit(async (tx) => {
    const doc = await tx.doc(BuiltInDoc, ROOT_CONVERSATION_ID)
    delete doc.id
    delete doc.deleted
  }, context)
  await writeJson(`${f.host.chapter.dir}/seed.json`, { session: 1 })
  await ensureAutomation(f.host)
  expect((await f.record((await f.own())!)).enabled).toBe(true)
})

it('reads dream.asleepAfter from project over user settings, and rejects nonsense', async () => {
  const home = await temp('ultimate-asleep-after-')
  const host = (project: object) =>
    ({ userHome: home, projectSettings: async () => project }) as unknown as ExtensionHost
  expect(await asleepAfter(host({}))).toBe(ASLEEP_AFTER)
  await writeJson(`${home}/.ultimate/settings.json`, { dream: { asleepAfter: 3 } })
  expect(await asleepAfter(host({}))).toBe(3)
  expect(await asleepAfter(host({ dream: { asleepAfter: 8 } }))).toBe(8)
  await expect(asleepAfter(host({ dream: { asleepAfter: 0 } }))).rejects.toThrow(
    'Invalid dream.asleepAfter',
  )
})

it("carries @ultimate's handoff, else its compaction summary without its memory, and the automation into the next chapter's seed", async () => {
  const f = await fixture()
  await f.compact(f.ultimate)
  await settledSession(f, 1)
  const id = (await f.own())!
  await f.action('pause', { id })
  // No handoff (it timed out): the latest compaction summary goes along.
  const seed = await buildSeed(f.host, 1)
  expect(seed.continues).toEqual({
    conversation: f.ultimate,
    summary: 'I was building dream after compaction (#355131).',
  })
  expect(seed.builtIn).toEqual({ enabled: false })
  // The built-in automation is dream's own: it is not carried as an ordinary one.
  expect(seed.automations).toEqual([])
  // With a handoff, the handoff replaces the summary.
  await f.harness.commit(async (tx) => {
    ;(await tx.doc(Sessions, ROOT_CONVERSATION_ID)).sessions[0].handoff = {
      task: 9,
      text: 'Open: the preview round.',
      at: 1,
    }
  }, context)
  expect((await buildSeed(f.host, 1)).continues).toEqual({
    conversation: f.ultimate,
    handoff: 'Open: the preview round.',
  })
})

it("renames a stored session's afterCompaction to beforeCompaction and adds the project pass", () => {
  const migrate = (
    Sessions as unknown as { definition: { migrate: (v: object, from: number) => object } }
  ).definition.migrate
  const outcome = { changes: 5, threshold: 5, result: 'ask', at: 3 }
  expect(
    migrate(
      {
        next: 3,
        sessions: [
          {
            id: 1,
            passes: { codify: { status: 'done' } },
            journal: { learned: [], text: '', at: 2 },
            afterCompaction: {
              automation: 'A4',
              name: 'Dream after compaction',
              at: 1,
              settling: 9,
              outcome,
            },
          },
          { id: 2, passes: { codify: { status: 'running' } } },
        ],
      },
      1,
    ),
  ).toEqual({
    next: 3,
    sessions: [
      {
        id: 1,
        passes: {
          codify: { status: 'done' },
          project: { status: 'done', note: 'not part of this dream' },
        },
        journal: { learned: [], text: '', at: 2 },
        beforeCompaction: {
          automation: 'A4',
          name: 'Dream after compaction',
          at: 1,
          settling: 9,
          outcome,
        },
      },
      {
        id: 2,
        passes: { codify: { status: 'running' }, project: { status: 'waiting' } },
      },
    ],
  })
})

it('ends a wait saved by the old event trigger instead of leaving it blocked', async () => {
  const f = await fixture()
  const task = await f.harness.commit(
    (tx) =>
      tx.createTask(
        compactionDream(f.host, f.deps).Retired,
        { automation: 'A4', name: 'Dream after compaction', deadline: 1 },
        {
          conversationId: ROOT_CONVERSATION_ID,
          ownership: { kind: 'conversation' },
          background: true,
        },
      ),
    context,
  )
  f.host.harness().resume()
  await until(
    async () =>
      (await f.harness.commit((tx) => tx.task(task), context))?.state.status === 'terminal',
  )
  expect(await f.waiting()).toBeUndefined()
})
