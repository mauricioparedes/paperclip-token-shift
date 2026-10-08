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

export function inWorkHours(now: Date, config: TokenShiftConfig): boolean {
  const p = toLocalParts(now, config.timezone);
  const m = p.hour * 60 + p.minute;
  const start = minutesOfDay(config.workStart);
  const end = minutesOfDay(config.workEnd);
  return start < end ? m >= start && m < end : m >= start || m < end;
}

/**
 * Decide whether managed agents may run right now.
 *
 * Agents only run outside work hours, and only while doing so cannot eat into
 * the quota the operator will have at the start of the next workday:
 * - with a session window open, they run until `pauseLeadMinutes` before it
 *   resets, provided it resets before the workday starts;
 * - with no window open, they run only if a fresh window opened now would
 *   reset by the start of the workday.
 */
export function decide(now: Date, config: TokenShiftConfig, quota: QuotaView): Decision {
  if (inWorkHours(now, config)) {
    return { run: false, reason: "work_hours", detail: "inside the operator's workday" };
  }
  if (quota.weeklyExhausted) {
    return { run: false, reason: "weekly_limit", detail: "weekly allowance exhausted" };
  }
  if (quota.source === "none") {
    return { run: false, reason: "quota_unknown", detail: "no usable /usage reading and no fallback reset time" };
  }

  const nextWorkStart = nextLocalOccurrence(now, config.timezone, config.workStart);
  const leadMs = config.pauseLeadMinutes * 60_000;
  const resetAt = quota.sessionResetAt;

  if (resetAt && resetAt.getTime() > now.getTime()) {
    if (resetAt.getTime() > nextWorkStart.getTime()) {
      return {
        run: false,
        reason: "window_overlaps_workday",
        detail: `current window resets at ${resetAt.toISOString()}, after the workday starts`,
      };
    }
    if (now.getTime() >= resetAt.getTime() - leadMs) {
      return { run: false, reason: "reset_reserve", detail: `within ${config.pauseLeadMinutes} min of the reset at ${resetAt.toISOString()}` };
    }
    return { run: true, reason: "night_window", detail: `running until ${new Date(resetAt.getTime() - leadMs).toISOString()}` };
  }

  const freshWindowEnd = now.getTime() + config.sessionWindowHours * 3_600_000;
  if (freshWindowEnd > nextWorkStart.getTime()) {
    return {
      run: false,
      reason: "reset_reserve",
      detail: `a new ${config.sessionWindowHours}h window opened now would still be open at ${nextWorkStart.toISOString()}`,
    };
  }
  return { run: true, reason: "night_window", detail: "no window open; a new one would reset before the workday" };
}
