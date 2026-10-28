import { createElement } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import type { ConversationId, TaskGraphNode, TaskId } from '@earendil-works/pi-durable'

const { action, notify, setState } = vi.hoisted(() => ({
  action: vi.fn<(...args: unknown[]) => Promise<null>>(() => Promise.resolve(null)),
  notify: vi.fn<(notice: { level: string; message: string }) => void>(),
  setState: vi.fn<(value: unknown) => void>(),
}))
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  // Lets the test call a component outside a render to reach its click handler.
  useState: <T>(initial: T) => [initial, setState],
}))
vi.mock('@/sdk', () => ({
  api: { action },
  cn: (...names: unknown[]) => names.filter(Boolean).join(' '),
  defineWebExtension: (extension: unknown) => extension,
  errorMessage: (error: unknown) => String(error),
  formatDuration: (ms: number) => `${ms}ms`,
  provide: () => ({}),
  RunStart: {},
}))
vi.mock('@/sdk/client', () => ({ store: { notify } }))
vi.mock('@/components/ai/tool', () => ({
  ToolStatusIcon: ({ state }: { state: string }) => createElement('i', { 'data-state': state }),
}))
vi.mock('../../extensions/workspaces/ui.tsx', () => ({}))
vi.mock('../../extensions/conversations/ui.tsx', () => ({}))
vi.mock('../../extensions/plan/ui.tsx', () => ({}))
vi.mock('../../extensions/messages/ui.tsx', () => ({}))
vi.mock('@/components/ui/collapsible', () => ({}))
const { RetryButton, TaskRow } = await import('../../extensions/tasks/web.tsx')
const { RetryAction } = await import('../../extensions/tasks/refs.ts')

const task = (blocked?: TaskGraphNode['blocked']): TaskGraphNode => ({
  id: 7 as TaskId,
  kind: 'pi.generation',
  conversationId: 3 as ConversationId,
  background: false,
  abortRequested: false,
  state: { status: 'running', phase: 'stream' },
  conversations: [],
  ...(blocked ? { blocked } : {}),
})
const tree = {
  children: new Map(),
  roots: new Map(),
  summaries: new Map(),
  meanings: new Map(),
  started: {},
  features: new Map(),
  now: 0,
}
const row = (node: TaskGraphNode) =>
  renderToStaticMarkup(createElement(TaskRow, { task: node, tree, depth: 0 }) as ReactNode)

it('shows a parked task with its reason and a Retry button', () => {
  const html = row(task('restart_limit'))
  expect(html).toContain('parked after 5 crashes')
  expect(html).toContain('data-state="interrupted"')
  expect(html).toContain('data-retry="7"')
  expect(row(task())).not.toContain('data-retry')
})

it('names another blocked reason without offering Retry, which only runs parked tasks', () => {
  const html = row(task('missing_task'))
  expect(html).toContain('blocked · missing task')
  expect(html).not.toContain('data-retry')
})

it('draws elbows to children, a rail past an ancestor with siblings below, and none at the top', () => {
  const child = (id: number) => ({ ...task(), id: id as TaskId })
  const nested = {
    ...tree,
    children: new Map([
      [7, [child(8), child(9)]],
      [8, [child(10)]],
    ]),
  }
  const html = renderToStaticMarkup(
    createElement(TaskRow, { task: task(), tree: nested, depth: 0 }) as ReactNode,
  )
  // Rows in order 7, 8, 10, 9: the top row has no lines; 8 continues down to its sibling 9 (full height), 9 is last
  // (half height); 10 is last under 8 but keeps 8's rail because 9 follows.
  const rows = html.split('<div class="relative').slice(1)
  expect(rows).toHaveLength(4)
  expect(rows[0]).not.toContain('border-dashed')
  expect(rows[1]).toContain('bottom-0')
  expect(rows[2]).toContain('inset-y-0')
  expect(rows[2]).toContain('h-1/2')
  expect(rows[3]).toContain('h-1/2')
  expect(rows[3]).not.toContain('inset-y-0')
})

it('Retry calls the retry action with the task id', async () => {
  const button = RetryButton({ id: 7 }) as ReactElement<{ onClick: () => Promise<void> }>
  await button.props.onClick()
  expect(action).toHaveBeenCalledWith(RetryAction, { id: 7 })
})

it('reports a failed Retry and clears its busy state', async () => {
  action.mockRejectedValueOnce(new Error('Task is no longer parked'))
  setState.mockClear()
  notify.mockClear()
  const button = RetryButton({ id: 7 }) as ReactElement<{ onClick: () => Promise<void> }>
  await button.props.onClick()
  expect(notify).toHaveBeenCalledWith({
    level: 'error',
    message: 'Error: Task is no longer parked',
  })
  expect(setState.mock.calls).toEqual([[true], [false]])
})
