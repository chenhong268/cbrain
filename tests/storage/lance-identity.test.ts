import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DOCUMENT_ENCODING_VERSION,
  INDEX_IDENTITY_FILENAME,
  LEGACY_VECTOR_DIMENSIONS,
  VectorIdentityError,
  assertIndexIdentity,
  identityFilePath,
  readIndexIdentity,
  vectorColumnDimensions,
  vectorIndexIdentity,
  vectorSchemas,
  writeIndexIdentity,
} from "../../src/storage/lance-identity.js";
import type { VectorIndexIdentity } from "../../src/storage/lance-identity.js";

const TEST_DIR = "/tmp/cbrain-test-lance-identity";

function ollama1024(overrides: Partial<VectorIndexIdentity> = {}): VectorIndexIdentity {
  return {
    provider: "ollama",
    model: "qwen3-embedding:0.6b",
    dimensions: 1024,
    documentEncoding: DOCUMENT_ENCODING_VERSION,
    ...overrides,
  };
}

function zhipu2048(overrides: Partial<VectorIndexIdentity> = {}): VectorIndexIdentity {
  return {
    provider: "zhipu",
    model: "embedding-3",
    dimensions: LEGACY_VECTOR_DIMENSIONS,
    documentEncoding: DOCUMENT_ENCODING_VERSION,
    ...overrides,
  };
}

describe("vectorSchemas", () => {
  test("builds the declared width for both tables", () => {
    expect(vectorColumnDimensions(vectorSchemas(1024).chunks)).toBe(1024);
    expect(vectorColumnDimensions(vectorSchemas(1024).insights)).toBe(1024);
    expect(vectorColumnDimensions(vectorSchemas(2048).chunks)).toBe(2048);
  });

  test("reports null when the vector column is not a fixed-size list", () => {
    expect(vectorColumnDimensions({ fields: [{ name: "vector", type: { listSize: "1024" } }] })).toBeNull();
    expect(vectorColumnDimensions({ fields: [{ name: "content", type: { listSize: 1024 } }] })).toBeNull();
    expect(vectorColumnDimensions({})).toBeNull();
  });
});

describe("vectorIndexIdentity", () => {
  test("rejects an empty provider, empty model, or non-positive dimension", () => {
    expect(() => vectorIndexIdentity({ provider: "", model: "m", dimensions: 1024 })).toThrow(VectorIdentityError);
    expect(() => vectorIndexIdentity({ provider: "ollama", model: "", dimensions: 1024 })).toThrow(VectorIdentityError);
    expect(() => vectorIndexIdentity({ provider: "ollama", model: "m", dimensions: 0 })).toThrow(VectorIdentityError);
    expect(() => vectorIndexIdentity({ provider: "ollama", model: "m", dimensions: 1.5 })).toThrow(VectorIdentityError);
  });

  test("defaults the encoding version and omits an unresolved digest", () => {
    const identity = vectorIndexIdentity({ provider: "ollama", model: "m", dimensions: 1024 });
    expect(identity.documentEncoding).toBe(DOCUMENT_ENCODING_VERSION);
    expect("modelDigest" in identity).toBe(false);
  });

  test("keeps an explicit digest", () => {
    const identity = vectorIndexIdentity({ provider: "ollama", model: "m", dimensions: 1024, modelDigest: "sha256:abc" });
    expect(identity.modelDigest).toBe("sha256:abc");
  });
});

describe("identity file on disk", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  test("returns null when the directory has no identity", () => {
    expect(readIndexIdentity(TEST_DIR)).toBeNull();
    expect(identityFilePath(TEST_DIR)).toBe(join(TEST_DIR, INDEX_IDENTITY_FILENAME));
  });

  test("round-trips an identity", () => {
    writeIndexIdentity(TEST_DIR, ollama1024());
    expect(readIndexIdentity(TEST_DIR)).toEqual(ollama1024());
  });

  test("fails closed on unparsable JSON", () => {
    writeFileSync(identityFilePath(TEST_DIR), "{not json", "utf8");
    expect(() => readIndexIdentity(TEST_DIR)).toThrow(/LANCE_IDENTITY_CORRUPT/);
  });

  test("fails closed on a malformed shape", () => {
    for (const bad of [
      {},
      { provider: "ollama", model: "m", dimensions: "1024", documentEncoding: 1 },
      { provider: "ollama", model: "m", dimensions: 1024 },
      { provider: "ollama", model: "m", dimensions: 1024, documentEncoding: 1, modelDigest: 7 },
      { provider: "", model: "m", dimensions: 1024, documentEncoding: 1 },
    ]) {
      writeFileSync(identityFilePath(TEST_DIR), JSON.stringify(bad), "utf8");
      expect(() => readIndexIdentity(TEST_DIR)).toThrow(VectorIdentityError);
    }
  });

  test("leaves no temp file behind", () => {
    writeIndexIdentity(TEST_DIR, ollama1024());
    expect(readFileSync(identityFilePath(TEST_DIR), "utf8")).toContain("qwen3-embedding:0.6b");
    expect(existsSync(`${identityFilePath(TEST_DIR)}.tmp`)).toBe(false);
  });
});

describe("assertIndexIdentity", () => {
  const indexPath = "/tmp/index";

  test("accepts an unlabelled legacy 2048d Zhipu index and never relabels it", () => {
    expect(() => assertIndexIdentity({
      indexPath, expected: zhipu2048(), stored: null, schemaDimensions: LEGACY_VECTOR_DIMENSIONS,
    })).not.toThrow();
  });

  test("rejects an unlabelled index for a local model", () => {
    expect(() => assertIndexIdentity({
      indexPath, expected: ollama1024(), stored: null, schemaDimensions: 1024,
    })).toThrow(/LANCE_IDENTITY_MISSING/);
  });

  test("rejects an unlabelled index whose schema is not the legacy width", () => {
    expect(() => assertIndexIdentity({
      indexPath, expected: zhipu2048(), stored: null, schemaDimensions: 1024,
    })).toThrow(/LANCE_IDENTITY_MISSING/);
  });

  test("rejects the same width built by a different model", () => {
    expect(() => assertIndexIdentity({
      indexPath,
      expected: zhipu2048(),
      stored: { provider: "deterministic", model: "deterministic-fixed-v1", dimensions: 2048, documentEncoding: 1 },
      schemaDimensions: 2048,
    })).toThrow(/LANCE_IDENTITY_MISMATCH/);
  });

  test("rejects a provider change at the same width", () => {
    expect(() => assertIndexIdentity({
      indexPath, expected: ollama1024(), stored: zhipu2048(), schemaDimensions: 2048,
    })).toThrow(/LANCE_IDENTITY_MISMATCH/);
  });

  test("rejects digest drift but tolerates an unresolved digest", () => {
    expect(() => assertIndexIdentity({
      indexPath,
      expected: ollama1024({ modelDigest: "sha256:new" }),
      stored: ollama1024({ modelDigest: "sha256:old" }),
      schemaDimensions: 1024,
    })).toThrow(/model digest/);

    expect(() => assertIndexIdentity({
      indexPath, expected: ollama1024(), stored: ollama1024({ modelDigest: "sha256:old" }), schemaDimensions: 1024,
    })).not.toThrow();
    expect(() => assertIndexIdentity({
      indexPath, expected: ollama1024({ modelDigest: "sha256:new" }), stored: ollama1024(), schemaDimensions: 1024,
    })).not.toThrow();
  });

  test("rejects an encoding strategy change", () => {
    expect(() => assertIndexIdentity({
      indexPath,
      expected: ollama1024({ documentEncoding: 2 }),
      stored: ollama1024(),
      schemaDimensions: 1024,
    })).toThrow(/document encoding/);
  });

  test("rejects an identity that contradicts the table schema", () => {
    expect(() => assertIndexIdentity({
      indexPath, expected: ollama1024(), stored: ollama1024(), schemaDimensions: 2048,
    })).toThrow(/LANCE_IDENTITY_SCHEMA_MISMATCH/);
  });

  test("checks the stored identity even without a provider context", () => {
    expect(() => assertIndexIdentity({
      indexPath, expected: null, stored: ollama1024(), schemaDimensions: 2048,
    })).toThrow(/LANCE_IDENTITY_SCHEMA_MISMATCH/);
    expect(() => assertIndexIdentity({
      indexPath, expected: null, stored: ollama1024(), schemaDimensions: 1024,
    })).not.toThrow();
    expect(() => assertIndexIdentity({
      indexPath, expected: null, stored: null, schemaDimensions: 2048,
    })).not.toThrow();
  });
});
