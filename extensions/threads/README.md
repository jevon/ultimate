Feature threads in @ultimate's conversation: each feature's traffic goes into its own thread, and the main stream keeps one root row per feature.

## Bucketing (`threads.tsx`)

`threadsOf(entries, messages, self)` is plain code over what the transcript and the message log already record; no model
decides it and @ultimate does nothing differently.

- A branch's messages and replies, its landing report and its notes belong to that branch, by their sender.
- The user's answer to a question belongs where the question came from: the call that asked it.
- A reply typed in a thread starts with `Re #<branch>: `; it and the turn it wakes belong to that thread.
- A turn belongs to the inputs that woke it, decided when it starts and never changed after (a run of inputs with no
  response between them wakes one turn), so it streams in its final place from its first token. A turn the user's own
  prompt woke stays in the main stream, whatever branches it starts or messages.
- A branch is known from the turn that starts or first messages it (the `branch` result, or the messages a call or a
  script sent), so its root shows while it works, before it reports.
- A tool result belongs with its call.

Unplaced, by design: the user's own prompts, build and to-do notes, notes about main, memory recalls, automation
fires and messages from other projects. A turn woken by several branches at once belongs to each of them.

`threading(entries, threads)` decides the main stream: each thread's root row follows the answer of the turn it began
in, and every entry of exactly one thread leaves the stream for that thread. `live` names the thread a run in progress
streams in.

## UI

- **Root** (`threads.root`, `roots.tsx`): a card with where the thread stands (dot, word, left edge), the feature, its title,
  the newest reply's first line and who said it, the reply count, when it last moved and how many replies are new. A
  new reply washes it briefly (Web Animations; none with reduced motion).
  While @ultimate runs a turn of that thread, the root says "@ultimate writing…"; its reply streams only in the thread.
- **Thread pane** (`pane.tsx`): the open thread is a column on the right, and main's column moves left beside it. On a
  phone, a thread opens as a full sheet with **← @ultimate** back. The open thread is the UI state `ext.threads.open`.
- The thread's composer sends to @ultimate as `Re #<branch>: …`. What arrives while a thread is open counts as seen.
- **Catch-up**: under a landing card, the branch's abstract frozen at landing (lineage's `abstract` action).

The core transcript does the splitting: this extension contributes `compact.threads`.

## On and off

Off by default while it is tried out (`defaultOff` in `shared/extension-api.ts`). Turn it on in user settings,
`~/.ultimate/settings.json`:

```json
{ "extensions": { "enable": ["threads"] } }
```

Or in the Extensions tab. Off, nothing contributes `compact.threads`, and @ultimate's transcript is the plain one.
