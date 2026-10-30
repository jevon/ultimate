import type { AssistantMessage, ToolCall } from '@earendil-works/pi-ai'
import type { EntryRecord } from '@earendil-works/pi-durable'
import type { Threading } from '../sdk/types.ts'

/** A transcript row: an entry, or only some content blocks of an assistant message. */
export interface CompactPart {
  entry: EntryRecord
  /** Indexes of the content blocks shown; the whole entry when absent. */
  blocks?: readonly number[]
}
/** A run of work folded into one row: the parts it hides and its steps, the tool calls and thoughts in it. */
export interface WorkRun {
  work: readonly CompactPart[]
  steps: number
}

const stepsOf = (blocks: AssistantMessage['content']) =>
  blocks.filter(
    (block) =>
      block.type === 'toolCall' ||
      (block.type === 'thinking' && (!!block.thinking || !!block.redacted)),
  ).length

/**
 * The rows of a conversation that uses compact mode. Each run of tool calls and thinking between inputs, messages and
 * answers folds into one `WorkRun`, without the calls `visible` keeps: those split a run and stay rows of their own.
 * Only responses that go on to use tools are work; an answer shows whole, its thinking included. System prompt changes
 * join the run they fall in, and a run without a step shows as it is.
 */
export function compactRows(
  entries: readonly EntryRecord[],
  visible: (call: ToolCall) => boolean,
): (CompactPart | WorkRun)[] {
  const rows: (CompactPart | WorkRun)[] = []
  let run: CompactPart[] = []
  let steps = 0
  const flush = () => {
    if (steps > 0) rows.push({ work: run, steps })
    else rows.push(...run)
    run = []
    steps = 0
  }
  const show = (part: CompactPart) => {
    flush()
    rows.push(part)
  }
  for (const entry of entries) {
    const message = entry.model?.[0]
    if (entry.kind === 'pi.system') {
      run.push({ entry })
      continue
    }
    if (entry.kind === 'pi.tool-result') {
      run.push({ entry })
      steps++
      continue
    }
    if (
      entry.kind !== 'pi.assistant' ||
      message?.role !== 'assistant' ||
      message.stopReason !== 'toolUse'
    ) {
      show({ entry })
      continue
    }
    const { content } = message
    const quiet = content.map((block) => block.type !== 'toolCall' || !visible(block))
    if (!quiet.includes(false)) {
      run.push({ entry })
      steps += stepsOf(content)
      continue
    }
    if (!quiet.includes(true)) {
      show({ entry })
      continue
    }
    for (let start = 0, end = 1; end <= content.length; end++) {
      if (end < content.length && quiet[end] === quiet[start]) continue
      const blocks = Array.from({ length: end - start }, (_, offset) => start + offset)
      if (quiet[start]) {
        run.push({ entry, blocks })
        steps += stepsOf(content.slice(start, end))
      } else show({ entry, blocks })
      start = end
    }
  }
  flush()
  return rows
}

/** Background rows folded together: a stretch of quiet rows and the runs of work between them. */
export interface QuietGroup {
  quiet: readonly (CompactPart | WorkRun)[]
  /** Steps in its runs of work. */
  steps: number
}

/**
 * `rows` with each stretch of quiet rows (`quiet` says which), and the runs of work and hidden rows between them, folded
 * into one group, so background always reads the same. A run of work that ends a stretch stays out of it, so work in
 * progress keeps its own line, and a stretch with no quiet row that shows stays as it is.
 */
export function groupQuiet(
  rows: readonly (CompactPart | WorkRun)[],
  quiet: (part: CompactPart) => boolean | 'hidden',
): (CompactPart | WorkRun | QuietGroup)[] {
  const grouped: (CompactPart | WorkRun | QuietGroup)[] = []
  let stretch: (CompactPart | WorkRun)[] = []
  let shown = new Set<CompactPart | WorkRun>()
  const flush = () => {
    const end = stretch.findLastIndex((row) => shown.has(row)) + 1
    const group = stretch.slice(0, end)
    if (group.some((row) => shown.has(row)))
      grouped.push({
        quiet: group,
        steps: group.reduce((sum, row) => sum + ('work' in row ? row.steps : 0), 0),
      })
    else grouped.push(...group)
    grouped.push(...stretch.slice(end))
    stretch = []
    shown = new Set()
  }
  for (const row of rows) {
    const verdict = 'work' in row ? 'hidden' : quiet(row)
    if (verdict) {
      stretch.push(row)
      if (verdict === true) shown.add(row)
    } else {
      flush()
      grouped.push(row)
    }
  }
  flush()
  return grouped
}

/** The group where `entry` first shows, if it does in one: revealing the entry opens it. */
export function quietOf(rows: readonly (CompactPart | WorkRun | QuietGroup)[], entry: number) {
  const first = rows.find((row) => partsOf(row).some((part) => part.entry.id === entry))
  return first && 'quiet' in first ? first : undefined
}

/**
 * What makes a streamed window fresh: its `older` and its head marker. Appends keep both; a resync after consecutive
 * compactions can keep `older` but brings a new head marker.
 */
export const windowKey = (window: readonly EntryRecord[], older: number | undefined) =>
  `${older}:${window[0]?.head === undefined ? '' : window[0].id}`

/**
 * Ranges `[after, before)` of stored history a fresh window starting at `older` does not cover, with `loaded` the rows
 * already shown below it:
 * - after a head marker, the window skips superseded markers newer than `older`; it is not in id order, the marker
 *   coming first, so the range reaches past its newest entry;
 * - rows kept from before a resync can end well below the new window.
 */
export function windowGaps(
  window: readonly EntryRecord[],
  older: number,
  loaded: readonly EntryRecord[],
): [number, number][] {
  const gaps: [number, number][] = []
  if (window[0]?.head !== undefined)
    gaps.push([older, Math.max(...window.map((entry) => entry.id)) + 1])
  let below = 0
  for (const entry of loaded) if (entry.id < older) below = Math.max(below, entry.id)
  if (below && below + 1 < older) gaps.push([below + 1, older])
  return gaps
}

/**
 * The entries a go-back set aside, as the model's context leaves them out. An entry whose `data.setAside` is an entry id
 * went back to it: the newest go-back after an entry decides. The entry is set aside when it came after that go-back's
 * point; otherwise the context returned to how it was at the point, where the go-backs before the point decide.
 */
export function setAsideIds(entries: readonly EntryRecord[]): Set<number> {
  const backs = entries.flatMap((entry) => {
    const at = (entry.data as { setAside?: unknown } | undefined)?.setAside
    return typeof at === 'number' ? [{ id: entry.id, at }] : []
  })
  const aside = new Set<number>()
  if (!backs.length) return aside
  for (const entry of entries) {
    let limit = Number.POSITIVE_INFINITY
    for (;;) {
      const back = backs.findLast((candidate) => candidate.id > entry.id && candidate.id <= limit)
      if (!back) break
      if (entry.id > back.at) {
        aside.add(entry.id)
        break
      }
      limit = back.at
    }
  }
  return aside
}

/** Rows set aside by a go-back, folded together: each consecutive stretch of them is one group. */
export interface AsideGroup {
  aside: readonly (CompactPart | WorkRun | QuietGroup)[]
  /** Its entries with messages other than system prompt changes, as the go-back counted them. */
  steps: number
}
/** A part's key: its entry, and its first block when it shows only some. */
export const partKey = (part: CompactPart) =>
  part.blocks ? `${part.entry.id}:${part.blocks[0]}` : String(part.entry.id)

/**
 * Whether a folded run or group is open, by the keys of all its parts: one that gains earlier parts from a page, or
 * later ones live, stays open.
 */
export const isOpenIn = (keys: ReadonlySet<string>, row: WorkRun | QuietGroup) =>
  partsOf(row).some((part) => keys.has(partKey(part)))

/** `keys` with every part of `row` added when it opens, or removed when it closes. */
export function openIn(keys: ReadonlySet<string>, row: WorkRun | QuietGroup, value: boolean) {
  const next = new Set(keys)
  for (const part of partsOf(row)) {
    if (value) next.add(partKey(part))
    else next.delete(partKey(part))
  }
  return next
}

/**
 * Where a scroll anchor is found after a page loads: a folded run or group by its last entry (a page that reaches into
 * it gives it an earlier first one), nested in an open group when it was; a row inside an open run or group below it,
 * never a run nested there, which can carry the same id; any other row by its id.
 */
export function anchorSelector(anchor: { entryId: number; last?: number; inner?: boolean }) {
  if (anchor.last !== undefined)
    return anchor.inner
      ? `[data-run-last] [data-run-last="${anchor.last}"]`
      : `:scope > [data-run-last="${anchor.last}"]`
  return anchor.inner
    ? `[data-run-last] [data-entry-id="${anchor.entryId}"]:not([data-run-last])`
    : `[data-entry-id="${anchor.entryId}"]`
}

/** The parts a row shows, those of its runs and groups included. */
export const partsOf = (row: CompactPart | WorkRun | QuietGroup): readonly CompactPart[] =>
  'quiet' in row ? row.quiet.flatMap(partsOf) : 'work' in row ? row.work : [row]

/** `rows` with each stretch of rows whose entries are all in `aside` folded into one group. */
export function groupAside(
  rows: readonly (CompactPart | WorkRun | QuietGroup)[],
  aside: ReadonlySet<number>,
): (CompactPart | WorkRun | QuietGroup | AsideGroup)[] {
  if (!aside.size) return [...rows]
  const grouped: (CompactPart | WorkRun | QuietGroup | AsideGroup)[] = []
  let group: (CompactPart | WorkRun | QuietGroup)[] = []
  const flush = () => {
    if (!group.length) return
    const entries = new Set(group.flatMap(partsOf).map((part) => part.entry))
    const steps = [...entries].filter((entry) =>
      entry.model?.some((message) => message.role !== 'system'),
    ).length
    grouped.push({ aside: group, steps })
    group = []
  }
  for (const row of rows) {
    if (partsOf(row).every((part) => aside.has(part.entry.id))) group.push(row)
    else {
      flush()
      grouped.push(row)
    }
  }
  flush()
  return grouped
}

/** The rows between two rows of the thread the reader follows, which recede together. */
export interface BetweenGroup<Row> {
  between: readonly Row[]
}

/**
 * `rows` with each stretch between two `thread` rows (and before the first, and after the last) folded into one group:
 * the conversation reads as its thread, the rest receding between. Only a whole row can be thread; runs of work and
 * groups never are.
 */
export function groupBetween<Row extends object>(
  rows: readonly Row[],
  thread: (row: Row) => boolean,
): (Row | BetweenGroup<Row>)[] {
  const grouped: (Row | BetweenGroup<Row>)[] = []
  let stretch: Row[] = []
  for (const row of rows) {
    if (thread(row)) {
      if (stretch.length) grouped.push({ between: stretch })
      stretch = []
      grouped.push(row)
    } else stretch.push(row)
  }
  if (stretch.length) grouped.push({ between: stretch })
  return grouped
}

/**
 * The entries a threaded transcript shows: in the main stream, those it does not hide, with a root row (of the
 * contribution's `root` kind) after each thread's root entry; in thread `thread`, that thread's entries alone.
 */
export function threadStream(
  entries: readonly EntryRecord[],
  { root: kind, of, hidden, roots }: Threading,
  thread: number | undefined,
): EntryRecord[] {
  if (thread !== undefined) return entries.filter((entry) => of.get(entry.id)?.includes(thread))
  const rootsAt = Map.groupBy(roots, ([, entry]) => entry)
  return entries.flatMap((entry) => {
    // A root row is known by its thread, negated so it never takes a stored entry's id.
    const rows = (rootsAt.get(entry.id) ?? []).map(
      ([root]) =>
        ({
          id: -root,
          conversationId: entry.conversationId,
          kind,
          data: { thread: root },
        }) as unknown as EntryRecord,
    )
    return hidden.has(entry.id) ? rows : [entry, ...rows]
  })
}

/**
 * Whether a stretch between thread rows shows nothing: every row in it is a bare part that renders nothing (`hidden`).
 * Such a stretch gets no line of its own; a line with nothing to count would be an empty chevron.
 */
export const emptyStretch = <Row extends object>(
  group: BetweenGroup<Row>,
  hidden: (part: CompactPart) => boolean,
) =>
  group.between.every(
    (row) => !('work' in row || 'quiet' in row || 'aside' in row) && hidden(row as CompactPart),
  )

/** The folded run where `entry` first shows, if it starts in one: revealing the entry opens it. */
export function runOf(rows: readonly (CompactPart | WorkRun | QuietGroup)[], entry: number) {
  const flat = rows.flatMap((row) => ('quiet' in row ? row.quiet : [row]))
  const first = flat.find((row) => partsOf(row).some((part) => part.entry.id === entry))
  return first && 'work' in first ? first : undefined
}
