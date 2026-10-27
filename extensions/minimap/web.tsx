import { useEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import {
  cn,
  defineWebExtension,
  events,
  formatTime,
  useAction,
  useConversation,
  useConversations,
  useDocOf,
  useViewport,
} from '@/sdk'
import { StandingDoc } from '../subagents/ui.tsx'
import { MarksAction } from './refs.ts'
import type { Mark, MarkKind } from './refs.ts'

type Profile = 'ultimate' | 'coordinator' | 'worker'

const kindLabel: Record<MarkKind, string> = {
  user: 'You',
  answer: 'Answer',
  message: 'Message',
  branch: 'Branch started',
  landed: 'Landed',
  failed: 'Failed',
  submit: 'Submitted',
  commit: 'Commit',
  preview: 'Preview started',
  subagent: 'Subagent started',
  report: 'Subagent reported',
  screenshot: 'Screenshot',
  restart: 'Restart',
  compaction: 'Compacted',
}

/** The milestones each kind of conversation shows in its third lane; other kinds stay off the rail. */
const milestones: Record<Profile, readonly MarkKind[]> = {
  ultimate: ['branch', 'landed', 'failed', 'compaction', 'restart'],
  coordinator: [
    'commit',
    'preview',
    'subagent',
    'report',
    'submit',
    'landed',
    'failed',
    'compaction',
  ],
  worker: ['commit', 'screenshot', 'preview', 'failed', 'compaction'],
}

/** @ultimate, a worker or another agent owned by a conversation, else a branch's coordinator. */
function useProfile(id: number | undefined): Profile {
  const ultimate = useDocOf(1, StandingDoc)?.ultimate
  const summary = useConversations().find((conversation) => conversation.id === id)
  if (id !== undefined && id === ultimate) return 'ultimate'
  if (summary?.parentConversationId !== undefined) return 'worker'
  return 'coordinator'
}

/** Lane 0 is the user, lane 1 the agent's answers and messages, lane 2 milestones; undefined leaves it off. */
function laneOf(kind: MarkKind, profile: Profile) {
  if (kind === 'user') return 0
  if (milestones[profile].includes(kind)) return 2
  if (kind === 'answer' || kind === 'message') return 1
  return undefined
}

/** One mark's glyph: shape and colour carry the kind, so a glance says what happened where. */
function Glyph({ kind, active }: { kind: MarkKind; active?: boolean }) {
  const bar = (width: string, tone: string) => (
    <span className={cn('block h-[2px] rounded-full', width, active ? 'bg-foreground' : tone)} />
  )
  const dot = (tone: string, ring: string) => (
    <span className={cn('block size-[7px] rounded-full', tone, active && `ring-2 ${ring}`)} />
  )
  switch (kind) {
    case 'user':
      return bar(active ? 'w-3.5' : 'w-2.5', 'bg-muted-foreground/80')
    case 'answer':
      return bar(active ? 'w-3.5' : 'w-2.5', 'bg-muted-foreground/35')
    case 'message':
      return bar(active ? 'w-3' : 'w-1.5', 'bg-muted-foreground/35')
    case 'branch':
      return (
        <span
          className={cn(
            'block size-[7px] rotate-45 rounded-[1px] bg-brand',
            active && 'ring-2 ring-brand/40',
          )}
        />
      )
    case 'landed':
      return dot('bg-success', 'ring-success/40')
    case 'failed':
      return dot('bg-error', 'ring-error/40')
    case 'submit':
      return (
        <span
          className={cn(
            'block size-[7px] rounded-full border-[1.5px] border-dashed border-success',
            active && 'bg-success',
          )}
        />
      )
    case 'commit':
      return (
        <span
          className={cn(
            'block size-[7px] rounded-full border-[1.5px] border-success',
            active && 'bg-success',
          )}
        />
      )
    case 'preview':
      return (
        <span
          className={cn(
            'block size-[7px] rounded-[2px] border-[1.5px] border-note',
            active && 'bg-note',
          )}
        />
      )
    case 'subagent':
      return bar('w-2', 'bg-brand/50')
    case 'report':
      return bar('w-3', 'bg-brand/85')
    case 'screenshot':
      return (
        <span
          className={cn(
            'block size-[6px] rounded-[1px] border border-muted-foreground',
            active && 'bg-foreground',
          )}
        />
      )
    case 'restart':
      return dot('bg-warning', 'ring-warning/40')
    default:
      return <span className="block w-3 border-t border-dashed border-muted-foreground/60" />
  }
}

/** The floating label next to a mark: kind, time, and its line of text. */
function Tip({ mark, more, top }: { mark: Mark; more: number; top: number }) {
  return (
    <div
      className="pointer-events-none absolute right-14 z-20 w-72 -translate-y-1/2 rounded-md border border-border bg-popover px-2.5 py-1.5 shadow-md"
      style={{ top }}
    >
      <div className="flex items-center gap-1.5 font-mono text-[10.5px] text-muted-foreground">
        <span className="flex w-4 justify-center">
          <Glyph kind={mark.kind} />
        </span>
        {kindLabel[mark.kind]}
        {mark.at !== undefined && <span className="ml-auto">{formatTime(mark.at)}</span>}
      </div>
      <div className="mt-0.5 line-clamp-3 text-[12.5px] leading-snug text-popover-foreground">
        {mark.text || kindLabel[mark.kind]}
      </div>
      {more > 0 && (
        <div className="mt-0.5 font-mono text-[10.5px] text-muted-foreground/70">
          +{more} nearby
        </div>
      )}
    </div>
  )
}

/** Turn the wheel over the rail into steps from mark to mark; the transcript does not scroll meanwhile. */
function useWheelSteps(element: RefObject<HTMLElement | null>, step: (delta: number) => void) {
  const latest = useRef(step)
  latest.current = step
  useEffect(() => {
    const target = element.current
    if (!target) return undefined
    let carry = 0
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      carry += event.deltaY
      // A mouse notch is about 100 px; a trackpad sends many small deltas.
      while (Math.abs(carry) >= 40) {
        latest.current(Math.sign(carry))
        carry -= Math.sign(carry) * 40
      }
    }
    target.addEventListener('wheel', onWheel, { passive: false })
    return () => target.removeEventListener('wheel', onWheel)
  }, [element])
}

/** The scroller of the transcript this overlay sits on: the nearest ancestor holding one. */
function transcriptOf(element: HTMLElement | null) {
  for (let at = element?.parentElement; at; at = at.parentElement) {
    const found = at.querySelector<HTMLElement>('[role="log"] > div')
    if (found) return found
  }
  return undefined
}

/** The entry ids on screen in the transcript beside `root`: the first and last visible row. */
function useVisible(root: RefObject<HTMLDivElement | null>, id: number | undefined) {
  const [visible, setVisible] = useState<[number, number]>()
  useEffect(() => {
    const scroller = transcriptOf(root.current)
    if (!scroller) return undefined
    let frame = 0
    const update = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const box = scroller.getBoundingClientRect()
        let first: number | undefined
        let last: number | undefined
        for (const row of scroller.querySelectorAll('[data-entry-id]')) {
          const rect = row.getBoundingClientRect()
          if (rect.bottom < box.top || rect.top > box.bottom || rect.height === 0) continue
          const entry = Number(
            row.getAttribute('data-run-last') ?? row.getAttribute('data-entry-id'),
          )
          const start = Number(row.getAttribute('data-entry-id'))
          first = Math.min(first ?? start, start)
          last = Math.max(last ?? entry, entry)
        }
        setVisible((previous) =>
          first === undefined || last === undefined
            ? previous
            : previous?.[0] === first && previous[1] === last
              ? previous
              : [first, last],
        )
      })
    }
    update()
    scroller.addEventListener('scroll', update, { passive: true })
    const observer = new ResizeObserver(update)
    observer.observe(scroller)
    return () => {
      cancelAnimationFrame(frame)
      scroller.removeEventListener('scroll', update)
      observer.disconnect()
    }
  }, [root, id])
  return visible
}

const LANE = 14
const MAX_GAP = 14
const MIN_GAP = 4

/** Which mark wins a shared slot in its lane: milestones before talk, failures first. */
const weight: Partial<Record<MarkKind, number>> = {
  failed: 9,
  landed: 8,
  branch: 7,
  restart: 6,
  preview: 6,
  submit: 5,
  commit: 4,
  report: 3,
  subagent: 2,
  screenshot: 1,
}

interface Row {
  mark: Mark
  lane: number
}

/**
 * Rows packed into `count` slots by order: each slot holds a run of neighbours, and draws per lane the one that weighs
 * most (the latest on a tie). With room for every row, a slot is one row.
 */
function pack(rows: readonly Row[], count: number) {
  const slots: { rows: Row[]; shown: Row[]; first: number }[] = []
  const per = Math.max(1, Math.ceil(rows.length / Math.max(1, count)))
  for (let start = 0; start < rows.length; start += per) {
    const run = rows.slice(start, start + per)
    const shown = [0, 1, 2].flatMap((lane) => {
      const inLane = run.filter((row) => row.lane === lane)
      const best = inLane.reduce<Row | undefined>(
        (top, row) =>
          !top || (weight[row.mark.kind] ?? 0) >= (weight[top.mark.kind] ?? 0) ? row : top,
        undefined,
      )
      return best ? [best] : []
    })
    slots.push({ rows: run, shown, first: start })
  }
  return { slots, per }
}

/** The rail; mounted only with rows to show, so its element exists when its listeners attach. */
function Lanes({ rows, room, id }: { rows: Row[]; room: number; id: number }) {
  const rail = useRef<HTMLDivElement>(null)
  // The row hovered or stepped to; every row is reachable, also those sharing a slot.
  const [active, setActive] = useState<number>()
  const visible = useVisible(rail, id)
  // Slots share the height evenly by order; with more rows than fit, neighbours share a slot.
  const fits = Math.max(1, Math.floor((room - 8) / MIN_GAP))
  const { slots, per } = useMemo(() => pack(rows, fits), [rows, fits])
  const gap = Math.max(MIN_GAP, Math.min(MAX_GAP, (room - 8) / Math.max(1, slots.length)))
  const height = gap * slots.length
  const band = useMemo(() => {
    if (!visible || !slots.length) return undefined
    const first = slots.findIndex((slot) => slot.rows.at(-1)!.mark.entry >= visible[0])
    const after = slots.findIndex((slot) => slot.rows[0].mark.entry > visible[1])
    const from = first === -1 ? slots.length : first
    const to = after === -1 ? slots.length : after
    return { top: from * gap, size: Math.max(4, (to - from) * gap) }
  }, [visible, slots, gap])
  const jump = (row: number) =>
    events.emit('ultimate:reveal-entry', { conversationId: id, entryId: rows[row].mark.entry })
  useWheelSteps(rail, (delta) =>
    setActive((row) => {
      const start =
        row ?? rows.findIndex(({ mark }) => visible !== undefined && mark.entry >= visible[0])
      return Math.max(0, Math.min(rows.length - 1, (start === -1 ? rows.length : start) + delta))
    }),
  )
  const activeSlot = active === undefined ? undefined : Math.floor(active / per)
  return (
    <div
      className="group/lanes pointer-events-auto relative w-12 cursor-pointer py-1"
      onKeyDown={(event) => {
        if (event.key === 'Enter' && active !== undefined) jump(active)
      }}
      onPointerLeave={() => setActive(undefined)}
      ref={rail}
      style={{ height: height + 8 }}
    >
      {[0, 1, 2].map((column) => (
        <span
          className="pointer-events-none absolute top-1 bottom-1 w-px bg-border/40 transition-colors group-hover/lanes:bg-border"
          key={column}
          style={{ left: 7 + column * LANE }}
        />
      ))}
      {band && (
        <span
          className="pointer-events-none absolute right-0 left-0 rounded-sm bg-foreground/[0.06]"
          style={{ top: 4 + band.top, height: band.size }}
        />
      )}
      {slots.map((slot, index) => (
        <div
          className={cn('absolute right-0 left-0', activeSlot === index && 'bg-foreground/5')}
          // oxlint-disable-next-line react/no-array-index-key -- Packed slots are positional; marks can share an entry.
          key={`${slot.rows[0].mark.entry}:${index}`}
          style={{ top: 4 + index * gap, height: gap }}
        >
          {slot.shown.map((shown) => {
            const row = slot.first + slot.rows.indexOf(shown)
            return (
              // Each lane's glyph is its own target: a shared slot still jumps to what it draws.
              <button
                aria-label={`${kindLabel[shown.mark.kind]}: ${shown.mark.text}`}
                className="absolute inset-y-0 flex w-3.5 cursor-pointer items-center justify-center"
                key={shown.lane}
                onClick={() => jump(row)}
                onPointerEnter={() => setActive(row)}
                style={{ left: shown.lane * LANE }}
                type="button"
              >
                <Glyph active={active === row} kind={shown.mark.kind} />
              </button>
            )
          })}
        </div>
      ))}
      {active !== undefined && activeSlot !== undefined && (
        <Tip
          mark={rows[active].mark}
          more={slots[activeSlot].rows.length - 1}
          top={4 + activeSlot * gap + gap / 2}
        />
      )}
    </div>
  )
}

function Minimap() {
  const viewport = useViewport()
  const { id, entries } = useConversation()
  const profile = useProfile(id)
  const latest = entries.at(-1)?.id
  const shown = viewport !== 'phone' && id !== undefined
  const { data, refetch } = useAction(
    MarksAction,
    { conversationId: id ?? 0 },
    { enabled: shown, onError: () => undefined },
  )
  // New entries may bring marks; the server reads only what is new since its last call.
  useEffect(() => {
    // oxlint-disable-next-line typescript/no-floating-promises -- useAction reports failures and resolves undefined.
    if (shown && latest !== undefined) void refetch()
  }, [shown, latest, refetch])
  const rows = useMemo(
    () =>
      (data ?? []).flatMap((mark) => {
        const lane = laneOf(mark.kind, profile)
        return lane === undefined ? [] : [{ mark, lane }]
      }),
    [data, profile],
  )
  const box = useRef<HTMLDivElement>(null)
  const [room, setRoom] = useState(0)
  useEffect(() => {
    const element = box.current
    if (!element) return undefined
    const observer = new ResizeObserver(() => setRoom(element.clientHeight))
    observer.observe(element)
    return () => observer.disconnect()
  }, [shown])
  if (!shown) return null
  return (
    <div
      className="pointer-events-none absolute top-4 right-4 bottom-40 flex flex-col items-end"
      ref={box}
    >
      {rows.length > 0 && room > 0 && <Lanes id={id} room={room} rows={rows} />}
    </div>
  )
}

export default defineWebExtension({
  slots: { 'conversation.overlay': [Minimap] },
})
