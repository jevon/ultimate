---
name: ui-preview-round
description: Run a preview round for UI work that lands only with the user's approval (polish, a new card, a panel, anything the task says to preview first). Use when a branch must show the user a running preview, collect approval, and only then workspace submit.
---

# A preview round

UI polish lands only when the user approved it on a running preview. Checks, a review or your own screenshots are not
approval, and one approval covers one round. On a hands-off goal @ultimate approves in the user's place, from your
screenshots: send them with the request.

1. **Commit the round** in your branch. A preview runs your checkout as it is on disk; committing keeps each round
   recoverable.
2. **Start the preview**: `instance start` (or `instance start {subagent: <id>}` for a designer's worktree). It is a
   clean Ultimate with its own empty home, every agent on `instance.model` (Sol, fast); it hot-reloads `web/` and `extensions/` as files
   change. A change in `server/` or `shared/` needs `instance stop` and a new `start`.
3. **Seed it like a user**: open @ultimate (the first row of the sidebar) and send real prompts until the state the user should
   judge exists: a long transcript, a running tool, a skill run, an error. Never fake state by writing entries.
   Drive it with `browser` steps `{send: '…'}` then `{until: 'idle'}` (or `'quiet'` when it starts branches), not
   fill, Enter and a fixed `wait`; set the model, thinking or Play/Pause with one `eval` on `window.ultimate.api`
   (`verify-ui`), not by clicking menus.
4. **Look first yourself**: follow the `verify-ui` skill. Fix what is off before you ask anyone.
5. **Ask for approval**: your final answer is the request: it reaches @ultimate once you stop with nothing under way.
   To send screenshots, `message` @ultimate with `images: "latest"` (reply: true); to its open message that is your
   answer and ends your run. Include the URL (the tailnet URL when the preview chip shows
   one), what changed, a short numbered "what to try" naming the conversation you seeded, and a `Decisions:` block
   (approve as is, or change something).
6. **Iterate**: each change is a new commit and a new round; keep the same preview running.
7. **On approval**: remove anything only the preview needed, `instance stop`, then `workspace submit` with the
   divergence. Report the landing in your final answer.
