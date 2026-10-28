/**
 * Everything audible, on Tone.js: the notification cues and the three bands of the sound of agents. Loaded on first
 * use (`import('./engine.ts')`): Tone opens an AudioContext when it loads, and a page plays only after a click.
 */
import * as Tone from 'tone'
import type { Sound } from './cues.ts'
import type { Happening, Level, Role, Tool, Variant } from './agents.ts'
import { total } from './agents.ts'

/** A note as [start in seconds, frequency in Hz, length in seconds]. */
export type Note = readonly [number, number, number]

// One bus for everything: volume, a soft limiter so chords never clip, and a light shared reverb.
const master = new Tone.Volume(-6)
master.chain(new Tone.Limiter(-3), Tone.getDestination())
const reverb = new Tone.Reverb({ decay: 3.5, wet: 0.28 }).connect(master)

/** Sets the volume from 0 (silent) to 1. */
export function setVolume(volume: number) {
  master.mute = volume <= 0
  master.volume.rampTo(Tone.gainToDb(volume) - 6, 0.05)
}

/** Starts audio; the browser allows it only during a click or key press, until the page had one. */
export const unlock = () => Tone.start()
export const running = () => Tone.getContext().state === 'running'

// Soft bells for the cues and other extensions' notes: FM with a gentle bell ratio, through the reverb.
const bells = new Tone.PolySynth(Tone.FMSynth, {
  harmonicity: 3.01,
  modulationIndex: 1.6,
  oscillator: { type: 'sine' },
  envelope: { attack: 0.005, decay: 1.2, sustain: 0, release: 1.2 },
  modulation: { type: 'sine' },
  modulationEnvelope: { attack: 0.002, decay: 0.4, sustain: 0, release: 0.4 },
}).connect(reverb)
bells.maxPolyphony = 24
// A warm pad under each cue: the chord the bells sit in.
const cuePad = new Tone.PolySynth(Tone.Synth, {
  oscillator: { type: 'fatsine', count: 3, spread: 18 },
  envelope: { attack: 0.08, decay: 0.6, sustain: 0.3, release: 1.4 },
}).connect(reverb)

const hz = (midi: number) => Tone.mtof(midi as Tone.Unit.MidiNote)

/** Each cue keeps its old melody, now as bells over a chord. */
const cues: Record<Sound, { bells: [number, number, number][]; chord: number[] }> = {
  // A fifth up, asking, over an open D: D5, A5.
  input: {
    bells: [
      [0, 74, 0.5],
      [0.16, 81, 0.9],
    ],
    chord: [50, 57, 64],
  },
  // A rising C major, resolved, over C and G below.
  finished: {
    bells: [
      [0, 72, 0.45],
      [0.09, 76, 0.45],
      [0.18, 79, 1],
      [0.3, 84, 1.2],
    ],
    chord: [48, 55, 64],
  },
  // A low minor third down over a dark A minor.
  failed: {
    bells: [
      [0, 64, 0.5],
      [0.2, 61, 1],
    ],
    chord: [45, 48, 52],
  },
}

/** Plays notification sound `sound`. */
export async function play(sound: Sound) {
  await Tone.start()
  const now = Tone.now() + 0.03
  const cue = cues[sound]
  cuePad.triggerAttackRelease(cue.chord.map(hz), 0.9, now, 0.18)
  for (const [start, midi, length] of cue.bells)
    bells.triggerAttackRelease(hz(midi), length, now + start, 0.5)
}

/** Plays `notes` as bells at `volume` (the notification cues use 0.18). */
export async function playNotes(notes: readonly Note[], volume = 0.18) {
  await Tone.start()
  const now = Tone.now() + 0.03
  for (const [start, frequency, length] of notes)
    bells.triggerAttackRelease(frequency, length, now + start, Math.min(1, volume * 3))
}

// The key and the harmony every band plays in: D major, I–vi–IV–V, a bar each, as MIDI chords around the third octave.
const progression = [
  [50, 54, 57],
  [47, 50, 54],
  [43, 47, 50],
  [45, 49, 52],
]
const pentatonic = [0, 2, 4, 7, 9]
/** The `degree`th note of D major pentatonic from `base`. */
const scale = (degree: number, base = 62) =>
  base + Math.floor(degree / 5) * 12 + pentatonic[((degree % 5) + 5) % 5]

/**
 * A monophonic voice refuses a start at or before its last one; two happenings on one 16th would. Each call gets a
 * time just after the voice's previous one.
 */
function later() {
  let last = 0
  return (time: number) => (last = Math.max(time, last + 0.012))
}

type Part = {
  bpm: (level: Level) => number
  /** Happenings a 16th may play; the rest wait for the next. */
  cap: number
  play: (happening: Happening, time: number, bar: number) => void
  /** Each sixteenth, for effects that change between happenings; nothing sounds without one. */
  tick?: (time: number) => void
  nodes: Tone.ToneAudioNode[]
}

/** A playing band: hand it what happens and how busy the project is; it quantizes both to its beat. */
export type Band = {
  hit: (happening: Happening) => void
  level: (level: Level) => void
  dispose: () => void
}

export function band(variant: Variant): Band {
  const part = parts[variant]()
  const queue: Happening[] = []
  let step = 0
  const transport = Tone.getTransport()
  let bpm = part.bpm({ busy: {}, streaming: 0 })
  transport.bpm.value = bpm
  const loop = new Tone.Loop((time) => {
    const bar = Math.floor(step / 16)
    for (const happening of queue.splice(0, part.cap)) part.play(happening, time, bar)
    // A burst bigger than a few beats' worth is noise: keep the newest.
    queue.splice(0, Math.max(0, queue.length - part.cap * 8))
    part.tick?.(time)
    step++
  }, '16n').start(0)
  transport.start('+0.05')
  return {
    hit: (happening) => void queue.push(happening),
    // Ramp only when the tempo changes: every ramp adds automation events to the transport's timeline, which Tone
    // never prunes and walks on every tick, and the live project reports its level on every render.
    level: (next) => {
      if (part.bpm(next) === bpm) return
      bpm = part.bpm(next)
      transport.bpm.rampTo(bpm, 2)
    },
    dispose: () => {
      loop.dispose()
      transport.stop()
      transport.cancel()
      // Let held notes release and reverb tails ring out before the voices go: a release scheduled on a disposed
      // synth throws inside Tone.
      setTimeout(() => {
        for (const node of part.nodes) node.dispose()
      }, 12_000)
    },
  }
}

const parts: Record<Variant, () => Part> = {
  ambient,
  orchestra,
  crazy,
}

/** (A) Calm and spacious: each tool call a soft short chord in its role's register, echoing into a long reverb. */
function ambient(): Part {
  const space = new Tone.Reverb({ decay: 9, wet: 0.6 }).connect(master)
  const echo = new Tone.FeedbackDelay({ delayTime: '4n.', feedback: 0.35, wet: 0.3 }).connect(space)
  const pad = new Tone.PolySynth(Tone.AMSynth, {
    harmonicity: 2,
    envelope: { attack: 1.5, decay: 1, sustain: 0.5, release: 4 },
  }).connect(space)
  pad.volume.value = -18
  const glass = new Tone.PolySynth(Tone.FMSynth, {
    harmonicity: 4,
    modulationIndex: 2,
    envelope: { attack: 0.01, decay: 1.5, sustain: 0, release: 2 },
  }).connect(echo)
  glass.volume.value = -16
  const timbre: Record<Tool, Tone.PolySynth> = {
    bash: glass,
    edit: pad,
    read: glass,
    browser: pad,
    other: glass,
  }
  const register: Record<Role, number> = {
    ultimate: 62,
    coordinator: 57,
    worker: 69,
    scout: 74,
    reviewer: 66,
    lander: 62,
    other: 69,
  }
  return {
    bpm: () => 60,
    cap: 2,
    nodes: [pad, glass, echo, space],
    play: (h, time, bar) => {
      const chord = progression[Math.floor(bar / 2) % 4]
      if (h.kind === 'tool') {
        // Two notes of the current chord, voiced in the role's register: a small chord, not a lone ping.
        const root = register[h.role] + (h.tool === 'read' ? 12 : 0)
        const first = Math.floor(Math.random() * 3)
        const notes = [chord[first], chord[(first + 1) % 3]].map(
          (n) => n + 12 * Math.round((root - n) / 12),
        )
        timbre[h.tool].triggerAttackRelease(
          notes.map(hz),
          h.tool === 'edit' ? 2 : 1,
          time,
          h.tool === 'read' ? 0.25 : 0.45,
        )
      } else if (h.kind === 'start')
        glass.triggerAttackRelease(hz(register[h.role] + 7), 2, time, 0.4)
      else if (h.kind === 'stop') glass.triggerAttackRelease(hz(register[h.role] - 5), 2, time, 0.3)
      else if (h.kind === 'commit')
        glass.triggerAttackRelease(
          chord.map((n) => hz(n + 24)),
          1.5,
          time,
          0.4,
        )
      else if (h.kind === 'landed')
        pad.triggerAttackRelease([62, 66, 69, 73, 76].map(hz), 6, time, 0.8)
      else pad.triggerAttackRelease([50, 51, 56].map(hz), 4, time, 0.7)
    },
  }
}

/** (B) Each role an instrument in one key and tempo, over a I–vi–IV–V progression. */
function orchestra(): Part {
  const hall = new Tone.Reverb({ decay: 4, wet: 0.35 }).connect(master)
  // @ultimate: a warm string pad holding the chord.
  const strings = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: 'fatsawtooth', count: 3, spread: 20 },
    envelope: { attack: 0.6, decay: 0.4, sustain: 0.7, release: 2 },
  })
  strings.chain(new Tone.Filter(1200, 'lowpass'), hall)
  strings.volume.value = -22
  // Coordinators: a cello-like bass on the beat.
  const cello = new Tone.MonoSynth({
    oscillator: { type: 'sawtooth' },
    filter: { Q: 1, type: 'lowpass' },
    envelope: { attack: 0.05, decay: 0.3, sustain: 0.5, release: 0.8 },
    filterEnvelope: { attack: 0.05, decay: 0.4, sustain: 0.4, baseFrequency: 120, octaves: 2.5 },
  }).connect(hall)
  cello.volume.value = -14
  // Workers: plucked strings.
  const pluck = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: 'triangle' },
    envelope: { attack: 0.003, decay: 0.35, sustain: 0, release: 0.4 },
  }).connect(hall)
  pluck.volume.value = -10
  // Scouts: a flute, high.
  const flute = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: 'sine' },
    envelope: { attack: 0.06, decay: 0.2, sustain: 0.6, release: 0.5 },
  })
  flute.connect(new Tone.Vibrato(5, 0.08).connect(hall))
  flute.volume.value = -16
  // Reviewers: a marimba.
  const marimba = new Tone.PolySynth(Tone.FMSynth, {
    harmonicity: 4,
    modulationIndex: 3,
    envelope: { attack: 0.001, decay: 0.5, sustain: 0, release: 0.5 },
    modulationEnvelope: { attack: 0.001, decay: 0.15, sustain: 0, release: 0.2 },
  }).connect(hall)
  marimba.volume.value = -10
  // The lander: brass.
  const brass = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: 'fatsawtooth', count: 2, spread: 10 },
    envelope: { attack: 0.08, decay: 0.3, sustain: 0.6, release: 0.6 },
  })
  brass.chain(new Tone.Filter(1800, 'lowpass'), hall)
  brass.volume.value = -14
  const timpani = new Tone.MembraneSynth({ pitchDecay: 0.08, octaves: 3 }).connect(hall)
  timpani.volume.value = -12
  const t = { cello: later(), timpani: later() }
  const voice: Record<Role, { synth: Tone.PolySynth | Tone.MonoSynth; octave: number }> = {
    ultimate: { synth: strings, octave: 12 },
    coordinator: { synth: cello, octave: -12 },
    worker: { synth: pluck, octave: 12 },
    scout: { synth: flute, octave: 24 },
    reviewer: { synth: marimba, octave: 24 },
    lander: { synth: brass, octave: 12 },
    other: { synth: pluck, octave: 24 },
  }
  // A tool is an articulation: bash short and low, edit a two-note figure, read soft and high, browser a run.
  const figures: Record<Tool, { notes: number[]; length: string; velocity: number }> = {
    bash: { notes: [0], length: '16n', velocity: 0.8 },
    edit: { notes: [0, 2], length: '16n', velocity: 0.7 },
    read: { notes: [2], length: '8n', velocity: 0.35 },
    browser: { notes: [0, 1, 2], length: '32n', velocity: 0.55 },
    other: { notes: [1], length: '16n', velocity: 0.5 },
  }
  const sound = (role: Role, midi: number, length: string, time: number, velocity: number) => {
    const { synth } = voice[role]
    if (synth === cello) cello.triggerAttackRelease(hz(midi), length, t.cello(time), velocity)
    else (synth as Tone.PolySynth).triggerAttackRelease(hz(midi), length, time, velocity)
  }
  return {
    bpm: (level) => 92 + Math.min(16, total(level) * 2),
    cap: 3,
    nodes: [strings, cello, pluck, flute, marimba, brass, timpani, hall],
    play: (h, time, bar) => {
      const chord = progression[bar % 4]
      const sixteenth = Tone.Time('16n').toSeconds()
      if (h.kind === 'tool') {
        const { octave } = voice[h.role]
        const figure = figures[h.tool]
        const low = h.tool === 'bash' ? -12 : 0
        const root = Math.floor(Math.random() * 3)
        figure.notes.forEach((offset, index) =>
          sound(
            h.role,
            chord[(root + offset) % 3] + octave + low,
            figure.length,
            time + index * sixteenth,
            figure.velocity,
          ),
        )
      } else if (h.kind === 'start')
        // An entrance: the role's instrument plays the chord upward.
        chord.forEach((midi, index) =>
          sound(h.role, midi + voice[h.role].octave, '8n', time + index * sixteenth * 2, 0.6),
        )
      else if (h.kind === 'stop') sound(h.role, chord[0] + voice[h.role].octave, '4n', time, 0.4)
      else if (h.kind === 'commit') {
        timpani.triggerAttackRelease(hz(38), '8n', t.timpani(time), 0.7)
        marimba.triggerAttackRelease(
          chord.map((n) => hz(n + 24)),
          '8n',
          time,
          0.6,
        )
      } else if (h.kind === 'landed') {
        // A cadence: V then I, brass and strings together, with a timpani roll.
        brass.triggerAttackRelease([57, 61, 64, 69].map(hz), '4n', time, 0.8)
        brass.triggerAttackRelease([62, 66, 69, 74].map(hz), '1m', time + sixteenth * 4, 0.9)
        strings.triggerAttackRelease([50, 57, 62, 66].map(hz), '1m', time + sixteenth * 4, 0.7)
        for (let i = 0; i < 6; i++)
          timpani.triggerAttackRelease(
            hz(i < 5 ? 45 : 38),
            '16n',
            t.timpani(time + (i * sixteenth) / 2),
            0.5 + i * 0.08,
          )
      } else {
        // Dissonance: a minor second and a tritone, the brass cut short.
        brass.triggerAttackRelease([56, 57, 62, 63].map(hz), '8n', time, 0.8)
        timpani.triggerAttackRelease(hz(36), '4n', t.timpani(time), 0.9)
      }
    },
  }
}

/** (C) A beat that speeds up with load; every tool call a drum hit or a glitch; landings drop, failures crunch. */
function crazy(): Part {
  const crush = new Tone.BitCrusher(8)
  const echo = new Tone.FeedbackDelay({ delayTime: '8n', feedback: 0.3, wet: 0.18 })
  const bus = new Tone.Volume(-4)
  bus.chain(crush, echo, reverb)
  crush.wet.value = 0.35
  const kick = new Tone.MembraneSynth({ pitchDecay: 0.04, octaves: 6 }).connect(bus)
  const snare = new Tone.NoiseSynth({
    noise: { type: 'white' },
    envelope: { attack: 0.001, decay: 0.15, sustain: 0 },
  }).connect(bus)
  snare.volume.value = -10
  const hat = new Tone.MetalSynth({
    harmonicity: 5.1,
    modulationIndex: 32,
    resonance: 4000,
    octaves: 1.5,
    envelope: { attack: 0.001, decay: 0.05, release: 0.01 },
  }).connect(bus)
  hat.volume.value = -26
  const crash = new Tone.MetalSynth({
    harmonicity: 3.1,
    modulationIndex: 16,
    resonance: 3000,
    envelope: { attack: 0.001, decay: 1.4, release: 0.5 },
  }).connect(bus)
  crash.volume.value = -22
  const acid = new Tone.MonoSynth({
    oscillator: { type: 'sawtooth' },
    filter: { Q: 8, type: 'lowpass' },
    envelope: { attack: 0.005, decay: 0.15, sustain: 0.2, release: 0.1 },
    filterEnvelope: { attack: 0.005, decay: 0.12, sustain: 0.1, baseFrequency: 180, octaves: 4 },
  }).connect(bus)
  acid.volume.value = -14
  const zap = new Tone.FMSynth({
    harmonicity: 8,
    modulationIndex: 20,
    envelope: { attack: 0.001, decay: 0.08, sustain: 0, release: 0.05 },
    modulationEnvelope: { attack: 0.001, decay: 0.08, sustain: 0, release: 0.05 },
  }).connect(bus)
  zap.volume.value = -14
  const stab = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: 'fatsquare', count: 3, spread: 30 },
    envelope: { attack: 0.002, decay: 0.2, sustain: 0.1, release: 0.3 },
  })
  stab.chain(new Tone.Distortion(0.4), bus)
  stab.volume.value = -18
  const riser = new Tone.NoiseSynth({
    noise: { type: 'pink' },
    envelope: { attack: 0.6, decay: 0.05, sustain: 0 },
  })
  const sweep = new Tone.Filter(400, 'bandpass')
  riser.chain(sweep, bus)
  riser.volume.value = -18
  const t = {
    kick: later(),
    snare: later(),
    hat: later(),
    crash: later(),
    acid: later(),
    zap: later(),
    riser: later(),
  }
  let glitch = 0
  return {
    bpm: (level) => Math.min(178, 104 + total(level) * 9 + level.streaming * 3),
    cap: 4,
    nodes: [kick, snare, hat, crash, acid, zap, stab, riser, sweep, crush, echo, bus],
    play: (h, time) => {
      if (h.kind === 'tool') {
        if (h.tool === 'bash') snare.triggerAttackRelease('16n', t.snare(time), 0.6)
        else if (h.tool === 'edit')
          acid.triggerAttackRelease(
            hz(scale(Math.floor(Math.random() * 7), 50)),
            '16n',
            t.acid(time),
            0.9,
          )
        else if (h.tool === 'read') hat.triggerAttackRelease(hz(400), '32n', t.hat(time), 0.9)
        else
          zap.triggerAttackRelease(
            hz(scale(Math.floor(Math.random() * 5), 74)),
            '32n',
            t.zap(time),
            0.9,
          )
        // Each call nudges the glitch: the crusher bites harder for a moment.
        glitch = Math.min(1, glitch + 0.08)
      } else if (h.kind === 'start') {
        sweep.frequency.setValueAtTime(300, time)
        sweep.frequency.exponentialRampToValueAtTime(5000, time + 0.6)
        riser.triggerAttackRelease(0.6, t.riser(time), 0.7)
      } else if (h.kind === 'stop') zap.triggerAttackRelease(hz(38), '16n', t.zap(time), 0.7)
      else if (h.kind === 'commit') {
        crash.triggerAttackRelease(hz(300), '8n', t.crash(time), 0.6)
        stab.triggerAttackRelease([62, 66, 69].map(hz), '16n', time, 0.6)
      } else if (h.kind === 'landed') {
        crash.triggerAttackRelease(hz(250), '2n', t.crash(time), 0.9)
        kick.triggerAttackRelease(hz(36), '8n', t.kick(time), 1)
        stab.triggerAttackRelease([50, 57, 62, 66, 69, 74].map(hz), '4n', time, 0.8)
      } else {
        // A failure crunches: crusher all the way down, a detuned cluster, a stutter.
        crush.bits.setValueAtTime(3, time)
        crush.bits.linearRampToValueAtTime(8, time + 1.2)
        stab.triggerAttackRelease([49, 50, 55, 56].map(hz), '8n', time, 0.9)
        for (let i = 0; i < 4; i++) snare.triggerAttackRelease('64n', t.snare(time + i * 0.06), 0.9)
      }
    },
    // Nothing plays on its own; the glitch only fades between calls.
    tick: (time) => {
      glitch *= 0.97
      crush.wet.setValueAtTime(0.25 + glitch * 0.6, time)
    },
  }
}
