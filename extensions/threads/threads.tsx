import type { EntryRecord } from '@earendil-works/pi-durable'
import type { Message } from '../messages/refs.ts'

/** One feature's thread in @ultimate's conversation: the branch it is about, and where it starts, ends and landed. */
export type Thread = {
  /** The branch conversation. */
  id: number
  /** The entry it is first known from. */
  first: number
  /** The landing report that landed it, and the commit. */
  landed?: { entry: number; sha: string }
  /** Messages @ultimate sent the user about it, by message id: an open question among them waits on the user. */
  asks?: number[]
}
export type Threads = {
  /** The threads of each placed entry: most have one, a turn woken by several branches has each. */
  of: ReadonlyMap<number, readonly number[]>
  /** Every thread, by its first entry. */
  threads: readonly Thread[]
  /** The threads of the latest turn, from the inputs that woke it: where its run streams while it runs. */
  live: readonly number[]
}

type Data = {
  from?: unknown
  id?: unknown
  outcome?: { outcome?: unknown; conversationId?: unknown; sha?: unknown }
  source?: unknown
}

const conversation = (value: unknown, self: number) =>
  typeof value === 'number' && value !== self ? [value] : []
const union = (...lists: (readonly number[])[]) => [...new Set(lists.flat())]

/** The entry kind of a thread's root row in the main stream, which `web.tsx` renders. */
export const ROOT = 'threads.root'

/** How a reply typed in a thread starts, so it and the turn it wakes belong to that thread. */
export const REPLY = /^Re #(\d+): /
export const reply = (thread: number, text: string) => `Re #${thread}: ${text}`

/**
 * Which feature thread each entry of @ultimate's conversation (`self`) belongs to, from what the entries record; no model
 * decides it. The message log (`messages`) only fills in what older entries do not say, so a log that drops old messages
 * moves nothing that the entries place.
 *
 * - What a branch sends, its landing report and its notes belong to that branch.
 * - The user's answer to a question belongs where the question came from: the call that asked it.
 * - A turn belongs to the inputs that woke it, decided when it starts and never changed after: a run of inputs with no
 *   response between them wakes one turn, and everything it says and does belongs where they do. A turn the user's own
 *   words woke (a prompt, or an answer to a question of no thread) stays in no thread, whatever else woke it with them
 *   and whatever branches it starts or messages; the branches it starts begin their threads there.
 * - A tool result belongs with its call.
 *
 * Everything else (the user's own prompts, notes about main, build and to-do notes, messages from other projects)
 * belongs to no thread.
 */
export function threadsOf(
  entries: readonly EntryRecord[],
  messages: readonly Message[],
  self: number,
): Threads {
  const of = new Map<number, readonly number[]>()
  const threads = new Map<number, Thread>()
  const calls = new Map<string, readonly number[]>()
  const byId = new Map(messages.map((message) => [message.id, message]))
  // Branches each call messaged, itself or from a script (`<script>/<n>`): starting one sends its first message.
  const reached = new Map<string, number[]>()
  for (const message of messages) {
    if (message.from !== self || message.call === undefined) continue
    const call = message.call.split('/')[0]
    reached.set(call, union(reached.get(call) ?? [], conversation(message.to, self)))
  }
  // From the entries themselves: the branches each call started (a script's output names those it started too), and
  // which call sent each message to the user (`Message <id> sent.`).
  const results = new Map<string, number[]>()
  const sentBy = new Map<number, string>()
  for (const message of messages)
    if (message.from === self && message.call !== undefined)
      sentBy.set(message.id, message.call.split('/')[0])
  // Who sent each delivered message, from its entry: the log is bounded, the transcript is not.
  const senders = new Map<unknown, unknown>()
  for (const entry of entries) {
    const data = (entry.data ?? {}) as Data
    if (entry.kind === 'board.message' || entry.kind === 'board.reply')
      senders.set(data.id, data.from)
    const result = entry.model?.[0]
    if (result?.role !== 'toolResult' || result.isError) continue
    const text = result.content.map((block) => (block.type === 'text' ? block.text : '')).join('')
    const started = [...text.matchAll(/Branch #(\d+) started/g)].map((match) => Number(match[1]))
    if (started.length) results.set(result.toolCallId, started)
    const sent = result.toolName === 'message' ? /^Message (\d+) sent/.exec(text) : null
    if (sent) sentBy.set(Number(sent[1]), result.toolCallId)
  }
  // The messages each call sent the user: an open question among them makes its threads wait on the user. Only the log
  // says whether one is still open, so one it dropped asks nothing.
  const asks = new Map<string, number[]>()
  for (const [message, call] of sentBy)
    if (byId.get(message)?.to === 'user') asks.set(call, [...(asks.get(call) ?? []), message])

  /** Thread `id` is known from `entry` on, without the entry being in it. */
  const mention = (entry: number, id: number) => {
    if (!threads.has(id)) threads.set(id, { id, first: entry })
  }
  const place = (entry: number, ids: readonly number[]) => {
    if (!ids.length) return
    of.set(entry, union(of.get(entry) ?? [], ids))
    for (const id of ids) mention(entry, id)
  }
  const input = (entry: EntryRecord): readonly number[] => {
    const data = (entry.data ?? {}) as Data
    switch (entry.kind) {
      case 'board.message':
      case 'board.reply': {
        if (data.from !== 'user') return conversation(data.from, self)
        // The question it answers, from the entry (older entries: the log), and the call that asked it.
        const re = (data as { re?: unknown }).re ?? byId.get(data.id as number)?.re
        const call = typeof re === 'number' ? sentBy.get(re) : undefined
        return call === undefined ? [] : (calls.get(call) ?? [])
      }
      case 'workspaces.lander-report':
        return conversation(data.outcome?.conversationId, self)
      // Retired: older transcripts woke a turn with a pointer to the message.
      case 'board.wake':
        return conversation(senders.get(data.id), self)
      // Typed in a thread: the thread's composer starts it with `Re #<branch>:`.
      case 'pi.user': {
        const content = entry.model?.[0]?.content
        const text =
          typeof content === 'string'
            ? content
            : (content?.find((block) => block.type === 'text')?.text ?? '')
        const re = REPLY.exec(text)
        return re ? conversation(Number(re[1]), self) : []
      }
      default:
        return []
    }
  }

  const asked = new Map<number, number[]>()
  let wake: readonly number[] = []
  // Whether the user's own words woke the turn: then it stays in main, whatever else woke it.
  let typed = false
  let answered = true
  for (const entry of entries) {
    const data = (entry.data ?? {}) as Data
    const message = entry.model?.[0]
    const ids = input(entry)
    place(entry.id, ids)
    const outcome = data.outcome
    if (
      entry.kind === 'workspaces.lander-report' &&
      outcome?.outcome === 'landed' &&
      typeof outcome.sha === 'string' &&
      ids.length
    )
      threads.get(ids[0])!.landed = { entry: entry.id, sha: outcome.sha }
    if (entry.input) {
      if (answered) {
        wake = []
        typed = false
      }
      wake = union(wake, ids)
      const user =
        entry.kind === 'pi.user' ||
        ((entry.kind === 'board.message' || entry.kind === 'board.reply') && data.from === 'user')
      if (user && !ids.length) typed = true
      answered = false
      continue
    }
    const turn = typed ? [] : wake
    if (message?.role === 'assistant') {
      answered = true
      const own = message.content.filter((block) => block.type === 'toolCall')
      for (const call of own) {
        calls.set(call.id, turn)
        // A branch it starts or messages is known from here on (its thread begins here when new); the call itself stays
        // where its turn is.
        for (const branch of union(results.get(call.id) ?? [], reached.get(call.id) ?? []))
          mention(entry.id, branch)
        // What it told the user about the threads of its turn.
        for (const thread of turn)
          asked.set(thread, [...(asked.get(thread) ?? []), ...(asks.get(call.id) ?? [])])
      }
      place(entry.id, turn)
      continue
    }
    if (message?.role === 'toolResult') {
      place(entry.id, calls.get(message.toolCallId) ?? [])
      continue
    }
    // A note from a branch, or the lander's note about its landing.
    if (entry.kind === 'lineage.note' && data.source !== 'main')
      place(entry.id, conversation(data.from, self))
    if (entry.kind === 'lineage.finished') place(entry.id, conversation(data.from, self))
  }
  for (const [id, sent] of asked) {
    const thread = threads.get(id)
    if (thread) thread.asks = sent
  }
  return {
    of,
    threads: [...threads.values()].toSorted((a, b) => a.first - b.first),
    live: typed ? [] : wake,
  }
}

/**
 * How the main stream shows `threads`: an entry of exactly one thread leaves the stream for it; one of several (a turn
 * woken by several branches at once) stays. Each thread's root row stands after the answer that ended the turn it began
 * in, so it follows the message that started it; while that turn still runs, the root waits for its answer.
 */
export function threading(entries: readonly EntryRecord[], { of, threads, live }: Threads) {
  const answers = entries.filter((entry) => {
    const message = entry.model?.[0]
    return message?.role === 'assistant' && message.stopReason !== 'toolUse'
  })
  const roots = new Map<number, number>()
  for (const thread of threads) {
    const after = answers.find((entry) => entry.id >= thread.first)
    if (after) roots.set(thread.id, after.id)
  }
  const hidden = new Set<number>()
  for (const [entry, ids] of of) if (ids.length === 1) hidden.add(entry)
  return { root: ROOT, of, hidden, roots, live }
}
