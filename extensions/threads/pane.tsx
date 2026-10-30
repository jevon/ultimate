import { cn } from 'cn'
import { ArrowLeftIcon, MessageSquareIcon, SquareArrowOutUpRightIcon, XIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import {
  api,
  Composer,
  ComposerRedirect,
  ThreadView,
  useConversation,
  useUltimate,
  useViewport,
} from '@/sdk'
import { FeatureTag, useOverview } from '../conversations/ui.tsx'
import {
  ease,
  reduced,
  tones,
  useInset,
  useOpenThread,
  useSeeing,
  useThread,
  useThreads,
} from './model.tsx'
import { Dot } from './roots.tsx'
import { reply } from './threads.tsx'

const duration = 340

/** Over @ultimate's conversation: the open thread, as a column on the right, or a sheet over main on a phone. */
export function Threads() {
  const found = useThreads()
  const sheet = useViewport() === 'phone'
  if (!found) return null
  return <Pane sheet={sheet} />
}

/** The open thread as a column on the right; main's column moves left to make room. On a phone, a sheet over main. */
function Pane({ sheet }: { sheet: boolean }) {
  const [open, setOpen] = useOpenThread()
  // The last thread stays mounted while its column leaves.
  const [shown, setShown] = useState<number | null>(open)
  if (open !== null && shown !== open) setShown(open)
  useEffect(() => {
    if (open !== null) return undefined
    const timer = setTimeout(() => setShown(null), duration + 40)
    return () => clearTimeout(timer)
  }, [open])
  const [pane, setPane] = useState(420)
  const { ref, width } = useInset(open !== null && !sheet ? pane : 0)
  const fit = Math.round(Math.min(512, Math.max(360, width * 0.4)))
  if (width && fit !== pane) setPane(fit)
  const still = reduced()
  const away = sheet ? 'translateY(104%)' : 'translateX(24px)'
  return (
    <div className="pointer-events-none absolute inset-0 z-20 overflow-hidden" ref={ref}>
      {shown !== null && (
        <aside
          aria-label="Thread"
          className={cn(
            'absolute flex flex-col overflow-hidden bg-background',
            open !== null && 'pointer-events-auto',
            sheet
              ? 'inset-x-0 top-0 bottom-0 shadow-2xl shadow-black/40'
              : 'top-0 right-0 bottom-0 border-l border-border/70',
          )}
          data-thread-pane={shown}
          inert={open === null}
          style={{
            width: sheet ? undefined : pane,
            transition: still
              ? `opacity ${duration}ms ease`
              : `transform ${duration}ms ${ease}, opacity ${duration}ms ease`,
            transform: open !== null || still ? 'none' : away,
            opacity: open !== null ? 1 : 0,
          }}
        >
          <ThreadHead id={shown} onClose={() => setOpen(null)} sheet={sheet} />
          <ThreadBody id={shown} />
        </aside>
      )}
    </div>
  )
}

/** A thread's header: where it stands, what it is, the way out. */
function ThreadHead({ id, onClose, sheet }: { id: number; onClose: () => void; sheet?: boolean }) {
  const shown = useThread(id)
  const feature = useOverview()[id]?.feature
  const tone = shown && tones[shown.tone]
  return (
    <header className="@container/thread flex h-11 shrink-0 items-center gap-2 border-b border-border/60 px-3 font-mono text-[11px] text-muted-foreground">
      {sheet ? (
        <button
          className="-ml-1 flex shrink-0 cursor-pointer items-center gap-1 rounded-sm px-1.5 py-1 text-foreground hover:bg-accent"
          onClick={onClose}
          type="button"
        >
          <ArrowLeftIcon className="size-3.5" />
          @ultimate
        </button>
      ) : (
        <MessageSquareIcon className="size-3.5 shrink-0 text-brand" />
      )}
      {feature && <FeatureTag className="shrink-0" feature={feature} />}
      <span className="min-w-0 truncate font-sans text-[13px] font-semibold text-foreground">
        {shown?.title ?? `#${id}`}
      </span>
      {shown && tone && (
        <span className={cn('flex shrink-0 items-center gap-1.5', tone.text)}>
          <Dot tone={shown.tone} />
          <span className="@max-[26rem]/thread:hidden">{tone.word}</span>
        </span>
      )}
      <span className="ml-auto flex shrink-0 items-center gap-1">
        <OpenBranch id={id} />
        {!sheet && (
          <button
            aria-label="Close thread"
            className="flex size-6 cursor-pointer items-center justify-center rounded-md hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
            onClick={onClose}
            title="Close thread"
            type="button"
          >
            <XIcon className="size-3.5" />
          </button>
        )}
      </span>
    </header>
  )
}

/** Opens the branch itself, with a dot while it works. */
function OpenBranch({ id }: { id: number }) {
  const { switchConversation } = useUltimate()
  return (
    <button
      aria-label={`Open branch #${id}`}
      className="flex size-6 cursor-pointer items-center justify-center rounded-md hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
      onClick={() => switchConversation(id)}
      title={`Open branch #${id}`}
      type="button"
    >
      <SquareArrowOutUpRightIcon className="size-3.5" />
    </button>
  )
}

/** A thread's story, and a composer whose words go to @ultimate about it. */
function ThreadBody({ id }: { id: number }) {
  const self = useConversation((conversation) => conversation.id)
  const shown = useThread(id)
  useSeeing(id, shown?.newest)
  return (
    <ThreadView thread={id}>
      <ComposerRedirect
        to={{
          placeholder: `Reply about #${id}…`,
          send: (text) => api.submit(reply(id, text), 'followUp', self),
        }}
      >
        <Composer dock />
      </ComposerRedirect>
    </ThreadView>
  )
}
