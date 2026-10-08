import { isValidTimeZone, parseHm, type Hm } from "./time.js";

const timezones = Intl.supportedValuesOf("timeZone");

export interface TokenShiftConfig {
  enabled: boolean;
  timezone: string;
  agentsWorkEnd: Hm;
  agentsWorkStart: Hm;
  pauseLeadMinutes: number;
  sessionWindowHours: number;
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
    agentsWorkEnd: { type: "string", default: "09:00", pattern: "^\\d{1,2}:\\d{2}$", title: "Agent Work Day End Time" },
    agentsWorkStart: { type: "string", default: "20:00", pattern: "^\\d{1,2}:\\d{2}$", title: "Agent Work Day Start Time" },
    timezone: {
      type: "string",
      default: "America/Santiago",
      title: "Timezone (IANA)",
      description: "Select the timezone used to evaluate agent work hours and quota resets.",
      enum: timezones,
    },
    pauseLeadMinutes: { type: "integer", default: 10, minimum: 0, maximum: 120, title: "Stop this many minutes before a quota reset" },
    sessionWindowHours: { type: "number", default: 5, minimum: 1, maximum: 24, title: "Claude session window length (hours)" },
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

  const agentsWorkEnd = parseHm(str("agentsWorkEnd", "09:00"));
  const agentsWorkStart = parseHm(str("agentsWorkStart", "20:00"));
  if (!agentsWorkEnd) errors.push("agentsWorkEnd must be HH:MM");
  if (!agentsWorkStart) errors.push("agentsWorkStart must be HH:MM");
  if (agentsWorkEnd && agentsWorkStart && agentsWorkEnd.hour * 60 + agentsWorkEnd.minute === agentsWorkStart.hour * 60 + agentsWorkStart.minute) {
    errors.push("agentsWorkEnd and agentsWorkStart must differ");
  }

  const fallbackRaw = str("fallbackResetAt", "");
  const fallbackResetAt = fallbackRaw === "" ? null : parseHm(fallbackRaw);
  if (fallbackRaw !== "" && !fallbackResetAt) errors.push("fallbackResetAt must be HH:MM or empty");

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    config: {
      enabled: raw.enabled === true,
      timezone,
      agentsWorkEnd: agentsWorkEnd!,
      agentsWorkStart: agentsWorkStart!,
      pauseLeadMinutes: Math.max(0, num("pauseLeadMinutes", 10)),
      sessionWindowHours: Math.max(1, num("sessionWindowHours", 5)),
      fallbackResetAt,
      usagePollMinutes: Math.max(5, num("usagePollMinutes", 15)),
      usageMaxAgeMinutes: Math.max(10, num("usageMaxAgeMinutes", 60)),
      claudeCommand: str("claudeCommand", "claude") || "claude",
      claudeConfigDir: str("claudeConfigDir", "") || null,
    },
  };
}
