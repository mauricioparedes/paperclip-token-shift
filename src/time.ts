// Timezone helpers built on Intl so the worker has no runtime dependencies.

export interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

export function toLocalParts(instant: Date, timeZone: string): LocalParts {
  const parts: Record<string, number> = {};
  for (const p of formatter(timeZone).formatToParts(instant)) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
  };
}

function offsetMs(instant: Date, timeZone: string): number {
  const p = toLocalParts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * Convert a local wall-clock time to an instant. Times skipped by a DST jump
 * resolve forward (e.g. 00:30 on a spring-forward night becomes 01:30); times
 * repeated by a fall-back resolve to the earlier occurrence.
 */
export function fromLocal(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const before = offsetMs(new Date(guess - 86_400_000), timeZone);
  const after = offsetMs(new Date(guess + 86_400_000), timeZone);
  const matches = [guess - before, guess - after].filter((t) => {
    const p = toLocalParts(new Date(t), timeZone);
    return p.year === year && p.month === month && p.day === day && p.hour === hour && p.minute === minute;
  });
  if (matches.length > 0) return new Date(Math.min(...matches));
  // Wall time falls in a DST gap: applying the pre-transition offset lands just after the jump.
  return new Date(guess - before);
}

export interface Hm {
  hour: number;
  minute: number;
}

export function parseHm(value: string): Hm | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

export function minutesOfDay(hm: Hm): number {
  return hm.hour * 60 + hm.minute;
}

/** Next instant strictly after `now` whose local wall time equals `hm`. */
export function nextLocalOccurrence(now: Date, timeZone: string, hm: Hm): Date {
  const p = toLocalParts(now, timeZone);
  for (let addDays = 0; addDays < 3; addDays++) {
    const d = new Date(Date.UTC(p.year, p.month - 1, p.day + addDays));
    const candidate = fromLocal(timeZone, d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), hm.hour, hm.minute);
    if (candidate.getTime() > now.getTime()) return candidate;
  }
  throw new Error(`no local occurrence of ${hm.hour}:${hm.minute} in ${timeZone}`);
}

export function formatLocal(instant: Date, timeZone: string): string {
  const p = toLocalParts(instant, timeZone);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
}
