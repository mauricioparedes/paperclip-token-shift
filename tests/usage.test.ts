import { describe, expect, it } from "vitest";
import { fromLocal } from "../src/time.js";
import { parseResetExpression, parseUsageOutput } from "../src/usage.js";

const TZ = "America/Santiago";
const now = fromLocal(TZ, 2026, 10, 7, 21, 0);

describe("parseResetExpression", () => {
  it.each([
    ["5:30am (America/Santiago)", "2026-10-08T08:30:00.000Z"],
    ["5:30am", "2026-10-08T08:30:00.000Z"],
    ["11pm (UTC)", "2026-10-08T23:00:00.000Z"],
    ["at 05:30", "2026-10-08T08:30:00.000Z"],
    ["Oct 12, 9am (America/Santiago)", "2026-10-12T12:00:00.000Z"],
    ["October 12 at 9:15pm", "2026-10-13T00:15:00.000Z"],
    ["Jan 2, 9am", "2027-01-02T12:00:00.000Z"],
    ["in 2h 15m", "2026-10-08T02:15:00.000Z"],
    ["in 45 minutes", "2026-10-08T00:45:00.000Z"],
    ["2026-10-08T08:30:00Z.", "2026-10-08T08:30:00.000Z"],
  ])("%s", (expr, iso) => {
    expect(parseResetExpression(expr, now, TZ)?.toISOString()).toBe(iso);
  });

  it.each(["5", "13pm", "soon", "5:30am (Not/AZone)"])("rejects %s", (expr) => {
    expect(parseResetExpression(expr, now, TZ)).toBeNull();
  });
});

describe("parseUsageOutput", () => {
  it("reads the session section of plan /usage output", () => {
    const out = [
      "Current session",
      "\x1b[32m█████▌\x1b[0m                11% used",
      "Resets 1:30am (America/Santiago)",
      "",
      "Current week (all models)",
      "██                    4% used",
      "Resets Oct 12, 9am (America/Santiago)",
      "",
      "Current week (Sonnet only)",
      "                      100% used",
      "Resets Oct 12, 9am (America/Santiago)",
    ].join("\n");
    const r = parseUsageOutput(out, now, TZ);
    expect(r).toEqual({ ok: true, reading: { sessionResetAt: new Date("2026-10-08T04:30:00.000Z"), weeklyExhausted: false } });
  });

  it("reports no open window when the session is unused", () => {
    const r = parseUsageOutput("Current session\n0% used\n\nCurrent week (all models)\n100% used\nResets Oct 12, 9am", now, TZ);
    expect(r).toEqual({ ok: true, reading: { sessionResetAt: null, weeklyExhausted: true } });
  });

  it("reads a usage-limit message", () => {
    const r = parseUsageOutput("5-hour limit reached ∙ resets 5:30am (America/Santiago)", now, TZ);
    expect(r.ok && r.reading.sessionResetAt?.toISOString()).toBe("2026-10-08T08:30:00.000Z");
  });

  it("rejects API-key cost summaries instead of treating them as no window", () => {
    const apiKeyOutput = "Total cost:            $0.0000\nTotal duration (API):  0s\nUsage:                 0 input, 0 output";
    expect(parseUsageOutput(apiKeyOutput, now, TZ).ok).toBe(false);
  });

  it("rejects a used session with no reset time", () => {
    expect(parseUsageOutput("Current session\n40% used", now, TZ).ok).toBe(false);
  });
});
