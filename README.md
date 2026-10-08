# Token Shift — Paperclip plugin

Implementation of `docs/research-paperclip-schedule-plugin.md`. It pauses the selected agents during your workday, lets them work overnight, and stops them before the Claude quota reset, so the next workday starts with a full quota.

No equivalent plugin existed: there is none on npm (the `@paperclipai/plugin-*` packages are sandboxes, wiki and diff) or in the Paperclip documentation. Outside Paperclip there is [`claude-overnight`](https://pypi.org/project/claude-overnight/), which queues prompts to run overnight but does not control Paperclip agents.

## Decision rule

Evaluated every minute in the configured `timezone` (`src/schedule.ts`):

1. Within `workStart`–`workEnd` → **pause** (`work_hours`).
2. Weekly quota exhausted according to `/usage` → **pause** (`weekly_limit`).
3. No valid `/usage` reading and no `fallbackResetAt` → **pause** (`quota_unknown`), i.e. it fails safe.
4. If there is an open session window that resets at `resetAt`:
   - if `resetAt` falls after the next `workStart` → **pause** (`window_overlaps_workday`);
   - if less than `pauseLeadMinutes` remain → **pause** (`reset_reserve`);
   - otherwise → **run** (`night_window`).
5. If there is no open window: run only if a new `sessionWindowHours` (5 h) window would close before the next `workStart`; otherwise **pause** (`reset_reserve`).

With a reset at 05:30 and a 10-minute margin: it runs from 20:00 to 05:20 and stays paused from 05:20 to 20:00, matching the table in the research document.

## Agent behavior

- It only touches the configured `agentIds`. It never pauses every agent in a company.
- It only resumes agents that **it** paused (`managed` state per company). An agent you paused manually stays paused.
- If you manually resume an agent paused by the plugin, the plugin stops treating it as its own. But if the rule says "pause", it will pause it again on the next minute: the schedule rule wins.
- Pausing does not stop a run in progress. To guarantee the cutoff, set the agent's `timeoutSec` below `pauseLeadMinutes`.
- Every pause and resume is recorded in the Paperclip activity log.
- With `enabled: false` it does nothing (it also does not resume what it had paused).

## Reading `/usage`

`src/claude-usage.ts` runs `claude -p /usage --output-format json` with the binary and `CLAUDE_CONFIG_DIR` you configure (they must be the same ones your `claude_local` agents use). `/usage` is a local command: it does not consume quota. The reading happens at most every `usagePollMinutes` and is considered stale after `usageMaxAgeMinutes`.

The parser (`src/usage.ts`) looks for the `Current session` section and its `Resets …` line. It accepts `5:30am (America/Santiago)`, `Oct 12, 9am (…)`, `in 2h 15m`, `HH:MM` and ISO 8601. It also reads the `Current week (all models)` section to detect `100% used`. Any output without a session section is rejected; it is not interpreted as "no open window".

> **Pending verification:** the parser format follows what Claude Code currently shows in interactive mode for Pro/Max plans. I could not test it against a real subscription account: in this environment the CLI is authenticated with an API key, and there `/usage` only returns a cost summary (which the plugin correctly rejects). Before enabling it, run `claude -p /usage --output-format json` with your profile. If the text differs, adjust `parseUsageOutput` and add that output as a case in `tests/usage.test.ts`.

## Configuration (per company)

| Field | Default | Purpose |
|---|---|---|
| `enabled` | `false` | Master switch |
| `timezone` | `America/Santiago` | IANA zone; handles DST |
| `workStart` / `workEnd` | `09:00` / `20:00` | Workday with agents paused (may cross midnight) |
| `pauseLeadMinutes` | `10` | Margin before the reset |
| `sessionWindowHours` | `5` | Length of the Claude session window |
| `agentIds` | `[]` | Controlled agents |
| `fallbackResetAt` | empty | Fallback reset time if `/usage` fails |
| `usagePollMinutes` | `15` | How often `/usage` is read |
| `usageMaxAgeMinutes` | `60` | Maximum age of a valid reading |
| `claudeCommand` | `claude` | Path to the CLI |
| `claudeConfigDir` | empty | `CLAUDE_CONFIG_DIR` of the agents' profile |

## Data and actions for UI/CLI

- `status` (data): last decision, `/usage` state and managed agents.
- `preview` (action): computes the decision and what it would do with each agent, without touching them.
- `reconcile-now` (action): applies the decision now; with `refreshUsage: true` it re-reads `/usage`.

It does not have its own Settings page yet. Configuration is edited through the form Paperclip generates from `instanceConfigSchema`.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test        # 46 tests: time boundaries, Santiago DST, parser and worker with the SDK harness
pnpm build       # dist/manifest.js + dist/worker.js
paperclipai plugin install "$(pwd)"
paperclipai plugin inspect c2c.token-shift
```

SDK pinned to `@paperclipai/plugin-sdk@2026.1005.0`. The APIs used (`ctx.agents.get/pause/resume`, `ctx.state`, `ctx.jobs`, `ctx.activity`, `ctx.companies.list`) were verified against that version's types.
