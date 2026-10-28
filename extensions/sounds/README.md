# Sounds

Short, soft notification sounds when @ultimate talks to you: a question (needs input), a
finished answer, or a failed run, and an opt-in **sound of agents** that plays the whole project's activity as music.
"sounds" in the status bar opens a switch for all of them, a volume slider, the sound of agents with its variants and
demo, and a checkbox and a play button for each notification; the choices live in `ext.sounds.muted`,
`ext.sounds.volume`, `ext.sounds.agents` and `ext.sounds.off`.

## Notifications

Only the primary standing agent sounds, read from the root's documents:

- **Needs input:** its reply-expected `message` to the user (`messages`); every question goes that way.
- **Finished:** its one-way `message` to the user, or its answer to your typed input.
- **Failed:** its run ended in an error (`ultimate.conversation-overview`); a stop or a reset does not.

Nothing else notifies: branches, workers, the lander, other standing agents, messages to you from anyone else,
landings, and @ultimate's answers to other agents' messages (`internalInput`).

Each event sounds once. Whatever the documents show when a tab opens has been heard already, and of several open tabs
the first that may play claims the event under a Web Lock in local storage. Browsers let a page play only after
someone clicked or typed in it, so a tab that never had input leaves the event to another. `cues.ts` decides what
sounds.

## Sound of agents

Off by default. Turned on, every tab plays the project: `agents.ts` follows the conversation list (busy states and
each one's role from its label), each busy conversation's `pi.live` (its tool calls by name and whether its model
streams; a fast call passes through there but often not through the coalesced task graph) and the event feed (`coding-tools.committed`, `workspaces.landed`, failed `workspaces.check`), plus
failed runs from the overview. It turns them into happenings (a conversation starts or stops, a tool call by timbre,
a commit, a landing, a failure) and a level (busy conversations by role, streaming models). Only happenings sound: there is no background drone, pad or beat, so idle is silence. The level sets the tempo.

Three variants, all in D major and quantized to a sixteenth, with a cap on happenings per step:

- **Ambient:** each tool call a soft two-note chord in its role's register, echoing into a long reverb; a landing a
  wide major chord, a failure a dark cluster.
- **Orchestra:** each role an instrument (@ultimate strings, coordinators cello, workers plucks, scouts flute,
  reviewers marimba, the lander brass) over a I–vi–IV–V progression; tools are articulations, a start an upward
  chord, a landing a V–I cadence, a failure a dissonant cluster.
- **Crazy:** faster as load grows (104 to 178 bpm); bash a snare, edits an acid note, reads hats, browser calls zaps;
  every call bites a bitcrusher harder; a landing drops, a failure crunches.

**Start demo** (in the popover, or ⌘K "Play the sound of agents demo") plays about 40 seconds of a scripted feature
through the same mapping: a coordinator, a scout, two workers, a commit, a failed check, reviewers, the lander and a
landing. Real activity plays along.

## Engine

Everything is synthesized with Tone.js in `engine.ts`, loaded on first sound (Tone opens an AudioContext when it
loads): FM bells over a soft pad chord for the notifications, a shared light reverb and a limiter, and the three
bands. A page plays only after a click or key press; with the sound of agents on after a reload, the popover says
"Click anywhere to start audio" and the first click starts it. `ui.tsx` exports `playNotes` for other extensions.
