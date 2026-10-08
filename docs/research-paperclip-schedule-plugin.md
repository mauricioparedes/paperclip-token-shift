# Schedule and quota plugin for Paperclip

## Conclusion

It is feasible to build a Paperclip plugin that pauses and resumes agents according to a schedule and avoids starting runs close to a quota cutoff. Paperclip already provides the official TypeScript SDK, periodic cron jobs, persistent state, a configuration UI and agent control; agents run on *heartbeats*, not as long-lived processes.

The integration can get the cutoff time from **Claude Code's `/usage`**. Anthropic's current documentation states that `/usage` shows the plan limits and when they reset; the limit-reached response also shows the reset time. The plugin should run that query through the authenticated Claude Code installation used by `claude_local`, extract the next reset and convert it into a timezone-aware instant. It must not assume the quota always resets at a fixed time. A manually configured time remains only as a fallback if `/usage` fails, is temporarily rate-limited, or changes to an unparseable format.

## Proposed policy

I assume this operating intent:

- Between **09:00 and 20:00**, managed agents stay paused to reserve the quota for your manual work.
- From **20:00** until the next known cutoff, agents work to consume the available quota.
- Before the cutoff they stop with a safety margin (for example, 5–15 minutes). If the next cutoff is **05:30**, they pause at **05:20**.
- From 05:30 to 09:00 no agents are launched. That way, the new quota stays intact for you to use from 09:00.

With a cutoff at 05:30, the daily schedule would be:

| Local interval | Agent state | Reason |
|---|---:|---|
| 20:00–05:20 | resumed | autonomous overnight work |
| 05:20–09:00 | paused | avoid contaminating the quota that resets at 05:30 |
| 09:00–20:00 | paused | reserve quota for your workday |

One caveat: Claude plans have shared usage limits and rolling windows; a time like 05:30 is information about your session/account, not a universal rule. If the limit resets at 10:30 after you start using it at 05:30, the plugin must keep the agents paused during your workday; that way the quota after 10:30 is also yours. At 20:00 the plugin re-enables overnight work.

## What Paperclip provides today

Paperclip has an implemented plugin system, although its `PLUGIN_SPEC.md` includes future ideas. For development, the reliable reference is `PLUGIN_AUTHORING_GUIDE.md` and the `@paperclipai/plugin-sdk` SDK.

- A plugin normally has `src/manifest.ts`, `src/worker.ts` and, if it needs visual configuration, `src/ui/index.tsx`.
- The worker is declared with `definePlugin(...)`.
- The manifest's `jobs[]` accepts a cron expression; the worker receives each run with `ctx.jobs.register(jobKey, handler)`.
- The plugin can persist its configuration/state with `ctx.state` and expose a Settings page with `usePluginData` / `usePluginAction`.
- Paperclip manages agents through heartbeats. The runtime guide documents run states, the heartbeat, pauses and resumes. The product's base API exposes `POST /agents/:agentId/pause` and `POST /agents/:agentId/resume`.
- For recurring work visible on the board, Paperclip recommends `routines`; for internal maintenance such as a schedule controller, a plugin `job` is the appropriate mechanism.

## Recommended design: `quota-schedule-guard`

### Narrow responsibility

The plugin does not manage prompts or projects, nor create new agents. It only decides whether a selected set of agents may be active according to the schedule rule. It must use an explicit list of agent IDs or a per-company selector, and never automatically pause all agents without approval.

### Per-company configuration

| Field | Example | Purpose |
|---|---|---|
| `timezone` | `America/Santiago` | Evaluate all times in the correct zone, including DST |
| `agentsWorkStart` | `20:00` | Start of the agents' workday; the autonomous window begins |
| `agentsWorkEnd` | `09:00` | End of the agents' workday; agents pause |
| `pauseLeadMinutes` | `10` | Avoids starting/running close to the cutoff |
| `usagePollMinutes` | `15` | How often `/usage` is queried; not worth doing on every reconciliation |
| `enabled` | `true` | Global per-company switch |
| `fallbackResetAt` | `05:30` | Fallback if `/usage` does not return a usable cutoff |
| `mode` | `claude-usage` / `manual-fallback` | Effective source of the next cutoff |

Agents are selected by name in **Company settings → Token Shift Agents**. Their IDs are persisted in company-scoped plugin state.

The plugin should persist `nextResetAt` as a UTC instant, along with `usageCheckedAt`, the source (`/usage`, limit error or manual fallback) and a parser version/fingerprint. The UI should show both the computed local time and the age of the last reading.

### Plugin job

Declare a single reconciliation job every minute or every two minutes:

```ts
jobs: [
  {
    jobKey: "reconcile-schedule",
    displayName: "Reconcile quota schedule",
    description: "Pauses or resumes the configured agents according to the local schedule.",
    schedule: "*/1 * * * *",
  },
]
```

Minimum capabilities to confirm against the installed Paperclip version:

- `jobs.schedule`
- `plugin.state.write`
- The agent read/control capability required by that version's SDK/host.
- `instance.settings.register` and a `settingsPage` slot if the graphical configuration is added.

The worker applies a pure, testable function:

```text
shouldRun(nowLocal, config):
  cutoff = resetAt - pauseLeadMinutes
  if outside agentsWorkStart–agentsWorkEnd: false  # Interval may cross midnight.
  if now >= cutoff:                       false  # Compare absolute instants.
  otherwise:                               true
```

For the 09:00/20:00 example with a 05:30 reset and a 10-minute margin, `shouldRun` only returns `true` between 20:00 and 05:20. It must also work when the window crosses midnight.

On each run:

1. Load the company configuration and convert `now` using `timezone`.
2. Compute the desired state.
3. Query the selected agents.
4. If the state already matches, do nothing.
5. If they must stop, pause only the active ones; optionally cancel an already active run if Paperclip exposes that control in the installed version and the configuration allows it.
6. If they must start, resume only the ones paused by this plugin. An agent the operator paused manually must not be resumed.
7. Persist a per-agent marker, for example `pausedBySchedule=true`, plus the last reason, to distinguish an automated pause from a manual one.
8. Emit an activity/audit entry: `paused_for_work_hours`, `paused_for_reset_reserve` or `resumed_for_night_window`.

### Race protection

Pausing an agent prevents future heartbeats, but a run already in progress may continue. To guarantee the 05:20 cutoff:

- Set the agents' `timeoutSec` below the operating margin, or start the cutoff early enough.
- If the host offers run cancellation, make it optional and visible in the UI; cancelling work can lose progress.
- Reduce heartbeats to reasonable intervals and do not start a heartbeat when less than `pauseLeadMinutes + timeoutSec` remain until the cutoff.
- Be idempotent: reconciliation must be repeatable without needlessly resuming/pausing.

## Detecting the reset time with `/usage`

### Primary source: authenticated Claude Code

`/usage` is the primary source. Anthropic documents that it shows the plan's usage limits and **when they reset**. The plugin should use the `claude` binary and the same authenticated profile used by the `claude_local` agents; a separate polling job updates `nextResetAt`, while the reconciliation job applies pauses/resumes every minute.

The query must not create agent work or send a business task. Its only purpose is to obtain the quota state. The implementation must validate that the output contains an unambiguous reset time/date, resolve it in the configured `timezone` and store it in UTC. If Claude also returns weekly or per-model-family windows, the **shared session** reset must be used for the overnight policy; an exhausted weekly limit requires keeping agents paused and notifying the operator.

The cost documentation notes that, if there is no recent snapshot, `/usage` may report that the usage endpoint is rate-limited. So the query should run infrequently —for example every 15 minutes— and use the last valid reading while it is not stale.

### Secondary signals and fallback

Claude Code's limit message also includes the reset time; it is used to update `nextResetAt` immediately if a heartbeat hits the limit before the next poll. The `fallbackResetAt` setting is only used when `/usage` cannot be queried or does not return a parseable date.

Required rules:

- Never log credentials, prompts or full output; persist only the limit type, `nextResetAt`, source and a reduced error.
- Validate the time against the current clock: a cutoff in the past, too far ahead or without a timezone is rejected.
- If the `/usage` data is stale and the fallback does not work either, apply a safe policy: pause agents and notify.
- Keep the manual alternative for controlled degradation, not as the usual source.
- Do not scrape `claude.ai/settings/usage`; the `/usage` CLI is the supported interface for this data.

## Development workflow

1. Run Paperclip locally and confirm the version/target:
   ```bash
   pnpm paperclipai run
   paperclipai plugin target
   ```
2. Create the skeleton:
   ```bash
   paperclipai plugin init @your-scope/quota-schedule-guard --output /path/to/plugins
   ```
3. Install dependencies, watch the build and install from a local path:
   ```bash
   cd /path/to/plugins/quota-schedule-guard
   pnpm install
   pnpm dev
   paperclipai plugin install /path/to/plugins/quota-schedule-guard
   ```
4. Implement the job, the state and boundary unit tests first (`05:19`, `05:20`, `05:30`, `08:59`, `09:00`, `19:59`, `20:00`), with day rollover and `America/Santiago` DST.
5. Add a Settings UI for the fields above and a "Reconcile now" button that shows the computed decision before acting.
6. Verify with:
   ```bash
   pnpm typecheck
   pnpm test
   pnpm build
   paperclipai plugin inspect your-scope.quota-schedule-guard
   ```

For publishing, Paperclip recommends an npm package; installing from a local folder is for development and runs trusted code locally without a sandbox.

## Implementation decision

The first version should use `/usage` as the quota clock and a scheduler based on a time policy, not an assumed token counter. That way it dynamically gets the next cutoff —for example, 05:30—, pauses before it, avoids spending the reserved block before your workday, and keeps a manual schedule only for transient failures.

Before turning it into an operational plugin, confirm in your installation: the adapter used by each agent (`claude_local` or another), the IDs of the agents to control, your IANA timezone (probably `America/Santiago`) and whether the cutoff should cancel runs or only prevent new heartbeats.

## Sources

- Paperclip, plugin authoring guide: https://github.com/paperclipai/paperclip/blob/master/doc/plugins/PLUGIN_AUTHORING_GUIDE.md
- Paperclip, local plugin development: https://github.com/paperclipai/paperclip/blob/master/doc/plugins/LOCAL_PLUGIN_DEVELOPMENT.md
- Official Paperclip SDK: https://github.com/paperclipai/paperclip/blob/master/packages/plugins/sdk/README.md
- Paperclip, agent runtime: https://github.com/paperclipai/paperclip/blob/master/docs/agents-runtime.md
- Paperclip, base pause/resume routes: https://github.com/paperclipai/paperclip/blob/master/doc/SPEC-implementation.md
- Anthropic, Claude Code models, usage and limits: https://support.claude.com/en/articles/14552983-models-usage-and-limits-in-claude-code
- Anthropic, `/usage` command, plan limits and resets: https://code.claude.com/docs/en/costs
- Anthropic, official command list (`/usage`): https://code.claude.com/docs/en/commands
- Anthropic, limit errors and reset time: https://code.claude.com/docs/en/errors
- Anthropic, tracking usage in Settings > Usage: https://support.claude.com/en/articles/9797557-usage-limit-best-practices
