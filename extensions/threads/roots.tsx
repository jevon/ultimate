import { cn } from 'cn'
import { useRef } from 'react'
import { Shimmer } from '@/components/ai/shimmer'
import { formatAgo, useNow } from '@/sdk'
import type { EntryRecord } from '@/sdk'
import { FeatureTag, useOverview } from '../conversations/ui.tsx'
import { tones, useOpenThread, usePulse, useThread, useToggle } from './model.tsx'
import type { Tone } from './model.tsx'

/** Where a thread stands, as a dot. */
export function Dot({ tone, className }: { tone: Tone; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('size-1.5 shrink-0 rounded-full', tones[tone].dot, className)}
      title={tones[tone].word}
    />
  )
}

/** How many replies the reader has not seen, or nothing. */
export function Fresh({ count, className }: { count: number; className?: string }) {
  if (!count) return null
  return (
    <span
      className={cn(
        'shrink-0 rounded-full bg-brand px-1.5 font-mono text-[10px] leading-4 text-brand-foreground tabular-nums',
        className,
      )}
    >
      {count} new
    </span>
  )
}

/**
 * A thread's root in @ultimate's main stream, like a chat app's "N replies" row: where it stands, the feature, the
 * newest reply's first line and who said it, how many and when. A click opens the thread beside the conversation.
 */
export function ThreadRoot({ entry }: { entry: EntryRecord }) {
  return <RootCard id={(entry.data as { thread: number }).thread} />
}

function RootCard({ id }: { id: number }) {
  const shown = useThread(id)
  const [open] = useOpenThread()
  const toggle = useToggle()
  const now = useNow(30_000)
  const feature = useOverview()[id]?.feature
  const ref = useRef<HTMLButtonElement>(null)
  usePulse(ref, shown?.newest)
  if (!shown) return null
  const tone = tones[shown.tone]
  const active = open === id
  return (
    <button
      aria-expanded={active}
      className={cn(
        'group flex w-full min-w-0 cursor-pointer flex-col gap-1 rounded-md border border-l-2 bg-muted/20 px-3 py-2 text-left transition-colors outline-none focus-visible:ring-1 focus-visible:ring-ring',
        tone.edge,
        active ? 'border-brand/40 bg-accent/50' : 'border-border/70 hover:bg-accent/40',
      )}
      data-thread-root={id}
      data-unread={shown.fresh > 0 || undefined}
      onClick={() => toggle(id, shown.newest)}
      ref={ref}
      type="button"
    >
      <span className="flex min-w-0 items-center gap-2 font-mono text-[11px] text-muted-foreground">
        <Dot tone={shown.tone} />
        {feature && <FeatureTag className="shrink-0" feature={feature} />}
        <span className="min-w-0 truncate font-sans text-[12.5px] text-foreground">
          {shown.title ?? `#${id}`}
        </span>
        <span className="shrink-0 text-muted-foreground/70">#{id}</span>
        <span className={cn('ml-auto shrink-0', tone.text)}>{tone.word}</span>
      </span>
      {shown.writing ? (
        <span
          className="flex min-w-0 items-baseline gap-1.5 pl-3.5 text-[13px]"
          data-thread-writing
        >
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground">@ultimate</span>
          <Shimmer as="span">writing…</Shimmer>
        </span>
      ) : (
        shown.line && (
          <span className="flex min-w-0 items-baseline gap-1.5 pl-3.5 text-[13px]">
            {shown.who && (
              <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                {shown.who}
              </span>
            )}
            <span
              className={cn(
                'min-w-0 truncate',
                shown.fresh ? 'text-foreground' : 'text-foreground/75',
              )}
            >
              {shown.line}
            </span>
          </span>
        )
      )}
      <span className="flex items-center gap-2 pl-3.5 font-mono text-[11px]">
        <span className="text-brand/90 group-hover:underline">
          {shown.replies} {shown.replies === 1 ? 'reply' : 'replies'}
        </span>
        {shown.at !== undefined && (
          <span className="text-muted-foreground/70">{formatAgo(shown.at, now)}</span>
        )}
        <Fresh count={shown.fresh} />
        <span className="ml-auto text-muted-foreground/60 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
          {active ? 'close thread' : 'open thread →'}
        </span>
      </span>
    </button>
  )
}
