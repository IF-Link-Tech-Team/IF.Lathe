/**
 * Secret redaction for job logs, the runner's copy of platform/src/ci.ts
 * `redactSecrets` (the runner ships without the platform's TypeScript).
 * platform/tests/ci-secrets.test.ts runs both against the same cases.
 *
 * Each value, and each line of a multi-line value (an SSH key), becomes
 * `***`. Shorter fragments are left alone: they would match ordinary text.
 */
export function redactSecrets(text, values) {
  const fragments = new Set();
  for (const value of values) {
    if (value.length >= 6) fragments.add(value);
    for (const line of value.split(/\r?\n/)) if (line.trim().length >= 8) fragments.add(line.trim());
  }
  let out = text;
  for (const fragment of [...fragments].sort((a, b) => b.length - a.length)) out = out.split(fragment).join("***");
  return out;
}
