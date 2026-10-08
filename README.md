# Token Shift — Paperclip plugin

Implementation of `docs/research-paperclip-schedule-plugin.md`. It runs selected agents during their configured workday and stops them before the Claude quota reset, preserving quota after their workday ends. The default agent workday runs overnight from 20:00 to 09:00.

No equivalent plugin existed: there is none on npm (the `@paperclipai/plugin-*` packages are sandboxes, wiki and diff) or in the Paperclip documentation. Outside Paperclip there is [`claude-overnight`](https://pypi.org/project/claude-overnight/), which queues prompts to run overnight but does not control Paperclip agents.

## Decision rule

Evaluated every minute in the configured `timezone` (`src/schedule.ts`):

1. Outside `agentsWorkStart`–`agentsWorkEnd` → **pause** (`work_hours`). The start is inclusive and the end is exclusive; the interval may cross midnight.
2. Weekly quota exhausted according to `/usage` → **pause** (`weekly_limit`).
3. No valid `/usage` reading and no `fallbackResetAt` → **pause** (`quota_unknown`), i.e. it fails safe.
4. If there is an open session window that resets at `resetAt`:
   - if `resetAt` falls after the next `agentsWorkEnd` → **pause** (`window_overlaps_workday`);
   - if less than `pauseLeadMinutes` remain → **pause** (`reset_reserve`);
   - otherwise → **run** (`night_window`).
5. If there is no open window: run only if a new `sessionWindowHours` (5 h) window would close before the next `agentsWorkEnd`; otherwise **pause** (`reset_reserve`).

With a reset at 05:30 and a 10-minute margin: it runs from 20:00 to 05:20 and stays paused from 05:20 to 20:00, matching the table in the research document.

## Agent behavior

- It only touches the selected agents. It never pauses every agent in a company.
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
| `agentsWorkStart` | `20:00` | Agent Work Day Start Time; agents may run from this time |
| `agentsWorkEnd` | `09:00` | Agent Work Day End Time; agents pause at this time |
| `pauseLeadMinutes` | `10` | Margin before the reset |
| `sessionWindowHours` | `5` | Length of the Claude session window |
| `agentIds` | `[]` | Legacy fallback until a selection is saved in Token Shift Agents |
| `fallbackResetAt` | empty | Fallback reset time if `/usage` fails |
| `usagePollMinutes` | `15` | How often `/usage` is read |
| `usageMaxAgeMinutes` | `60` | Maximum age of a valid reading |
| `claudeCommand` | `claude` | Path to the CLI |
| `claudeConfigDir` | empty | `CLAUDE_CONFIG_DIR` of the agents' profile |

## Data and actions for UI/CLI

- `status` (data): last decision, `/usage` state and managed agents.
- `agent-selection` (data): company agent names, roles, statuses and selected IDs.
- `save-agent-selection` (action): validates and saves the selected IDs for the company.
- `preview` (action): computes the decision and what it would do with each agent, without touching them.
- `reconcile-now` (action): applies the decision now; with `refreshUsage: true` it re-reads `/usage`.

Open **Company settings → Token Shift Agents** to search agents by name, check the agents to control, and click **Save agent selection**. Names are displayed but stable IDs are saved, so renaming an agent does not change the selection. Duplicate names show IDs to distinguish them. Terminated agents and agents awaiting approval cannot be added. Unavailable saved agents can be removed.

The saved selection is scoped to the company and takes precedence over `agentIds` in the generated plugin configuration form. Saving an empty selection controls no agents. Saving changes the selection for the next reconciliation; it does not immediately pause or resume agents. Other settings, including timezone and agent workday times, remain in Paperclip's generated plugin configuration form. The legacy `agentIds` field is under **Advanced options**.

Existing configurations remain readable: legacy `workStart` maps to `agentsWorkEnd`, and legacy `workEnd` maps to `agentsWorkStart`. Explicit new keys take precedence. Existing decision reason codes remain stable: `work_hours` now describes time outside the agents' workday, and `window_overlaps_workday` describes a quota window extending past `agentsWorkEnd`.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test        # Time boundaries, Santiago DST, parser and worker with the SDK harness
pnpm build       # dist/manifest.js + dist/worker.js + dist/ui/index.js
paperclipai plugin install "$(pwd)"
paperclipai plugin inspect c2c.token-shift
```

SDK pinned to `@paperclipai/plugin-sdk@2026.1005.0`. The APIs used (`ctx.agents.get/pause/resume`, `ctx.state`, `ctx.jobs`, `ctx.activity`, `ctx.companies.list`) were verified against that version's types.
