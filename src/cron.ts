/** Parses `every:<minutes>` or a 5-field cron expression (UTC; `*` or a number per field). */
export function parseSchedule(raw: string): { kind: "interval"; minutes: number } | { kind: "cron"; fields: number[] } | null {
  const value = raw.trim();
  if (!value) return null;
  const every = /^every:(\d{1,4})$/.exec(value);
  if (every) return { kind: "interval", minutes: Math.max(1, Number(every[1])) };
  const parts = value.split(/\s+/);
  if (parts.length !== 5) return null;
  const fields: number[] = [];
  for (const part of parts) {
    if (part === "*") {
      fields.push(-1);
      continue;
    }
    if (!/^\d{1,2}$/.test(part)) return null;
    fields.push(Number(part));
  }
  return { kind: "cron", fields };
}
