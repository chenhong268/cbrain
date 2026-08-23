export type TemporalPrecision = "instant" | "day" | "month" | "year" | "approximate";

export interface TemporalPoint {
  value: string;
  precision: TemporalPrecision;
  timezone: string;
  earliestMs: number;
  latestExclusiveMs: number;
}

export type ValidityState = "unknown" | "scheduled" | "effective" | "expired" | "superseded" | "revoked";

export interface ClaimTransition {
  kind: "supersedes" | "revokes";
  oldClaimId: string;
  newClaimId?: string;
  confirmationState: "candidate" | "confirmed" | "rejected";
  effectiveAt?: TemporalPoint;
  recordedAt?: TemporalPoint;
}

export interface ValidityResult {
  state: ValidityState;
  temporalCertainty: "known" | "unknown";
  transitionConflict: boolean;
}

interface ReduceClaimValidityInput {
  claimId: string;
  asOf: TemporalPoint;
  validFrom?: TemporalPoint;
  validTo?: TemporalPoint;
  transitions: ClaimTransition[];
}

const offsetMs = (timezone: string): number => {
  if (timezone === "Z") return 0;
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(timezone);
  if (!match) throw new Error(`invalid_timezone: ${timezone}`);
  const amount = (Number(match[2]) * 60 + Number(match[3])) * 60_000;
  return match[1] === "+" ? amount : -amount;
};

const startOf = (value: string, precision: Exclude<TemporalPrecision, "approximate">, timezone: string): number => {
  if (precision === "instant") return Date.parse(value);
  const match = precision === "day"
    ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
    : precision === "month"
      ? /^(\d{4})-(\d{2})$/.exec(value)
      : /^(\d{4})$/.exec(value);
  if (!match) throw new Error(`invalid_${precision}: ${value}`);
  const year = Number(match[1]);
  const month = precision === "year" ? 1 : Number(match[2]);
  const day = precision === "day" ? Number(match[3]) : 1;
  return Date.UTC(year, month - 1, day) - offsetMs(timezone);
};

const calendarParts = (value: string, precision: Exclude<TemporalPrecision, "instant" | "approximate">): [number, number, number] => {
  const match = precision === "day"
    ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
    : precision === "month"
      ? /^(\d{4})-(\d{2})$/.exec(value)
      : /^(\d{4})$/.exec(value);
  if (!match) throw new Error(`invalid_${precision}: ${value}`);
  return [Number(match[1]), precision === "year" ? 1 : Number(match[2]), precision === "day" ? Number(match[3]) : 1];
};

export const temporalPoint = (value: string, precision: TemporalPrecision, timezone: string): TemporalPoint => {
  if (precision === "approximate") throw new Error("approximate_requires_interval");
  const earliestMs = startOf(value, precision, timezone);
  const latestExclusiveMs = precision === "instant"
    ? earliestMs
    : (() => {
        const [year, month, day] = calendarParts(value, precision);
        if (precision === "day") return Date.UTC(year, month - 1, day + 1) - offsetMs(timezone);
        if (precision === "month") return Date.UTC(year, month, 1) - offsetMs(timezone);
        return Date.UTC(year + 1, 0, 1) - offsetMs(timezone);
      })();
  return { value, precision, timezone, earliestMs, latestExclusiveMs };
};

export const approximatePoint = (value: string, timezone: string, earliest: string, latestExclusive: string): TemporalPoint => ({
  value,
  precision: "approximate",
  timezone,
  earliestMs: Date.parse(earliest),
  latestExclusiveMs: Date.parse(latestExclusive),
});

const crossed = (point: TemporalPoint | undefined, asOf: TemporalPoint): boolean => point !== undefined && asOf.earliestMs >= point.latestExclusiveMs;
const ambiguous = (point: TemporalPoint | undefined, asOf: TemporalPoint): boolean => point !== undefined && point.earliestMs < asOf.latestExclusiveMs && asOf.earliestMs < point.latestExclusiveMs;

export const reduceClaimValidity = ({ claimId, asOf, validFrom, validTo, transitions }: ReduceClaimValidityInput): ValidityResult => {
  if (validFrom && validTo && validFrom.latestExclusiveMs > validTo.earliestMs) throw new Error("invalid_or_ambiguous_valid_interval");
  const confirmed = transitions.filter((transition) => transition.oldClaimId === claimId && transition.confirmationState === "confirmed" && transition.effectiveAt);
  const crossedRevocation = confirmed.some((transition) => transition.kind === "revokes" && crossed(transition.effectiveAt, asOf));
  const crossedSupersession = confirmed.some((transition) => transition.kind === "supersedes" && crossed(transition.effectiveAt, asOf));
  if (crossedRevocation) return { state: "revoked", temporalCertainty: "known", transitionConflict: crossedSupersession };
  if (crossedSupersession) return { state: "superseded", temporalCertainty: "known", transitionConflict: false };
  if (confirmed.some((transition) => ambiguous(transition.effectiveAt, asOf))) return { state: "unknown", temporalCertainty: "unknown", transitionConflict: false };
  if (validFrom && asOf.latestExclusiveMs <= validFrom.earliestMs) return { state: "scheduled", temporalCertainty: "known", transitionConflict: false };
  if (validFrom && ambiguous(validFrom, asOf)) return { state: "unknown", temporalCertainty: "unknown", transitionConflict: false };
  if (validTo && crossed(validTo, asOf)) return { state: "expired", temporalCertainty: "known", transitionConflict: false };
  if (validTo && ambiguous(validTo, asOf)) return { state: "unknown", temporalCertainty: "unknown", transitionConflict: false };
  if (validFrom || validTo) return { state: "effective", temporalCertainty: "known", transitionConflict: false };
  return { state: "unknown", temporalCertainty: "unknown", transitionConflict: false };
};
