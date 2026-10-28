The live durable task graph in the right panel's Tasks tab, grouped by what the work means rather than who owns it (`kinds.ts`):

- **Running:** each conversation with a turn, as a tree by owner (turn → tool calls → the conversations a task owns, such as subagents). Top-level conversations show their feature tag; one linked to a plan task shows the plan's `TaskChip`. Click a conversation to show it.
- **Messages:** `board.delivery` tasks in plain words: "Delivering to", "Waiting on" (a reply-enabled message placed and not yet answered), "Delivered to", "Delivering the reply to", with the sender and the message's opening words; subagent reports and notify-when-done watches too.
- **Landing**, **Scheduled** (automations and watchdog retries, with when they wake).
- **Background**, folded to a count: summaries, routing, notes and other chores. A blocked chore or one past ten minutes stays out of the fold.

No row is named after the root conversation: work it owns (deliveries, automations) is the project's. Each row's hover shows the raw kind, id, phase and owner. Durations come from the task record's durable `startedAt` (warning colour after ten minutes, so a stuck task stands out). Names come from the `describe {ids}` action, which reads each task's input once (a message's ids and text, an automation's name, a tool's name, a lander's submission); an unknown kind shows its raw name in Background.

The composer's status line shows the shown conversation's open messages (`messages/open.tsx`): how many answers it waits for, owes and is still delivering; a click lists them, and each row opens its conversation.

A task Pi Durable cannot run shows why: a task cut off by a crash five times in a row is **parked** by the crash-loop guard (header counts them), with a **Retry** button that calls the user-only `retry {id}` action (`Harness.retryTask`); other blocked reasons (missing or too-old definition, failed migration) are named without Retry, since they clear when the registry changes.

Data comes from `useTasks()` (the server's `tasks` event), `useConversations()`, the conversations overview and the messages log; start times and facts come from the `started {ids}` and `describe {ids}` actions, each asked once per task since they never change.
