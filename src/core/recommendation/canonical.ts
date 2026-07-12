import { createHash } from "node:crypto";

export function serializeNumber(n: number): string {
  if (!Number.isFinite(n)) throw new Error(`canonical: number must be finite, got ${String(n)}`);
  return String(Object.is(n, -0) ? 0 : n);
}

export function normalizeProse(s: string): string {
  return s.normalize("NFKC").replace(/\s+/g, " ").trim();
}

const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|[\uDC00-\uDFFF](?<![\uD800-\uDBFF])/u;

export function assertJsonSafe(v: unknown, seen: Set<object> = new Set()): void {
  if (v === null || typeof v === "boolean") return;
  if (typeof v === "number") {
    serializeNumber(v);
    return;
  }
  if (typeof v === "string") {
    if (LONE.test(v)) throw new Error("canonical: lone surrogate is not JSON-safe");
    return;
  }
  if (typeof v !== "object" || v === undefined) throw new Error(`canonical: non-JSON-safe type ${typeof v}`);
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && !Array.isArray(v)) throw new Error(`canonical: non-plain object (${proto?.constructor?.name ?? "?"}) is not JSON-safe`);
  if (seen.has(v as object)) throw new Error("canonical: cycle detected (not JSON-safe)");
  seen.add(v as object);
  if (Array.isArray(v)) {
    for (const el of v) assertJsonSafe(el, seen);
  } else {
    for (const k of Object.keys(v)) {
      const val = (v as Record<string, unknown>)[k];
      if (val === undefined) throw new Error(`canonical: undefined at key "${k}" is not JSON-safe (omit the key instead)`);
      assertJsonSafe(val, seen);
    }
  }
  seen.delete(v as object);
}

export function canonicalJson(value: unknown): string {
  assertJsonSafe(value);
  return emit(value, new Set<object>());
}

function emit(v: unknown, seen: Set<object>): string {
  if (v === null) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return serializeNumber(v);
  if (typeof v === "string") return quote(v);
  if (Array.isArray(v)) {
    seen.add(v);
    const parts = v.map((el) => emit(el, seen)).sort();
    seen.delete(v);
    return `[${parts.join(",")}]`;
  }
  seen.add(v as object);
  const entries = Object.keys(v as object)
    .sort()
    .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
    .map((k) => `${quote(k)}:${emit((v as Record<string, unknown>)[k], seen)}`);
  seen.delete(v as object);
  return `{${entries.join(",")}}`;
}

function quote(s: string): string {
  let out = '"';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (ch === "\\" || ch === '"') out += "\\" + ch;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\f") out += "\\f";
    else if (cp < 0x20) out += "\\u" + cp.toString(16).padStart(4, "0");
    else out += ch;
  }
  return out + '"';
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}
