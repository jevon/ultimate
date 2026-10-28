import { AudioLinesIcon, PlayIcon, SquareIcon, Volume2Icon, VolumeOffIcon } from 'lucide-react'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { Checkbox } from '@/components/ui/checkbox'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import {
  cn,
  defineWebExtension,
  ConversationScope,
  useConversation,
  useConversations,
  useDocOf,
  useEvents,
  useExtensionUiState,
  useNow,
} from '@/sdk'
import { MessagesDoc, emptyMessages } from '../messages/ui.tsx'
import { OverviewDoc } from '../conversations/ui.tsx'
import { StandingDoc } from '../subagents/ui.tsx'
import { Committed } from '../coding-tools/ui.tsx'
import { CheckRan, SubmissionLanded } from '../workspaces/ui.tsx'
import { listener, sounds } from './cues.ts'
import type { Cue, Sound } from './cues.ts'
import { silence, tracker, variants } from './agents.ts'
import type { Variant } from './agents.ts'
import * as conductor from './conductor.ts'
import * as tones from './tones.ts'

const playedKey = 'ultimate.sounds.played'

function useSettings() {
  const [muted, setMuted] = useExtensionUiState('muted', false)
  const [off, setOff] = useExtensionUiState<Sound[]>('off', [])
  const [volume, setVolume] = useExtensionUiState('volume', 0.8)
  // The sound of agents: off, or the variant that plays.
  const [stored, setAgents] = useExtensionUiState<string>('agents', 'off')
  // A variant from another build plays as off.
  const agents: Variant | 'off' = variants.some((variant) => variant.id === stored)
    ? (stored as Variant)
    : 'off'
  return { muted, setMuted, off, setOff, volume, setVolume, agents, setAgents }
}

/**
 * Sounds `cue` in one tab only: every open tab sees the same event, and the first that may play claims it under a
 * lock, in this origin's storage. A tab nobody has clicked in yet may not play, so it leaves the event to another.
 */
async function announce(cue: Cue) {
  if (!navigator.userActivation.hasBeenActive) return
  const claimed = await navigator.locks.request(playedKey, () => {
    const played: string[] = JSON.parse(localStorage.getItem(playedKey) ?? '[]')
    if (played.includes(cue.key)) return false
    localStorage.setItem(playedKey, JSON.stringify([...played, cue.key].slice(-100)))
    return true
  })
  if (claimed) await tones.play(cue.sound)
}

/**
 * Watches @ultimate and sounds what it newly tells the user: a question, a finished answer,
 * a failed run. Whatever it shows when this tab opens has been heard already.
 */
function Player() {
  const overview = useDocOf(1, OverviewDoc)
  const log = useDocOf(1, MessagesDoc)
  const agent = useDocOf(1, StandingDoc)?.ultimate
  const { muted, off, volume, agents } = useSettings()
  const [hear] = useState(listener)
  useEffect(() => tones.setVolume(muted ? 0 : volume), [muted, volume])
  useEffect(() => {
    // oxlint-disable-next-line typescript/no-floating-promises -- conduct catches nothing worth reporting beyond a warning.
    conductor
      .conduct(muted || agents === 'off' ? undefined : agents)
      .catch((error: unknown) => console.warn('Sound of agents failed', error))
  }, [muted, agents])
  useEffect(() => {
    if (!overview || agent === undefined) return
    const due = hear({
      agent,
      row: overview.conversations[agent],
      messages: (log ?? emptyMessages).messages,
    })
    for (const cue of due)
      if (!muted && !off.includes(cue.sound))
        announce(cue).catch((error: unknown) => console.warn('Sound failed', error))
  }, [hear, overview, log, agent, muted, off])
  return agents !== 'off' && !muted ? <Listener /> : null
}

const watched = [SubmissionLanded, Committed, CheckRan] as const

/** While the sound of agents plays: follows every conversation, tool call and landing, and hands them to the band. */
function Listener() {
  const conversations = useConversations()
  const overview = useDocOf(1, OverviewDoc)
  const standing = useDocOf(1, StandingDoc)
  const events = useEvents({ events: watched, limit: 20 })
  const [follow] = useState(tracker)
  // Each busy conversation's live round, reported by a `Round` in its scope: its tool calls by name, and whether its
  // model streams. A fast call passes through `pi.live` but often not through the coalesced task graph.
  const [rounds, setRounds] = useState<Record<number, Round>>({})
  const busy = conversations.filter((conversation) => conversation.busy).map(({ id }) => id)
  useEffect(() => {
    if (!overview) return
    const live = busy.map((id) => rounds[id]).filter((round) => round !== undefined)
    const { happenings, level } = follow({
      conversations,
      standing: new Set(Object.values(standing ?? {})),
      tools: Object.fromEntries(live.flatMap((round) => round.tools)),
      streaming: live.filter((round) => round.streaming).length,
      runs: overview.conversations,
      events: events ?? [],
    })
    for (const happening of happenings) conductor.hit(happening)
    conductor.level('live', level)
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- `busy` follows `conversations`.
  }, [follow, conversations, standing, rounds, overview, events])
  useEffect(() => () => conductor.level('live', silence), [])
  return busy.map((id) => (
    <ConversationScope id={id} key={id}>
      <RoundOf id={id} report={setRounds} />
    </ConversationScope>
  ))
}

type Round = { tools: [string, { name: string; conversationId: number }][]; streaming: boolean }

/** Reports conversation `id`'s current round from its `pi.live`. */
function RoundOf({
  id,
  report,
}: {
  id: number
  report: (update: (previous: Record<number, Round>) => Record<number, Round>) => void
}) {
  const live = useConversation((conversation) => conversation.live)
  useEffect(() => {
    const round: Round = {
      tools: [...(live.tools ?? []), ...(live.nestedTools ?? [])].map((slot) => [
        `${id}:${slot.callId}`,
        { name: slot.name, conversationId: id },
      ]),
      streaming: live.generation?.message !== undefined && !live.tools,
    }
    report((previous) => ({ ...previous, [id]: round }))
  }, [id, live, report])
  return null
}

const preview = (sound: Sound) =>
  tones.play(sound).catch((error: unknown) => console.warn('Sound failed', error))

const row = 'flex h-8 items-center justify-between gap-2 px-2 text-[12px]'
const section = 'border-t border-border/70 pt-1'

/** The status-bar entry: sounds on or off, volume, the sound of agents, and each notification cue. */
function Control() {
  const { muted, setMuted, off, setOff, volume, setVolume, agents, setAgents } = useSettings()
  const stage = useSyncExternalStore(conductor.subscribe, conductor.current)
  const now = useNow(1000, stage.demoUntil !== undefined)
  const playing = agents !== 'off' && !muted
  const left =
    stage.demoUntil === undefined
      ? undefined
      : Math.max(0, Math.ceil((stage.demoUntil - now) / 1000))
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          aria-label="Sounds"
          className={cn(
            '-mx-1 flex items-center gap-1.5 rounded-sm px-1 transition-colors hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground',
            muted && 'text-muted-foreground/60',
            playing && 'text-brand',
          )}
          type="button"
        >
          {muted ? (
            <VolumeOffIcon className="size-3" />
          ) : playing ? (
            <AudioLinesIcon className="size-3 animate-pulse" />
          ) : (
            <Volume2Icon className="size-3" />
          )}
          sounds
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-1 font-mono" side="top">
        <label className={cn(row, 'cursor-pointer')}>
          Sounds
          <Switch checked={!muted} onCheckedChange={(on) => setMuted(!on)} />
        </label>
        <label className={cn(row, muted && 'opacity-50')}>
          <span className="text-muted-foreground">Volume</span>
          <input
            aria-label="Volume"
            className="h-1 w-32 cursor-pointer accent-brand"
            disabled={muted}
            max={1}
            min={0}
            onChange={(event) => setVolume(Number(event.target.value))}
            step={0.05}
            type="range"
            value={volume}
          />
        </label>
        <div className={cn(section, muted && 'opacity-50')}>
          <label className={cn(row, 'cursor-pointer')}>
            Sound of agents
            <Switch
              checked={agents !== 'off'}
              disabled={muted}
              onCheckedChange={(on) => setAgents(on ? 'ambient' : 'off')}
            />
          </label>
          {agents !== 'off' && (
            <>
              <div
                aria-label="Variant"
                className="mx-2 mb-1 grid grid-cols-3 rounded-md border border-border/70 p-px"
                role="radiogroup"
              >
                {variants.map((variant) => (
                  <button
                    aria-checked={agents === variant.id}
                    className={cn(
                      'h-6 cursor-pointer rounded-[5px] text-[11px] text-muted-foreground transition-colors hover:text-foreground',
                      agents === variant.id && 'bg-accent text-foreground',
                    )}
                    disabled={muted}
                    key={variant.id}
                    onClick={() => setAgents(variant.id)}
                    role="radio"
                    title={variant.detail}
                    type="button"
                  >
                    {variant.label}
                  </button>
                ))}
              </div>
              <div className="px-2 pb-1 text-[11px] leading-4 text-muted-foreground">
                {variants.find((variant) => variant.id === agents)?.detail}
              </div>
              <button
                className={cn(
                  row,
                  'w-full cursor-pointer rounded-sm whitespace-nowrap hover:bg-accent',
                  left !== undefined && 'text-brand',
                )}
                disabled={muted}
                onClick={() => (left === undefined ? conductor.startDemo() : conductor.stopDemo())}
                type="button"
              >
                <span className="flex items-center gap-2">
                  {left === undefined ? (
                    <PlayIcon className="size-3" />
                  ) : (
                    <SquareIcon className="size-3" />
                  )}
                  {left === undefined ? 'Start demo' : 'Stop demo'}
                </span>
                <span className="text-[11px] text-muted-foreground">
                  {left === undefined ? '40s' : `${left}s`}
                </span>
              </button>
              {stage.blocked && (
                <div className="px-2 pb-1 text-[11px] text-warning">
                  Click anywhere to start audio
                </div>
              )}
            </>
          )}
        </div>
        <div className={section}>
          {sounds.map(({ sound, label }) => (
            <div
              className={cn('flex h-7 items-center gap-2 px-2 text-[12px]', muted && 'opacity-50')}
              key={sound}
            >
              <label className="flex flex-1 cursor-pointer items-center gap-2">
                <Checkbox
                  checked={!off.includes(sound)}
                  disabled={muted}
                  onCheckedChange={(on) => {
                    setOff((previous) =>
                      on ? previous.filter((other) => other !== sound) : [...previous, sound],
                    )
                    // oxlint-disable-next-line typescript/no-floating-promises -- preview catches and logs playback failures.
                    if (on) void preview(sound)
                  }}
                />
                {label}
              </label>
              <button
                aria-label={`Play ${label}`}
                className="grid size-5 place-items-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                onClick={() => void preview(sound)}
                type="button"
              >
                <PlayIcon className="size-3" />
              </button>
            </div>
          ))}
          <div className="px-2 pt-0.5 pb-1 text-[11px] text-muted-foreground">
            Notifications from @ultimate only
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

export default defineWebExtension({
  slots: { overlay: [Player], 'statusline.right': [{ component: Control, order: -1 }] },
  commands: [
    {
      id: 'sounds.demo',
      title: 'Play the sound of agents demo',
      run: () => conductor.startDemo(),
    },
  ],
})
