import { describe, expect, test } from "bun:test";
import {
  parseFingerprintedNerJob,
  parseNerFingerprint,
  parseZeroLinkRepairMarker,
} from "../../../src/core/ingestion/ner-backfill-contract.js";

const DERIVED = `derived:${"a".repeat(64)}`;
const BATCH_ID = "11111111-1111-4111-8111-111111111111";

describe("canonical NER fingerprint contract", () => {
  test.each([
    ["page fingerprint infers vault source", "page:hash-a", undefined, "vault_hash"],
    ["derived fingerprint infers raw-chunk source", DERIVED, undefined, "raw_chunks"],
    ["page fingerprint accepts matching declared source", "page:hash-a", "vault_hash", "vault_hash"],
    ["derived fingerprint accepts matching declared source", DERIVED, "raw_chunks", "raw_chunks"],
  ] as const)("%s", (_label, fingerprint, declaredKind, sourceKind) => {
    expect(parseNerFingerprint(fingerprint, declaredKind)).toEqual({
      fingerprint,
      sourceKind,
    });
  });

  test.each([
    ["empty page payload", "page:", undefined],
    ["short derived payload", "derived:abc", undefined],
    ["uppercase derived hash", `derived:${"A".repeat(64)}`, undefined],
    ["page declared as raw chunks", "page:hash-a", "raw_chunks"],
    ["derived declared as vault hash", DERIVED, "vault_hash"],
    ["unknown declared kind", "page:hash-a", "other"],
  ] as const)("rejects %s", (_label, fingerprint, declaredKind) => {
    expect(parseNerFingerprint(fingerprint, declaredKind)).toBeNull();
  });

  test("accepts only the exact repair marker shape", () => {
    expect(parseZeroLinkRepairMarker({
      name: "zero-link-rich-records",
      version: 1,
      batchId: BATCH_ID,
      contentFingerprint: DERIVED,
      sourceKind: "raw_chunks",
    })).toEqual({
      name: "zero-link-rich-records",
      version: 1,
      batchId: BATCH_ID,
      contentFingerprint: DERIVED,
      sourceKind: "raw_chunks",
    });

    expect(parseZeroLinkRepairMarker({
      name: "zero-link-rich-records",
      version: 1,
      batchId: BATCH_ID,
      contentFingerprint: "page:hash-a",
      sourceKind: "raw_chunks",
    })).toBeNull();
    expect(parseZeroLinkRepairMarker({
      name: "zero-link-rich-records",
      version: 1,
      batchId: BATCH_ID,
      contentFingerprint: DERIVED,
      sourceKind: "raw_chunks",
      extra: true,
    })).toBeNull();
  });

  test("rejects ambiguous job identities", () => {
    expect(parseFingerprintedNerJob({
      slug: "records/anonymous",
      kind: "ner",
      sourceFingerprint: "page:hash-a",
      sourceKind: "raw_chunks",
    })).toBeNull();
    expect(parseFingerprintedNerJob({
      slug: "records/anonymous",
      kind: "ner",
      sourceFingerprint: "page:hash-a",
      repair: {
        name: "zero-link-rich-records",
        version: 1,
        batchId: BATCH_ID,
        contentFingerprint: DERIVED,
        sourceKind: "raw_chunks",
      },
    })).toBeNull();
    expect(parseFingerprintedNerJob({
      slug: "records/anonymous",
      kind: "ner",
      sourceKind: "raw_chunks",
      repair: {
        name: "zero-link-rich-records",
        version: 1,
        batchId: BATCH_ID,
        contentFingerprint: "page:hash-a",
        sourceKind: "vault_hash",
      },
    })).toBeNull();
  });
});
