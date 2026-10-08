import { definePlugin, runWorker, type PluginContext } from "@paperclipai/plugin-sdk";
import { runClaudeUsage } from "./claude-usage.js";
import { parseConfig, type TokenShiftConfig } from "./config.js";
import { decide, type Decision, type QuotaView } from "./schedule.js";
import { formatLocal, nextLocalOccurrence } from "./time.js";
import { parseUsageOutput } from "./usage.js";
import type { AgentOption, AgentSelectionData } from "./agent-selection.js";

export interface WorkerDeps {
  now: () => Date;
  readUsage: (config: TokenShiftConfig) => Promise<string>;
}

interface UsageState {
  lastAttemptAt: string | null;
  lastError: string | null;
  good: { checkedAt: string; sessionResetAt: string | null; weeklyExhausted: boolean } | null;
}

interface ManagedEntry {
  reason: string;
  pausedAt: string;
}

type ManagedState = Record<string, ManagedEntry>;

export interface AgentOutcome {
  agentId: string;
  action: "paused" | "resumed" | "unchanged" | "skipped" | "error";
  note?: string;
}

export interface ReconcileResult {
  companyId: string;
  enabled: boolean;
  decision: Decision | null;
  quota: { source: QuotaView["source"]; sessionResetAt: string | null; sessionResetLocal: string | null } | null;
  agents: AgentOutcome[];
  errors?: string[];
}

const companyKey = (companyId: string, stateKey: string) => ({ scopeKind: "company" as const, scopeId: companyId, stateKey });

export function buildPlugin(deps: WorkerDeps) {
  let ctx: PluginContext;

  async function readState<T>(companyId: string, key: string, fallback: T): Promise<T> {
    const value = await ctx.state.get(companyKey(companyId, key));
    return value === null || value === undefined ? fallback : (value as T);
  }

  async function selectedAgentIds(companyId: string, configuredIds: string[]): Promise<string[]> {
    // An explicitly empty selection must override any legacy configured IDs.
    return readState<string[]>(companyId, "selected-agent-ids", configuredIds);
  }

  async function agentSelection(companyId: string): Promise<AgentSelectionData> {
    const agents: AgentOption[] = [];
    for (let offset = 0; ; offset += 100) {
      const page = await ctx.agents.list({ companyId, limit: 100, offset });
      agents.push(...page.map((agent) => ({
        id: agent.id,
        name: agent.name,
        role: agent.role,
        status: agent.status,
        selectable: agent.status !== "terminated" && agent.status !== "pending_approval",
      })));
      if (page.length < 100) break;
    }
    agents.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    const parsed = parseConfig(await ctx.config.get(companyId));
    const saved = await readState<string[] | null>(companyId, "selected-agent-ids", null);
    return {
      companyId,
      agents,
      agentIds: saved ?? (parsed.ok ? parsed.config.agentIds : []),
      source: saved === null ? "config" : "selection",
    };
  }

  async function refreshUsage(companyId: string, config: TokenShiftConfig, force: boolean): Promise<UsageState> {
    const now = deps.now();
    const state = await readState<UsageState>(companyId, "usage", { lastAttemptAt: null, lastError: null, good: null });
    const last = state.lastAttemptAt ? Date.parse(state.lastAttemptAt) : 0;
    if (!force && now.getTime() - last < config.usagePollMinutes * 60_000) return state;

    const next: UsageState = { ...state, lastAttemptAt: now.toISOString() };
    try {
      const parsed = parseUsageOutput(await deps.readUsage(config), now, config.timezone);
      if (parsed.ok) {
        next.lastError = null;
        next.good = {
          checkedAt: now.toISOString(),
          sessionResetAt: parsed.reading.sessionResetAt?.toISOString() ?? null,
          weeklyExhausted: parsed.reading.weeklyExhausted,
        };
      } else {
        next.lastError = parsed.error;
      }
    } catch (error) {
      next.lastError = error instanceof Error ? error.message : String(error);
    }
    if (next.lastError) ctx.logger.warn("token-shift: /usage reading unavailable", { companyId, error: next.lastError });
    await ctx.state.set(companyKey(companyId, "usage"), next);
    return next;
  }

  function quotaView(now: Date, config: TokenShiftConfig, usage: UsageState): QuotaView {
    const good = usage.good;
    if (good && now.getTime() - Date.parse(good.checkedAt) <= config.usageMaxAgeMinutes * 60_000) {
      const reset = good.sessionResetAt ? new Date(good.sessionResetAt) : null;
      return {
        source: "usage",
        sessionResetAt: reset && reset.getTime() > now.getTime() ? reset : null,
        weeklyExhausted: good.weeklyExhausted,
      };
    }
    if (config.fallbackResetAt) {
      return {
        source: "fallback",
        sessionResetAt: nextLocalOccurrence(now, config.timezone, config.fallbackResetAt),
        weeklyExhausted: false,
      };
    }
    return { source: "none", sessionResetAt: null, weeklyExhausted: false };
  }

  async function reconcileCompany(companyId: string, opts: { dryRun?: boolean; forceUsage?: boolean } = {}): Promise<ReconcileResult> {
    const parsed = parseConfig(await ctx.config.get(companyId));
    if (!parsed.ok) {
      ctx.logger.warn("token-shift: invalid config", { companyId, errors: parsed.errors });
      return { companyId, enabled: false, decision: null, quota: null, agents: [], errors: parsed.errors };
    }
    const config = parsed.config;
    if (!config.enabled && !opts.dryRun) return { companyId, enabled: false, decision: null, quota: null, agents: [] };

    const usage = await refreshUsage(companyId, config, opts.forceUsage === true);
    const now = deps.now();
    const quota = quotaView(now, config, usage);
    const decision = decide(now, config, quota);
    const result: ReconcileResult = {
      companyId,
      enabled: config.enabled,
      decision,
      quota: {
        source: quota.source,
        sessionResetAt: quota.sessionResetAt?.toISOString() ?? null,
        sessionResetLocal: quota.sessionResetAt ? formatLocal(quota.sessionResetAt, config.timezone) : null,
      },
      agents: [],
    };

    const managed = await readState<ManagedState>(companyId, "managed", {});
    let managedChanged = false;

    for (const agentId of await selectedAgentIds(companyId, config.agentIds)) {
      try {
        const agent = await ctx.agents.get(agentId, companyId);
        if (!agent) {
          result.agents.push({ agentId, action: "skipped", note: "agent not found" });
          continue;
        }
        if (agent.status === "terminated" || agent.status === "pending_approval") {
          result.agents.push({ agentId, action: "skipped", note: agent.status });
          continue;
        }
        const ours = managed[agentId];

        if (!decision.run) {
          if (agent.status === "paused") {
            result.agents.push({ agentId, action: "unchanged", note: ours ? "paused by token-shift" : "paused by someone else" });
            continue;
          }
          if (!opts.dryRun) {
            await ctx.agents.pause(agentId, companyId);
            managed[agentId] = { reason: decision.reason, pausedAt: now.toISOString() };
            managedChanged = true;
            await ctx.activity.log({
              companyId,
              entityType: "agent",
              entityId: agentId,
              message: `Token Shift paused ${agent.name}: ${decision.detail}`,
              metadata: { reason: decision.reason, quotaSource: quota.source },
            });
          }
          result.agents.push({ agentId, action: "paused", note: decision.reason });
          continue;
        }

        if (!ours) {
          result.agents.push({ agentId, action: "unchanged", note: agent.status === "paused" ? "paused by someone else; left alone" : undefined });
          continue;
        }
        if (agent.status !== "paused") {
          // Someone resumed it by hand; it is no longer ours to manage.
          if (!opts.dryRun) {
            delete managed[agentId];
            managedChanged = true;
          }
          result.agents.push({ agentId, action: "unchanged", note: "already resumed manually" });
          continue;
        }
        if (!opts.dryRun) {
          await ctx.agents.resume(agentId, companyId);
          delete managed[agentId];
          managedChanged = true;
          await ctx.activity.log({
            companyId,
            entityType: "agent",
            entityId: agentId,
            message: `Token Shift resumed ${agent.name}: ${decision.detail}`,
            metadata: { reason: decision.reason, quotaSource: quota.source },
          });
        }
        result.agents.push({ agentId, action: "resumed" });
      } catch (error) {
        const note = error instanceof Error ? error.message : String(error);
        ctx.logger.error("token-shift: failed to reconcile agent", { companyId, agentId, error: note });
        result.agents.push({ agentId, action: "error", note });
      }
    }

    if (managedChanged) await ctx.state.set(companyKey(companyId, "managed"), managed);
    if (!opts.dryRun) {
      await ctx.state.set(companyKey(companyId, "last-decision"), { at: now.toISOString(), ...result });
    }
    return result;
  }

  async function companyIds(): Promise<string[]> {
    const ids: string[] = [];
    for (let offset = 0; ; offset += 100) {
      const page = await ctx.companies.list({ limit: 100, offset });
      ids.push(...page.map((c) => c.id));
      if (page.length < 100) return ids;
    }
  }

  function requireCompanyId(params: Record<string, unknown>): string {
    if (typeof params.companyId !== "string" || params.companyId === "") throw new Error("companyId is required");
    return params.companyId;
  }

  return definePlugin({
    async setup(pluginCtx) {
      ctx = pluginCtx;

      ctx.jobs.register("reconcile", async () => {
        for (const companyId of await companyIds()) {
          try {
            await reconcileCompany(companyId);
          } catch (error) {
            ctx.logger.error("token-shift: reconcile failed", { companyId, error: error instanceof Error ? error.message : String(error) });
          }
        }
      });

      ctx.data.register("status", async (params) => {
        const companyId = requireCompanyId(params);
        return {
          lastDecision: await readState(companyId, "last-decision", null),
          usage: await readState(companyId, "usage", null),
          managed: await readState(companyId, "managed", {}),
        };
      });

      ctx.data.register("agent-selection", async (params) => agentSelection(requireCompanyId(params)));

      ctx.actions.register("save-agent-selection", async (params) => {
        const companyId = requireCompanyId(params);
        if (!Array.isArray(params.agentIds) || params.agentIds.some((id) => typeof id !== "string" || id.trim() === "")) {
          throw new Error("agentIds must be an array of non-empty strings");
        }
        const ids = [...new Set((params.agentIds as string[]).map((id) => id.trim()))];
        const current = await agentSelection(companyId);
        const selectableIds = new Set(current.agents.filter((agent) => agent.selectable).map((agent) => agent.id));
        if (ids.some((id) => !selectableIds.has(id))) {
          throw new Error("Selection contains an unavailable agent or an agent outside this company. Refresh the list and try again.");
        }
        await ctx.state.set(companyKey(companyId, "selected-agent-ids"), ids);
        return { ...current, agentIds: ids, source: "selection" as const };
      });

      // Shows what the plugin would do right now without pausing or resuming anything.
      ctx.actions.register("preview", async (params) => reconcileCompany(requireCompanyId(params), { dryRun: true }));

      ctx.actions.register("reconcile-now", async (params) =>
        reconcileCompany(requireCompanyId(params), { forceUsage: params.refreshUsage === true }),
      );
    },

    async onValidateConfig(config) {
      const parsed = parseConfig(config);
      if (!parsed.ok) return { ok: false, errors: parsed.errors };
      const warnings: string[] = [];
      if (parsed.config.enabled && parsed.config.agentIds.length === 0) warnings.push("select agents in company settings > Token Shift Agents if no selection has been saved yet");
      if (!parsed.config.fallbackResetAt) warnings.push("no fallbackResetAt: agents stay paused whenever /usage cannot be read");
      return { ok: true, warnings };
    },
  });
}

const plugin = buildPlugin({ now: () => new Date(), readUsage: runClaudeUsage });

export default plugin;

runWorker(plugin, import.meta.url);
