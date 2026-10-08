import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Agent } from "@paperclipai/plugin-sdk";
import { describe, expect, it } from "vitest";
import manifest from "../src/manifest.js";
import { fromLocal } from "../src/time.js";
import { buildPlugin } from "../src/worker.js";
import type { AgentSelectionData } from "../src/agent-selection.js";

const TZ = "America/Santiago";
const COMPANY = "co_1";

function agent(id: string, status: Agent["status"]): Agent {
  return {
    id,
    companyId: COMPANY,
    name: `Agent ${id}`,
    urlKey: id,
    role: "general",
    title: null,
    icon: null,
    status,
    reportsTo: null,
    capabilities: null,
    adapterType: "claude_local",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: {},
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as Agent;
}

async function setup(opts: { usage?: string | Error; config?: Record<string, unknown>; agents?: Agent[]; selectedIds?: string[] | null } = {}) {
  let clock = fromLocal(TZ, 2026, 10, 7, 21, 0);
  let usageCalls = 0;
  const plugin = buildPlugin({
    now: () => clock,
    readUsage: async () => {
      usageCalls++;
      if (opts.usage instanceof Error) throw opts.usage;
      return opts.usage ?? "Current session\n0% used";
    },
  });
  const harness = createTestHarness({
    manifest,
    config: { enabled: true, timezone: TZ, ...opts.config },
  });
  harness.seed({
    companies: [{ id: COMPANY, name: "C2C" } as never],
    agents: opts.agents ?? [agent("a1", "idle"), agent("a2", "paused"), agent("a3", "running")],
  });
  await plugin.definition.setup(harness.ctx);
  if (opts.selectedIds !== null) {
    await harness.ctx.state.set({ scopeKind: "company", scopeId: COMPANY, stateKey: "selected-agent-ids" }, opts.selectedIds ?? ["a1", "a2", "a3"]);
  }
  const status = async (id: string) => (await harness.ctx.agents.get(id, COMPANY))?.status;
  return {
    harness,
    status,
    setClock: (h: number, m: number, day = 7) => (clock = fromLocal(TZ, 2026, 10, day, h, m)),
    usageCalls: () => usageCalls,
  };
}

describe("token-shift worker", () => {
  it("lists agents by name with no default selection", async () => {
    const t = await setup({ selectedIds: null, config: { agentIds: ["a1"] }, agents: [
      { ...agent("a1", "idle"), name: "Zoe" },
      { ...agent("a2", "paused"), name: "Alice" },
      { ...agent("foreign", "idle"), companyId: "co_2" },
    ] });
    const data = await t.harness.getData<AgentSelectionData>("agent-selection", { companyId: COMPANY });
    expect(data.companyId).toBe(COMPANY);
    expect(data.agents.map((a) => [a.id, a.name])).toEqual([["a2", "Alice"], ["a1", "Zoe"]]);
    expect(data.agentIds).toEqual([]);
    t.setClock(10, 0);
    await t.harness.runJob("reconcile");
    expect(await t.status("a1")).toBe("idle");
  });

  it("paginates agent options beyond the first hundred", async () => {
    const t = await setup({ agents: Array.from({ length: 105 }, (_, index) => agent(`agent-${index}`, "idle")) });
    const data = await t.harness.getData<AgentSelectionData>("agent-selection", { companyId: COMPANY });
    expect(data.agents).toHaveLength(105);
    expect(data.agents.map((a) => a.id)).toContain("agent-104");
  });

  it("uses saved IDs instead of names when reconciling", async () => {
    const t = await setup({ agents: [
      { ...agent("a1", "idle"), name: "Same name" },
      { ...agent("a3", "idle"), name: "Same name" },
    ] });
    await t.harness.performAction("save-agent-selection", { companyId: COMPANY, agentIds: [" a3 ", "a3"] });
    t.setClock(10, 0);
    await t.harness.runJob("reconcile");
    expect(await t.status("a1")).toBe("idle");
    expect(await t.status("a3")).toBe("paused");
    t.harness.seed({ agents: [{ ...agent("a3", "paused"), name: "Renamed agent" }] });
    t.setClock(21, 0);
    await t.harness.runJob("reconcile");
    expect(await t.status("a3")).toBe("idle");
    const data = await t.harness.getData<AgentSelectionData>("agent-selection", { companyId: COMPANY });
    expect(data.agentIds).toEqual(["a3"]);
  });

  it("honors an explicitly empty selection", async () => {
    const t = await setup();
    await t.harness.performAction("save-agent-selection", { companyId: COMPANY, agentIds: [] });
    t.setClock(10, 0);
    await t.harness.runJob("reconcile");
    expect(await t.status("a1")).toBe("idle");
    expect(await t.status("a3")).toBe("running");
    expect((await t.harness.getData<AgentSelectionData>("agent-selection", { companyId: COMPANY })).agentIds).toEqual([]);
  });

  it("isolates selections by company", async () => {
    const t = await setup();
    await t.harness.performAction("save-agent-selection", { companyId: COMPANY, agentIds: [] });
    const other = await t.harness.getData<AgentSelectionData>("agent-selection", { companyId: "co_2" });
    expect(other.agentIds).toEqual([]);
    expect(other.agents).toEqual([]);
  });

  it("rejects foreign, missing, terminated and pending approval agents without saving", async () => {
    const t = await setup({ agents: [
      agent("a1", "idle"), agent("terminated", "terminated"), agent("pending", "pending_approval"),
      { ...agent("foreign", "idle"), companyId: "co_2" },
    ] });
    for (const id of ["foreign", "missing", "terminated", "pending"]) {
      await expect(t.harness.performAction("save-agent-selection", { companyId: COMPANY, agentIds: [id] })).rejects.toThrow("unavailable agent");
    }
    const data = await t.harness.getData<AgentSelectionData>("agent-selection", { companyId: COMPANY });
    expect(data.agentIds).toEqual(["a1", "a2", "a3"]);
    expect(data.agents.filter((a) => !a.selectable).map((a) => a.id).sort()).toEqual(["pending", "terminated"]);
  });

  it("rejects malformed selections and missing company IDs", async () => {
    const t = await setup();
    for (const agentIds of [null, "a1", [42], [""]]) {
      await expect(t.harness.performAction("save-agent-selection", { companyId: COMPANY, agentIds })).rejects.toThrow("array of non-empty strings");
    }
    await expect(t.harness.getData("agent-selection", {})).rejects.toThrow("companyId is required");
    await expect(t.harness.performAction("save-agent-selection", { agentIds: [] })).rejects.toThrow("companyId is required");
  });

  it("pauses outside agent work hours and resumes only the agents it paused", async () => {
    const t = await setup();
    t.setClock(10, 0);
    await t.harness.runJob("reconcile");
    expect(await t.status("a1")).toBe("paused");
    expect(await t.status("a3")).toBe("paused");

    t.setClock(21, 0);
    await t.harness.runJob("reconcile");
    expect(await t.status("a1")).toBe("idle");
    expect(await t.status("a3")).toBe("idle");
    expect(await t.status("a2")).toBe("paused"); // paused by the operator, left alone
    expect(t.harness.activity.map((a) => a.message)).toContain("Token Shift resumed Agent a1: no window open; a new one would reset by the end of the agents' workday");
  });

  it("does nothing when disabled", async () => {
    const t = await setup({ config: { enabled: false } });
    t.setClock(10, 0);
    await t.harness.runJob("reconcile");
    expect(await t.status("a1")).toBe("idle");
    expect(t.usageCalls()).toBe(0);
  });

  it("polls /usage at the configured interval", async () => {
    const t = await setup({ config: { usagePollMinutes: 15 } });
    await t.harness.runJob("reconcile");
    t.setClock(21, 10);
    await t.harness.runJob("reconcile");
    expect(t.usageCalls()).toBe(1);
    t.setClock(21, 15);
    await t.harness.runJob("reconcile");
    expect(t.usageCalls()).toBe(2);
  });

  it("stops before the reset reported by /usage", async () => {
    const t = await setup({ usage: "Current session\n60% used\nResets 11:30pm (America/Santiago)" });
    await t.harness.runJob("reconcile");
    expect(await t.status("a1")).toBe("idle");
    t.setClock(23, 20);
    await t.harness.runJob("reconcile");
    expect(await t.status("a1")).toBe("paused");
  });

  it("falls back to the configured reset time, then fails safe", async () => {
    const withFallback = await setup({ usage: new Error("claude not found"), config: { fallbackResetAt: "05:30" } });
    await withFallback.harness.runJob("reconcile");
    expect(await withFallback.status("a1")).toBe("idle");

    const without = await setup({ usage: new Error("claude not found") });
    await without.harness.runJob("reconcile");
    expect(await without.status("a1")).toBe("paused");
    const s = await without.harness.getData<{ usage: { lastError: string } }>("status", { companyId: COMPANY });
    expect(s.usage.lastError).toContain("claude not found");
  });

  it("preview reports the decision without touching agents", async () => {
    const t = await setup();
    t.setClock(10, 0);
    const r = await t.harness.performAction<{ decision: { reason: string }; agents: Array<{ action: string }> }>(
      "preview",
      {},
      { companyId: COMPANY },
    );
    expect(r.decision.reason).toBe("work_hours");
    expect(r.agents.map((a) => a.action)).toEqual(["paused", "unchanged", "paused"]);
    expect(await t.status("a1")).toBe("idle");
  });

  it("forgets an agent the operator resumed by hand", async () => {
    const t = await setup();
    t.setClock(10, 0);
    await t.harness.runJob("reconcile");
    await t.harness.ctx.agents.resume("a1", COMPANY);
    t.setClock(21, 0);
    await t.harness.runJob("reconcile");
    expect(await t.status("a1")).toBe("idle");
    const s = await t.harness.getData<{ managed: Record<string, unknown> }>("status", { companyId: COMPANY });
    expect(Object.keys(s.managed)).toEqual([]);
  });
});
