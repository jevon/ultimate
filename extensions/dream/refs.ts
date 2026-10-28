/** Dream in the browser: the prepared next chapter, the sleep into it and the chapters. Browser-safe. */
import { actionRef, docRef } from '../../shared/extension-api.ts'

/**
 * What @ultimate prepared for the next chapter once its dream's work was done: the chapter's name, three lines it
 * learned, and its handover, which the new chapter wakes up from.
 */
export type Prepared = { chapter: string; learned: string[]; handoff: string; at: number }

export type Sleep = {
  chapter: string
  /** `asleep`: the switch happened; this chapter is the one it left. */
  phase: 'seeding' | 'backing up' | 'switching' | 'asleep' | 'failed'
  backup?: { id?: string; skipped?: string }
  error?: string
  at: number
}

/** `{ prepared?, sleep? }` on conversation 1: the next chapter @ultimate prepared, and the sleep into it. */
export const DreamDoc = docRef<{ prepared?: Prepared; sleep?: Sleep }>('dream.next')

/**
 * A `dream.requested` entry in @ultimate's conversation: who asked for the dream, the user's Dream button or a
 * built-in automation (`pause`: how long the user had been away, ms).
 */
export type RequestedEntry = { automation?: { id: string; name: string; pause?: number } }

/** No arguments: ask @ultimate to dream now. User-only. */
export const StartAction = actionRef<null, { requested: true }>('dream', 'start')
/**
 * `{ chapter, learned, handoff }`: @ultimate prepares the next chapter and puts the Fall asleep card up; a second call
 * replaces it.
 */
export const PrepareAction = actionRef<
  { chapter: string; learned: string[]; handoff: string },
  Prepared
>('dream', 'prepare')
/** `{ name? }` → progress: seed, back up and restart into the prepared chapter. User-only. */
export const AsleepAction = actionRef<{ name?: string }, { sleep: Sleep }>('dream', 'asleep')
/** No arguments → the active chapter, its number, the newest name, and every chapter in creation order. */
export const ChaptersAction = actionRef<
  null,
  {
    active: string
    number: number
    newest: string
    chapters: { name: string; number: number; createdAt?: number }[]
  }
>('dream', 'chapters')
/** `{ chapter }`: restart into an existing, idle chapter. User-only; a returned error means restart failed. */
export const SwitchAction = actionRef<{ chapter: string }, never>('dream', 'switch')

/** Calls per tool over the trace's window: how often, how often failing, how slow; and enabled tools never called. */
export type ToolStats = {
  since?: number
  calls: number
  tools: { name: string; calls: number; failed: number; avgMs: number }[]
  unused: string[]
  errors: { name: string; error: string; count: number }[]
}
/** No arguments → tool statistics from `trace.sqlite`, no model involved. */
export const StatsAction = actionRef<null, ToolStats>('dream', 'stats')
