import type { SearchResult } from "./search.js";
import { isStandaloneTemporalFramingToken } from "./recall-intent.js";

export type RetrievalSupportChannel = "exact" | "vector" | "fts" | "graph" | "temporal";
export type RetrievalQueryOrigin = "original" | "derived";

export interface RetrievalChannelEvidence {
  readonly rankScore: number;
  readonly vectorCosineSimilarity?: number;
  readonly rootLexicalCoverage?: number;
}

export interface RetrievalChannelSupport {
  readonly original?: RetrievalChannelEvidence;
  readonly derived?: RetrievalChannelEvidence;
}

export type RetrievalSupport = Readonly<Partial<
  Record<RetrievalSupportChannel, RetrievalChannelSupport>
>>;

export const CONTENT_LEXICAL_MIN_COVERAGE = 0.6;
export const CONTENT_LEXICAL_WINDOW_UNITS = 5;
export const CONTENT_LEXICAL_MAX_WINDOW_SPAN = 160;
export const CONTENT_VECTOR_MIN_COSINE = 0.8;
export const CONTENT_VECTOR_EPSILON = 1e-6;

const CHANNELS: readonly RetrievalSupportChannel[] = [
  "exact",
  "vector",
  "fts",
  "graph",
  "temporal",
];
const ORIGINS: readonly RetrievalQueryOrigin[] = ["original", "derived"];
const SUPPORT = new WeakMap<object, RetrievalSupport>();
const EMPTY_SUPPORT = Object.freeze(Object.create(null)) as RetrievalSupport;

const HAN_RE = /^\p{Script=Han}$/u;
const LETTER_RE = /^\p{L}$/u;
const NUMBER_RE = /^\p{N}$/u;
const HARD_BOUNDARY_RE = /^[\p{Sentence_Terminal};；]$/u;
const HORIZONTAL_SPACE_RE = /^[^\S\r\n\u2028\u2029]$/u;
const ID_SEPARATOR_RE = /^(?:[^\S\r\n\u2028\u2029]|[-_/])$/u;

interface PositionedCharacter {
  readonly value: string;
  readonly offset: number;
}

interface EvidenceSlot {
  readonly unit?: string;
  readonly start: number;
  readonly end: number;
}

export function attachRetrievalSupport(
  result: SearchResult,
  support: RetrievalSupport,
): SearchResult {
  const copied = Object.create(null) as Record<string, RetrievalChannelSupport>;

  for (const channel of CHANNELS) {
    const channelSnapshot = readOwnValue(support, channel);
    if (!channelSnapshot.present || !isObject(channelSnapshot.value)) continue;
    const sourceChannel = channelSnapshot.value;

    const copiedChannel = Object.create(null) as Record<string, RetrievalChannelEvidence>;
    for (const origin of ORIGINS) {
      const originSnapshot = readOwnValue(sourceChannel, origin);
      if (!originSnapshot.present || !isObject(originSnapshot.value)) continue;
      const sourceEvidence = originSnapshot.value;

      const rankScore = readOwnScalar(sourceEvidence, "rankScore");
      if (!rankScore.present || !Number.isFinite(rankScore.value)) continue;
      const vectorCosineSimilarity = readOwnScalar(sourceEvidence, "vectorCosineSimilarity");
      const rootLexicalCoverage = readOwnScalar(sourceEvidence, "rootLexicalCoverage");

      const copiedEvidence = Object.create(null) as {
        rankScore: number;
        vectorCosineSimilarity?: number;
        rootLexicalCoverage?: number;
      };
      copiedEvidence.rankScore = rankScore.value;
      if (
        vectorCosineSimilarity.present
        && Number.isFinite(vectorCosineSimilarity.value)
        && vectorCosineSimilarity.value >= -1
        && vectorCosineSimilarity.value <= 1
      ) {
        copiedEvidence.vectorCosineSimilarity = vectorCosineSimilarity.value;
      }
      if (
        rootLexicalCoverage.present
        && Number.isFinite(rootLexicalCoverage.value)
        && rootLexicalCoverage.value >= 0
        && rootLexicalCoverage.value <= 1
      ) {
        copiedEvidence.rootLexicalCoverage = rootLexicalCoverage.value;
      }
      copiedChannel[origin] = Object.freeze(copiedEvidence);
    }

    if (Reflect.ownKeys(copiedChannel).length > 0) {
      copied[channel] = Object.freeze(copiedChannel);
    }
  }

  SUPPORT.set(result, Object.freeze(copied));
  return result;
}

export function getRetrievalSupport(result: SearchResult): RetrievalSupport {
  return SUPPORT.get(result) ?? EMPTY_SUPPORT;
}

export function computeRootLexicalCoverage(
  rootQuery: string,
  evidenceText: string,
): number {
  const querySegments = tokenize(rootQuery);
  const evidenceSegments = tokenize(evidenceText);
  if (!querySegments || !evidenceSegments) return 0;

  const queryUnits = new Set<string>();
  for (const segment of querySegments) {
    for (const slot of segment) {
      if (slot.unit) queryUnits.add(slot.unit);
    }
  }
  if (queryUnits.size === 0) return 0;

  // Never let fuzzy character matching bypass the complete-match rule for
  // short lexical queries. This blocks one-character subject/quarter/ID drift.
  const exactPhraseCoverage = queryUnits.size <= 3
    ? 0
    : Math.max(
        computeBoundedExactPhraseCoverage(rootQuery, evidenceText),
        computeTemporalFramedPhraseCoverage(rootQuery, evidenceText),
      );

  const requiredUnits = Math.min(CONTENT_LEXICAL_WINDOW_UNITS, queryUnits.size);
  let maximum = 0;
  for (const segment of evidenceSegments) {
    for (let start = 0; start < segment.length; start++) {
      const matched = new Set<string>();
      const firstOffset = segment[start]!.start;
      const maximumEnd = Math.min(segment.length, start + CONTENT_LEXICAL_WINDOW_UNITS);
      for (let end = start; end < maximumEnd; end++) {
        const slot = segment[end]!;
        if (slot.end - firstOffset > CONTENT_LEXICAL_MAX_WINDOW_SPAN) break;
        if (slot.unit && queryUnits.has(slot.unit)) matched.add(slot.unit);
        maximum = Math.max(maximum, matched.size / requiredUnits);
      }
    }
  }

  const clamped = Math.min(1, Math.max(0, maximum));
  const localCoverage = queryUnits.size <= 3 && clamped !== 1 ? 0 : clamped;
  // A compact, unspaced CJK-bearing phrase has no structural token boundary
  // that can prove a dropped/replaced character is semantically harmless.
  // Require one bounded exact compact occurrence instead of guessing.
  if (
    queryUnits.size > 3
    && localCoverage >= CONTENT_LEXICAL_MIN_COVERAGE
    && requiresBoundedExactPhrase(rootQuery)
    && exactPhraseCoverage < 1
  ) {
    return 0;
  }
  return localCoverage >= CONTENT_LEXICAL_MIN_COVERAGE
    ? localCoverage
    : Math.max(localCoverage, exactPhraseCoverage);
}

const EXACT_PHRASE_MIN_QUERY_UNITS = 4;
const EXACT_PHRASE_MAX_QUERY_UNITS = 64;
const CONTENT_LEXICAL_MAX_INPUT_CODEPOINTS = 100_000;

function requiresBoundedExactPhrase(input: string): boolean {
  let normalized: string;
  try {
    normalized = input.normalize("NFKC").toLowerCase();
  } catch {
    return false;
  }
  const compact = Array.from(normalized).filter((value) => !isHorizontalSpace(value));
  return compact.length >= EXACT_PHRASE_MIN_QUERY_UNITS
    && compact.some((value) => isHan(value));
}

function computeTemporalFramedPhraseCoverage(
  rootQuery: string,
  evidenceText: string,
): number {
  let normalized: string;
  try {
    normalized = rootQuery.normalize("NFKC").toLowerCase();
  } catch {
    return 0;
  }
  const characters = Array.from(normalized);
  const separator = characters.findIndex((value) => isHorizontalSpace(value));
  if (separator <= 0) return 0;
  let remainderStart = separator;
  while (
    remainderStart < characters.length
    && isHorizontalSpace(characters[remainderStart]!)
  ) {
    remainderStart++;
  }
  if (remainderStart >= characters.length) return 0;
  const framing = characters.slice(0, separator).join("");
  if (!isStandaloneTemporalFramingToken(framing)) return 0;
  return computeBoundedExactPhraseCoverage(
    characters.slice(remainderStart).join(""),
    evidenceText,
  );
}

function computeBoundedExactPhraseCoverage(
  rootQuery: string,
  evidenceText: string,
): number {
  const querySegments = compactCharacterSegments(rootQuery);
  const evidenceSegments = compactCharacterSegments(evidenceText);
  if (!querySegments || !evidenceSegments || querySegments.length !== 1) return 0;

  const query = querySegments[0]!;
  if (
    query.length < EXACT_PHRASE_MIN_QUERY_UNITS
    || query.length > EXACT_PHRASE_MAX_QUERY_UNITS
    || !query.some((item) => isHan(item.value))
  ) {
    return 0;
  }

  const values = query.map((item) => item.value);
  const failure = new Uint8Array(values.length);
  for (let index = 1, matched = 0; index < values.length; index++) {
    while (matched > 0 && values[index] !== values[matched]) matched = failure[matched - 1]!;
    if (values[index] === values[matched]) matched++;
    failure[index] = matched;
  }
  for (const evidence of evidenceSegments) {
    let matched = 0;
    for (let index = 0; index < evidence.length; index++) {
      while (matched > 0 && evidence[index]!.value !== values[matched]) {
        matched = failure[matched - 1]!;
      }
      if (evidence[index]!.value === values[matched]) matched++;
      if (matched !== values.length) continue;
      const start = index - values.length + 1;
      if (
        evidence[index]!.offset - evidence[start]!.offset + 1
        <= CONTENT_LEXICAL_MAX_WINDOW_SPAN
      ) {
        return 1;
      }
      matched = failure[matched - 1]!;
    }
  }
  return 0;
}

function compactCharacterSegments(input: string): PositionedCharacter[][] | undefined {
  if (typeof input !== "string" || input.length === 0) return undefined;

  let normalized: string;
  try {
    normalized = input.normalize("NFKC").toLowerCase();
  } catch {
    return undefined;
  }

  const segments: PositionedCharacter[][] = [];
  let segment: PositionedCharacter[] = [];
  const closeSegment = () => {
    if (segment.length > 0) segments.push(segment);
    segment = [];
  };
  let offset = 0;
  for (const value of Array.from(normalized)) {
    if (isHardBoundary(value)) {
      closeSegment();
    } else if (!isHorizontalSpace(value)) {
      segment.push({ value, offset });
    }
    offset++;
  }
  closeSegment();
  return segments;
}

export function computeCosineSimilarity(
  left: ArrayLike<number>,
  right: ArrayLike<number>,
): number | undefined {
  if (!left || !right) return undefined;
  const length = left.length;
  if (!Number.isInteger(length) || length <= 0 || right.length !== length) return undefined;

  let leftScale = 0;
  let rightScale = 0;
  for (let index = 0; index < length; index++) {
    const leftValue = left[index];
    const rightValue = right[index];
    if (!Number.isFinite(leftValue) || !Number.isFinite(rightValue)) return undefined;
    leftScale = Math.max(leftScale, Math.abs(leftValue));
    rightScale = Math.max(rightScale, Math.abs(rightValue));
  }
  if (leftScale === 0 || rightScale === 0) return undefined;

  let dot = 0;
  let leftSquared = 0;
  let rightSquared = 0;
  for (let index = 0; index < length; index++) {
    const scaledLeft = left[index]! / leftScale;
    const scaledRight = right[index]! / rightScale;
    dot += scaledLeft * scaledRight;
    leftSquared += scaledLeft * scaledLeft;
    rightSquared += scaledRight * scaledRight;
  }

  const similarity = dot / Math.sqrt(leftSquared * rightSquared);
  if (!Number.isFinite(similarity)) return undefined;
  return Math.min(1, Math.max(-1, similarity));
}

function tokenize(input: string): EvidenceSlot[][] | undefined {
  if (typeof input !== "string" || input.length === 0) return undefined;

  let normalized: string;
  try {
    normalized = input.normalize("NFKC").toLowerCase();
  } catch {
    return undefined;
  }
  if (normalized.length === 0) return undefined;

  const characters: PositionedCharacter[] = [];
  let offset = 0;
  for (const value of normalized) {
    if (offset >= CONTENT_LEXICAL_MAX_INPUT_CODEPOINTS) return undefined;
    characters.push({ value, offset });
    offset++;
  }

  const segments: EvidenceSlot[][] = [];
  let segment: EvidenceSlot[] = [];
  const closeSegment = () => {
    if (segment.length > 0) segments.push(segment);
    segment = [];
  };

  let index = 0;
  while (index < characters.length) {
    const character = characters[index]!;
    if (isHardBoundary(character.value)) {
      closeSegment();
      index++;
      continue;
    }
    if (isHorizontalSpace(character.value)) {
      index++;
      continue;
    }
    if (isHan(character.value)) {
      const consumed = consumeHanRegion(characters, index);
      for (const slot of consumed.slots) segment.push(slot);
      index = consumed.next;
      continue;
    }
    if (isLetter(character.value) || isNumber(character.value)) {
      const consumed = consumeAlphaNumeric(characters, index);
      segment.push(consumed.slot);
      index = consumed.next;
      continue;
    }

    segment.push({ start: character.offset, end: character.offset + 1 });
    index++;
  }
  closeSegment();
  return segments;
}

function consumeHanRegion(
  characters: readonly PositionedCharacter[],
  start: number,
): { slots: EvidenceSlot[]; next: number } {
  const han: PositionedCharacter[] = [];
  let index = start;
  while (index < characters.length) {
    const character = characters[index]!;
    if (isHan(character.value)) {
      han.push(character);
      index++;
      continue;
    }
    if (isHorizontalSpace(character.value)) {
      index++;
      continue;
    }
    break;
  }

  if (han.length === 1) {
    return {
      slots: [{ start: han[0]!.offset, end: han[0]!.offset + 1 }],
      next: index,
    };
  }

  const width = han.length === 2 ? 2 : han.length <= 4 ? 2 : 3;
  const slots: EvidenceSlot[] = [];
  for (let unitStart = 0; unitStart <= han.length - width; unitStart++) {
    const slice = han.slice(unitStart, unitStart + width);
    slots.push({
      unit: slice.map((item) => item.value).join(""),
      start: slice[0]!.offset,
      end: slice[slice.length - 1]!.offset + 1,
    });
  }
  return { slots, next: index };
}

function consumeAlphaNumeric(
  characters: readonly PositionedCharacter[],
  start: number,
): { slot: EvidenceSlot; next: number } {
  let index = start;
  while (
    index < characters.length
    && !isHan(characters[index]!.value)
    && (isLetter(characters[index]!.value) || isNumber(characters[index]!.value))
  ) {
    index++;
  }

  const firstRun = characters.slice(start, index);
  const firstHasLetter = firstRun.some((item) => isLetter(item.value));
  const firstHasNumber = firstRun.some((item) => isNumber(item.value));

  if (firstHasLetter && !firstHasNumber) {
    let separatorEnd = index;
    while (separatorEnd < characters.length && isIdSeparator(characters[separatorEnd]!.value)) {
      separatorEnd++;
    }
    let numberEnd = separatorEnd;
    while (numberEnd < characters.length && isNumber(characters[numberEnd]!.value)) {
      numberEnd++;
    }
    if (separatorEnd > index && numberEnd > separatorEnd) {
      const unit = firstRun.map((item) => item.value).join("")
        + characters.slice(separatorEnd, numberEnd).map((item) => item.value).join("");
      return {
        slot: { unit, start: firstRun[0]!.offset, end: characters[numberEnd - 1]!.offset + 1 },
        next: numberEnd,
      };
    }
  }

  const value = firstRun.map((item) => item.value).join("");
  const isMixedId = firstHasLetter && firstHasNumber;
  return {
    slot: {
      unit: isMixedId || firstRun.length >= 2 ? value : undefined,
      start: firstRun[0]!.offset,
      end: firstRun[firstRun.length - 1]!.offset + 1,
    },
    next: index,
  };
}

function isHan(value: string): boolean {
  return HAN_RE.test(value);
}

function isLetter(value: string): boolean {
  return LETTER_RE.test(value);
}

function isNumber(value: string): boolean {
  return NUMBER_RE.test(value);
}

function isHardBoundary(value: string): boolean {
  return value === "\n" || value === "\r" || value === "\u2028" || value === "\u2029"
    || HARD_BOUNDARY_RE.test(value);
}

function isHorizontalSpace(value: string): boolean {
  return HORIZONTAL_SPACE_RE.test(value);
}

function isIdSeparator(value: string): boolean {
  return ID_SEPARATOR_RE.test(value);
}

function isObject(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null;
}

function readOwnScalar(
  object: Record<PropertyKey, unknown>,
  key: string,
): { readonly present: false; readonly value: number } | {
  readonly present: true;
  readonly value: number;
} {
  const snapshot = readOwnValue(object, key);
  return snapshot.present
    ? { present: true, value: snapshot.value as number }
    : { present: false, value: Number.NaN };
}

function readOwnValue(
  object: object,
  key: PropertyKey,
): { readonly present: false; readonly value: undefined } | {
  readonly present: true;
  readonly value: unknown;
} {
  if (!Object.hasOwn(object, key)) return { present: false, value: undefined };
  try {
    return { present: true, value: (object as Record<PropertyKey, unknown>)[key] };
  } catch {
    return { present: false, value: undefined };
  }
}
