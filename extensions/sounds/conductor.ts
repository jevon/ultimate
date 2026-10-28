/**
 * The one band of this tab: which variant plays, what the live project and the demo feed it, and whether the browser
 * lets it play yet. Loads the Tone.js engine only once the sound of agents is on.
 */
import { demo, demoLength, demoPlayer, mix, silence } from './agents.ts'
import type { Happening, Level, Variant } from './agents.ts'
import type { Band } from './engine.ts'
import { engine } from './tones.ts'

export type Stage = {
  variant?: Variant
  /** Audio is on but the browser waits for a click in the page. */
  blocked: boolean
  /** The demo is playing; ends at this time (ms). */
  demoUntil?: number
}

let stage: Stage = { blocked: false }
let band: Band | undefined
let levels: { live: Level; demo: Level } = { live: silence, demo: silence }
let timers: ReturnType<typeof setTimeout>[] = []
const listeners = new Set<() => void>()

const set = (next: Partial<Stage>) => {
  stage = { ...stage, ...next }
  for (const listener of listeners) listener()
}
export const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}
export const current = () => stage

/** Any click or key press in the page lets audio start: the mode survives reloads without a dead first sound. */
async function unblock() {
  const { unlock, running } = await engine()
  await unlock()
  if (running()) set({ blocked: false })
}
function waitForGesture() {
  const once = () => {
    for (const type of ['pointerdown', 'keydown'] as const) removeEventListener(type, once, true)
    unblock().catch((error: unknown) => console.warn('Audio start failed', error))
  }
  for (const type of ['pointerdown', 'keydown'] as const)
    addEventListener(type, once, { capture: true })
}

/** Plays `variant`, or stops the band when undefined. */
export async function conduct(variant: Variant | undefined) {
  if (variant === stage.variant) return
  band?.dispose()
  band = undefined
  if (!variant) {
    stopDemo()
    set({ variant: undefined, blocked: false })
    return
  }
  set({ variant })
  const tone = await engine()
  // Turned off or switched again while the engine loaded.
  if (stage.variant !== variant) return
  // Without a click the browser keeps the context suspended; a click anywhere resumes it.
  if (!navigator.userActivation.hasBeenActive) {
    set({ blocked: true })
    waitForGesture()
  } else await tone.unlock()
  const playing = tone.band(variant)
  playing.level(mix(levels.live, levels.demo))
  band = playing
}

export const hit = (happening: Happening) => band?.hit(happening)

// A hot reload replaces this module: the old band would keep playing on the shared transport beside the new one.
import.meta.hot?.dispose(() => {
  band?.dispose()
  stopDemo()
})
export function level(source: 'live' | 'demo', next: Level) {
  levels = { ...levels, [source]: next }
  band?.level(mix(levels.live, levels.demo))
}

/** Plays the scripted demo through the band: a feature from first message to landing, about 40 seconds. */
export function startDemo() {
  stopDemo()
  const step = demoPlayer()
  timers = demo.map((s) =>
    setTimeout(() => {
      const { happening, level: next } = step(s)
      if (happening) hit(happening)
      level('demo', next)
    }, s.at * 1000),
  )
  timers.push(setTimeout(stopDemo, demoLength * 1000))
  set({ demoUntil: Date.now() + demoLength * 1000 })
}
export function stopDemo() {
  for (const timer of timers) clearTimeout(timer)
  timers = []
  level('demo', silence)
  if (stage.demoUntil !== undefined) set({ demoUntil: undefined })
}
