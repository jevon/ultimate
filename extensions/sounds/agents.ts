/**
 * The sound of agents, as data: what the live project does, turned into happenings a band plays and a level it plays
 * at. Pure and browser-safe; `engine.ts` makes the music.
 */

/** Who makes a sound: each role is its own instrument or register. */
export type Role = 'ultimate' | 'coordinator' | 'worker' | 'scout' | 'reviewer' | 'lander' | 'other'
/** Tool calls by timbre. */
export type Tool = 'bash' | 'edit' | 'read' | 'browser' | 'other'

export type Happening =
  | { kind: 'start' | 'stop'; role: Role }
  | { kind: 'tool'; role: Role; tool: Tool }
  | { kind: 'commit' | 'landed' | 'failed' }

/** How busy the project is right now: running conversations by role, and how many models are streaming. */
export type Level = { busy: Partial<Record<Role, number>>; streaming: number }
export const silence: Level = { busy: {}, streaming: 0 }

export const total = (level: Level) => Object.values(level.busy).reduce((sum, n) => sum + n, 0)

/** Levels of several sources (the live project, a demo) played together. */
export const mix = (...levels: Level[]): Level => {
  const busy: Partial<Record<Role, number>> = {}
  for (const level of levels)
    for (const [role, n] of Object.entries(level.busy) as [Role, number][])
      busy[role] = (busy[role] ?? 0) + n
  return { busy, streaming: levels.reduce((sum, level) => sum + level.streaming, 0) }
}

export const variants = [
  { id: 'ambient', label: 'Ambient', detail: 'Soft chords for each action, in a long reverb' },
  { id: 'orchestra', label: 'Orchestra', detail: 'Each role an instrument, one key and tempo' },
  { id: 'crazy', label: 'Crazy', detail: 'Drums and glitches for every call; faster under load' },
] as const
export type Variant = (typeof variants)[number]['id']

/** A conversation's role from its label: the agent definition it runs as, or `agent` for a standing agent. */
export function roleOf(label: string | undefined, standing: boolean): Role {
  if (standing) return 'ultimate'
  if (!label) return 'other'
  if (label === 'coordinator') return 'coordinator'
  if (label === 'worker' || label === 'designer') return 'worker'
  if (label === 'scout' || label === 'dream-pass') return 'scout'
  if (label === 'lander') return 'lander'
  if (label.startsWith('reviewer')) return 'reviewer'
  return 'other'
}

/** A tool's timbre from its name. */
export function toolOf(name: string): Tool {
  if (name === 'bash' || name === 'shell') return 'bash'
  if (name === 'edit' || name === 'write') return 'edit'
  if (name === 'read' || name === 'memory' || name === 'plan') return 'read'
  if (['browser', 'screenshot', 'web_search', 'web_fetch'].includes(name)) return 'browser'
  return 'other'
}

/** What the tracker reads of the project at one moment. */
export type Snapshot = {
  conversations: readonly { id: number; label?: string; busy: boolean }[]
  /** The standing agents' conversation ids. */
  standing: ReadonlySet<number>
  /** Tool calls of the current rounds by a key unique to each call. */
  tools: Readonly<Record<string, { name: string; conversationId: number }>>
  /** How many models are streaming an answer. */
  streaming: number
  /** Run state and latest input of each conversation, for failures. */
  runs: Readonly<Record<string, { runState: string; inputId?: number }>>
  /** Recent durable events, any order. */
  events: readonly { id: number; kind: string; data: unknown }[]
}

/**
 * Follows the project and says what newly happened and how busy it is. Whatever the first snapshot shows was heard
 * already: a tab that opens mid-landing does not play it.
 */
export function tracker() {
  let first = true
  let busy = new Set<number>()
  const heard = new Set<string>()
  return (snapshot: Snapshot): { happenings: Happening[]; level: Level } => {
    const roles = new Map(
      snapshot.conversations.map((c) => [c.id, roleOf(c.label, snapshot.standing.has(c.id))]),
    )
    const role = (id: number) => roles.get(id) ?? 'other'
    const happenings: Happening[] = []
    const fresh = (key: string) => {
      if (heard.has(key)) return false
      heard.add(key)
      return !first
    }
    const nowBusy = new Set(snapshot.conversations.filter((c) => c.busy).map((c) => c.id))
    if (!first) {
      for (const id of nowBusy)
        if (!busy.has(id)) happenings.push({ kind: 'start', role: role(id) })
      for (const id of busy) if (!nowBusy.has(id)) happenings.push({ kind: 'stop', role: role(id) })
    }
    busy = nowBusy
    for (const [id, call] of Object.entries(snapshot.tools))
      if (fresh(`tool:${id}`))
        happenings.push({ kind: 'tool', role: role(call.conversationId), tool: toolOf(call.name) })
    for (const event of snapshot.events) {
      const kind =
        event.kind === 'event.coding-tools.committed'
          ? 'commit'
          : event.kind === 'event.workspaces.landed'
            ? 'landed'
            : event.kind === 'event.workspaces.check' &&
                (event.data as { result?: string }).result === 'failed'
              ? 'failed'
              : undefined
      if (kind && fresh(`event:${event.id}`)) happenings.push({ kind })
    }
    for (const [id, run] of Object.entries(snapshot.runs))
      if (run.runState === 'error' && fresh(`failed:${id}:${run.inputId}`))
        happenings.push({ kind: 'failed' })
    first = false
    const level: Level = { busy: {}, streaming: snapshot.streaming }
    for (const id of nowBusy) level.busy[role(id)] = (level.busy[role(id)] ?? 0) + 1
    return { happenings, level }
  }
}

/** One step of the demo: a fake conversation starts, streams, calls a tool or stops, or the project commits, lands, fails. */
export type DemoStep = { at: number } & (
  | { do: 'start'; id: string; role: Role }
  | { do: 'stream' | 'quiet' | 'stop'; id: string }
  | { do: 'tool'; id: string; tool: Tool }
  | { do: 'commit' | 'landed' | 'failed' }
)

const calls = (id: string, from: number, tools: Tool[], every: number): DemoStep[] =>
  tools.map((tool, index) => ({ at: from + index * every, do: 'tool', id, tool }))

/**
 * About 50 seconds of a feature's life: @ultimate starts a coordinator, which reads, sends out a scout and two
 * workers; they edit and run tests, one commits; a check fails and is fixed; reviewers read; the lander runs checks
 * and lands; everyone goes quiet.
 */
export const demo: readonly DemoStep[] = [
  { at: 0, do: 'start', id: 'u', role: 'ultimate' },
  { at: 0.5, do: 'stream', id: 'u' },
  { at: 2.5, do: 'quiet', id: 'u' },
  { at: 2.5, do: 'start', id: 'c', role: 'coordinator' },
  { at: 3, do: 'stream', id: 'c' },
  ...calls('c', 4, ['read', 'read', 'bash', 'read'], 0.6),
  { at: 6.5, do: 'start', id: 's', role: 'scout' },
  { at: 6.5, do: 'stream', id: 's' },
  ...calls('s', 7, ['read', 'bash', 'read', 'read', 'browser', 'read'], 0.45),
  { at: 9.5, do: 'stop', id: 's' },
  { at: 10, do: 'start', id: 'w1', role: 'worker' },
  { at: 10.3, do: 'start', id: 'w2', role: 'worker' },
  { at: 10.5, do: 'stream', id: 'w1' },
  { at: 11, do: 'stream', id: 'w2' },
  ...calls('w1', 11, ['read', 'edit', 'edit', 'bash', 'read', 'edit', 'bash', 'bash'], 0.5),
  ...calls('w2', 11.4, ['read', 'read', 'edit', 'browser', 'edit', 'browser', 'bash'], 0.6),
  { at: 15.5, do: 'commit' },
  { at: 16.5, do: 'failed' },
  ...calls('w2', 17, ['read', 'edit', 'bash', 'bash'], 0.4),
  { at: 19, do: 'commit' },
  { at: 19.5, do: 'stop', id: 'w1' },
  { at: 20, do: 'stop', id: 'w2' },
  { at: 20.5, do: 'start', id: 'r1', role: 'reviewer' },
  { at: 20.7, do: 'start', id: 'r2', role: 'reviewer' },
  { at: 21, do: 'stream', id: 'r1' },
  { at: 21.2, do: 'stream', id: 'r2' },
  ...calls('r1', 21.5, ['read', 'read', 'bash', 'read', 'read'], 0.7),
  ...calls('r2', 21.8, ['read', 'bash', 'read', 'read'], 0.8),
  { at: 25.5, do: 'stop', id: 'r1' },
  { at: 26, do: 'stop', id: 'r2' },
  ...calls('c', 26.5, ['bash', 'read'], 0.5),
  { at: 28, do: 'start', id: 'l', role: 'lander' },
  ...calls('l', 28.5, ['bash', 'bash', 'bash', 'bash', 'bash', 'bash'], 0.7),
  { at: 33, do: 'landed' },
  { at: 33.5, do: 'stop', id: 'l' },
  { at: 34, do: 'quiet', id: 'c' },
  { at: 35, do: 'stop', id: 'c' },
  { at: 35.5, do: 'stream', id: 'u' },
  { at: 37.5, do: 'stop', id: 'u' },
]

/** Plays the demo's steps through the same mapping: each step's happening and the level after it. */
export function demoPlayer() {
  const running = new Map<string, { role: Role; streaming: boolean }>()
  return (step: DemoStep): { happening?: Happening; level: Level } => {
    let happening: Happening | undefined
    if (step.do === 'start') {
      running.set(step.id, { role: step.role, streaming: false })
      happening = { kind: 'start', role: step.role }
    } else if (step.do === 'stream' || step.do === 'quiet') {
      const c = running.get(step.id)
      if (c) c.streaming = step.do === 'stream'
    } else if (step.do === 'stop') {
      const c = running.get(step.id)
      running.delete(step.id)
      if (c) happening = { kind: 'stop', role: c.role }
    } else if (step.do === 'tool') {
      happening = { kind: 'tool', role: running.get(step.id)?.role ?? 'other', tool: step.tool }
    } else happening = { kind: step.do }
    const level: Level = { busy: {}, streaming: 0 }
    for (const c of running.values()) {
      level.busy[c.role] = (level.busy[c.role] ?? 0) + 1
      if (c.streaming) level.streaming++
    }
    return { happening, level }
  }
}

export const demoLength = Math.max(...demo.map((step) => step.at)) + 3
