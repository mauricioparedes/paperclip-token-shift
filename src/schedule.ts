import type { TokenShiftConfig } from "./config.js";
import { minutesOfDay, nextLocalOccurrence, toLocalParts } from "./time.js";

export type QuotaSource = "usage" | "fallback" | "none";

export interface QuotaView {
  source: QuotaSource;
  /** When the current Claude session window resets; null when no window is open. */
  sessionResetAt: Date | null;
  /** True when /usage reported the weekly allowance as exhausted. */
  weeklyExhausted: boolean;
}

// Keep existing reason codes stable for status consumers and stored decisions.
export type DecisionReason =
  | "work_hours"
  | "weekly_limit"
  | "quota_unknown"
  | "window_overlaps_workday"
  | "reset_reserve"
  | "night_window";

export interface Decision {
  run: boolean;
  reason: DecisionReason;
  /** Human-readable explanation for logs and the settings page. */
  detail: string;
}

export function inAgentsWorkHours(now: Date, config: TokenShiftConfig): boolean {
  const p = toLocalParts(now, config.timezone);
  const m = p.hour * 60 + p.minute;
  const start = minutesOfDay(config.agentsWorkStart);
  const end = minutesOfDay(config.agentsWorkEnd);
  return start < end ? m >= start && m < end : m >= start || m < end;
}

/**
 * Decide whether managed agents may run right now.
 *
 * Agents only run within their configured work hours, while preserving quota
 * after the end of their workday:
 * - with a session window open, they run until `pauseLeadMinutes` before it
 *   resets, provided it resets by the end of the agents' workday;
 * - with no window open, they run only if a fresh window opened now would
 *   reset by the end of the agents' workday.
 */
export function decide(now: Date, config: TokenShiftConfig, quota: QuotaView): Decision {
  if (!inAgentsWorkHours(now, config)) {
    return { run: false, reason: "work_hours", detail: "outside the agents' workday" };
  }
  if (quota.weeklyExhausted) {
    return { run: false, reason: "weekly_limit", detail: "weekly allowance exhausted" };
  }
  if (quota.source === "none") {
    return { run: false, reason: "quota_unknown", detail: "no usable /usage reading and no fallback reset time" };
  }

  const nextAgentsWorkEnd = nextLocalOccurrence(now, config.timezone, config.agentsWorkEnd);
  const leadMs = config.pauseLeadMinutes * 60_000;
  const resetAt = quota.sessionResetAt;

  if (resetAt && resetAt.getTime() > now.getTime()) {
    if (resetAt.getTime() > nextAgentsWorkEnd.getTime()) {
      return {
        run: false,
        reason: "window_overlaps_workday",
        detail: `current window resets at ${resetAt.toISOString()}, after the agents' workday ends`,
      };
    }
    if (now.getTime() >= resetAt.getTime() - leadMs) {
      return { run: false, reason: "reset_reserve", detail: `within ${config.pauseLeadMinutes} min of the reset at ${resetAt.toISOString()}` };
    }
    return { run: true, reason: "night_window", detail: `running until ${new Date(resetAt.getTime() - leadMs).toISOString()}` };
  }

  const freshWindowEnd = now.getTime() + config.sessionWindowHours * 3_600_000;
  if (freshWindowEnd > nextAgentsWorkEnd.getTime()) {
    return {
      run: false,
      reason: "reset_reserve",
      detail: `a new ${config.sessionWindowHours}h window opened now would still be open at ${nextAgentsWorkEnd.toISOString()}`,
    };
  }
  return { run: true, reason: "night_window", detail: "no window open; a new one would reset by the end of the agents' workday" };
}
