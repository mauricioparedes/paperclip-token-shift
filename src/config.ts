import { isValidTimeZone, parseHm, type Hm } from "./time.js";

const timezones = Intl.supportedValuesOf("timeZone");

export interface TokenShiftConfig {
  enabled: boolean;
  timezone: string;
  workStart: Hm;
  workEnd: Hm;
  pauseLeadMinutes: number;
  sessionWindowHours: number;
  agentIds: string[];
  fallbackResetAt: Hm | null;
  usagePollMinutes: number;
  usageMaxAgeMinutes: number;
  claudeCommand: string;
  claudeConfigDir: string | null;
}

export const instanceConfigSchema = {
  type: "object",
  properties: {
    enabled: { type: "boolean", default: false, title: "Enabled", description: "Master switch for this company." },
    timezone: {
      type: "string",
      default: "America/Santiago",
      title: "Timezone (IANA)",
      description: "Select the timezone used to evaluate work hours and quota resets.",
      enum: timezones,
    },
    workStart: { type: "string", default: "09:00", pattern: "^\\d{1,2}:\\d{2}$", title: "Workday start (agents paused)" },
    workEnd: { type: "string", default: "20:00", pattern: "^\\d{1,2}:\\d{2}$", title: "Workday end (agents may run)" },
    pauseLeadMinutes: { type: "integer", default: 10, minimum: 0, maximum: 120, title: "Stop this many minutes before a quota reset" },
    sessionWindowHours: { type: "number", default: 5, minimum: 1, maximum: 24, title: "Claude session window length (hours)" },
    agentIds: { type: "array", items: { type: "string" }, default: [], title: "Agent IDs to control" },
    fallbackResetAt: { type: "string", default: "", pattern: "^(\\d{1,2}:\\d{2})?$", title: "Fallback reset time when /usage is unavailable (HH:MM, empty = none)" },
    usagePollMinutes: { type: "integer", default: 15, minimum: 5, maximum: 240, title: "Minutes between /usage reads" },
    usageMaxAgeMinutes: { type: "integer", default: 60, minimum: 10, maximum: 720, title: "Treat a /usage reading as stale after (minutes)" },
    claudeCommand: { type: "string", default: "claude", title: "Path to the claude CLI used by claude_local agents" },
    claudeConfigDir: { type: "string", default: "", title: "CLAUDE_CONFIG_DIR of that profile (empty = default)" },
  },
} as const;

export type ConfigResult = { ok: true; config: TokenShiftConfig } | { ok: false; errors: string[] };

export function parseConfig(raw: Record<string, unknown>): ConfigResult {
  const errors: string[] = [];
  const str = (key: string, fallback: string) => (typeof raw[key] === "string" ? (raw[key] as string).trim() : fallback);
  const num = (key: string, fallback: number) => (typeof raw[key] === "number" && Number.isFinite(raw[key]) ? (raw[key] as number) : fallback);

  const timezone = str("timezone", "America/Santiago");
  if (!isValidTimeZone(timezone)) errors.push(`timezone "${timezone}" is not a valid IANA zone`);

  const workStart = parseHm(str("workStart", "09:00"));
  const workEnd = parseHm(str("workEnd", "20:00"));
  if (!workStart) errors.push("workStart must be HH:MM");
  if (!workEnd) errors.push("workEnd must be HH:MM");
  if (workStart && workEnd && workStart.hour * 60 + workStart.minute === workEnd.hour * 60 + workEnd.minute) {
    errors.push("workStart and workEnd must differ");
  }

  const fallbackRaw = str("fallbackResetAt", "");
  const fallbackResetAt = fallbackRaw === "" ? null : parseHm(fallbackRaw);
  if (fallbackRaw !== "" && !fallbackResetAt) errors.push("fallbackResetAt must be HH:MM or empty");

  const agentIds = Array.isArray(raw.agentIds)
    ? [...new Set(raw.agentIds.filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim()))]
    : [];

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    config: {
      enabled: raw.enabled === true,
      timezone,
      workStart: workStart!,
      workEnd: workEnd!,
      pauseLeadMinutes: Math.max(0, num("pauseLeadMinutes", 10)),
      sessionWindowHours: Math.max(1, num("sessionWindowHours", 5)),
      agentIds,
      fallbackResetAt,
      usagePollMinutes: Math.max(5, num("usagePollMinutes", 15)),
      usageMaxAgeMinutes: Math.max(10, num("usageMaxAgeMinutes", 60)),
      claudeCommand: str("claudeCommand", "claude") || "claude",
      claudeConfigDir: str("claudeConfigDir", "") || null,
    },
  };
}
