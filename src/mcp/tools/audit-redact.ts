// Redaction for the opt-in audit payload (#327 Phase 1). Spec §5.1 L1 invariant: credentials
// and absolute paths are NEVER output — including audit. slug/id/internal/debug ARE retained
// (audit exists so a reviewer can trace why). Therefore this strips ONLY credentials + paths,
// using the shared CREDENTIAL_PATH_UNSAFE_PATTERNS — it does NOT redeclare any regex (Codex
// HIGH 1: single rule source). Slug/internal stripping for the `data` field is a different
// layer (sanitizeUntrustedData in result-builder.ts, which uses the full DISPLAY_UNSAFE_PATTERNS).

import {
  CREDENTIAL_PATH_UNSAFE_PATTERNS,
  UNICODE_CONTROL_RE,
} from "../../core/safety/display-safety.js";

const REDACTED = "[redacted]";
const OMIT = Symbol("omit-audit-value");
const UNSAFE_OBJECT_KEYS: ReadonlySet<string> = new Set(["__proto__", "prototype", "constructor"]);

function isCredentialOrPath(value: string): boolean {
  return CREDENTIAL_PATH_UNSAFE_PATTERNS.some((p) => p.test(value));
}

function redactText(value: string): string {
  const normalized = value.replace(UNICODE_CONTROL_RE, "").normalize("NFKC");
  return isCredentialOrPath(normalized) ? REDACTED : normalized;
}

function redactAuditValue(value: unknown, arrayItem: boolean): unknown | typeof OMIT {
  if (typeof value === "string") {
    return redactText(value);
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
    return arrayItem ? null : OMIT;
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor)) {
        out.push(null);
        continue;
      }
      const item = redactAuditValue(descriptor.value, true);
      out.push(item === OMIT ? null : item);
    }
    return out;
  }
  if (value instanceof Map) {
    return Array.from(Map.prototype.entries.call(value), ([key, entryValue]) => {
      const redactedKey = redactAuditValue(key, true);
      const redactedValue = redactAuditValue(entryValue, true);
      return {
        key: redactedKey === OMIT ? null : redactedKey,
        value: redactedValue === OMIT ? null : redactedValue,
      };
    });
  }
  if (value instanceof Set) {
    return Array.from(Set.prototype.values.call(value), (item) => {
      const redacted = redactAuditValue(item, true);
      return redacted === OMIT ? null : redacted;
    });
  }
  if (value instanceof Date) {
    return redactText(Date.prototype.toISOString.call(value));
  }
  if (value instanceof RegExp) {
    return redactText(value.toString());
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [k, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (!descriptor.enumerable || !("value" in descriptor)) continue;
      const baseKey = redactText(k);
      const safeKey = UNSAFE_OBJECT_KEYS.has(baseKey) ? REDACTED : baseKey;
      let outputKey = safeKey;
      let collision = 2;
      while (Object.hasOwn(out, outputKey)) {
        outputKey = `${safeKey}#${collision}`;
        collision += 1;
      }
      const redacted = redactAuditValue(descriptor.value, false);
      if (redacted !== OMIT) out[outputKey] = redacted;
    }
    return out;
  }
  return arrayItem ? null : OMIT;
}

/** Recursively strip credentials + absolute paths; retain slug/id/internal/debug. */
export function redactAudit(value: unknown): unknown {
  const redacted = redactAuditValue(value, false);
  return redacted === OMIT ? null : redacted;
}
