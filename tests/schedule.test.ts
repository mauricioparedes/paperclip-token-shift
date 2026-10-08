import { describe, expect, it } from "vitest";
import { instanceConfigSchema, parseConfig, type TokenShiftConfig } from "../src/config.js";
import { decide, inAgentsWorkHours, type QuotaView } from "../src/schedule.js";
import { fromLocal, nextLocalOccurrence, toLocalParts } from "../src/time.js";

const TZ = "America/Santiago";

function config(overrides: Record<string, unknown> = {}): TokenShiftConfig {
  const parsed = parseConfig({ enabled: true, fallbackResetAt: "05:30", ...overrides });
  if (!parsed.ok) throw new Error(parsed.errors.join(", "));
  return parsed.config;
}

// 2026-10-07 is a Wednesday in Santiago summer time (UTC-3).
const at = (hhmm: string, day = 7) => {
  const [h, m] = hhmm.split(":").map(Number);
  return fromLocal(TZ, 2026, 10, day, h, m);
};

const fallbackQuota = (now: Date, cfg: TokenShiftConfig): QuotaView => ({
  source: "fallback",
  sessionResetAt: nextLocalOccurrence(now, TZ, cfg.fallbackResetAt!),
  weeklyExhausted: false,
});

describe("time helpers", () => {
  it("round-trips local times", () => {
    const d = fromLocal(TZ, 2026, 10, 7, 5, 30);
    expect(d.toISOString()).toBe("2026-10-07T08:30:00.000Z");
    expect(toLocalParts(d, TZ)).toMatchObject({ hour: 5, minute: 30, day: 7 });
  });

  it("pushes a time in the spring-forward gap past the jump", () => {
    // Santiago skips 00:00-00:59 on 2026-09-06.
    const d = fromLocal(TZ, 2026, 9, 6, 0, 30);
    expect(toLocalParts(d, TZ)).toMatchObject({ day: 6, hour: 1, minute: 30 });
  });

  it("picks the earlier of a repeated fall-back hour", () => {
    // Santiago repeats 23:00-23:59 on 2026-04-04.
    const d = fromLocal(TZ, 2026, 4, 4, 23, 30);
    expect(d.toISOString()).toBe("2026-04-05T02:30:00.000Z");
  });

  it("finds the next occurrence across midnight", () => {
    expect(nextLocalOccurrence(at("21:00"), TZ, { hour: 5, minute: 30 }).toISOString()).toBe(at("05:30", 8).toISOString());
    expect(nextLocalOccurrence(at("05:30"), TZ, { hour: 5, minute: 30 }).toISOString()).toBe(at("05:30", 8).toISOString());
  });
});

describe("agent work hours", () => {
  it.each([
    ["19:59", false],
    ["20:00", true],
    ["23:59", true],
    ["00:00", true],
    ["08:59", true],
    ["09:00", false],
  ] as const)("includes %s in the overnight agent workday: %s", (time, expected) => {
    expect(inAgentsWorkHours(at(time), config())).toBe(expected);
  });

  it.each([
    ["05:59", false],
    ["06:00", true],
    ["21:59", true],
    ["22:00", false],
  ] as const)("includes %s in a daytime agent workday: %s", (time, expected) => {
    const cfg = config({ agentsWorkStart: "06:00", agentsWorkEnd: "22:00" });
    expect(inAgentsWorkHours(at(time), cfg)).toBe(expected);
  });
});

describe("decide with a 05:30 fallback reset", () => {
  const cfg = config();
  const cases: Array<[string, number, boolean, string]> = [
    ["08:59", 7, false, "window_overlaps_workday"],
    ["09:00", 7, false, "work_hours"],
    ["19:59", 7, false, "work_hours"],
    ["20:00", 7, true, "night_window"],
    ["23:59", 7, true, "night_window"],
    ["05:19", 8, true, "night_window"],
    ["05:20", 8, false, "reset_reserve"],
    ["05:30", 8, false, "window_overlaps_workday"],
  ];
  it.each(cases)("%s (day %i) → run=%s (%s)", (time, day, run, reason) => {
    const now = at(time, day);
    const d = decide(now, cfg, fallbackQuota(now, cfg));
    expect(d.run).toBe(run);
    expect(d.reason).toBe(reason);
  });
});

describe("decide with /usage readings", () => {
  const cfg = config({ fallbackResetAt: "" });
  const usage = (reset: Date | null, weeklyExhausted = false): QuotaView => ({ source: "usage", sessionResetAt: reset, weeklyExhausted });

  it("opens a fresh window when it would close by the end of the agents' workday", () => {
    expect(decide(at("22:00"), cfg, usage(null)).run).toBe(true);
    expect(decide(at("04:00", 8), cfg, usage(null)).run).toBe(true); // closes exactly at 09:00
  });

  it("refuses a fresh window that would still be open at 09:00", () => {
    const d = decide(at("04:01", 8), cfg, usage(null));
    expect(d).toMatchObject({ run: false, reason: "reset_reserve" });
  });

  it("uses an open window until the lead time before its reset", () => {
    const reset = at("01:00", 8);
    expect(decide(at("00:49", 8), cfg, usage(reset)).run).toBe(true);
    expect(decide(at("00:50", 8), cfg, usage(reset))).toMatchObject({ run: false, reason: "reset_reserve" });
  });

  it("keeps agents off a window that resets after their workday ends", () => {
    expect(decide(at("06:00", 8), cfg, usage(at("10:30", 8)))).toMatchObject({ run: false, reason: "window_overlaps_workday" });
  });

  it("stops when the weekly allowance is known to be exhausted", () => {
    expect(decide(at("22:00"), cfg, usage(null, true))).toMatchObject({ run: false, reason: "weekly_limit" });
    expect(decide(at("22:00"), cfg, { source: "none", sessionResetAt: null, weeklyExhausted: true })).toMatchObject({ run: false, reason: "weekly_limit" });
  });

  it.each(["20:00", "22:00", "08:59"])("allows unknown quota at %s within the workday", (time) => {
    expect(decide(at(time), cfg, { source: "none", sessionResetAt: null, weeklyExhausted: false })).toMatchObject({ run: true, reason: "quota_unknown" });
  });

  it.each(["19:59", "09:00"])("pauses with unknown quota at %s outside the workday", (time) => {
    expect(decide(at(time), cfg, { source: "none", sessionResetAt: null, weeklyExhausted: false })).toMatchObject({ run: false, reason: "work_hours" });
  });

  it("handles a daytime agent workday", () => {
    const daytime = config({ agentsWorkStart: "06:00", agentsWorkEnd: "22:00", fallbackResetAt: "" });
    expect(decide(at("23:00"), daytime, usage(null)).reason).toBe("work_hours");
    expect(decide(at("03:00", 8), daytime, usage(null)).reason).toBe("work_hours");
    expect(decide(at("10:00"), daytime, usage(null)).run).toBe(true);
    expect(decide(at("17:00"), daytime, usage(null)).run).toBe(true);
    expect(decide(at("17:01"), daytime, usage(null)).reason).toBe("reset_reserve");
  });
});

describe("instanceConfigSchema", () => {
  it("uses the runtime-supported IANA timezones as selectable options", () => {
    expect(instanceConfigSchema.properties.timezone.enum).toEqual(Intl.supportedValuesOf("timeZone"));
    expect(instanceConfigSchema.properties.timezone.enum).toContain("America/Santiago");
  });
});

describe("parseConfig", () => {
  it("defaults to the agents' overnight workday", () => {
    expect(parseConfig({})).toMatchObject({
      ok: true,
      config: { agentsWorkStart: { hour: 20, minute: 0 }, agentsWorkEnd: { hour: 9, minute: 0 } },
    });
  });

  it("ignores removed operator workday settings", () => {
    expect(parseConfig({ workStart: "08:30", workEnd: "19:15" })).toMatchObject({
      ok: true,
      config: { agentsWorkStart: { hour: 20, minute: 0 }, agentsWorkEnd: { hour: 9, minute: 0 } },
    });
  });

  it("uses explicit agent workday settings", () => {
    expect(parseConfig({ agentsWorkStart: "06:00", agentsWorkEnd: "22:00" })).toMatchObject({
      ok: true,
      config: { agentsWorkStart: { hour: 6, minute: 0 }, agentsWorkEnd: { hour: 22, minute: 0 } },
    });
  });

  it("rejects identical agent workday boundaries", () => {
    expect(parseConfig({ agentsWorkStart: "06:00", agentsWorkEnd: "06:00" })).toEqual({
      ok: false,
      errors: ["agentsWorkEnd and agentsWorkStart must differ"],
    });
  });

  it("reports invalid agent workday boundaries by their new names", () => {
    expect(parseConfig({ agentsWorkStart: "25:00", agentsWorkEnd: "9am" })).toEqual({
      ok: false,
      errors: ["agentsWorkEnd must be HH:MM", "agentsWorkStart must be HH:MM"],
    });
  });

  it("rejects bad values", () => {
    const r = parseConfig({ timezone: "Mars/Base", agentsWorkEnd: "9am", fallbackResetAt: "25:00" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toHaveLength(3);
  });

  it("ignores removed agent ID configuration and defaults to disabled", () => {
    const r = parseConfig({ agentIds: ["a", "b"] });
    expect(r.ok && r.config).not.toHaveProperty("agentIds");
    expect(r.ok && r.config.enabled).toBe(false);
  });
});
