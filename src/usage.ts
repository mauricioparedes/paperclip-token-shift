import { fromLocal, isValidTimeZone, nextLocalOccurrence, toLocalParts } from "./time.js";

export interface UsageReading {
  /** Reset of the shared 5-hour session window; null when the session section shows no open window. */
  sessionResetAt: Date | null;
  weeklyExhausted: boolean;
}

export type UsageParseResult = { ok: true; reading: UsageReading } | { ok: false; error: string };

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * Parse the time expression that follows "resets" in Claude Code output, e.g.
 * "5:30am (America/Santiago)", "Oct 12, 9am (America/Santiago)", "in 2h 15m",
 * "17:30" or an ISO timestamp. Times without a zone use `defaultTz`.
 */
export function parseResetExpression(expr: string, now: Date, defaultTz: string): Date | null {
  let text = expr.trim().replace(/[.\s]+$/, "");

  const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.exec(text);
  if (iso) {
    const d = new Date(text);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const rel = /^in\s+(?:(\d+)\s*d(?:ays?)?\s*)?(?:(\d+)\s*h(?:ours?|rs?)?\s*)?(?:(\d+)\s*m(?:in(?:utes?|s)?)?)?$/i.exec(text);
  if (rel && (rel[1] || rel[2] || rel[3])) {
    const ms = ((Number(rel[1] ?? 0) * 24 + Number(rel[2] ?? 0)) * 60 + Number(rel[3] ?? 0)) * 60_000;
    return new Date(now.getTime() + ms);
  }

  let tz = defaultTz;
  const zone = /\(([^)]+)\)\s*$/.exec(text);
  if (zone) {
    const candidate = zone[1].trim();
    if (candidate.toUpperCase() === "UTC") tz = "UTC";
    else if (isValidTimeZone(candidate)) tz = candidate;
    else return null;
    text = text.slice(0, zone.index).trim();
  }
  text = text.replace(/^at\s+/i, "");

  const m = /^(?:([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(text);
  if (!m) return null;
  let hour = Number(m[3]);
  const minute = Number(m[4] ?? 0);
  const meridiem = m[5]?.toLowerCase();
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (meridiem === "pm" ? 12 : 0);
  } else if (!m[4]) {
    return null; // a bare number like "5" is too ambiguous
  }
  if (hour > 23 || minute > 59) return null;

  if (!m[1]) return nextLocalOccurrence(now, tz, { hour, minute });

  const monthIndex = MONTHS.indexOf(m[1].toLowerCase());
  if (monthIndex < 0) return null;
  const day = Number(m[2]);
  const local = toLocalParts(now, tz);
  let result = fromLocal(tz, local.year, monthIndex + 1, day, hour, minute);
  // A date well in the past means the reset is in the next year (e.g. "Jan 2" read in December).
  if (result.getTime() < now.getTime() - 86_400_000) result = fromLocal(tz, local.year + 1, monthIndex + 1, day, hour, minute);
  return result;
}

interface Section {
  heading: string;
  lines: string[];
}

function splitSections(text: string): Section[] {
  const sections: Section[] = [];
  let current: Section = { heading: "", lines: [] };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, "").trim();
    if (/^current\s+(session|week)\b/i.test(line)) {
      sections.push(current);
      current = { heading: line.toLowerCase(), lines: [] };
    } else if (line !== "") {
      current.lines.push(line);
    }
  }
  sections.push(current);
  return sections;
}

function findReset(lines: string[], now: Date, tz: string): Date | null | undefined {
  for (const line of lines) {
    const m = /\bresets?\b(?:\s+at)?\s+(.+)$/i.exec(line);
    if (!m) continue;
    return parseResetExpression(m[1], now, tz);
  }
  return undefined;
}

function percentUsed(lines: string[]): number | null {
  for (const line of lines) {
    const m = /(\d{1,3}(?:\.\d+)?)\s*%\s*used/i.exec(line);
    if (m) return Number(m[1]);
  }
  return null;
}

/**
 * Extract the session reset time from `/usage` output (or from a usage-limit
 * error message). Rejects output that does not mention a session window, so
 * an unrelated `/usage` format (e.g. API-key cost summaries) is never
 * mistaken for "no window open".
 */
export function parseUsageOutput(text: string, now: Date, tz: string): UsageParseResult {
  const sections = splitSections(text);
  const session = sections.find((s) => s.heading.startsWith("current session"));
  const weekAll = sections.find((s) => s.heading.startsWith("current week") && !/\b(sonnet|opus|fable|haiku)\b/.test(s.heading));
  const weeklyExhausted = weekAll ? (percentUsed(weekAll.lines) ?? 0) >= 100 : false;

  if (session) {
    const reset = findReset(session.lines, now, tz);
    if (reset === null) return { ok: false, error: "session reset time not understood" };
    if (reset === undefined) {
      const used = percentUsed(session.lines);
      if (used === null || used > 0) return { ok: false, error: "session section has no reset time" };
      return { ok: true, reading: { sessionResetAt: null, weeklyExhausted } };
    }
    return validate(reset, now, weeklyExhausted);
  }

  // No sections: a usage-limit message such as "5-hour limit reached ∙ resets 5:30am".
  if (/limit/i.test(text)) {
    const reset = findReset(sections.flatMap((s) => s.lines), now, tz);
    if (reset) return validate(reset, now, weeklyExhausted);
  }
  return { ok: false, error: "no session window found in /usage output" };
}

function validate(reset: Date, now: Date, weeklyExhausted: boolean): UsageParseResult {
  const delta = reset.getTime() - now.getTime();
  if (delta <= -60_000) return { ok: false, error: "reset time is in the past" };
  if (delta > 8 * 86_400_000) return { ok: false, error: "reset time is implausibly far away" };
  return { ok: true, reading: { sessionResetAt: reset, weeklyExhausted } };
}
