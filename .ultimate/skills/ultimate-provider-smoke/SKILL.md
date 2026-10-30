---
name: ultimate-provider-smoke
description: Check a change whose behaviour depends on the provider or model itself (latency, streaming of tool arguments, a pinned agent model, login or fallback, prompt caching) on the model it is meant for, with one short real turn on a supervised scratch server. Use when a preview cannot show it because `instance start` forces every agent onto `instance.model`.
---

# Smoke-test the real provider

A preview (`instance start`) runs every agent on `instance.model` through `ULTIMATE_MODEL`, which overrides the
agent pins, the root model and `summaryModel`. Whatever depends on the model itself stays invisible there. This
recipe runs the branch's checkout as a supervised scratch server without `ULTIMATE_MODEL`, so the configured models
run, and spends one or two short turns on them.

## Start it

From the branch's worktree. This is the scratch-server command from `docs/running.md`, run in the background:

```bash
H=$(mktemp -d /tmp/ultimate-smoke-XXXX)
env $(env | grep -o '^ULTIMATE_[A-Z_]*' | sed 's/^/-u /') ULTIMATE_HOME=$H \
  pnpm start --port 4799 --no-open > $H.log 2>&1 &
echo "supervisor pid $!"
```

- Unset every inherited `ULTIMATE_*`: an agent's shell carries the live server's `ULTIMATE_HOME`, `ULTIMATE_PROJECT`
  and the rest. Use its own home and port, never the project's default home.
- Logins stay where they are and are only read. Pi providers come from `~/.pi/agent`. Claude Code finds its own
  login through its default lookup (`~/.claude` and `~/.claude.json`), the same way the live host does. Never copy
  `auth.json`, credentials or secrets into the scratch home.
- Do not set `PI_CLAUDE_CODE_CONFIG_DIR` or `CLAUDE_CONFIG_DIR` to `~/.claude`. Claude Code then keeps its global
  config in `~/.claude/.claude.json`, a stray second config beside the real `~/.claude.json`. Set either only to
  test a different login on purpose, and point it at a throwaway directory.
- Before you start, run `ls ~/.claude/.claude.json`. It should not exist. Claude Code may add a file under
  `~/.claude/sessions`, as on any run.
- Wait until `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4799/` returns `200`. `$H.log` says
  `supervisor: ready`.
- To try a different model, set it the way a user would: an agent definition or a project setting in the checkout,
  or the composer's model picker on the scratch server. Do not use `ULTIMATE_MODEL`.

## Drive one turn

Screenshot `http://127.0.0.1:4799/`. Its header shows @ultimate's `#<id>` and its composer shows the model. Then send
to that conversation explicitly. A send without `conversation` targets conversation 1, the root.

```json
{"url": "http://127.0.0.1:4799/?conversation=<id>", "steps": [
  {"until": "idle", "conversation": <id>},
  {"send": "Reply with exactly the word: pong. Do not call any tools.", "conversation": <id>},
  {"until": "idle", "conversation": <id>, "timeoutMs": 180000}
], "screenshot": true}
```

Use a prompt that exercises only the behaviour under test: one tool call to watch streaming arguments, or two sends
to see the cache read on the second one. Stop after one or two turns.

## Read the evidence

The scratch server is not in the host's project list, so read its home directly, read-only:

```bash
# every model call: conversation, provider/model, wall time in ms, usage and stop reason
sqlite3 -readonly $H/trace.sqlite \
  "select conversation, name, round(ms), result from calls where kind='model' order by at"
# the conversation's model and its usage document (pi.agent, pi.usage)
sqlite3 -readonly $H/state.sqlite "select d.kind, r.content from documents d
  join document_revisions r on r.document_id = d.id
  where d.owner_id = <id> and d.kind in ('\"pi.agent\"', '\"pi.usage\"') order by r.seq desc"
```

`pi.agent.model` is the model that actually ran. `pi.usage` has its tokens, cache reads and writes, and cost. The
trace also lists background calls such as titles and summaries on `summaryModel`. Keep those apart from the turn you
measured.

## Clean up

```bash
kill <supervisor pid>    # not pkill -f: the pattern matches your own shell and kills it
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4799/   # 000 once it is down
ls ~/.claude/.claude.json   # still absent
rm -rf $H $H.log
```

## Report

State the model that ran, taken from `pi.agent` or the trace, not the configured one. Give the measured numbers: the
model call's milliseconds, its input, output and cache tokens, and the cost. Name what you could not reach as
unverified. Leave out machine names and addresses.
