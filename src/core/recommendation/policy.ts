export const DEFAULT_SUPPRESSION_TTL_SECONDS = 7 * 86400;
export const SUPPRESSION_REOPENED = "1970-01-01 00:00:00";

const TS = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;

/** Semantically validate a SQLite-UTC `YYYY-MM-DD HH:MM:SS` timestamp (parse + UTC round-trip). */
export function validateTimestamp(s: string, name: string): void {
  const m = TS.exec(s);
  if (!m) throw new Error(`policy: invalid ${name} format, got ${JSON.stringify(s)}`);
  const [, Y, Mo, D, H, Mi, S] = m;
  const y = +Y;
  const mo = +Mo;
  const d = +D;
  const h = +H;
  const mi = +Mi;
  const sec = +S;
  if (mo < 1 || mo > 12) throw new Error(`policy: invalid ${name} month`);
  if (d < 1 || d > 31) throw new Error(`policy: invalid ${name} day`);
  if (h > 23 || mi > 59 || sec > 59) throw new Error(`policy: invalid ${name} time`);
  const dt = new Date(Date.UTC(y, mo - 1, d, h, mi, sec));
  const back = `${dt.getUTCFullYear().toString().padStart(4, "0")}-${(dt.getUTCMonth() + 1).toString().padStart(2, "0")}-${dt.getUTCDate().toString().padStart(2, "0")} ${dt.getUTCHours().toString().padStart(2, "0")}:${dt.getUTCMinutes().toString().padStart(2, "0")}:${dt.getUTCSeconds().toString().padStart(2, "0")}`;
  if (back !== s) throw new Error(`policy: invalid ${name} date (round-trip mismatch)`);
}

/** Default durable suppression window: now + policy TTL (7d). */
export function defaultSuppressedUntil(nowIso: string): string {
  validateTimestamp(nowIso, "now");
  const epoch = Date.parse(`${nowIso.replace(" ", "T")}Z`);
  return new Date(epoch + DEFAULT_SUPPRESSION_TTL_SECONDS * 1000)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, "");
}
