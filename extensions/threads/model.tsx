import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { useConversation, useConversations, useDocOf, useTranscript, useUiState } from '@/sdk'
import type { CompactDocs, EntryRecord } from '@/sdk'
import { MessagesDoc } from '../messages/ui.tsx'
import type { Message } from '../messages/refs.ts'
import { StandingDoc } from '../subagents/ui.tsx'
import { threadsOf } from './threads.tsx'
import type { Thread } from './threads.tsx'

export const isUltimate = (id: number | undefined, standing: unknown) =>
  id !== undefined && (standing as { ultimate?: unknown } | null | undefined)?.ultimate === id
export const messagesOf = (docs: CompactDocs) =>
  (docs.board as { messages?: Message[] } | null | undefined)?.messages ?? []

/** The thread open beside the conversation, if any; durable UI state, so a reload keeps it open. */
export const useOpenThread = () => useUiState<number | null>('ext.threads.open', null)
/** The newest entry of each thread the reader has seen, by thread: a newer one marks the root unread. */
export const useSeen = () => useUiState<Record<string, number>>('ext.threads.seen', {})

/** @ultimate's threads over the entries loaded: one per branch it talked with. */
export function useThreads() {
  const id = useConversation((conversation) => conversation.id)
  const busy = useConversation((conversation) => conversation.busy)
  const standing = useDocOf(1, StandingDoc)
  const log = useDocOf(1, MessagesDoc)
  // What the transcript around it has loaded, earlier pages included, so a root sees the same entries that split the
  // stream; outside a transcript (the pane's header and the seen marker), the active entries.
  const loaded = useTranscript()
  const active = useConversation((conversation) => conversation.entries)
  const entries = loaded.length ? loaded : active
  if (!isUltimate(id, standing)) return undefined
  const threads = threadsOf(entries, log?.messages ?? [], id!)
  // The thread @ultimate is writing in: its run in progress was woken by that thread alone.
  const writing = busy && threads.live.length === 1 ? threads.live[0] : undefined
  return { self: id!, entries, threads, writing }
}

export type Tone = 'waiting' | 'working' | 'landed' | 'idle'
export const tones: Record<Tone, { word: string; text: string; dot: string; edge: string }> = {
  waiting: {
    word: 'waiting on you',
    text: 'text-warning',
    dot: 'bg-warning',
    edge: 'border-l-warning/70',
  },
  working: {
    word: 'working',
    text: 'text-brand',
    dot: 'bg-brand animate-pulse-dot',
    edge: 'border-l-brand/60',
  },
  landed: {
    word: 'landed',
    text: 'text-success',
    dot: 'bg-success',
    edge: 'border-l-success/60',
  },
  idle: {
    word: 'idle',
    text: 'text-muted-foreground/70',
    dot: 'bg-muted-foreground/40',
    edge: 'border-l-border',
  },
}

/** A thread's entries that say something: messages in and out, answers, landings; not tool steps. */
function said(
  entries: readonly EntryRecord[],
  of: ReadonlyMap<number, readonly number[]>,
  id: number,
) {
  return entries.filter((entry) => {
    if (!of.get(entry.id)?.includes(id)) return false
    if (entry.kind === 'pi.tool-result') return false
    const message = entry.model?.[0]
    if (message?.role === 'assistant')
      return message.content.some(
        (block) =>
          (block.type === 'text' && block.text.trim()) ||
          (block.type === 'toolCall' && block.name === 'message'),
      )
    return true
  })
}

/** The first line a thread entry says, for its root. */
function firstLine(entry: EntryRecord | undefined): string {
  if (!entry) return ''
  const data = entry.data as
    | { text?: unknown; outcome?: { outcome?: string; sha?: string } }
    | undefined
  if (entry.kind === 'workspaces.lander-report')
    return data?.outcome?.outcome === 'landed'
      ? `Landed ${data.outcome.sha?.slice(0, 7)}`
      : 'Landing failed'
  if (typeof data?.text === 'string') return data.text
  const message = entry.model?.[0]
  if (message?.role === 'assistant') {
    for (const block of message.content) {
      if (block.type === 'toolCall' && block.name === 'message') {
        const text = (block.arguments as { text?: unknown }).text
        if (typeof text === 'string') return text
      }
      if (block.type === 'text' && block.text.trim()) return block.text
    }
  }
  if (message?.role === 'user')
    return typeof message.content === 'string'
      ? message.content
      : (message.content.find((block) => block.type === 'text')?.text ?? '')
  return ''
}
const oneLine = (text: string) =>
  text
    .replace(/^Re #\d+: /, '')
    .replace(/[*_`#>]/g, '')
    .split('\n')
    .find((line) => line.trim())
    ?.trim() ?? ''

/** Who said a thread entry, as its root names them. */
function speaker(entry: EntryRecord | undefined): string | undefined {
  if (!entry) return undefined
  const from = (entry.data as { from?: unknown; outcome?: unknown } | undefined)?.from
  if (entry.kind === 'workspaces.lander-report') return 'lander'
  if (from === 'user') return 'you'
  if (typeof from === 'number') return `#${from}`
  const role = entry.model?.[0]?.role
  if (role === 'assistant') return '@ultimate'
  if (role === 'user') return 'you'
  return undefined
}

const timeOf = (entry: EntryRecord | undefined) => {
  const at = entry?.model?.[0]?.timestamp ?? (entry?.data as { at?: unknown } | undefined)?.at
  return typeof at === 'number' ? at : undefined
}

/** Everything a root shows about thread `id`: where it stands, its newest reply, and what the reader has not seen. */
export function useThread(id: number) {
  const found = useThreads()
  const [seen] = useSeen()
  const [open] = useOpenThread()
  const conversation = useConversations().find((item) => item.id === id)
  const log = useDocOf(1, MessagesDoc)
  const thread: Thread | undefined = found?.threads.threads.find((item) => item.id === id)
  if (!found || !thread) return undefined
  const replies = said(found.entries, found.threads.of, id)
  const newest = replies.at(-1)
  const read = open === id ? (newest?.id ?? 0) : (seen[String(id)] ?? 0)
  const fresh = replies.filter((entry) => entry.id > read).length
  const asks = log?.messages.some(
    (m) => m.to === 'user' && m.reply && m.state === 'delivered' && thread.asks?.includes(m.id),
  )
  const tone: Tone = thread.landed
    ? 'landed'
    : asks
      ? 'waiting'
      : conversation?.busy
        ? 'working'
        : 'idle'
  return {
    thread,
    title: conversation?.title,
    writing: found.writing === id,
    tone,
    replies: replies.length,
    newest: newest?.id,
    line: oneLine(firstLine(newest)),
    who: speaker(newest),
    at: timeOf(newest),
    fresh,
  }
}

/** Opens or closes thread `id`, marking what it has so far as seen. */
export function useToggle() {
  const [open, setOpen] = useOpenThread()
  const [, setSeen] = useSeen()
  return (id: number, newest: number | undefined) => {
    setOpen(open === id ? null : id)
    if (newest !== undefined) setSeen((value) => ({ ...value, [id]: newest }))
  }
}

/** While thread `id` is open, what arrives in it is seen. */
export function useSeeing(id: number, newest: number | undefined) {
  const [, setSeen] = useSeen()
  useEffect(() => {
    if (newest !== undefined)
      setSeen((value) => (value[String(id)] === newest ? value : { ...value, [id]: newest }))
  }, [id, newest, setSeen])
}

export const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches
export const ease = 'cubic-bezier(0.2, 0.8, 0.2, 1)'

/** A short brand wash over `ref` when a reply arrives in its thread after it was shown; nothing with reduced motion. */
export function usePulse(ref: RefObject<HTMLElement | null>, newest: number | undefined) {
  const last = useRef(newest)
  useEffect(() => {
    const before = last.current
    last.current = newest
    if (before === undefined || newest === undefined || newest <= before) return
    if (!ref.current || reduced()) return
    ref.current.animate(
      [
        { backgroundColor: 'color-mix(in oklab, var(--brand) 22%, transparent)' },
        { backgroundColor: 'transparent' },
      ],
      { duration: 1400, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
    )
  }, [newest, ref])
}

/** Main's reading column, as the transcript centres it. */
const COLUMN = 736

/** Pads `region`'s right side; its centred children centre in what is left. */
function padRight(region: HTMLElement, px: number) {
  region.style.paddingRight = px ? `${px}px` : ''
}

/**
 * Gives a column `want` px wide on the right of the region the returned `ref`'s element sits in: the region pads its
 * right side, so main's transcript and composer centre in what is left beside it, and glide to their new place. A column
 * that fits main's free margin takes it as it is. Undone on unmount.
 */
export function useInset(want: number) {
  const ref = useRef<HTMLDivElement>(null)
  const previous = useRef(0)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const region = ref.current?.parentElement
    if (!region) return undefined
    const observer = new ResizeObserver(() => setWidth(region.clientWidth))
    observer.observe(region)
    return () => {
      observer.disconnect()
      padRight(region, 0)
    }
  }, [])
  const right = want > (width - COLUMN) / 2 ? want : 0
  useLayoutEffect(() => {
    const region = ref.current?.parentElement
    if (!region) return
    // Main's column moves by half the change: from there it glides back to rest.
    const dx = (right - previous.current) / 2
    previous.current = right
    padRight(region, right)
    if (!dx || reduced()) return
    for (const layer of region.children)
      if (layer instanceof HTMLElement && getComputedStyle(layer).position !== 'absolute')
        layer.animate([{ transform: `translateX(${dx}px)` }, { transform: 'none' }], {
          duration: 340,
          easing: ease,
        })
  }, [right])
  return { ref, width }
}
