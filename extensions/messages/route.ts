/** `board.route`: a branch's final answers reach the conversation that started it. */
import { defineTask, InboxDoc, LiveDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type {
  ConversationId,
  GenerationResult,
  SubmissionId,
  TaskId,
  Tx,
} from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { ConversationsApi } from '../conversations/api.ts'
import { Subagents } from '../subagents/api.ts'
import { WorkspacesApi } from '../workspaces/api.ts'
import { Messages } from './api.ts'
import { terminal } from './log.ts'
import { send } from './send.ts'

/** Every task state but `terminal`: queried by status, so finished tasks are never scanned. */
const LIVE = ['pending', 'running', 'waiting', 'sleeping', 'completing'] as const
/** Live tasks of `kind` in `conversationId` (any conversation when undefined). */
async function live(tx: Tx, kind: string, conversationId?: ConversationId) {
  const found = []
  for (const status of LIVE) {
    let cursor: Parameters<Tx['scanTasks']>[2]
    do {
      const page = await tx.scanTasks(
        { ...(conversationId === undefined ? {} : { conversationId }), kind, status },
        100,
        cursor,
      )
      found.push(...page.items)
      cursor = page.next
    } while (cursor !== undefined)
  }
  return found
}
/**
 * Whether `id` runs or has input queued, or one of its tasks will wake it: a subagent's report until its input is
 * admitted, or a waking `notify` on another conversation. Matched by kind, so messages needs neither extension.
 */
async function busy(tx: Tx, id: ConversationId) {
  if ((await tx.doc(LiveDoc, id)).run || (await tx.doc(InboxDoc, id)).items.length) return true
  if ((await live(tx, 'ultimate.subagent-reporter', id)).length) return true
  return (await live(tx, 'lineage.notify', id)).some(
    (task) => (task.input as { wake?: unknown }).wake !== false,
  )
}
/**
 * Whether branch `id` still has work under way that will wake it again: a run or queued input, a waking task, a
 * subagent at any depth that is busy, a submission the lander has not reported yet, or a reply-enabled message still
 * waiting on its answer. While the lander reports a landing it decides, once, whether the branch is done: it
 * concludes it and wakes the starter, or leaves it open to report when it stops. Until then a report waits as a note.
 */
async function underway(host: ExtensionHost, tx: Tx, id: ConversationId): Promise<boolean> {
  // A landing concludes the branch in the commit that ends its report and wakes the starter itself; an answer routed
  // after that, or for a branch concluded by hand, is not a report. Any input that runs the branch resumes it first.
  if ((await host.need(ConversationsApi).concludedIn(tx)).has(id)) return true
  const queue = (await tx.doc(host.need(WorkspacesApi).doc, ROOT_CONVERSATION_ID)).queue
  if (queue.some((item) => item.conversationId === id)) return true
  // A submission leaves the queue in the commit that moves the lander to reporting it.
  for (const task of await live(tx, 'workspaces.lander')) {
    const checkpoint = (task.state as { checkpoint?: { phase?: string; conversationId?: number } })
      .checkpoint
    if (checkpoint?.phase === 'report' && checkpoint.conversationId === id) return true
  }
  return working(tx, id)
}
/**
 * Whether `id` has work of its own that will wake it: a run or queued input, a waking task, a busy subagent at any
 * depth, or a reply-enabled message it sent still waiting on its answer. The lander asks it before concluding.
 */
export async function working(tx: Tx, id: ConversationId): Promise<boolean> {
  if (await busy(tx, id)) return true
  const log = await tx.doc(Messages, ROOT_CONVERSATION_ID)
  if (
    log.messages.some(
      (m) => m.from === id && m.reply && (m.state === 'sent' || m.state === 'delivered'),
    )
  )
    return true
  return children(tx, id)
}
async function children(tx: Tx, id: ConversationId): Promise<boolean> {
  for (const child of Object.values((await tx.doc(Subagents, id)).agents))
    if ((await busy(tx, child.conversationId)) || (await children(tx, child.conversationId)))
      return true
  return false
}

/**
 * After a branch's run, its final answer reaches the conversation that started it, unless it already goes back as the
 * answer to a reply-enabled message, the starter's or another conversation's. A branch that stops with nothing under way reports: its answer wakes
 * the starter. One that still waits on work (subagents, the lander, a reply) leaves it as a note. Routing goes only
 * from a branch to its starter, which existed first, and a routed message is one-way: it cannot ping-pong.
 */
export function route(host: ExtensionHost) {
  return defineTask<
    {
      generation: TaskId<GenerationResult>
      inputs: SubmissionId[]
      by: number
    },
    { phase: 'observe' },
    null
  >({
    name: 'board.route',
    version: 1,
    initial: () => ({ phase: 'observe' }),
    phases: {
      observe: async (task, runtime, ctx) => {
        const settled = await runtime.waitForTask(task.input.generation, ctx)
        if (settled.state.outcome.status !== 'completed') {
          await runtime.commit(() => terminal, ctx)
          return
        }
        const answer = settled.state.outcome.result.entryId
        const inputs = await Promise.all(
          task.input.inputs.map(async (id) =>
            (await host.harness().submission(id, ctx))?.status(ctx),
          ),
        )
        const { by } = task.input
        const id = runtime.conversationId
        const routed = await host.harness().commit(async (tx) => {
          // A continued generation's answer is no run's final answer: only inputs it settled make one.
          const answered = inputs.flatMap((input) =>
            input?.type === 'input' && input.status === 'done' && input.answer === answer
              ? [input.entry]
              : [],
          )
          if (!answered.length) return undefined
          // board.delivery returns an answer to a reply-enabled message to whoever sent it. To the starter's, that is
          // where the answer goes; when every input was another conversation's question (a sibling's, a subagent's),
          // it goes back to them, not also to the starter.
          let elsewhere = true
          for (const entryId of answered) {
            const entry = await tx.entry(entryId)
            const data = entry?.data as { from?: unknown; reply?: unknown } | undefined
            const asked = entry?.kind === 'board.message' && data?.reply === true
            if (asked && data.from === by) return undefined
            if (!asked) elsewhere = false
          }
          const message = (await tx.entry(answer))?.model?.[0]
          if (
            message?.role !== 'assistant' ||
            message.stopReason === 'error' ||
            message.stopReason === 'aborted'
          )
            return undefined
          const report = !(await underway(host, tx, id))
          if (elsewhere) {
            if (!report) return undefined
            // Answering them ended the branch's work, though, and the starter may have had its last update only as a
            // note: it becomes the report, so the starter still wakes when the branch stops.
            const last = (await tx.doc(Messages, ROOT_CONVERSATION_ID)).messages.findLast(
              (m) => (m.from === id && m.to === by) || (m.from === by && m.to === id),
            )
            if (last?.from !== id || last.reply || last.report || last.re !== undefined)
              return undefined
            return { text: last.text, report }
          }
          const text = message.content.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('')
          return { text, report }
        }, ctx)
        if (routed?.text.trim())
          await send(host, id, { to: `#${by}`, text: routed.text, reply: false }, ctx, {
            requestId: `route:${answer}`,
            note: !routed.report,
            report: routed.report,
          })
        await runtime.commit(() => terminal, ctx)
      },
    },
    abort: (_task, runtime, ctx) =>
      runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx),
  })
}
