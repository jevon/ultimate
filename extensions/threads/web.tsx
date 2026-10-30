import { GitBranchIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { MessageResponse } from '@/components/ai/message'
import { defineWebExtension, provide, useAction, useConversation, useDocOf } from '@/sdk'
import { FeatureTag } from '../conversations/ui.tsx'
import { AbstractAction } from '../lineage/ui.tsx'
import { StandingDoc } from '../subagents/ui.tsx'
import { LandingAfter } from '../workspaces/ui.tsx'
import { isUltimate, messagesOf } from './model.tsx'
import { Threads } from './pane.tsx'
import { ThreadRoot } from './roots.tsx'
import { ROOT, threading, threadsOf } from './threads.tsx'

/**
 * Under a landing in @ultimate's conversation: the feature's catch-up, its abstract as this landing froze it, so the
 * reader gets where it ended without opening the branch.
 */
function useCatchUp({ from: branch, sha }: { from: number; sha: string }): ReactNode {
  const id = useConversation((conversation) => conversation.id)
  const standing = useDocOf(1, StandingDoc)
  const show = isUltimate(id, standing) && branch !== id
  const abstract = useAction(
    AbstractAction,
    { id: branch, sha },
    // The landing card says what landed either way; the catch-up only adds to it.
    { enabled: show, onError: () => undefined },
  )
  const text = abstract.data?.text
  if (!show || !text) return null
  return (
    <section
      className="mt-1.5 rounded-md border border-border/60 bg-muted/10 px-3 py-2"
      data-thread-catchup={branch}
    >
      <header className="mb-1 flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
        <GitBranchIcon className="size-3 text-success" />
        catch-up
        {abstract.data?.feature && <FeatureTag feature={abstract.data.feature} />}
        <span className="min-w-0 truncate">{abstract.data?.title}</span>
      </header>
      {/* An abstract is a few `Label: text` lines (Ask, Diverged, State, Areas, Open): one row each. */}
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px] leading-relaxed">
        {text
          .split('\n')
          .filter((line) => line.trim())
          .map((line, index) => {
            const [, label, rest] = /^-?\s*([A-Z][\w ]{0,15}):\s*(.*)$/.exec(line) ?? []
            return (
              // oxlint-disable-next-line react/no-array-index-key -- the lines of one stored text keep their order.
              <div className="contents" key={index}>
                <dt className="pt-px font-mono text-[11px] text-muted-foreground">{label ?? ''}</dt>
                <dd className="min-w-0 text-foreground/85 [&_p]:my-0">
                  <MessageResponse>{rest ?? line}</MessageResponse>
                </dd>
              </div>
            )
          })}
      </dl>
    </section>
  )
}

export default defineWebExtension({
  slots: { 'conversation.overlay': [Threads] },
  entries: { [ROOT]: ThreadRoot },
  provides: [provide(LandingAfter, useCatchUp)],
  compact: {
    when: (conversation, docs) => isUltimate(conversation.id, docs[StandingDoc.kind]),
    docs: ['board', StandingDoc.kind],
    threads: (entries, docs, conversation) =>
      threading(entries, threadsOf(entries, messagesOf(docs), conversation)),
  },
})
