/**
 * Runtime accessors for untrusted JSON.
 *
 * The Python original leaned on `isinstance` checks everywhere; TypeScript has
 * no runtime types, so the checks move here and the linter calls these helpers.
 */

/** `str(value or "")` — never throws, never returns `undefined`. */
export function asString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "True" : "False";
  return String(value);
}

/** The value if it is a JSON object, otherwise `undefined`. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/** The value if it is a JSON array, otherwise `undefined`. */
export function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

/** The value as an array of strings (non-strings dropped). */
export function asStringArray(value: unknown): string[] {
  const items = asArray(value);
  if (!items) return [];
  return items.filter((item): item is string => typeof item === "string");
}

/** `int(value)` — `undefined` when the value cannot be read as an integer. */
export function asInt(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value) : undefined;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") {
    const text = value.trim();
    if (!/^[+-]?\d+$/.test(text)) return undefined;
    return Number(text);
  }
  return undefined;
}

/**
 * Render a list the way Python does (`['a', 'b']`).
 *
 * The messages are part of the tool's contract — the rules manual quotes them —
 * so the rendering stays identical to the original implementation.
 */
export function pyListRepr(values: readonly unknown[]): string {
  const items = values.map((value) => {
    const text = typeof value === "string" ? value : String(value);
    return `'${text.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  });
  return `[${items.join(", ")}]`;
}

/** `re.fullmatch` semantics: the pattern has to cover the whole string. */
export function fullMatch(pattern: RegExp, text: string): boolean {
  const match = pattern.exec(text);
  return match !== null && match.index === 0 && match[0].length === text.length;
}
