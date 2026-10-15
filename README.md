# opencode-goal

Claude Code's `/goal` for **OpenCode v2**. Give the agent a finish line; it keeps working, turn after turn, until an evaluator confirms the condition is met.

![/goal in the OpenCode CLI](https://raw.githubusercontent.com/EL4CTEO/opencode-goal/main/assets/goal-status.png)

## Install

```sh
opencode plugin add @el4cteo/opencode-goal
```

Or from GitHub: `opencode plugin add github:EL4CTEO/opencode-goal`, or point `plugins` in `opencode.json` at a local clone:

```json
{ "plugins": ["/path/to/opencode-goal"] }
```

Requires OpenCode 2.0.29 or newer.

## Use

| Command | What it does |
| --- | --- |
| `/goal <condition>` | Sets the goal and starts working on it right away |
| `/goal` | Shows status: condition, time, turns, spend, last evaluator reason |
| `/goal clear` | Removes the goal (`stop`, `off`, `reset`, `none`, `cancel` also work) |

```text
/goal bun test passes with 0 failures and no test file is modified
```

While a goal runs, the footer shows its state:

![footer indicator](https://raw.githubusercontent.com/EL4CTEO/opencode-goal/main/assets/goal-running.png)

**Write a good condition:** one measurable end state, how to prove it (`npm test exits 0`), and anything that must not change. Add a limit for open-ended work, e.g. `or stop after 20 turns`.

## How it works

- After every turn, an evaluator reads the conversation and answers **met**, **not met** or **impossible**.
- **Not met:** the agent gets the reason and starts the next turn on its own.
- **Met / impossible:** the goal ends and a note is added to the transcript.
- The evaluator only sees what's in the conversation, so the agent is told to show proof (test output, command results).
- By default the evaluator reuses the session's cached context, so each check costs little more than a short answer.

Safety rails:

- **Pauses** after 3 turns in a row without tool use, on rate limits, on interrupt (Esc), or at the 200-turn cap. Send any message to resume.
- **Retries** dropped connections and overloads with backoff (up to 3 times).
- **Clears** on errors you must fix: auth, credit, context overflow, missing model.
- **Waits** while subagents or background shells run, with check-ins at 30 min, then 60, then 120.
- **Restores** active goals after a restart or plugin reload.

## Options

All optional, set in `opencode.json`:

```json
{
  "plugins": [
    {
      "package": "@el4cteo/opencode-goal",
      "options": {
        "evaluator": { "model": "opencode-go/deepseek-v4.1-flash" },
        "maxTurns": 200,
        "stallTurns": 3,
        "checkinMinutes": 30,
        "maxRetries": 3,
        "systemReminder": false,
        "transcriptNotes": true
      }
    }
  ]
}
```

| Option | Default | Meaning |
| --- | --- | --- |
| `evaluator.model` | session model | Separate model that judges the goal (fresh eyes, uses a transcript digest) |
| `evaluator.mode` | `auto` | `session`, `independent`, or `auto` (independent when a model is set) |
| `maxTurns` | `200` | Hard turn cap, `0` = none |
| `stallTurns` | `3` | Turns without tool use before pausing |
| `checkinMinutes` | `30` | First background check-in; `0` disables check-ins and retries |
| `maxRetries` | `3` | Automatic retries after transient errors |
| `systemReminder` | `false` | Also put the goal in the system prompt (costs one cache miss) |
| `transcriptNotes` | `true` | Record achieved/impossible verdicts in the transcript |

Environment overrides: `OPENCODE_GOAL_MODEL`, `OPENCODE_GOAL_MAX_TURNS`, `OPENCODE_GOAL_CHECKIN_MINUTES`.

## Develop

```sh
bun install
bun run check                         # typecheck + unit tests
bun run e2e <empty-dir> [provider/model]  # real run against a private opencode server
```

## License

MIT
