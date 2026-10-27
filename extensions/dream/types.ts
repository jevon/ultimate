import type { ConversationSummary } from '../../shared/protocol.ts'
import type { MemoryItem } from '../lineage/refs.ts'
import type { Todo } from '../todos/refs.ts'
import type { ModelThinkingLevel } from '@earendil-works/pi-ai'
import type { TaskGraph } from '@earendil-works/pi-durable'
import type { CreateArgs, Schedule } from '../automations/refs.ts'
import type { Journal, Proposal, Session, Waiting } from './refs.ts'

/** Everything a dream carries to a fresh chapter; numeric trigger targets and subscribers need recreating. */
export type Seed = {
  /** Written only by the gate: the preview checks automations' schedules instead of creating them. */
  gate?: true
  from: { name: string; number: number }
  session: number
  journal: Journal & { proposals: Proposal[] }
  memories: Record<string, MemoryItem>
  todos: Pick<Todo, 'text' | 'owner'>[]
  questions: { text: string; ref: string }[]
  automations: {
    name: string
    prompt?: string
    schedule?: Schedule
    event?: CreateArgs['event']
    condition?: CreateArgs['condition']
    agent?: string
    model?: { provider: string; modelId: string }
    thinking?: ModelThinkingLevel
  }[]
  scripts: {
    id: string
    scope?: 'project'
    name: string
    ask: string
    prompt?: string
    agent?: string
    model?: { provider: string; modelId: string }
    thinking?: ModelThinkingLevel
  }[]
  counts: {
    memories: number
    todos: number
    questions: number
    automations: number
    scripts: number
  }
  /**
   * The built-in "Dream before compaction" automation, recreated in the new chapter as it was; `null` when the user
   * deleted it. Absent in seeds from before it existed: the new chapter makes it.
   */
  builtIn?: { enabled: boolean } | null
  /** The built-in "Dream after a pause" automation, likewise. */
  builtInPause?: { enabled: boolean } | null
  /**
   * What @ultimate was doing in conversation `conversation` of the chapter it left, so the new chapter continues it:
   * the handoff it wrote for the dream, else its latest compaction summary (capped at 12,000 characters).
   */
  continues?: { conversation: number; handoff?: string; summary?: string }
}

/** The six passes a dream runs, in the order the journal lists them. */
export const PASSES = ['memory', 'failures', 'tools', 'corrections', 'codify', 'project'] as const
export type PassName = (typeof PASSES)[number]

/**
 * Top-level conversations at work besides @ultimate: a dream reads finished work, not work in progress. Without
 * `tasks`, every conversation with a foreground task counts (`busy`), as a chapter switch needs: it parks whatever
 * is live. With the live `tasks`, only those `working` count, as starting a read-only dream needs.
 */
export function busyElsewhere(
  conversations: readonly ConversationSummary[],
  ultimate?: number,
  tasks?: TaskGraph['tasks'],
) {
  return conversations
    .filter(
      (item) =>
        (tasks ? working(tasks, item.id) : item.busy) &&
        item.id !== ultimate &&
        item.parentConversationId === undefined,
    )
    .map((item) => ({ id: item.id, title: item.title ?? `#${item.id}` }))
}

/**
 * Whether conversation `id` actively works: one of its own foreground tasks runs or is about to (a model response, a
 * tool call). A task that only waits, on other conversations' work (subagents, reporters, the lander) or on nothing
 * live, or that sleeps, does not count by itself; a response waiting on its own running tool counts through the tool.
 */
export function working(tasks: TaskGraph['tasks'], id: number) {
  return Object.values(tasks).some(
    (task) =>
      task.conversationId === id &&
      !task.background &&
      (task.state.status === 'running' || task.state.status === 'pending'),
  )
}

/**
 * The session the status line keeps in view: the open one, or the newest once every proposal settled while its Fall
 * asleep is still to come. A session the user ended early, or one a compaction's
 * dream settled to stay, is done.
 */
export function pinnedOf(sessions: readonly Session[] = []): Session | undefined {
  const open = sessions.find((item) => item.endedAt === undefined)
  if (open) return open
  const newest = sessions.at(-1)
  if (!newest?.journal || newest.sleep?.phase === 'asleep') return undefined
  if (newest.proposals.some((item) => item.status === 'open' || item.status === 'approved'))
    return undefined
  if (newest.beforeCompaction?.outcome?.result === 'stay') return undefined
  return newest
}

/**
 * Whether the pinned dialog leads with Fall asleep (or its progress, or its failure): the newest session, or one that
 * slept, once no proposal is open or on a branch, whichever card in the conversation carries Fall asleep.
 */
export function sleepLeads(session: Session, newest: boolean) {
  if (!session.journal || !(newest || session.sleep)) return false
  return (
    !!session.sleep ||
    !session.proposals.some((item) => item.status === 'open' || item.status === 'approved')
  )
}

/** The stages a dream walks through, as the sidebar's strip shows them. */
export const STAGES = ['handoff', 'dreaming', 'deciding', 'settled', 'asleep'] as const

/**
 * Where a dream stands for the sidebar: its `stage`, one sentence, and the one thing the user has to do, if any:
 * `decide` proposals with @ultimate, `sleep` (press Fall asleep) or look at a `failed` sleep. Undefined when no dream
 * needs following.
 */
export type DreamStep = {
  session?: number
  stage: (typeof STAGES)[number]
  text: string
  action?: 'decide' | 'sleep' | 'failed'
}

export function stepOf(doc?: { sessions: Session[]; waiting?: Waiting }): DreamStep | undefined {
  // A new dream waiting on its handoff comes before a settled session still pinned for Fall asleep.
  const waiting = doc?.waiting && !doc.waiting.gaveUp ? doc.waiting : undefined
  const session = pinnedOf(doc?.sessions)
  if (!session || (waiting && session.endedAt !== undefined)) {
    if (!waiting) return undefined
    return {
      stage: 'handoff',
      text: waiting.handoff
        ? 'Handed off · dreaming once nothing else works'
        : 'Writing my handoff',
    }
  }
  const at = { session: session.id }
  const sleep = session.sleep
  if (sleep?.phase === 'failed')
    return { ...at, stage: 'asleep', text: 'Falling asleep failed', action: 'failed' }
  if (sleep) {
    const step = ['seeding', 'checking', 'backing up', 'switching'].indexOf(sleep.phase) + 1
    return { ...at, stage: 'asleep', text: `Falling asleep · step ${step} of 4` }
  }
  if (!session.journal) {
    const done = PASSES.filter((pass) => session.passes[pass].status === 'done').length
    return { ...at, stage: 'dreaming', text: `Dreaming · ${done} of ${PASSES.length} passes` }
  }
  const open = session.proposals.filter((item) => item.status === 'open').length
  const approved = session.proposals.filter((item) => item.status === 'approved').length
  if (open > 0)
    return {
      ...at,
      stage: 'deciding',
      text: `${open} proposal${open === 1 ? '' : 's'} to decide`,
      action: 'decide',
    }
  if (approved > 0) return { ...at, stage: 'deciding', text: `${approved} on branches, landing` }
  const compaction = session.beforeCompaction
  if (compaction && !compaction.outcome)
    return { ...at, stage: 'settled', text: 'Settled · weighing a fresh chapter' }
  const chapter = session.journal.chapter
  return {
    ...at,
    stage: 'settled',
    text: chapter ? `Ready for a fresh chapter: ${chapter}` : 'Ready to fall asleep',
    action: 'sleep',
  }
}

const settled = (session: Session) =>
  session.proposals.filter((item) => item.status !== 'open' && item.status !== 'approved').length

/** Where the session stands, in a few words: dreaming, deciding, waiting on branches, or ready to fall asleep. */
export function progress(session: Session): { long: string; short?: string; moons?: true } {
  if (session.sleep)
    return { long: session.sleep.phase === 'failed' ? 'falling asleep failed' : 'falling asleep' }
  if (!session.journal) return { long: 'dreaming', moons: true }
  const total = session.proposals.length
  const done = settled(session)
  if (session.endedAt !== undefined || done === total) return { long: 'ready to fall asleep' }
  const open = session.proposals.filter((item) => item.status === 'open').length
  const approved = total - done - open
  const rest = [open > 0 && `${open} to decide`, approved > 0 && `${approved} on branches`]
  return {
    long: [`${done} of ${total} settled`, ...rest].filter(Boolean).join(' · '),
    short: `${done}/${total}`,
  }
}
